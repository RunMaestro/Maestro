import { readAgentRuns } from '../../cli/services/agent-run-store';
import { nativeTabSession } from './pianola-queue-session';
import { isTerminalAgentRunStatus, type AgentRun } from '../../shared/agent-run';
import { forgetQueueConsultRelease } from './pianola-queue-routing';
import { getDispatchCallbackRegistry, type DispatchCallbackRegistry } from '../dispatch-callbacks';
import { canonicalJson } from '../../shared/canonicalJson';
import { isPianolaScopeId, resolvePianolaScopeOwnership } from '../../shared/pianola/pianola-scope';
/** Native new-tab adapter. A prepared tab cannot spawn before durable enrollment. */
import { createKeyedWriteQueue } from '../../shared/keyedWriteQueue';
import {
	pianolaScopeBindingFingerprint,
	type PianolaScopeSnapshot,
} from '../../shared/pianola/pianola-scope-cycle';
import type { PianolaDispatchReceipt } from '../../shared/pianola/pianola-dispatch';
import type { ExecuteCommandCallback } from '../web-server/types';
import type { NewAITabWithPromptCallback } from '../../shared/pianola/pianola-dispatch';
import {
	PianolaDispatchAdmissionService,
	type PianolaDispatchAdmissionDeps,
} from './pianola-dispatch-admission';

/** Host-only fence, keyed by the actual desktop process address, never caller payload IDs. */
class NewTabSpawnFences {
	private readonly held = new Map<
		string,
		{
			guard?: (boundaryId?: string) => void;
			started?: (runId?: string) => void;
			claimed?: boolean;
			capturedRunId?: string;
			dispatchId?: string;
			queueOnly?: boolean;
			captured?: (runId: string) => void | boolean;
			notStarted?: () => void;
			beforeSpawn?: () => void;
			runUpdated?: (run: AgentRun) => void;
		}
	>();
	// Only confirmed native children retain observers; terminal capture (including
	// supersession) removes them. Neither a wire locator nor restart restores these.
	private readonly running = new Map<string, (run: AgentRun) => void>();
	observeRun(run: AgentRun) {
		const listener = this.running.get(run.id);
		if (!listener) return;
		if (isTerminalAgentRunStatus(run.status)) this.running.delete(run.id);
		listener(run);
	}
	hold(agentId: string, tabId: string) {
		const key = `${agentId}-ai-${tabId}`;
		if (!this.held.has(key)) this.held.set(key, {});
	}
	cancelHold(agentId: string, tabId: string) {
		const key = `${agentId}-ai-${tabId}`;
		if (!this.held.get(key)?.claimed) this.held.delete(key);
	}
	isHeld(agentId: string, tabId: string): boolean {
		return this.held.has(`${agentId}-ai-${tabId}`);
	}
	arm(
		agentId: string,
		tabId: string,
		guard: (boundaryId?: string) => void,
		started: (runId?: string) => void,
		dispatchId?: string,
		lifecycle?: {
			captured(runId: string): void | boolean;
			notStarted(): void;
			queueOnly?: boolean;
			beforeSpawn?(): void;
			runUpdated?(run: AgentRun): void;
		}
	) {
		const entry = this.held.get(`${agentId}-ai-${tabId}`);
		if (!entry) throw new Error('DispatchTargetNotHeld');
		entry.dispatchId = dispatchId;
		entry.queueOnly = lifecycle?.queueOnly;
		entry.captured = lifecycle?.captured;
		entry.notStarted = lifecycle?.notStarted;
		entry.beforeSpawn = lifecycle?.beforeSpawn;
		entry.runUpdated = lifecycle?.runUpdated;
		entry.guard = guard;
		entry.started = started;
	}
	assertReady(processId: string, boundaryId?: string) {
		const entry = this.held.get(processId);
		if (!entry) return;
		if (!entry.guard) throw new Error('DispatchAdmissionPending');
		entry.guard(boundaryId);
	}
	claim(
		processId: string,
		dispatchId?: string,
		queueItemId?: string,
		boundaryId?: string
	): (() => void) & { notStarted(): void } {
		const entry = this.held.get(processId);
		if (!entry) {
			if (dispatchId) throw new Error('DispatchFenceUnavailable');
			return Object.assign(() => {}, { notStarted() {} });
		}
		if (entry.queueOnly && queueItemId !== entry.dispatchId)
			throw new Error('DispatchQueueConsumerRequired');
		if (entry.dispatchId && entry.dispatchId !== dispatchId)
			throw new Error('DispatchIdentityMismatch');
		if (entry.claimed) throw new Error('DispatchAlreadyStarting');
		if (!entry.guard) throw new Error('DispatchAdmissionPending');
		try {
			this.assertReady(processId, boundaryId);
		} catch (error) {
			// An armed dispatch refused before claiming cannot have started.
			if (this.held.get(processId) === entry) {
				this.held.delete(processId);
				entry.notStarted?.();
			}
			throw error;
		}
		entry.claimed = true;
		return Object.assign(
			() => {
				if (this.held.get(processId) !== entry) throw new Error('DispatchTargetUnavailable');
				this.assertReady(processId, boundaryId);
				entry.beforeSpawn?.();
			},
			{
				notStarted: () => {
					// Only the owner of this claim can conclude a proven nonstart.
					if (this.held.get(processId) === entry) {
						this.held.delete(processId);
						entry.notStarted?.();
					}
				},
			}
		);
	}

	captured(processId: string, runId: string, dispatchId?: string, queueItemId?: string) {
		const entry = this.held.get(processId);
		if (
			entry?.claimed &&
			(!entry.capturedRunId || entry.capturedRunId === runId) &&
			(!entry.dispatchId || entry.dispatchId === dispatchId) &&
			(!entry.queueOnly || queueItemId === entry.dispatchId)
		) {
			if (entry.captured?.(runId) === false) return;
			entry.capturedRunId = runId;
			if (entry.runUpdated) this.running.set(runId, entry.runUpdated);
		}
	}

	started(processId: string, runId?: string, dispatchId?: string, queueItemId?: string) {
		const entry = this.held.get(processId);
		if (
			!entry ||
			(entry.dispatchId && entry.dispatchId !== dispatchId) ||
			(entry.queueOnly && queueItemId !== entry.dispatchId)
		)
			return;
		entry.started?.(runId ?? entry.capturedRunId);
		this.held.delete(processId);
		return runId ?? entry.capturedRunId;
	}
}
/** Called synchronously under the existing session write lock, even when the
 * WebServer has not started. A removed durable request cannot be resurrected
 * by a stale renderer row. Native uncertainty is never labelled a nonstart. */
export function cancelPianolaQueueItem(
	store: Pick<
		PianolaDispatchAdmissionDeps['store'],
		'readDispatchAdmission' | 'writeDispatchAdmission'
	>,
	registry: DispatchCallbackRegistry | null | undefined,
	agentId: string,
	tabId: string,
	itemId: string
) {
	if (!isPianolaScopeId(itemId)) return;
	const record = store.readDispatchAdmission(itemId);
	if (
		!record?.queuePrepare ||
		record.targetAgentId !== agentId ||
		record.targetTabId !== tabId ||
		record.runId ||
		record.phase === 'settled'
	)
		return;
	forgetQueueConsultRelease(itemId);
	record.queueCancelled = true;
	if (!record.queueRelease) {
		record.phase = 'settled';
		record.outcome = 'rejected';
	}
	store.writeDispatchAdmission(record);
	const callback = record.queuePrepare.callbackId
		? registry?.get(record.queuePrepare.callbackId)
		: undefined;
	if (
		callback?.pendingAdmissionId === itemId &&
		callback.targetAgentId === agentId &&
		callback.targetTabId === tabId
	)
		registry?.cancel(callback.callbackId);
}

export const pianolaNewTabSpawns = new NewTabSpawnFences();

export interface PianolaExistingTabRequest extends PianolaNewTabRequest {
	targetTabId: string;
	images?: string[];
}

export interface PianolaNewTabRequest {
	dispatchId: string;
	targetAgentId: string;
	prompt: string;
	background: boolean;
	hidden: boolean;
	mentionRouting?: Parameters<NewAITabWithPromptCallback>[4];
}

type Client = { cliAuthenticated?: boolean };
export class PianolaNewTabDispatch {
	readonly admission: PianolaDispatchAdmissionService;
	private readonly queue = createKeyedWriteQueue();
	private readonly requests = new Map<string, PianolaNewTabRequest>();
	private readonly identities = new Map<
		string,
		{ createdAt: number; agentSessionId?: string | null }
	>();
	private readonly startedRuns = new Map<string, string | undefined>();
	private readonly callbacks = new Map<string, string | undefined>();
	constructor(
		private readonly deps: Omit<
			PianolaDispatchAdmissionDeps,
			'readSnapshot' | 'assertTargetReady' | 'release'
		> & {
			snapshot(): PianolaScopeSnapshot;
			newTab: NewAITabWithPromptCallback;
			executeCommand?: ExecuteCommandCallback;
			enqueueCommand?: import('../web-server/types').EnqueueCommandCallback;
			confirmQueueItem?: import('../stores/queue-item-receipt').ConfirmQueueItem;
			queueItem?(
				request: PianolaExistingTabRequest & { held: boolean }
			): Promise<import('../../shared/pianola/pianola-dispatch').PianolaQueueItem>;
			callbackRegistry?: () => DispatchCallbackRegistry | null;
			onReconcileError(error: unknown): void;
		}
	) {
		this.nativeNewTab = deps.newTab;
		this.snapshot = deps.snapshot;
		this.admission = new PianolaDispatchAdmissionService({
			...deps,
			readSnapshot: async () => deps.snapshot(),
			queueSnapshot: () => deps.snapshot(),
			assertTargetReady: (receipt, fingerprint, ownsLocalRun) => {
				const snapshot = deps.snapshot();
				const tab = snapshot.tabs.find(
					(t) => t.agentId === receipt.targetAgentId && t.tabId === receipt.targetTabId
				);
				const targets = deps.store.readSupervisorTargets();
				const scope = targets.find((t) => t.id === receipt.scopeId);
				const scopes = targets
					.filter((t) => t.kind === 'watch-scope' && t.selection && t.managerAgentId)
					.map((t) => ({ ...t, selection: t.selection!, managerAgentId: t.managerAgentId! }));
				const ownership = tab
					? resolvePianolaScopeOwnership(
							tab,
							snapshot.owners,
							scopes,
							targets.filter((t) => t.kind === 'watch')
						)
					: undefined;
				if (
					!snapshot.complete ||
					ownership?.kind !== 'scope' ||
					ownership.scopeId !== receipt.scopeId ||
					!tab ||
					tab.paused ||
					(tab.busy && !ownsLocalRun) ||
					tab.consult ||
					tab.ephemeral ||
					!scope?.selection ||
					!scope.managerAgentId ||
					pianolaScopeBindingFingerprint(
						{ ...scope, selection: scope.selection, managerAgentId: scope.managerAgentId },
						tab.agentId,
						snapshot.owners
					) !== fingerprint
				)
					throw new Error('DispatchTargetUnavailable');
			},
			release: async (receipt, admissionGuard) => {
				const request = this.requests.get(receipt.dispatchId);
				if (!request || !receipt.targetTabId) throw new Error('DispatchIntentUnavailable');
				const identity = this.identities.get(receipt.dispatchId);
				const guard = () => {
					admissionGuard();
					if (identity) {
						const tab = deps
							.snapshot()
							.tabs.find(
								(t) => t.agentId === receipt.targetAgentId && t.tabId === receipt.targetTabId
							);
						if (
							!tab ||
							tab.createdAt !== identity.createdAt ||
							tab.agentSessionId !== identity.agentSessionId
						)
							throw new Error('DispatchTargetIdentityChanged');
					}
				};
				pianolaNewTabSpawns.arm(
					receipt.targetAgentId,
					receipt.targetTabId,
					guard,
					(runId) => {
						this.startedRuns.set(receipt.dispatchId, runId);
						void this.admission
							.reconcile(receipt.dispatchId, 'accepted', runId)
							.catch(deps.onReconcileError);
					},
					request.dispatchId
				);
				guard();
				if ('targetTabId' in request) {
					if (!deps.executeCommand) throw new Error('DispatchTransportUnavailable');
					const accepted = await deps.executeCommand(
						request.targetAgentId,
						request.prompt,
						'ai',
						receipt.targetTabId,
						false,
						(request as PianolaExistingTabRequest).images,
						request.background,
						request.mentionRouting,
						true,
						request.dispatchId
					);
					return this.startedRuns.has(receipt.dispatchId)
						? 'accepted'
						: accepted
							? 'unknown'
							: 'rejected';
				}
				const result = await deps.newTab(
					request.targetAgentId,
					request.prompt,
					request.background,
					request.hidden,
					request.mentionRouting,
					{ phase: 'release', dispatchId: request.dispatchId, tabId: receipt.targetTabId }
				);
				// The renderer event is not proof of a spawn. Only the native spawn hook reconciles accepted.
				if (this.startedRuns.has(receipt.dispatchId)) return 'accepted';
				return result.unknown || result.success ? 'unknown' : 'rejected';
			},
		});
	}

	run(
		client: Client,
		request: PianolaNewTabRequest,
		armCallback: (tabId: string) => string | undefined
	): Promise<{ receipt: PianolaDispatchReceipt; callbackId?: string }> {
		return this.queue.enqueue(request.dispatchId, async () => {
			let receipt = await this.admission.prepare(client, {
				dispatchId: request.dispatchId,
				targetAgentId: request.targetAgentId,
				intent: request,
			});
			if (receipt.outcome !== 'not-started')
				return { receipt, callbackId: this.callbacks.get(request.dispatchId) };
			// Stable host-minted address: a lost prepare acknowledgment cannot create a second tab.
			const tabId = request.dispatchId;
			if (
				!receipt.targetTabId &&
				!pianolaNewTabSpawns.isHeld(request.targetAgentId, tabId) &&
				this.snapshot().tabs.some(
					(tab) => tab.agentId === request.targetAgentId && tab.tabId === tabId
				)
			)
				throw new Error('DispatchPrepareUnknown');

			pianolaNewTabSpawns.hold(request.targetAgentId, tabId);
			// A lost prepare acknowledgment may still have created the empty tab. Keep
			// its fence so only the same host-minted address can be prepared again.
			let prepareUnknown = true;
			try {
				const prepared = await this.newTabPrepare(request, tabId);
				prepareUnknown = !!prepared.unknown;
				if (!prepared.success || prepared.tabId !== tabId)
					throw new Error(prepared.error ?? 'DispatchPrepareUnknown');
				await this.admission.bind(client, request.dispatchId, tabId);
				await this.admission.enroll(client, request.dispatchId);
				if (!this.callbacks.has(request.dispatchId))
					this.callbacks.set(request.dispatchId, armCallback(tabId));
				this.requests.set(request.dispatchId, request);
				// If status itself becomes unavailable after release, preserve uncertainty.
				receipt = { ...receipt, outcome: 'unknown' };
				receipt = await this.admission.release(client, request.dispatchId);
				const runId = this.startedRuns.get(request.dispatchId);
				if (runId) receipt = await this.admission.reconcile(request.dispatchId, 'accepted', runId);
			} catch (error) {
				receipt = this.admission.status(client, request.dispatchId);
				if (receipt.outcome !== 'unknown') throw error;
			} finally {
				this.requests.delete(request.dispatchId);
				this.identities.delete(request.dispatchId);
				if (
					!prepareUnknown &&
					(receipt.outcome === 'not-started' || receipt.outcome === 'rejected')
				)
					pianolaNewTabSpawns.cancelHold(request.targetAgentId, tabId);
			}
			return { receipt, callbackId: this.callbacks.get(request.dispatchId) };
		});
	}

	/** Existing tabs use the same durable journal and native capture fence as new tabs. */
	runExisting(
		client: Client,
		request: PianolaExistingTabRequest,
		armCallback: (tabId: string) => string | undefined
	): Promise<{ receipt: PianolaDispatchReceipt; callbackId?: string }> {
		return this.queue.enqueue(request.dispatchId, async () => {
			let receipt = await this.admission.prepare(client, {
				dispatchId: request.dispatchId,
				targetAgentId: request.targetAgentId,
				intent: request,
			});
			if (receipt.outcome !== 'not-started')
				return { receipt, callbackId: this.callbacks.get(request.dispatchId) };
			if (pianolaNewTabSpawns.isHeld(request.targetAgentId, request.targetTabId))
				throw new Error('DispatchTargetHeld');
			pianolaNewTabSpawns.hold(request.targetAgentId, request.targetTabId);
			try {
				const tab = this.snapshot().tabs.find(
					(t) => t.agentId === request.targetAgentId && t.tabId === request.targetTabId
				);
				if (tab)
					this.identities.set(request.dispatchId, {
						createdAt: tab.createdAt,
						agentSessionId: tab.agentSessionId,
					});
				// No renderer prepare: this exact tab must already exist and have an idle baseline.
				await this.admission.bind(client, request.dispatchId, request.targetTabId);
				await this.admission.enroll(client, request.dispatchId);
				if (!this.callbacks.has(request.dispatchId))
					this.callbacks.set(request.dispatchId, armCallback(request.targetTabId));
				this.requests.set(request.dispatchId, request);
				receipt = await this.admission.release(client, request.dispatchId);
				const runId = this.startedRuns.get(request.dispatchId);
				if (runId) receipt = await this.admission.reconcile(request.dispatchId, 'accepted', runId);
			} catch (error) {
				receipt = this.admission.status(client, request.dispatchId);
				if (receipt.outcome !== 'unknown') throw error;
			} finally {
				this.requests.delete(request.dispatchId);
				this.identities.delete(request.dispatchId);
				if (receipt.outcome === 'not-started' || receipt.outcome === 'rejected')
					pianolaNewTabSpawns.cancelHold(request.targetAgentId, request.targetTabId);
			}
			return { receipt, callbackId: this.callbacks.get(request.dispatchId) };
		});
	}

	/** Prepare only: persist a held queue row, never enroll/release or infer native execution. */
	runQueue(
		client: Client,
		request: PianolaExistingTabRequest & { held: boolean; callbackIntent?: unknown },
		armCallback: (tabId: string) => string | undefined
	): Promise<{ receipt: PianolaDispatchReceipt; callbackId?: string; durable: boolean }> {
		return this.queue.enqueue(request.dispatchId, async () => {
			await this.admission.prepare(client, {
				dispatchId: request.dispatchId,
				targetAgentId: request.targetAgentId,
				intent: request,
			});
			await this.admission.bind(
				client,
				request.dispatchId,
				request.targetTabId,
				request.dispatchId
			);
			let prepared = this.deps.store.readDispatchAdmission(request.dispatchId)?.queuePrepare;
			let outcome: Awaited<ReturnType<PianolaDispatchAdmissionService['prepareQueue']>> | undefined;
			try {
				if (prepared)
					outcome = await this.admission.prepareQueue(client, request.dispatchId, prepared.item);
				if (!prepared) {
					if (!this.deps.queueItem || !this.deps.enqueueCommand || !this.deps.confirmQueueItem)
						throw new Error('DispatchQueueUnavailable');
					const item = await this.deps.queueItem(request);
					const callbackId = armCallback(request.targetTabId);
					outcome = await this.admission.prepareQueue(
						client,
						request.dispatchId,
						item,
						callbackId,
						callbackId ? this.queueCallbackProof(callbackId) : undefined
					);
					prepared = outcome.prepared;
					if (outcome.commitFailed) throw outcome.commitError;
					// The journal commit above forbids ANY subsequent enqueue for this key,
					// including failure/timeout/negative persistence proof and host restart.
					await this.deps
						.enqueueCommand(
							request.targetAgentId,
							request.prompt,
							'ai',
							request.targetTabId,
							request.images,
							request.background,
							request.held,
							request.mentionRouting,
							undefined,
							{ dispatchId: request.dispatchId, item: prepared.item }
						)
						.catch((error) => this.deps.onReconcileError(error));
				}
				const proof = await this.deps.confirmQueueItem?.({
					agentId: request.targetAgentId,
					tabId: request.targetTabId,
					itemId: request.dispatchId,
					pendingAdmissionId: request.dispatchId,
					item: JSON.parse(JSON.stringify(prepared.item)),
				});
				const receipt = await outcome!.recordEvidence(proof?.durable === true);
				return { receipt, callbackId: prepared.callbackId, durable: proof?.durable === true };
			} catch (error) {
				if (!outcome) throw error;
				this.deps.onReconcileError(error);
				// No store read or caller lookup here: either can fail after durable acceptance.
				// Only the pinned receipt is needed to report uncertainty without resending.
				return {
					receipt: { ...outcome.receipt, outcome: 'unknown' },
					callbackId: outcome.prepared.callbackId,
					durable: false,
				};
			}
		});
	}

	cancelQueueItem(agentId: string, tabId: string, itemId: string) {
		cancelPianolaQueueItem(this.deps.store, this.registry(), agentId, tabId, itemId);
	}

	private registry() {
		return this.deps.callbackRegistry?.() ?? getDispatchCallbackRegistry();
	}

	private queueCallbackProof(callbackId: string) {
		const entry = this.registry()?.get(callbackId);
		if (!entry) return undefined;
		const snapshot = this.snapshot();
		const owner = snapshot.owners.find((o) => o.id === entry.callerAgentId);
		const tab = entry.callerTabId
			? snapshot.tabs.find(
					(t) => t.agentId === entry.callerAgentId && t.tabId === entry.callerTabId
				)
			: undefined;
		if (!snapshot.complete || !owner || (entry.callerTabId && !tab))
			throw new Error('DispatchCallbackOwnerUnavailable');
		return {
			registration: {
				targetAgentId: entry.targetAgentId,
				targetTabId: entry.targetTabId,
				callerAgentId: entry.callerAgentId,
				callerTabId: entry.callerTabId,
				callbackPrompt: entry.callbackPrompt,
				timeoutMs: entry.timeoutMs,
				prompt: entry.prompt,
				pendingAdmissionId: entry.pendingAdmissionId,
			},
			expiresAt: entry.expiresAt,
			owner,
			...(tab
				? { callerTab: { createdAt: tab.createdAt, agentSessionId: tab.agentSessionId } }
				: {}),
		};
	}

	/** This host capability is called only from the owning desktop spawn IPC.
	 * There is no wire journal adoption or renderer release acknowledgment. */
	prepareQueueSpawn(agentId: string, tabId: string, itemId: string, assertOwner: () => void) {
		return this.queue.enqueue(itemId, async () => {
			assertOwner();
			const record = this.deps.store.readDispatchAdmission(itemId);
			if (
				!record?.queuePrepare ||
				record.targetAgentId !== agentId ||
				record.targetTabId !== tabId ||
				record.queueItemId !== itemId
			)
				throw new Error('DispatchTargetMismatch');
			if (record.outcome === 'accepted' && record.runId)
				return { reconciled: true as const, runId: record.runId };
			if (record.queueCancelled) throw new Error('DispatchQueueCancelled');
			if (record.outcome === 'rejected') throw new Error('DispatchQueueNotStarted');
			const delayedLocal = record.queueRouting?.routing === 'consult-first';
			if (
				delayedLocal
					? record.phase !== 'released' || !record.queueRelease
					: record.phase !== 'bound' || record.queueRelease
			)
				throw new Error('DispatchQueueReleaseUncertain');
			if (!record.queueAuthority || Date.now() >= record.queueAuthority.expiresAt)
				throw new Error('DispatchQueueAuthorityUnavailable');
			const local = record.queueRouting?.steps.find((s) => s.kind === 'local');
			if (
				record.queueRouting &&
				(!local ||
					!['parallel', 'handoff', 'consult-first'].includes(record.queueRouting.routing) ||
					local.status !== 'prepared')
			)
				throw new Error('DispatchQueueLocalUnavailable');
			let callbackId = record.queuePrepare.callbackId;
			const registry = this.registry();
			const callbackGuard = () => {
				if (!callbackId) return;
				const proof = record.queuePrepare!.callbackProof;
				const entry = registry?.get(callbackId);
				const snapshot = this.snapshot();
				const owner = snapshot.owners.find((o) => o.id === proof?.registration.callerAgentId);
				const tab = snapshot.tabs.find(
					(t) =>
						t.agentId === proof?.registration.callerAgentId &&
						t.tabId === proof?.registration.callerTabId
				);
				if (
					!proof ||
					!snapshot.complete ||
					!owner ||
					canonicalJson(owner) !== canonicalJson(proof.owner) ||
					(proof.registration.callerTabId &&
						(!tab ||
							tab.createdAt !== proof.callerTab?.createdAt ||
							tab.agentSessionId !== proof.callerTab?.agentSessionId)) ||
					proof.registration.targetAgentId !== agentId ||
					proof.registration.targetTabId !== tabId ||
					proof.registration.pendingAdmissionId !== itemId ||
					Date.now() >= proof.expiresAt ||
					!entry ||
					entry.state !== 'pending' ||
					entry.pendingAdmissionId !== itemId ||
					canonicalJson({
						targetAgentId: entry.targetAgentId,
						targetTabId: entry.targetTabId,
						callerAgentId: entry.callerAgentId,
						callerTabId: entry.callerTabId,
						callbackPrompt: entry.callbackPrompt,
						timeoutMs: proof.registration.timeoutMs,
						prompt: entry.prompt,
						pendingAdmissionId: entry.pendingAdmissionId,
					}) !== canonicalJson(proof.registration)
				)
					throw new Error('DispatchCallbackReconstructionUnavailable');
			};
			if (callbackId && !registry?.get(callbackId)) {
				const proof = record.queuePrepare.callbackProof;
				if (!registry || !proof || Date.now() >= proof.expiresAt)
					throw new Error('DispatchCallbackReconstructionUnavailable');
				// Only the persisted, authenticated intent may reconstruct this callback.
				// Validate the caller identity before registering anything.
				const snapshot = this.snapshot();
				const owner = snapshot.owners.find((o) => o.id === proof.registration.callerAgentId);
				const tab = snapshot.tabs.find(
					(t) =>
						t.agentId === proof.registration.callerAgentId &&
						t.tabId === proof.registration.callerTabId
				);
				if (
					!snapshot.complete ||
					!owner ||
					canonicalJson(owner) !== canonicalJson(proof.owner) ||
					(proof.registration.callerTabId &&
						(!tab ||
							tab.createdAt !== proof.callerTab?.createdAt ||
							tab.agentSessionId !== proof.callerTab?.agentSessionId)) ||
					proof.registration.targetAgentId !== agentId ||
					proof.registration.targetTabId !== tabId ||
					proof.registration.pendingAdmissionId !== itemId ||
					registry.hasArmedFor(agentId, tabId)
				)
					throw new Error('DispatchCallbackReconstructionUnavailable');
				callbackId = registry.register({
					...proof.registration,
					timeoutMs: proof.expiresAt - Date.now(),
				}).callbackId;
				record.queuePrepare.callbackId = callbackId;
				this.deps.store.writeDispatchAdmission(record);
			}
			callbackGuard();
			// Do not hold a busy predecessor. Only D01 can establish FIFO/idle eligibility.
			const released = delayedLocal
				? this.admission.queueLocalRelease(itemId)
				: await this.admission.releaseQueue(itemId);
			assertOwner();
			callbackGuard();
			if (pianolaNewTabSpawns.isHeld(agentId, tabId)) throw new Error('DispatchTargetHeld');
			pianolaNewTabSpawns.hold(agentId, tabId);
			const guard = () => {
				const current = this.deps.store.readDispatchAdmission(itemId);
				if (
					current?.queueCancelled ||
					current?.phase !== 'released' ||
					current.queueRelease?.generation !== released.generation
				)
					throw new Error('DispatchQueueCancelledOrChanged');
				assertOwner();
				callbackGuard();
				released.guard();
			};
			const nativeRuns = this.deps.readNativeRuns ?? readAgentRuns;
			const nativeFrontier = new Set(
				local
					? nativeRuns()
							.filter((run) => run.sessionId === `${agentId}-ai-${tabId}`)
							.map((run) => run.id)
					: []
			);
			const releasedSession = this.snapshot().tabs.find(
				(t) => t.agentId === agentId && t.tabId === tabId
			)?.agentSessionId;
			let capturedRunId: string | undefined;
			let nativeLocalBound = false;
			let uncertain = false;
			const updateLocal = (
				mutate: (step: NonNullable<typeof local>, current: NonNullable<typeof record>) => void
			) => {
				const current = this.deps.store.readDispatchAdmission(itemId);
				const step = current?.queueRouting?.steps.find(
					(s) => s.kind === 'local' && s.requestId === local?.requestId
				);
				if (
					!current ||
					!step ||
					current.queueRelease?.generation !== released.generation ||
					current.intentFingerprint !== record.intentFingerprint
				)
					throw new Error('DispatchRoutingStepChanged');
				mutate(step, current);
				this.deps.store.writeDispatchAdmission(current);
			};
			const observeLocal = (run: AgentRun) => {
				if (!local || uncertain) return;
				try {
					const identity = nativeTabSession(run);
					if (
						run.id !== capturedRunId ||
						nativeFrontier.has(run.id) ||
						(identity?.initialSessionId ?? undefined) !== (releasedSession ?? undefined) ||
						!identity ||
						identity.conflicted ||
						identity.agentId !== agentId ||
						identity.tabId !== tabId ||
						identity.createdAt !== record.queueAuthority!.createdAt
					)
						throw new Error('DispatchRoutingCaptureMismatch');
					updateLocal((step, current) => {
						if (step.terminal) return;
						step.runId = run.id;
						step.processId = run.sessionId;
						step.status = isTerminalAgentRunStatus(run.status) ? 'settled' : 'started';
						if (identity.announcedSessionId) step.agentSessionId = identity.announcedSessionId;
						current.runId = run.id;
						current.outcome = 'accepted';
						current.phase = 'settled';
						if (isTerminalAgentRunStatus(run.status))
							step.terminal = {
								text: typeof run.metadata?.answerTail === 'string' ? run.metadata.answerTail : '',
								...(run.status !== 'completed' ? { error: `Native local run ${run.status}` } : {}),
								...(run.status === 'cancelled' ? { canceled: true } : {}),
							};
					});
					if (!nativeLocalBound) {
						this.admission.noteQueueLocalCapture(itemId, released.generation, run.id);
						nativeLocalBound = true;
					}
				} catch (error) {
					uncertain = true;
					forgetQueueConsultRelease(itemId);
					this.deps.onReconcileError(error);
					try {
						updateLocal((step, current) => {
							if (step.terminal) return;
							step.status = 'unknown';
							step.startError = 'DispatchRoutingJournalUnknown';
							current.outcome = 'unknown';
						});
					} catch (commitError) {
						this.deps.onReconcileError(commitError);
					}
				}
			};
			if (local) {
				try {
					updateLocal((step) => {
						step.status = 'intent';
					});
				} catch (error) {
					pianolaNewTabSpawns.cancelHold(agentId, tabId);
					throw error;
				}
			}
			pianolaNewTabSpawns.arm(
				agentId,
				tabId,
				guard,
				(runId) => {
					if (runId && !local)
						void this.admission
							.reconcile(itemId, 'accepted', runId)
							.catch(this.deps.onReconcileError);
				},
				itemId,
				{
					queueOnly: true,
					beforeSpawn: local
						? () => {
								guard();
								updateLocal((step) => {
									if (step.status !== 'intent') throw new Error('DispatchRoutingAlreadyStarting');
									step.status = 'unknown';
								});
								guard();
							}
						: undefined,
					runUpdated: local ? observeLocal : undefined,
					captured: (runId) => {
						if (local) {
							capturedRunId = runId;
							const run = nativeRuns().find((r) => r.id === runId);
							if (run) observeLocal(run);
							else {
								uncertain = true;
								this.deps.onReconcileError(new Error('DispatchRoutingCaptureUnavailable'));
							}
						}
						if (callbackId && !local) {
							registry!.releaseQueueAdmission(callbackId, itemId);
							registry!.noteSpawn(`${agentId}-ai-${tabId}`);
						}
						return !uncertain;
					},
					notStarted: () => {
						if (callbackId) registry?.cancel(callbackId);
						void this.admission.reconcile(itemId, 'rejected').catch(this.deps.onReconcileError);
					},
				}
			);
			return { reconciled: false as const, generation: released.generation };
		});
	}

	private newTabPrepare = (request: PianolaNewTabRequest, tabId: string) =>
		this.nativeNewTab(
			request.targetAgentId,
			'',
			request.background,
			request.hidden,
			request.mentionRouting,
			{ phase: 'prepare', dispatchId: request.dispatchId, tabId }
		);
	private readonly nativeNewTab: NewAITabWithPromptCallback;
	private readonly snapshot: () => PianolaScopeSnapshot;
}
