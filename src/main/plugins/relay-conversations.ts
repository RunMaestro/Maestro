import { createHash } from 'node:crypto';
import { canonicalJson } from '../../shared/canonicalJson';
import { createKeyedWriteQueue } from '../../shared/keyedWriteQueue';
import { generateUUID } from '../../shared/uuid';
import type { RelayConversationState } from '../../shared/relayConversation';
import {
	buildTabRecord,
	DEFAULT_RULE_CONTEXT,
	DEFAULT_TAB_DEFAULTS,
} from '../../shared/maestro-lib/agents/rules';
import type { StoredSession } from '../stores/types';
import type { HeadlessAgentRunner } from './plugin-manager-singleton';
import { RelayLedger, type RelayLedgerLimits } from './relay-ledger';
import type { AnchorStore } from '../utils/keyring-anchor';
import { RelayLedgerClient } from './relay-ledger-client';
import {
	acquireProviderSessionWriter,
	hasProviderSessionWriter,
} from '../utils/provider-session-writer';

interface LiveRelayTurn {
	controller: AbortController;
	sessionId: string;
	toolType: string;
	cwd: string;
	startTime: number;
}
const liveRelayTurns = new Map<string, LiveRelayTurn>();

/** Host-owned turns, including writer waits, for the existing live-process query. */
export function getLiveRelayConversationTurns() {
	return [...liveRelayTurns.values()].map(({ controller: _controller, ...turn }) => ({
		...turn,
		// These runners are cancelled by session identity, not by an exposed OS PID.
		pid: 0,
		isTerminal: false,
		isBatchMode: false,
	}));
}

/** The real tab's Stop button cancels the host-owned process through its existing signal. */
export function cancelRelayConversationTurn(processId: string): boolean {
	const turn = liveRelayTurns.get(processId);
	if (!turn) return false;
	turn.controller.abort();
	return true;
}

export interface RelaySendOptions {
	conversationId: string;
	messageId: string;
	sessionId?: string;
	originalAttachments?: readonly [import('../../shared/plugins/media-tools').OriginalAttachmentRef];
}
type SendResult = Awaited<ReturnType<HeadlessAgentRunner>> & {
	conversationId?: string;
	tabId?: string;
	replayed?: boolean;
};
interface Mapping {
	agentId: string;
	conversationId: string;
	tabId: string;
	providerSessionId?: string;
	interrupted?: boolean;
	pendingReceiptKey?: string;
	/** False until the first tab materialization succeeds; absent on legacy completed restores. */
	materialized?: boolean;
}
interface Receipt {
	promptHash: string;
	messageId: string;
	result?: SendResult;
}
interface RelayTab {
	id: string;
	agentSessionId?: string | null;
	logs: Array<{ id: string; timestamp: number; source: string; text: string }>;
	relayConversation?: RelayConversationState;
	[key: string]: any;
}
export interface RelayConversationDeps {
	baseDir: string;
	receiptAnchor?: AnchorStore;
	receiptLimits?: Partial<RelayLedgerLimits>;
	getAgent(agentId: string): StoredSession | undefined;
	/** Synchronous read-modify-write, shared with the host's sessions store and lifecycle broadcast. */
	updateAgent(agentId: string, update: (agent: StoredSession) => StoredSession): void;
	run: HeadlessAgentRunner;
	loadTranscript?: (agentId: string, providerSessionId: string) => Promise<RelayTab['logs']>;
	now?: () => number;
	flush?: () => Promise<void>;
}

/** Private, durable Relay identity and idempotency ledger. Never exposed as plugin KV.
 * The sessions store owns transcripts/drafts; this ledger owns identity and execution receipts.
 * An interrupted receipt fails closed on retry: tool work might already have happened.
 */
export class RelayConversations {
	private readonly store: RelayLedger | RelayLedgerClient;
	private readonly queue = createKeyedWriteQueue();
	private readonly pending = new Map<string, number>();
	private generation = 0;
	private purging?: Promise<void>;
	private purgeFailed = false;
	private readonly controllers = new Set<AbortController>();
	private readonly now: () => number;
	constructor(private readonly deps: RelayConversationDeps) {
		this.store = deps.receiptAnchor
			? new RelayLedger(deps.baseDir, deps.receiptAnchor, deps.receiptLimits)
			: new RelayLedgerClient(deps.baseDir, deps.receiptLimits);
		this.now = deps.now ?? Date.now;
	}
	/** Uninstall removes only plugin-private identity/receipts, preserving user transcripts. */
	purge(): Promise<void> {
		if (this.purging) return this.purging;
		this.purging = this.performPurge().then(
			() => {
				this.purging = undefined;
				this.purgeFailed = false;
			},
			(error) => {
				this.purging = undefined;
				this.purgeFailed = true;
				throw error;
			}
		);
		return this.purging;
	}
	private assertAdmission(): void {
		if (this.purging || this.purgeFailed)
			throw Error('Relay cleanup pending or failed; admission denied');
	}
	private async performPurge(): Promise<void> {
		this.generation++;
		for (const controller of this.controllers) controller.abort();
		for (const key of await this.store.mappingKeys()) {
			const mapping = await this.read<Mapping>(key);
			if (!mapping?.tabId || !mapping.agentId) continue;
			if (mapping.pendingReceiptKey)
				await this.store.settleTurn(mapping.pendingReceiptKey, mapping.providerSessionId);
			const tab = (this.deps.getAgent(mapping.agentId)?.aiTabs as RelayTab[] | undefined)?.find(
				(tab) => tab.id === mapping.tabId
			);
			if (
				tab?.relayConversation?.status === 'queued' ||
				tab?.relayConversation?.status === 'running'
			)
				await this.patch(
					mapping,
					{},
					{
						status: 'error',
						completedAt: undefined,
						error: 'Relay was uninstalled during this turn',
					}
				);
		}
		for (const controller of this.controllers) controller.abort();
		await this.store.purgeMappings();
	}
	private assertGeneration(generation: number): void {
		if (generation !== this.generation) throw new Error('Relay conversation ledger was purged');
	}
	private key(...parts: string[]): string {
		return createHash('sha256').update(canonicalJson(parts)).digest('hex');
	}
	private async read<T>(key: string): Promise<T | undefined> {
		const generation = this.generation;
		const value = await this.store.get(key);
		this.assertGeneration(generation);
		return value ? (JSON.parse(value) as T) : undefined;
	}
	private async write(key: string, value: unknown): Promise<void> {
		const generation = this.generation;
		await this.store.set(key, JSON.stringify(value));
		this.assertGeneration(generation);
	}
	private async mapping(
		agentId: string,
		opts: RelaySendOptions,
		authorize: () => void = () => {}
	): Promise<Mapping> {
		const generation = this.generation;
		const key = this.key('conversation', agentId, opts.conversationId);
		const existing = await this.read<Mapping>(key);
		if (existing?.interrupted)
			throw new Error(
				'Previous Relay execution is uncertain; inspect the provider session before continuing'
			);
		if (existing) return existing;
		const agent = this.deps.getAgent(agentId);
		if (!agent) throw new Error('Relay agent not found');
		const tabs = (agent.aiTabs ?? []) as RelayTab[];
		if (
			!opts.sessionId &&
			tabs.some((tab) => tab.relayConversation?.conversationId === opts.conversationId)
		)
			throw new Error(
				'Relay conversation ownership was removed; use an explicitly authorized provider binding'
			);
		const matches = opts.sessionId ? tabs.filter((t) => t.agentSessionId === opts.sessionId) : [];
		if (matches.length > 1) throw new Error('Ambiguous Relay provider/tab mapping');
		if (
			matches[0]?.relayConversation &&
			matches[0].relayConversation.conversationId !== opts.conversationId
		)
			throw new Error('Provider session already maps to another Relay conversation');
		// A deterministic authenticated binding survives closure and payload eviction.
		if (opts.sessionId)
			await this.store.assertProviderAvailable(agentId, opts.sessionId, opts.conversationId);
		const mapping: Mapping = {
			agentId,
			conversationId: opts.conversationId,
			tabId: matches[0]?.id ?? generateUUID(),
			providerSessionId: opts.sessionId,
			materialized: false,
		};
		this.assertGeneration(generation);
		authorize();
		await this.write(key, mapping);
		return mapping;
	}
	private async patch(
		mapping: Mapping,
		patch: Partial<RelayTab>,
		relay: Partial<RelayConversationState>,
		log?: RelayTab['logs'][number],
		persistMovement = true
	): Promise<void> {
		let moved = false;
		this.deps.updateAgent(mapping.agentId, (agent) => {
			const tabs = (agent.aiTabs ?? []) as RelayTab[];
			// History's resume path may have reopened the same provider after the tab was closed.
			const current =
				tabs.find((t) => t.id === mapping.tabId) ??
				(mapping.providerSessionId
					? tabs.find((t) => t.agentSessionId === mapping.providerSessionId)
					: undefined);
			if (current && current.id !== mapping.tabId) {
				mapping.tabId = current.id;
				moved = true;
			}
			const fresh = buildTabRecord(
				{ ...DEFAULT_RULE_CONTEXT, newId: () => mapping.tabId, now: this.now },
				DEFAULT_TAB_DEFAULTS
			);
			const tab = {
				...fresh,
				...current,
				origin: 'relay',
				...patch,
				agentSessionId: mapping.providerSessionId ?? current?.agentSessionId ?? null,
				relayConversation: {
					conversationId: mapping.conversationId,
					status: 'idle',
					lastActivityAt: this.now(),
					...current?.relayConversation,
					...relay,
				},
				logs: patch.logs ?? current?.logs ?? [],
			} as RelayTab;
			if (log && !tab.logs.some((row) => row.id === log.id)) tab.logs = [...tab.logs, log];
			return {
				...agent,
				aiTabs: current ? tabs.map((t) => (t.id === current.id ? tab : t)) : [...tabs, tab],
				unifiedTabOrder: (agent.unifiedTabOrder ?? []).some(
					(ref: { type: string; id: string }) => ref.type === 'ai' && ref.id === tab.id
				)
					? agent.unifiedTabOrder
					: [...(agent.unifiedTabOrder ?? []), { type: 'ai', id: tab.id }],
			};
		});
		if (moved && persistMovement)
			await this.write(this.key('conversation', mapping.agentId, mapping.conversationId), mapping);
	}
	private async flushMapping(mapping: Mapping, generation: number): Promise<void> {
		await this.deps.flush?.();
		this.assertGeneration(generation);
		if (mapping.materialized === false) {
			mapping.materialized = true;
			await this.write(this.key('conversation', mapping.agentId, mapping.conversationId), mapping);
		}
	}
	async send(
		agentId: string,
		prompt: string,
		opts: RelaySendOptions,
		signal: AbortSignal,
		onProgress: Parameters<HeadlessAgentRunner>[5],
		authorize: () => void,
		run: HeadlessAgentRunner = this.deps.run
	): Promise<SendResult> {
		opts = {
			...opts,
			...(opts.originalAttachments
				? {
						originalAttachments: [{ ...opts.originalAttachments[0] }] as const,
					}
				: {}),
		};
		this.assertAdmission();
		const generation = this.generation;
		const conversationKey = this.key('conversation', agentId, opts.conversationId);
		this.pending.set(conversationKey, (this.pending.get(conversationKey) ?? 0) + 1);
		try {
			return await this.queue.enqueue(conversationKey, async () => {
				this.assertGeneration(generation);
				authorize();
				if (signal.aborted) throw new Error('Relay send cancelled');
				const receiptKey = this.key('message', agentId, opts.conversationId, opts.messageId);
				const hash = opts.originalAttachments
					? this.key(
							'relay-original-attachments-v1',
							canonicalJson({ prompt, originalAttachments: opts.originalAttachments })
						)
					: this.key(prompt);
				const previous = await this.read<Receipt>(receiptKey);
				authorize();
				if (signal.aborted) throw Error('Relay send cancelled');
				if (previous) {
					if (previous.promptHash !== hash)
						throw new Error('Relay messageId reused with different content');
					return {
						...(previous.result ?? {
							success: false,
							response: null,
							sessionId: null,
							error: 'Previous Relay execution interrupted; inspect conversation before retrying',
						}),
						replayed: true,
					};
				}
				this.assertGeneration(generation);
				const mapping = await this.mapping(agentId, opts, authorize);
				authorize();
				if (signal.aborted) throw Error('Relay send cancelled');
				const tab = (this.deps.getAgent(agentId)?.aiTabs as RelayTab[] | undefined)?.find(
					(t) => t.id === mapping.tabId
				);
				if (!tab && mapping.providerSessionId && this.deps.loadTranscript) {
					const logs = await this.deps.loadTranscript(agentId, mapping.providerSessionId);
					this.assertGeneration(generation);
					await this.patch(mapping, { logs }, {});
				}
				// Desktop continuation may have updated the provider id; the live tab is authoritative.
				mapping.providerSessionId = tab?.agentSessionId ?? mapping.providerSessionId;
				const agent = this.deps.getAgent(agentId)!;
				const controller = new AbortController();
				const abort = () => controller.abort();
				signal.addEventListener('abort', abort, { once: true });
				if (signal.aborted) controller.abort();
				const processId = `${agentId}-ai-${mapping.tabId}`;
				const liveTurn: LiveRelayTurn = {
					controller,
					sessionId: processId,
					toolType: agent.toolType,
					cwd: agent.cwd,
					startTime: this.now(),
				};
				liveRelayTurns.set(processId, liveTurn);
				this.controllers.add(controller);
				let release = () => {};
				let runnerInvoked = false;
				try {
					mapping.pendingReceiptKey = receiptKey;
					await this.store.reserveTurn(
						receiptKey,
						JSON.stringify({ promptHash: hash, messageId: opts.messageId } satisfies Receipt),
						conversationKey,
						JSON.stringify(mapping)
					);
					this.assertGeneration(generation);
					await this.patch(
						mapping,
						{ hidden: false, hasUnread: true },
						{
							messageId: opts.messageId,
							status: 'queued',
							completedAt: undefined,
							archivedAt: undefined,
							error: undefined,
							lastActivityAt: this.now(),
						},
						{ id: `${receiptKey}:user`, timestamp: this.now(), source: 'user', text: prompt }
					);
					await this.flushMapping(mapping, generation);
					const resolveCurrentSessionId = () => {
						const latest = this.deps.getAgent(agentId);
						if (!latest || latest.toolType !== agent.toolType)
							throw new Error('Relay provider changed while waiting');
						return (
							(latest.aiTabs as RelayTab[] | undefined)?.find((tab) => tab.id === mapping.tabId)
								?.agentSessionId ?? mapping.providerSessionId
						);
					};
					let requestedId = mapping.providerSessionId;
					for (;;) {
						let protectedId = requestedId;
						release = await acquireProviderSessionWriter(
							agent.toolType,
							processId,
							requestedId,
							controller.signal,
							() => (protectedId = resolveCurrentSessionId())
						);
						authorize();
						if (controller.signal.aborted) throw new Error('Relay send cancelled');
						const currentId = resolveCurrentSessionId();
						if ((currentId ?? undefined) === (protectedId ?? undefined)) {
							mapping.providerSessionId = protectedId;
							break;
						}
						// Release all stale keys before reacquiring in the writer's canonical order.
						release();
						requestedId = currentId;
					}
					mapping.interrupted = true;
					await this.write(conversationKey, mapping);
					await this.patch(mapping, {}, { status: 'running' });
					authorize();
					this.assertGeneration(generation);
					if (controller.signal.aborted) throw new Error('Relay send cancelled');
					runnerInvoked = true;
					const result = await run(
						agentId,
						prompt,
						mapping.providerSessionId,
						controller.signal,
						'relay',
						onProgress,
						undefined,
						false,
						true
					);
					this.assertGeneration(generation);
					if (result.sessionId) mapping.providerSessionId = result.sessionId;
					if (mapping.providerSessionId || result.executionStarted === false)
						mapping.interrupted = false;
					const returned: SendResult = {
						...result,
						conversationId: opts.conversationId,
						tabId: mapping.tabId,
					};
					await this.patch(
						mapping,
						{ hasUnread: true },
						{
							status: result.success ? 'idle' : 'error',
							lastActivityAt: this.now(),
							error: result.error,
						},
						{
							id: `${receiptKey}:answer`,
							timestamp: this.now(),
							source: result.success ? 'stdout' : 'error',
							text: result.response ?? result.error ?? 'Relay run failed',
						},
						false
					);
					// Keep the complete answer in durable user history before ownership/cache writes.
					await this.deps.flush?.();
					this.assertGeneration(generation);
					// Persist outcome before releasing it. A replay never runs the provider again.
					returned.tabId = mapping.tabId;
					await this.store.finishTurn(
						receiptKey,
						JSON.stringify({
							promptHash: hash,
							messageId: opts.messageId,
							result: returned,
						} satisfies Receipt),
						conversationKey,
						JSON.stringify(mapping)
					);
					this.assertGeneration(generation);
					authorize();
					return returned;
				} catch (error) {
					if (generation === this.generation && !runnerInvoked) {
						// No provider call occurred. Keep retries possible; uncertain runs retain receipts.
						await this.store.deletePending(receiptKey);
						delete mapping.pendingReceiptKey;
						mapping.interrupted = false;
						await this.write(conversationKey, mapping);
					}
					if (generation === this.generation && runnerInvoked)
						await this.store.settleTurn(receiptKey, mapping.providerSessionId);
					if (generation === this.generation)
						await this.patch(
							mapping,
							{},
							{ status: 'error', error: String(error), lastActivityAt: this.now() }
						);
					throw error;
				} finally {
					this.controllers.delete(controller);
					signal.removeEventListener('abort', abort);
					if (liveRelayTurns.get(processId) === liveTurn) liveRelayTurns.delete(processId);
					release();
				}
			});
		} finally {
			const remaining = (this.pending.get(conversationKey) ?? 1) - 1;
			if (remaining) this.pending.set(conversationKey, remaining);
			else this.pending.delete(conversationKey);
		}
	}
	/** Adopt only a plugin's explicitly identified real thread, without starting a turn.
	 * Existing archived tabs stay archived; an intentional manual close is also kept.
	 */
	async restore(
		agentId: string,
		conversationId: string,
		providerSessionId: string,
		authorize: () => void = () => {}
	): Promise<SendResult> {
		this.assertAdmission();
		const generation = this.generation;
		const key = this.key('conversation', agentId, conversationId);
		return this.queue.enqueue(key, async () => {
			this.assertGeneration(generation);
			authorize();
			const known = await this.read<Mapping>(key);
			this.assertGeneration(generation);
			const mapping = await this.mapping(
				agentId,
				{
					conversationId,
					messageId: '',
					sessionId: providerSessionId,
				},
				authorize
			);
			this.assertGeneration(generation);
			authorize();
			const tab = (this.deps.getAgent(agentId)?.aiTabs as RelayTab[] | undefined)?.find(
				(t) => t.id === mapping.tabId
			);
			if ((!known || mapping.materialized === false) && !tab) {
				const logs = (await this.deps.loadTranscript?.(agentId, providerSessionId)) ?? [];
				this.assertGeneration(generation);
				authorize();
				await this.patch(mapping, { logs }, {});
			} else if ((!known || mapping.materialized === false) && tab)
				await this.patch(mapping, {}, {});
			authorize();
			await this.flushMapping(mapping, generation);
			authorize();
			return {
				success: true,
				response: null,
				sessionId: mapping.providerSessionId ?? null,
				tabId: mapping.tabId,
				conversationId,
			};
		});
	}
	async complete(
		agentId: string,
		conversationId: string,
		messageId: string,
		authorize: () => void = () => {}
	): Promise<void> {
		this.assertAdmission();
		const generation = this.generation;
		const key = this.key('conversation', agentId, conversationId);
		if (this.pending.has(key)) throw new Error('Relay conversation has pending messages');
		const mapping = await this.read<Mapping>(key);
		const receipt = await this.read<Receipt>(
			this.key('message', agentId, conversationId, messageId)
		);
		this.assertGeneration(generation);
		const agent = this.deps.getAgent(agentId);
		const tab = (agent?.aiTabs as RelayTab[] | undefined)?.find((t) => t.id === mapping?.tabId);
		if (
			this.pending.has(key) ||
			!mapping ||
			!tab ||
			!receipt?.result?.success ||
			hasProviderSessionWriter(
				agent!.toolType,
				`${agentId}-ai-${tab.id}`,
				mapping.providerSessionId
			) ||
			tab.logs.at(-1)?.id !== `${this.key('message', agentId, conversationId, messageId)}:answer` ||
			tab.relayConversation?.messageId !== messageId ||
			tab.relayConversation.status !== 'idle' ||
			tab.state === 'busy' ||
			agent?.executionQueue?.some(
				(item: { tabId?: string }) => !item.tabId || item.tabId === tab.id
			)
		)
			throw new Error('Relay completion is stale or the conversation has unfinished work');
		authorize();
		if (!tab.relayConversation.completedAt)
			await this.patch(mapping, {}, { completedAt: this.now() });
		await this.deps.flush?.();
		authorize();
	}
	/** Host restart cannot turn an unfinished provider run into a completed task. */
	async reconcileInterrupted(): Promise<void> {
		this.assertAdmission();
		for (const key of await this.store.mappingKeys()) {
			const mapping = await this.read<Mapping>(key);
			if (!mapping?.tabId || !mapping.agentId || !mapping.conversationId) continue;
			if (liveRelayTurns.has(`${mapping.agentId}-ai-${mapping.tabId}`)) continue;
			if (mapping.pendingReceiptKey) {
				await this.store.settleTurn(mapping.pendingReceiptKey, mapping.providerSessionId);
				mapping.interrupted = true;
				await this.write(key, mapping);
			}
			const tab = (this.deps.getAgent(mapping.agentId)?.aiTabs as RelayTab[] | undefined)?.find(
				(t) => t.id === mapping.tabId
			);
			if (
				tab?.relayConversation?.status === 'running' ||
				tab?.relayConversation?.status === 'queued'
			)
				await this.patch(
					mapping,
					{},
					{
						status: 'error',
						completedAt: undefined,
						error: 'Host restarted during Relay execution; inspect before retrying',
					}
				);
		}
	}
}
