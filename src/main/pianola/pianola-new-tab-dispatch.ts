import { resolvePianolaScopeOwnership } from '../../shared/pianola/pianola-scope';
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
			guard?: () => void;
			started?: (runId?: string) => void;
			claimed?: boolean;
			capturedRunId?: string;
			dispatchId?: string;
		}
	>();
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
		guard: () => void,
		started: (runId?: string) => void,
		dispatchId?: string
	) {
		const entry = this.held.get(`${agentId}-ai-${tabId}`);
		if (!entry) throw new Error('DispatchTargetNotHeld');
		entry.dispatchId = dispatchId;
		entry.guard = guard;
		entry.started = started;
	}
	assertReady(processId: string) {
		const entry = this.held.get(processId);
		if (!entry) return;
		if (!entry.guard) throw new Error('DispatchAdmissionPending');
		entry.guard();
	}
	claim(processId: string, dispatchId?: string): (() => void) & { notStarted(): void } {
		const entry = this.held.get(processId);
		if (!entry) {
			if (dispatchId) throw new Error('DispatchFenceUnavailable');
			return Object.assign(() => {}, { notStarted() {} });
		}
		if (entry.dispatchId && entry.dispatchId !== dispatchId)
			throw new Error('DispatchIdentityMismatch');
		if (entry.claimed) throw new Error('DispatchAlreadyStarting');
		if (!entry.guard) throw new Error('DispatchAdmissionPending');
		try {
			this.assertReady(processId);
		} catch (error) {
			// An armed dispatch refused before claiming cannot have started.
			if (this.held.get(processId) === entry) this.held.delete(processId);
			throw error;
		}
		entry.claimed = true;
		return Object.assign(
			() => {
				if (this.held.get(processId) !== entry) throw new Error('DispatchTargetUnavailable');
				this.assertReady(processId);
			},
			{
				notStarted: () => {
					// Only the owner of this claim can conclude a proven nonstart.
					if (this.held.get(processId) === entry) this.held.delete(processId);
				},
			}
		);
	}

	captured(processId: string, runId: string) {
		const entry = this.held.get(processId);
		if (entry?.claimed) entry.capturedRunId = runId;
	}

	started(processId: string, runId?: string) {
		const entry = this.held.get(processId);
		if (!entry) return;
		entry.started?.(runId ?? entry.capturedRunId);
		this.held.delete(processId);
	}
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
			onReconcileError(error: unknown): void;
		}
	) {
		this.nativeNewTab = deps.newTab;
		this.snapshot = deps.snapshot;
		this.admission = new PianolaDispatchAdmissionService({
			...deps,
			readSnapshot: async () => deps.snapshot(),
			queueSnapshot: () => deps.snapshot(),
			assertTargetReady: (receipt, fingerprint) => {
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
					tab.busy ||
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
					outcome = await this.admission.prepareQueue(client, request.dispatchId, item, callbackId);
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
