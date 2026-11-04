/** Host-only pre-start boundary. Adapters prepare a held target, then bind/enroll/release.
 * One service per host; no watcher, timer, plugin activation or answer permission. */
import { createHash } from 'crypto';
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
	callers?: Pick<HostCallerRuns, 'resolve'>;
	featureEnabled(): boolean;
	/** Host metadata only; complete census, with authoritative pre-start cursor. */
	readSnapshot(): Promise<PianolaScopeSnapshot>;
	/** Current answer-rule revision. Observation enrollment never grants answers. */
	ruleSetRevision(): string;
	/** Synchronous native fence: exact held target, current ownership/lineage, pause and queue hold. */
	assertTargetReady(receipt: PianolaDispatchReceipt, bindingFingerprint: string): void;
	/** Adapter must hold exact tab/queue item and call guard at the actual send/drain. */
	release(
		receipt: PianolaDispatchReceipt,
		guard: () => void
	): Promise<Exclude<PianolaDispatchOutcome, 'not-started'>>;
}

const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

export class PianolaDispatchAdmissionService {
	private readonly queue = createKeyedWriteQueue();
	constructor(private readonly deps: PianolaDispatchAdmissionDeps) {}

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
		const snapshot = await this.deps.readSnapshot();
		caller.assertActive();
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
		if (scope.managerAgentId !== caller.run.agentId) throw new Error('PianolaManagerMismatch');
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
			caller.assertActive();
			if (
				!this.deps.featureEnabled() ||
				canonicalJson(targets) !== canonicalJson(this.deps.store.readSupervisorTargets()) ||
				policy.ruleSetRevision !== this.deps.ruleSetRevision()
			)
				throw new Error('PianolaPolicyChanged');
		};
		return { caller, snapshot, scope, policyFingerprint, guard };
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
			return this.receipt(record);
		});
	}

	private checkPolicy(
		record: PianolaDispatchAdmission,
		auth: Awaited<ReturnType<PianolaDispatchAdmissionService['authorize']>>
	) {
		auth.guard();
		if (auth.scope.id !== record.scopeId || auth.policyFingerprint !== record.policyFingerprint)
			throw new Error('PianolaPolicyChanged');
	}

	release(client: Client, dispatchId: string): Promise<PianolaDispatchReceipt> {
		return this.queue.enqueue('admissions', async () => {
			const record = this.record(client, dispatchId);
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
		callbackId?: string
	) {
		return this.queue.enqueue('admissions', async () => {
			const record = this.record(client, dispatchId);
			if (record.queuePrepare) return this.queueOutcome(record);
			if (
				record.phase !== 'bound' ||
				record.targetTabId !== item.tabId ||
				record.queueItemId !== item.id ||
				item.pendingAdmissionId !== dispatchId
			)
				throw new Error('DispatchTargetMismatch');
			const auth = await this.authorize(client, record.targetAgentId, record.targetTabId);
			this.checkPolicy(record, auth);
			record.queuePrepare = {
				phase: 'unknown',
				item: JSON.parse(canonicalJson(item)),
				...(callbackId ? { callbackId } : {}),
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
