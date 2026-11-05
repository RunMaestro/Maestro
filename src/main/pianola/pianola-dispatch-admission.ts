import type { ManagedQueueRoutingProgress } from '../../shared/crossAgentTypes';
import { buildConsultFirstContext, buildConsultReplyContext } from '../../shared/crossAgentContext';
import { getPrompt } from '../prompt-manager';
import { captureException } from '../utils/sentry';
import {
	prepareQueueRouting,
	queueRoutingEpoch,
	assertQueueRouting,
	bindQueueConsultRelease,
	forgetQueueConsultRelease,
	type QueueRoutingSnapshot,
} from './pianola-queue-routing';
import type { StartCrossAgentRequestOptions } from '../cross-agent/cross-agent-router';
/** Host-only pre-start boundary. Adapters prepare a held target, then bind/enroll/release.
 * One service per host; no watcher, timer, plugin activation or answer permission. */
import { isTerminalAgentRunStatus } from '../../shared/agent-run';
import { readAgentRuns } from '../../cli/services/agent-run-store';
import {
	initialQueueSession,
	queueSessionMatches,
	nativeTabSession,
} from './pianola-queue-session';
import { randomUUID, createHash } from 'crypto';
import { canonicalJson } from '../../shared/canonicalJson';
import { createKeyedWriteQueue } from '../../shared/keyedWriteQueue';
import {
	hostCallerRuns,
	type HostCallerRuns,
	type HostCallerRun,
} from '../agent-run/caller-identity';
import type { PianolaFsStore } from '../../shared/pianola/fs-store';
import {
	resolvePianolaScopeOwnership,
	type PianolaScopeCandidate,
} from '../../shared/pianola/pianola-scope';
import {
	pianolaScopeConfigurationFingerprint,
	pianolaScopeBindingFingerprint,
	type PianolaScopeSnapshot,
} from '../../shared/pianola/pianola-scope-cycle';
import { initialWatchState } from '../../shared/pianola/pianola-watcher';
import { isPianolaScopeId } from '../../shared/pianola/pianola-scope';
import type {
	PianolaDispatchAdmission,
	PianolaDispatchReceipt,
	PianolaDispatchOutcome,
} from '../../shared/pianola/pianola-dispatch';

export interface PianolaDispatchRequest {
	dispatchId: string;
	targetAgentId: string;
	/** Stable adapter intent: prompt, placement and options. Stored only as a hash. */
	intent: unknown;
}
type Client = { cliAuthenticated?: boolean };
type Store = Pick<
	PianolaFsStore,
	| 'readSupervisorTargets'
	| 'readScopeCheckpoint'
	| 'writeScopeCheckpoint'
	| 'readDispatchAdmission'
	| 'writeDispatchAdmission'
>;
export interface PianolaDispatchAdmissionDeps {
	store: Store;
	/** Host ledger only; never supplied by an IPC caller. */
	readNativeRuns?: typeof readAgentRuns;
	/** Host-only atomic session mutation; never a renderer-supplied receipt. */
	releaseQueueItem?: import('../stores/queue-item-receipt').ReleaseQueueItem;
	queueSnapshot?(): PianolaScopeSnapshot;
	routingSnapshot?(): QueueRoutingSnapshot;
	now?(): number;
	callers?: Pick<HostCallerRuns, 'resolve'>;
	featureEnabled(): boolean;
	/** Host metadata only; complete census, with authoritative pre-start cursor. */
	readSnapshot(): Promise<PianolaScopeSnapshot>;
	/** Current answer-rule revision. Observation enrollment never grants answers. */
	ruleSetRevision(): string;
	/** Synchronous native fence: exact held target, current ownership/lineage, pause and queue hold. */
	assertTargetReady(
		receipt: PianolaDispatchReceipt,
		bindingFingerprint: string,
		ownsLocalRun?: boolean
	): void;
	/** Adapter must hold exact tab/queue item and call guard at the actual send/drain. */
	release(
		receipt: PianolaDispatchReceipt,
		guard: () => void
	): Promise<Exclude<PianolaDispatchOutcome, 'not-started'>>;
}

const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

export class PianolaDispatchAdmissionService {
	private readonly queue = createKeyedWriteQueue();
	private readonly routingReleases = new Map<
		string,
		{
			generation: string;
			guard(): void;
			localPrompt(): string;
			terminals: Map<string, string>;
			localRunId?: string;
			onSettled?: (progress: ManagedQueueRoutingProgress) => void;
			replyNotified?: boolean;
			handoffNotified?: boolean;
		}
	>();
	private disposed = false;
	constructor(private readonly deps: PianolaDispatchAdmissionDeps) {}

	/** Revoke future starts; live ConsultService children keep their own ownership. */
	dispose(): void {
		this.disposed = true;
		for (const id of this.routingReleases.keys()) forgetQueueConsultRelease(id);
		this.routingReleases.clear();
	}

	private caller(client: Client): HostCallerRun {
		const caller = (this.deps.callers ?? hostCallerRuns).resolve(client);
		if (!caller) throw new Error('CallerRunUnavailable');
		caller.assertActive();
		return caller;
	}

	private record(client: Client, dispatchId: string): PianolaDispatchAdmission {
		const caller = this.caller(client);
		const record = this.deps.store.readDispatchAdmission(dispatchId);
		if (!record || canonicalJson(record.caller) !== canonicalJson(caller.run))
			throw new Error('DispatchCallerMismatch');
		return record;
	}

	/** Resolve standing scope authority on each boundary, including overlapping pause vetoes. */
	private async authorize(client: Client, targetAgentId: string, targetTabId?: string) {
		const caller = this.caller(client);
		return {
			caller,
			...(await this.authorizeOwner(
				caller.run.agentId,
				() => caller.assertActive(),
				targetAgentId,
				targetTabId
			)),
		};
	}

	private async authorizeOwner(
		managerAgentId: string,
		assertAuthority: () => void,
		targetAgentId: string,
		targetTabId?: string
	) {
		const snapshot = await this.deps.readSnapshot();
		assertAuthority();
		if (!this.deps.featureEnabled()) throw new Error('PianolaFeatureOff');
		if (!snapshot.complete) throw new Error('PianolaSnapshotUnavailable');
		const targets = this.deps.store.readSupervisorTargets();
		if (new Set(targets.map((t) => t.id)).size !== targets.length)
			throw new Error('AmbiguousPianolaScopes');
		const scopes: PianolaScopeCandidate[] = targets
			.filter((t) => t.kind === 'watch-scope' && t.selection && t.managerAgentId)
			.map((t) => ({ ...t, selection: t.selection!, managerAgentId: t.managerAgentId! }));
		const tab = targetTabId
			? snapshot.tabs.find((t) => t.agentId === targetAgentId && t.tabId === targetTabId)
			: { agentId: targetAgentId, tabId: '', paused: false, consult: false, ephemeral: false };
		if (!tab) throw new Error('DispatchTargetUnavailable');
		const ownership = resolvePianolaScopeOwnership(
			tab,
			snapshot.owners,
			scopes,
			targets.filter((t) => t.kind === 'watch')
		);
		if (ownership.kind !== 'scope') throw new Error('PianolaTargetExcluded');
		const scope = scopes.find((s) => s.id === ownership.scopeId)!;
		if (scope.managerAgentId !== managerAgentId) throw new Error('PianolaManagerMismatch');
		const target = targets.find((t) => t.id === scope.id)!;
		// Existing identity-based selection is standing observation authorization.
		// An absent policy does not require a new per-dispatch opt-in or create an answer rule.
		const policy = target.delegationPolicy ?? {
			version: 1,
			revision: 1,
			enabled: true,
			managerAgentId: scope.managerAgentId,
			coverage: 'selected-agents',
			ruleSetRevision: this.deps.ruleSetRevision(),
		};
		if (!policy.enabled) throw new Error('PianolaPolicyPaused');
		if (
			policy.managerAgentId !== scope.managerAgentId ||
			policy.ruleSetRevision !== this.deps.ruleSetRevision()
		)
			throw new Error('PianolaPolicyChanged');
		const policyFingerprint = hash({ scope: pianolaScopeConfigurationFingerprint(scope), policy });
		// Synchronous final fence. Adapter additionally verifies the held native tab/queue identity.
		const guard = () => {
			assertAuthority();
			if (
				!this.deps.featureEnabled() ||
				canonicalJson(targets) !== canonicalJson(this.deps.store.readSupervisorTargets()) ||
				policy.ruleSetRevision !== this.deps.ruleSetRevision()
			)
				throw new Error('PianolaPolicyChanged');
		};
		return { snapshot, scope, policyFingerprint, guard };
	}

	prepare(client: Client, request: PianolaDispatchRequest): Promise<PianolaDispatchReceipt> {
		return this.queue.enqueue('admissions', async () => {
			if (!isPianolaScopeId(request.dispatchId)) throw new Error('InvalidDispatchId');
			const intentFingerprint = hash({
				targetAgentId: request.targetAgentId,
				intent: request.intent,
			});
			if (this.deps.store.readDispatchAdmission(request.dispatchId)) {
				const prior = this.record(client, request.dispatchId);
				if (prior.intentFingerprint !== intentFingerprint)
					throw new Error('DispatchIntentMismatch');
				return this.receipt(prior);
			}
			const auth = await this.authorize(client, request.targetAgentId);
			auth.guard();
			const record: PianolaDispatchAdmission = {
				version: 1,
				dispatchId: request.dispatchId,
				targetAgentId: request.targetAgentId,
				scopeId: auth.scope.id,
				caller: { ...auth.caller.run },
				intentFingerprint,
				policyFingerprint: auth.policyFingerprint,
				phase: 'prepared',
				supervision: 'unavailable',
				outcome: 'not-started',
			};
			this.deps.store.writeDispatchAdmission(record);
			return this.receipt(record);
		});
	}

	bind(
		client: Client,
		dispatchId: string,
		targetTabId: string,
		queueItemId?: string
	): Promise<PianolaDispatchReceipt> {
		return this.queue.enqueue('admissions', async () => {
			const record = this.record(client, dispatchId);
			if (record.targetTabId !== undefined) {
				if (record.targetTabId !== targetTabId || record.queueItemId !== queueItemId)
					throw new Error('DispatchTargetMismatch');
				return this.receipt(record);
			}
			const auth = await this.authorize(client, record.targetAgentId, targetTabId);
			this.checkPolicy(record, auth);
			Object.assign(record, { targetTabId, queueItemId, phase: 'bound' });
			this.deps.store.writeDispatchAdmission(record);
			return this.receipt(record);
		});
	}

	enroll(client: Client, dispatchId: string): Promise<PianolaDispatchReceipt> {
		return this.queue.enqueue('admissions', async () => {
			const record = this.record(client, dispatchId);
			if (record.queuePrepare) throw new Error('DispatchQueueDrainUnavailable');
			if (record.phase !== 'bound') {
				if (record.phase === 'prepared') throw new Error('DispatchNotBound');
				return this.receipt(record);
			}
			const auth = await this.authorize(client, record.targetAgentId, record.targetTabId);
			this.checkPolicy(record, auth);
			this.enrollRecord(record, auth);
			return this.receipt(record);
		});
	}

	private enrollRecord(
		record: PianolaDispatchAdmission,
		auth: Awaited<ReturnType<PianolaDispatchAdmissionService['authorizeOwner']>>
	) {
		const tab = auth.snapshot.tabs.find(
			(t) => t.agentId === record.targetAgentId && t.tabId === record.targetTabId
		)!;
		if (!tab.cursorAvailable || tab.busy) throw new Error('DispatchBaselineUnavailable');
		const configurationFingerprint = pianolaScopeConfigurationFingerprint(auth.scope);
		let checkpoint = this.deps.store.readScopeCheckpoint(record.scopeId);
		// Never silently re-arm a suspended or reconfigured existing scope.
		if (
			checkpoint &&
			(checkpoint.status !== 'armed' ||
				checkpoint.configurationFingerprint !== configurationFingerprint)
		)
			throw new Error('PianolaCheckpointSuspended');
		checkpoint ??= {
			version: 1,
			scopeId: record.scopeId,
			configurationFingerprint,
			activatedAt: auth.snapshot.capturedAt,
			status: 'armed',
			tabs: [],
		};
		const bindingFingerprint = pianolaScopeBindingFingerprint(
			auth.scope,
			tab.agentId,
			auth.snapshot.owners
		);
		const saved = checkpoint.tabs.find((t) => t.agentId === tab.agentId && t.tabId === tab.tabId);
		if (saved && (saved.status !== 'active' || saved.bindingFingerprint !== bindingFingerprint))
			throw new Error('PianolaEnrollmentUnavailable');
		if (!saved)
			checkpoint.tabs.push({
				agentId: tab.agentId,
				tabId: tab.tabId,
				bindingFingerprint,
				dispatchEnrollmentId: record.dispatchId,
				emptyEnrollment: tab.enrollment,
				baseline: tab.cursor,
				baselineBusy: false,
				lastSeen: tab.cursor,
				state: initialWatchState(),
				status: 'active',
				unresolvedIntent: null,
			});
		// Checkpoint commit precedes journal commit; a crash here may safely reuse coverage.
		this.deps.store.writeScopeCheckpoint(checkpoint, true);
		record.supervision = saved ? 'already-covered' : 'enrolled';
		record.phase = 'enrolled';
		this.deps.store.writeDispatchAdmission(record);
	}

	private checkPolicy(
		record: PianolaDispatchAdmission,
		auth: Awaited<ReturnType<PianolaDispatchAdmissionService['authorizeOwner']>>
	) {
		auth.guard();
		if (auth.scope.id !== record.scopeId || auth.policyFingerprint !== record.policyFingerprint)
			throw new Error('PianolaPolicyChanged');
	}

	release(client: Client, dispatchId: string): Promise<PianolaDispatchReceipt> {
		return this.queue.enqueue('admissions', async () => {
			const record = this.record(client, dispatchId);
			if (record.queuePrepare) throw new Error('DispatchQueueDrainUnavailable');
			if (record.phase === 'released' || record.phase === 'settled') return this.receipt(record);
			if (record.phase !== 'enrolled') throw new Error('DispatchNotEnrolled');
			const auth = await this.authorize(client, record.targetAgentId, record.targetTabId);
			this.checkPolicy(record, auth);
			const binding = pianolaScopeBindingFingerprint(
				auth.scope,
				record.targetAgentId,
				auth.snapshot.owners
			);
			const guard = () => {
				auth.guard();
				const checkpoint = this.deps.store.readScopeCheckpoint(record.scopeId);
				const saved = checkpoint?.tabs.find(
					(t) => t.agentId === record.targetAgentId && t.tabId === record.targetTabId
				);
				if (
					checkpoint?.status !== 'armed' ||
					checkpoint.configurationFingerprint !==
						pianolaScopeConfigurationFingerprint(auth.scope) ||
					saved?.status !== 'active' ||
					saved.bindingFingerprint !== binding
				)
					throw new Error('PianolaEnrollmentUnavailable');
				this.deps.assertTargetReady(this.receipt(record), binding);
			};
			guard();
			// Commit uncertainty BEFORE I/O. Throw, lost ack and host crash all prohibit resend.
			record.phase = 'released';
			record.outcome = 'unknown';
			this.deps.store.writeDispatchAdmission(record);
			const outcome = await this.deps.release(this.receipt(record), guard);
			return this.settle(record, outcome);
		});
	}

	/** Only an authoritative host adapter may reconcile; never infer failure from a timeout. */
	reconcile(
		dispatchId: string,
		outcome: Exclude<PianolaDispatchOutcome, 'not-started'>,
		runId?: string
	): Promise<PianolaDispatchReceipt> {
		return this.queue.enqueue('admissions', async () => {
			const record = this.deps.store.readDispatchAdmission(dispatchId);
			if (!record || !['released', 'settled'].includes(record.phase))
				throw new Error('DispatchNotReleased');
			if (record.runId && runId !== undefined && record.runId !== runId)
				throw new Error('DispatchRunMismatch');
			if (record.outcome !== 'unknown' && record.outcome !== 'queued' && record.outcome !== outcome)
				throw new Error('DispatchOutcomeConflict');
			return this.settle(record, outcome, runId);
		});
	}

	private settle(
		record: PianolaDispatchAdmission,
		outcome: Exclude<PianolaDispatchOutcome, 'not-started'>,
		runId?: string
	) {
		record.phase = 'settled';
		record.outcome = outcome;
		if (runId !== undefined) record.runId = runId;
		this.deps.store.writeDispatchAdmission(record);
		return this.receipt(record);
	}

	/** Commit the exact held row BEFORE renderer I/O. Busy tabs need no baseline here. */
	prepareQueue(
		client: Client,
		dispatchId: string,
		item: import('../../shared/pianola/pianola-dispatch').PianolaQueueItem,
		callbackId?: string,
		callbackProof?: import('../../shared/pianola/pianola-dispatch').PianolaQueueCallbackProof
	) {
		return this.queue.enqueue('admissions', async () => {
			const record = this.record(client, dispatchId);
			if (record.queuePrepare) {
				if (record.phase !== 'bound') throw new Error('DispatchQueueAlreadyReleased');
				return this.queueOutcome(record);
			}
			if (
				record.phase !== 'bound' ||
				record.targetTabId !== item.tabId ||
				record.queueItemId !== item.id ||
				item.pendingAdmissionId !== dispatchId
			)
				throw new Error('DispatchTargetMismatch');
			const auth = await this.authorize(client, record.targetAgentId, record.targetTabId);
			this.checkPolicy(record, auth);
			const tab = auth.snapshot.tabs.find(
				(t) => t.agentId === record.targetAgentId && t.tabId === record.targetTabId
			)!;
			const acceptedAt = (this.deps.now ?? Date.now)();
			const initialSession = initialQueueSession(
				tab.agentSessionId ? [] : (this.deps.readNativeRuns ?? readAgentRuns)(),
				tab
			);
			if (item.crossAgentMention && !this.deps.routingSnapshot)
				throw new Error('DispatchRoutingUnavailable');
			if (this.deps.routingSnapshot)
				record.queueRouting = prepareQueueRouting(
					item,
					record.targetAgentId,
					this.deps.routingSnapshot()
				);
			record.queueAuthority = {
				...(initialSession ? { initialSession } : {}),
				acceptedAt,
				expiresAt: acceptedAt + 86_400_000,
				bindingFingerprint: pianolaScopeBindingFingerprint(
					auth.scope,
					tab.agentId,
					auth.snapshot.owners
				),
				createdAt: tab.createdAt,
				...(tab.agentSessionId !== undefined ? { agentSessionId: tab.agentSessionId } : {}),
			};
			record.queuePrepare = {
				phase: 'unknown',
				item: JSON.parse(canonicalJson(item)),
				...(callbackId ? { callbackId } : {}),
				...(callbackProof ? { callbackProof } : {}),
			};
			record.outcome = 'unknown';
			try {
				this.deps.store.writeDispatchAdmission(record);
			} catch (commitError) {
				// A failed acknowledgment cannot prove that the uncertainty write did not land.
				return { ...this.queueOutcome(record), commitFailed: true, commitError };
			}
			return this.queueOutcome(record);
		});
	}

	/** Host drain only. No wire caller may adopt a journal by ID. The standing
	 * task was authorized at prepare; caller completion is irrelevant, policy
	 * revocation, target replacement and expiry are not. Uncertain release is
	 * terminal for retries, including after restart or a lost acknowledgment. */
	releaseQueue(dispatchId: string, onSettled?: (progress: ManagedQueueRoutingProgress) => void) {
		return this.queue.enqueue('admissions', async () => {
			const record = this.deps.store.readDispatchAdmission(dispatchId);
			if (
				!record?.queuePrepare ||
				record.queuePrepare.phase !== 'durable' ||
				!record.queueAuthority
			)
				throw new Error('DispatchQueueAuthorityUnavailable');
			if (record.queueCancelled) throw new Error('DispatchQueueCancelled');
			if (record.phase !== 'bound' || record.queueRelease)
				throw new Error('DispatchQueueReleaseUncertain');
			if (!this.deps.releaseQueueItem || !this.deps.queueSnapshot)
				throw new Error('DispatchQueueDrainUnavailable');
			const authority = record.queueAuthority;
			const assertAuthority = () => {
				const now = (this.deps.now ?? Date.now)();
				if (now < authority.acceptedAt || now >= authority.expiresAt)
					throw new Error('DispatchQueueAuthorityExpired');
			};
			const auth = await this.authorizeOwner(
				record.caller.agentId,
				assertAuthority,
				record.targetAgentId,
				record.targetTabId
			);
			this.checkPolicy(record, auth);
			const guard = (ownLocal = false) => {
				if (this.disposed) throw new Error('DispatchAdmissionDisposed');
				const current = this.deps.store.readDispatchAdmission(dispatchId);
				if (
					!current ||
					current.intentFingerprint !== record.intentFingerprint ||
					(record.queueRelease &&
						current.queueRelease?.generation !== record.queueRelease.generation)
				)
					throw new Error('DispatchRoutingAdmissionChanged');
				if (this.deps.store.readDispatchAdmission(dispatchId)?.queueCancelled)
					throw new Error('DispatchQueueCancelled');
				auth.guard();
				const snapshot = this.deps.queueSnapshot!();
				const tab = snapshot.tabs.find(
					(t) => t.agentId === record.targetAgentId && t.tabId === record.targetTabId
				);
				let ownsLocalRun = false;
				if (ownLocal && current.runId) {
					const local = current.queueRouting?.steps.find(
						(s) => s.kind === 'local' && s.runId === current.runId
					);
					const runs = (this.deps.readNativeRuns ?? readAgentRuns)();
					const history = runs.filter(
						(r) => r.sessionId === `${record.targetAgentId}-ai-${record.targetTabId}`
					);
					const run = history.find((r) => r.id === current.runId);
					const identity = run && nativeTabSession(run);
					ownsLocalRun = !!(
						run &&
						local?.runId === run.id &&
						local.processId === run.sessionId &&
						['started', 'settled'].includes(local.status) &&
						['running', 'completed', 'failed', 'cancelled'].includes(run.status) &&
						identity &&
						!identity.conflicted &&
						identity.createdAt === authority.createdAt &&
						identity.agentId === record.targetAgentId &&
						identity.tabId === record.targetTabId &&
						(tab?.agentSessionId ?? undefined) ===
							(identity.announcedSessionId ?? identity.initialSessionId ?? undefined) &&
						!history.some((r) => r.id !== run.id && r.createdAt >= run.createdAt)
					);
					if (!ownsLocalRun) throw new Error('DispatchRoutingOwnCaptureUnavailable');
				}
				if (
					!snapshot.complete ||
					!tab ||
					!tab.cursorAvailable ||
					(tab.busy && !ownsLocalRun) ||
					tab.paused ||
					tab.consult ||
					tab.ephemeral ||
					tab.createdAt !== authority.createdAt ||
					(!ownsLocalRun &&
						!queueSessionMatches(
							record,
							tab.agentSessionId,
							authority.initialSession ? (this.deps.readNativeRuns ?? readAgentRuns)() : []
						)) ||
					pianolaScopeBindingFingerprint(auth.scope, record.targetAgentId, snapshot.owners) !==
						authority.bindingFingerprint
				)
					throw new Error('DispatchTargetIdentityChangedOrBusy');
				const targets = this.deps.store.readSupervisorTargets();
				const ownership = resolvePianolaScopeOwnership(
					tab,
					snapshot.owners,
					targets
						.filter((t) => t.kind === 'watch-scope' && t.selection && t.managerAgentId)
						.map((t) => ({ ...t, selection: t.selection!, managerAgentId: t.managerAgentId! })),
					targets.filter((t) => t.kind === 'watch')
				);
				if (ownership.kind !== 'scope' || ownership.scopeId !== record.scopeId)
					throw new Error('PianolaTargetExcluded');
				if (record.queueRelease) {
					const checkpoint = this.deps.store.readScopeCheckpoint(record.scopeId);
					const saved = checkpoint?.tabs.find(
						(t) => t.agentId === record.targetAgentId && t.tabId === record.targetTabId
					);
					if (
						checkpoint?.status !== 'armed' ||
						saved?.status !== 'active' ||
						checkpoint.configurationFingerprint !==
							pianolaScopeConfigurationFingerprint(auth.scope) ||
						saved.bindingFingerprint !== authority.bindingFingerprint
					)
						throw new Error('PianolaEnrollmentUnavailable');
				}
				if (record.queueRouting) {
					if (!this.deps.routingSnapshot) throw new Error('DispatchRoutingUnavailable');
					assertQueueRouting(
						record.queueRouting,
						record.queuePrepare!.item,
						record.targetAgentId,
						this.deps.routingSnapshot()
					);
				}
				this.deps.assertTargetReady(
					this.receipt(record),
					authority.bindingFingerprint,
					ownsLocalRun
				);
			};
			guard();
			const releaseTab = this.deps.queueSnapshot!().tabs.find(
				(t) => t.agentId === record.targetAgentId && t.tabId === record.targetTabId
			)!;
			const release = await this.deps.releaseQueueItem(
				{
					agentId: record.targetAgentId,
					tabId: record.targetTabId!,
					itemId: record.queueItemId!,
					pendingAdmissionId: record.dispatchId,
					item: JSON.parse(canonicalJson(record.queuePrepare.item)),
					tabIdentity: {
						createdAt: authority.createdAt,
						...(releaseTab.agentSessionId !== undefined
							? { agentSessionId: releaseTab.agentSessionId }
							: {}),
					},
				},
				(assertRow) => {
					guard();
					assertRow();
					// Capture baseline only NOW, under the session write lock.
					const snapshot = this.deps.queueSnapshot!();
					const currentAuth = { ...auth, snapshot };
					record.outcome = 'unknown';
					this.enrollRecord(record, currentAuth);
					guard();
					assertRow();
					record.queueRelease = {
						generation: randomUUID(),
						baseline: snapshot.tabs.find(
							(t) => t.agentId === record.targetAgentId && t.tabId === record.targetTabId
						)!.cursor,
					};
					record.phase = 'released';
					record.outcome = 'unknown';
					this.deps.store.writeDispatchAdmission(record);
					return { generation: record.queueRelease.generation, guard };
				}
			);
			const nativeFrontier = new Set(
				(this.deps.readNativeRuns ?? readAgentRuns)()
					.filter((r) => r.sessionId === `${record.targetAgentId}-ai-${record.targetTabId}`)
					.map((r) => r.id)
			);
			const routingIdentity = (value: PianolaDispatchAdmission) =>
				canonicalJson({
					item: value.queuePrepare?.item,
					callbackProof: value.queuePrepare?.callbackProof,
					routing: value.queueRouting && {
						routing: value.queueRouting.routing,
						rendererConsumer: value.queueRouting.rendererConsumer,
						targets: value.queueRouting.targets,
						steps: value.queueRouting.steps.map(({ kind, stage, targetAgentId, requestId }) => ({
							kind,
							stage,
							targetAgentId,
							requestId,
						})),
					},
				});
			const pinnedRouting = routingIdentity(record);
			const releaseEpoch = queueRoutingEpoch;
			const routingGuard = () => {
				if (releaseEpoch !== queueRoutingEpoch)
					throw new Error('DispatchRoutingReleaseUnavailable');
				const current = this.deps.store.readDispatchAdmission(dispatchId);
				if (!current || routingIdentity(current) !== pinnedRouting)
					throw new Error('DispatchRoutingAdmissionChanged');
				if (current.runId && this.routingReleases.get(dispatchId)?.localRunId !== current.runId)
					throw new Error('DispatchRoutingOwnCaptureUnavailable');
				if (
					!current.runId &&
					(this.deps.readNativeRuns ?? readAgentRuns)().some(
						(r) =>
							r.sessionId === `${record.targetAgentId}-ai-${record.targetTabId}` &&
							!nativeFrontier.has(r.id)
					)
				)
					throw new Error('DispatchRoutingSourceSuperseded');
				if (
					current?.runId &&
					current.queueRouting?.steps.some((s) => s.kind === 'local' && s.runId === current.runId)
				)
					guard(true);
				else release.guard();
			};
			for (const [id, entry] of this.routingReleases) {
				try {
					entry.guard();
				} catch {
					this.routingReleases.delete(id);
					forgetQueueConsultRelease(id);
				}
			}
			while (this.routingReleases.size >= 256) {
				const id = this.routingReleases.keys().next().value!;
				this.routingReleases.delete(id);
				forgetQueueConsultRelease(id);
			}
			if (record.queueRouting) {
				const terminals = new Map<string, string>();
				const localPrompt = () => {
					routingGuard();
					const current = this.deps.store.readDispatchAdmission(dispatchId)!;
					if (
						!current.queueRouting ||
						!['parallel', 'consult-first'].includes(current.queueRouting.routing)
					)
						throw new Error('DispatchQueueLocalUnavailable');
					const consults = current.queueRouting.steps.filter((s) => s.kind === 'consult');
					if (
						!consults.length ||
						consults.some(
							(s) =>
								s.status !== 'settled' ||
								!s.terminal ||
								s.terminal.error ||
								s.terminal.canceled ||
								terminals.get(s.requestId) !== canonicalJson(s)
						)
					)
						throw new Error('DispatchRoutingRepliesUnavailable');
					if (current.queueRouting?.routing === 'parallel') {
						const initial = current.queueRouting.steps.find((s) => s.kind === 'local' && !s.stage);
						if (
							!initial?.terminal ||
							initial.terminal.error ||
							initial.terminal.canceled ||
							terminals.get(initial.requestId) !== canonicalJson(initial)
						)
							throw new Error('DispatchRoutingRepliesUnavailable');
						return (
							current.queuePrepare!.item.text +
							'\n\n---\n\n' +
							buildConsultReplyContext(getPrompt('cross-agent-consult-reply'), [
								{ targetAgentName: 'Your earlier local turn', text: initial.terminal.text },
								...consults.map((s) => ({
									targetAgentName: this.deps.routingSnapshot!().agents.find(
										(a) => a.id === s.targetAgentId
									)!.name,
									text: s.terminal!.text,
								})),
							])
						);
					}
					return buildConsultFirstContext(
						getPrompt('cross-agent-consult-first'),
						consults.map((s) => ({
							targetAgentName: this.deps.routingSnapshot!().agents.find(
								(a) => a.id === s.targetAgentId
							)!.name,
							text: s.terminal!.text,
						})),
						current.queuePrepare!.item.text
					);
				};
				this.routingReleases.set(dispatchId, {
					generation: release.generation,
					guard: routingGuard,
					localPrompt,
					terminals,
					onSettled,
				});
				if (record.queueRouting.steps.some((s) => s.kind === 'consult'))
					bindQueueConsultRelease(dispatchId, {
						sourceAgentId: record.targetAgentId,
						sourceTabId: record.targetTabId!,
						generation: release.generation,
						guard: routingGuard,
						localPrompt,
						replyReady: () => !!this.routingReleases.get(dispatchId)?.replyNotified,
						revoke: () => this.routingReleases.delete(dispatchId),
						start: (target, opts) =>
							this.startQueueConsult(dispatchId, release.generation, target, opts),
					});
			}

			return { receipt: this.receipt(record), ...release };
		});
	}

	/** Called only by the existing native capture observer, never by a wire caller. */
	noteQueueLocalCapture(dispatchId: string, generation: string, runId: string): void {
		const release = this.routingReleases.get(dispatchId);
		const record = this.deps.store.readDispatchAdmission(dispatchId);
		const local = record?.queueRouting?.steps.find((s) => s.kind === 'local' && s.runId === runId);
		if (
			!release ||
			release.generation !== generation ||
			record?.runId !== runId ||
			local?.runId !== runId ||
			(release.localRunId &&
				release.localRunId !== runId &&
				!(
					local?.stage === 'reply' &&
					record?.queueRouting?.steps.some(
						(s) =>
							s.runId === release.localRunId &&
							s.terminal &&
							release.terminals.get(s.requestId) === canonicalJson(s)
					)
				))
		)
			throw new Error('DispatchRoutingOwnCaptureUnavailable');
		release.localRunId = runId;
		const run = (this.deps.readNativeRuns ?? readAgentRuns)().find((r) => r.id === runId);
		if (run && isTerminalAgentRunStatus(run.status)) {
			const expected = {
				text: typeof run.metadata?.answerTail === 'string' ? run.metadata.answerTail : '',
				...(run.status !== 'completed' ? { error: `Native local run ${run.status}` } : {}),
				...(run.status === 'cancelled' ? { canceled: true } : {}),
			};
			if (local.status !== 'settled' || canonicalJson(local.terminal) !== canonicalJson(expected))
				throw new Error('DispatchRoutingLocalOutputChanged');
			release.terminals.set(local.requestId, canonicalJson(local));
		}
		this.settleQueueRouting(dispatchId);
	}

	/** Native observers only: neither renderer completion chunks nor journal IDs call this. */
	private settleQueueRouting(dispatchId: string): void {
		const release = this.routingReleases.get(dispatchId);
		const record = this.deps.store.readDispatchAdmission(dispatchId);
		if (!release?.onSettled || !record?.queueRouting) return;
		const reply = record.queueRouting.steps.find((s) => s.stage === 'reply');
		const mode = record.queueRouting.routing;
		const initial = record.queueRouting.steps.filter((s) =>
			mode === 'consult-first'
				? s.kind === 'consult'
				: mode === 'handoff'
					? s.kind === 'local'
					: !s.stage
		);
		if (
			initial.some(
				(s) =>
					s.status !== 'settled' ||
					!s.terminal ||
					s.startError ||
					release.terminals.get(s.requestId) !== canonicalJson(s)
			)
		)
			return;
		const failed =
			initial.some((s) => s.terminal?.error || s.terminal?.canceled) ||
			(mode === 'handoff' && !initial[0]?.terminal?.text.trim());
		if (mode === 'consult-first' && !failed) {
			const local = record.queueRouting.steps.find((s) => s.kind === 'local')!;
			if (local.status === 'prepared' && !release.replyNotified) {
				release.localPrompt();
				release.replyNotified = true;
				release.onSettled({ failed: false, continuationStepId: local.requestId });
				return;
			}
			if (
				local.status !== 'settled' ||
				!local.terminal ||
				local.startError ||
				release.terminals.get(local.requestId) !== canonicalJson(local)
			)
				return;
		}
		if (mode === 'handoff' && !failed) {
			if (!release.handoffNotified) {
				release.guard();
				release.handoffNotified = true;
				release.onSettled({
					failed: false,
					handoff: {
						generation: release.generation,
						targetSessionIds: record.queueRouting.targets.map((t) => t.agentId),
					},
				});
				return;
			}
			if (
				record.queueRouting.steps.some(
					(s) =>
						s.kind === 'handoff' &&
						(s.status !== 'settled' ||
							!s.terminal ||
							s.startError ||
							release.terminals.get(s.requestId) !== canonicalJson(s))
				)
			)
				return;
		}
		if (reply && !failed) {
			if (reply.status === 'prepared' && !release.replyNotified) {
				release.localPrompt();
				release.replyNotified = true;
				release.onSettled({ failed: false, continuationStepId: reply.requestId });
				return;
			}
			if (
				reply.status !== 'settled' ||
				!reply.terminal ||
				reply.startError ||
				release.terminals.get(reply.requestId) !== canonicalJson(reply)
			)
				return;
		}
		const local = record.queueRouting.steps.find(
			(s) => s.kind === 'local' && s.runId === record.runId
		);
		if (local && local.runId !== release.localRunId) return;
		release.guard();
		record.phase = 'settled';
		record.outcome = 'accepted';
		record.queueRouting.completed = true;
		this.deps.store.writeDispatchAdmission(record);
		// Drop the capability before notification, including reentrant callbacks.
		this.routingReleases.delete(dispatchId);
		forgetQueueConsultRelease(dispatchId);
		release.onSettled({
			failed:
				failed ||
				record.queueRouting.steps.some((s) => !!s.terminal?.error || !!s.terminal?.canceled),
		});
	}

	hasQueueRoutingConsumer(dispatchId: string): boolean {
		return !!this.routingReleases.get(dispatchId)?.onSettled;
	}

	/** Revoke the live local/handoff release too; it has no consult transport entry. */
	revokeQueueRouting(dispatchId: string): boolean {
		const live = this.routingReleases.delete(dispatchId);
		forgetQueueConsultRelease(dispatchId);
		return live;
	}

	/** Only a live host release can authorize delayed LOCAL; disk IDs cannot restore it. */
	queueLocalRelease(dispatchId: string, stepId?: string) {
		const release = this.routingReleases.get(dispatchId);
		if (!release) throw new Error('DispatchRoutingReleaseUnavailable');
		const routing = this.deps.store.readDispatchAdmission(dispatchId)?.queueRouting;
		if (
			routing?.routing === 'consult-first' &&
			routing.rendererConsumer &&
			(!release.replyNotified ||
				!stepId ||
				!routing.steps.some(
					(s) => s.kind === 'local' && s.requestId === stepId && s.status === 'prepared'
				))
		)
			throw new Error('DispatchRoutingRepliesUnavailable');
		if (
			(routing?.routing === 'parallel' || routing?.routing === 'handoff') &&
			(!!stepId !== !!release.replyNotified ||
				(stepId &&
					!routing.steps.some(
						(s) => s.requestId === stepId && s.stage === 'reply' && s.status === 'prepared'
					)))
		)
			throw new Error('DispatchRoutingRepliesUnavailable');
		if (['parallel', 'handoff'].includes(routing?.routing ?? '') && !release.replyNotified)
			release.guard();
		else release.localPrompt();
		return {
			generation: release.generation,
			guard: () => {
				if (['parallel', 'handoff'].includes(routing?.routing ?? '') && !release.replyNotified)
					release.guard();
				else release.localPrompt();
			},
		};
	}

	startQueueHandoff(
		dispatchId: string,
		generation: string,
		targetAgentId: string,
		opts: Omit<StartCrossAgentRequestOptions, 'nativeAdmission'>
	) {
		return this.startQueueBranch(dispatchId, generation, targetAgentId, opts, 'handoff');
	}

	/** Only the native queue release may reach this consumer. A journal/readback
	 * ID is not a capability: the live release closure is deliberately not restored
	 * after restart. Continuation and handoff reuse the same guarded native lifecycle. */
	startQueueConsult(
		dispatchId: string,
		generation: string,
		targetAgentId: string,
		opts: Omit<StartCrossAgentRequestOptions, 'nativeAdmission'>
	): Promise<{ requestId: string }> {
		return this.startQueueBranch(dispatchId, generation, targetAgentId, opts, 'consult');
	}

	private startQueueBranch(
		dispatchId: string,
		generation: string,
		targetAgentId: string,
		opts: Omit<StartCrossAgentRequestOptions, 'nativeAdmission'>,
		kind: 'consult' | 'handoff'
	) {
		return this.queue.enqueue('admissions', async () => {
			const release = this.routingReleases.get(dispatchId);
			if (!release || release.generation !== generation)
				throw new Error('DispatchRoutingReleaseUnavailable');
			release.guard();
			const record = this.deps.store.readDispatchAdmission(dispatchId);
			if (kind === 'handoff' && record?.queueRouting?.rendererConsumer && !release.handoffNotified)
				throw new Error('DispatchRoutingLocalOutputUnavailable');
			if ((record?.queueRouting?.routing === 'handoff') !== (kind === 'handoff'))
				throw new Error('DispatchRoutingReleaseUnavailable');
			const step = record?.queueRouting?.steps.find(
				(s) => s.kind === kind && s.targetAgentId === targetAgentId
			);
			if (!record || !step || step.status !== 'prepared')
				throw new Error('DispatchRoutingAlreadyClaimedOrUnavailable');
			const handoffAnswer = () => {
				if (kind !== 'handoff') return undefined;
				release.guard();
				const current = this.deps.store.readDispatchAdmission(dispatchId)!;
				const local = current.queueRouting?.steps.find((s) => s.kind === 'local');
				const run = (this.deps.readNativeRuns ?? readAgentRuns)().find(
					(r) => r.id === current.runId
				);
				if (
					current.queueRouting?.routing !== 'handoff' ||
					current.phase !== 'settled' ||
					!run ||
					run.status !== 'completed' ||
					local?.status !== 'settled' ||
					local.runId !== run.id ||
					!local.terminal ||
					local.terminal.error ||
					local.terminal.canceled ||
					typeof run.metadata?.answerTail !== 'string' ||
					!run.metadata.answerTail.trim() ||
					local.terminal.text !== run.metadata.answerTail
				)
					throw new Error('DispatchRoutingLocalOutputUnavailable');
				return run.metadata.answerTail;
			};
			const answer = handoffAnswer();
			const requestId = step.requestId;
			const source = this.deps
				.routingSnapshot?.()
				.agents.find((a) => a.id === record.targetAgentId);
			const update = (mutate: (s: NonNullable<typeof step>) => void) => {
				const current = this.deps.store.readDispatchAdmission(dispatchId);
				const saved = current?.queueRouting?.steps.find(
					(s) => s.requestId === requestId && s.kind === kind && s.targetAgentId === targetAgentId
				);
				if (!current || !saved || current.queueRelease?.generation !== generation)
					throw new Error('DispatchRoutingStepChanged');
				mutate(saved);
				this.deps.store.writeDispatchAdmission(current);
				if (
					!release.onSettled &&
					current.queueRouting!.routing !== 'consult-first' &&
					current.queueRouting!.steps.every((s) => s.terminal)
				) {
					this.routingReleases.delete(dispatchId);
					forgetQueueConsultRelease(dispatchId);
				}
			};
			// Claim before asynchronous provider/system-prompt preparation. A crash or
			// unknown acknowledgement never makes this branch eligible again.
			update((s) => {
				s.status = 'intent';
			});
			let nativeClaimed = false;
			let nativeEndObserved = false;
			let confirmedNonstart = false;
			let journalUncertain = false;
			const journalFailure = (error: unknown) => {
				journalUncertain = true;
				forgetQueueConsultRelease(dispatchId);
				this.routingReleases.delete(dispatchId);
				void captureException(error, {
					operation: 'pianola:consultJournal',
					dispatchId,
					requestId,
				});
				// Best effort only: failed persistence may have landed, so retain
				// any authentic terminal already on disk and never reset for retry.
				try {
					update((s) => {
						if (s.terminal) return;
						s.status = 'unknown';
						s.startError = 'DispatchRoutingJournalUnknown';
					});
				} catch (commitError) {
					void captureException(commitError, {
						operation: 'pianola:consultUncertaintyJournal',
						dispatchId,
						requestId,
					});
				}
			};
			const { startCrossAgentRequest } = await import('../cross-agent/cross-agent-router');
			await startCrossAgentRequest(
				{
					requestId,
					sourceAgentName: source?.name,
					sourceCwd: source?.cwd,
					sourceSessionId: record.targetAgentId,
					sourceTabId: record.targetTabId!,
					targetSessionId: targetAgentId,
					userPrompt: record.queuePrepare!.item.text,
					handoffAnswer: answer,
					transcript: [],
					strategy: { kind: 'full' },
					createdAt: (this.deps.now ?? Date.now)(),
				},
				{
					...opts,
					writable: kind === 'handoff',
					nativeAdmission: {
						notStarted: () => {
							confirmedNonstart = true;
						},
						beforeSpawn: () => {
							if (nativeClaimed) throw new Error('DispatchRoutingAlreadyStarting');
							if (handoffAnswer() !== answer) throw new Error('DispatchRoutingLocalOutputChanged');
							if (this.routingReleases.get(dispatchId) !== release)
								throw new Error('DispatchRoutingReleaseUnavailable');
							opts.assertNativeOwner?.();
							release.guard();
							update((s) => {
								if (s.status !== 'intent') throw new Error('DispatchRoutingStepChanged');
								s.status = 'unknown';
							});
							// A synchronous journal write may invoke host persistence hooks.
							if (handoffAnswer() !== answer) throw new Error('DispatchRoutingLocalOutputChanged');
							opts.assertNativeOwner?.();
							release.guard();
							if (this.routingReleases.get(dispatchId) !== release)
								throw new Error('DispatchRoutingReleaseUnavailable');
							nativeClaimed = true;
						},
						ended: () => {
							nativeEndObserved = true;
						},
						started: (processId, pid) => {
							// A fast real exit may already have committed terminal evidence.
							if (nativeEndObserved || journalUncertain) return;
							try {
								update((s) => {
									if (!nativeClaimed) throw new Error('DispatchRoutingNativeClaimMissing');
									s.processId = processId;
									if (pid !== undefined) s.pid = pid;
									if (s.status !== 'settled') s.status = 'started';
								});
							} catch (error) {
								journalFailure(error);
							}
						},
					},
					onChunk: (chunk) => {
						if (
							chunk.requestId !== requestId ||
							chunk.sourceSessionId !== record.targetAgentId ||
							chunk.sourceTabId !== record.targetTabId ||
							chunk.targetSessionId !== targetAgentId
						)
							return;
						try {
							if (chunk.done && !journalUncertain)
								update((s) => {
									if (s.terminal) return;
									if (!confirmedNonstart && !nativeEndObserved) {
										s.status = 'unknown';
										s.startError = chunk.error ?? 'Native start acknowledgement unavailable';
										return;
									}
									s.status = 'settled';
									s.terminal = {
										text: chunk.chunk,
										...(chunk.error ? { error: chunk.error } : {}),
										...(chunk.canceled ? { canceled: true } : {}),
									};
									if (chunk.targetAgentSessionId) s.agentSessionId = chunk.targetAgentSessionId;
								});
							if (
								chunk.done &&
								((nativeClaimed && nativeEndObserved) ||
									(confirmedNonstart && !!(chunk.error || chunk.canceled))) &&
								!journalUncertain
							) {
								const saved = this.deps.store
									.readDispatchAdmission(dispatchId)
									?.queueRouting?.steps.find((s) => s.requestId === requestId);
								if (
									saved?.terminal &&
									saved.status === 'settled' &&
									!release.terminals.has(requestId) &&
									canonicalJson(saved.terminal) ===
										canonicalJson({
											text: chunk.chunk,
											...(chunk.error ? { error: chunk.error } : {}),
											...(chunk.canceled ? { canceled: true } : {}),
										})
								)
									release.terminals.set(requestId, canonicalJson(saved));
								this.settleQueueRouting(dispatchId);
							}
						} catch (error) {
							journalFailure(error);
						}
						// A persistence failure cannot be promoted to a successful terminal
						// or retried. Durable nonterminal evidence remains non-repeatable.
						opts.onChunk(
							journalUncertain
								? {
										...chunk,
										chunk: '',
										targetAgentSessionId: undefined,
										error: 'DispatchRoutingJournalUnknown',
									}
								: chunk
						);
					},
				}
			);
			return { requestId };
		});
	}

	/** Minted only by authenticated prepareQueue after attempting the uncertainty commit.
	 * A failed commit acknowledgment is outcome-only uncertainty and forbids enqueue.
	 * The closure pins one caller/intent/row, takes no wire ID, and can only record evidence.
	 * Caller lifetime fences sending; it must not erase an already committed outcome.
	 */
	private queueOutcome(record: PianolaDispatchAdmission) {
		const pinned: PianolaDispatchAdmission = JSON.parse(canonicalJson(record));
		return {
			prepared: JSON.parse(canonicalJson(pinned.queuePrepare!)) as NonNullable<
				PianolaDispatchAdmission['queuePrepare']
			>,
			commitFailed: false,
			commitError: undefined as unknown,
			receipt: this.receipt(pinned),
			recordEvidence: (durable: boolean) =>
				this.queue.enqueue('admissions', async () => {
					const record = this.deps.store.readDispatchAdmission(pinned.dispatchId);
					if (
						!record ||
						canonicalJson({
							...record,
							outcome: pinned.outcome,
							queuePrepare: record.queuePrepare
								? { ...record.queuePrepare, phase: pinned.queuePrepare!.phase }
								: undefined,
						}) !== canonicalJson(pinned)
					)
						throw new Error('DispatchIntentMismatch');
					if (!record.queuePrepare) throw new Error('DispatchQueueNotPrepared');
					record.queuePrepare.phase = durable ? 'durable' : 'unknown';
					record.outcome = durable ? 'queued' : 'unknown';
					this.deps.store.writeDispatchAdmission(record);
					return this.receipt(record);
				}),
		};
	}

	status(client: Client, dispatchId: string): PianolaDispatchReceipt {
		return this.receipt(this.record(client, dispatchId));
	}
	private receipt(record: PianolaDispatchAdmission): PianolaDispatchReceipt {
		const {
			version,
			dispatchId,
			scopeId,
			targetAgentId,
			targetTabId,
			queueItemId,
			runId,
			supervision,
			outcome,
		} = record;
		return {
			version,
			dispatchId,
			scopeId,
			targetAgentId,
			targetTabId,
			queueItemId,
			runId,
			supervision,
			outcome,
		};
	}
}
