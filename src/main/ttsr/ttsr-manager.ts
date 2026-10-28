/**
 * `TtsrManager` - the per-session stream matcher.
 *
 * Fed by the `StdoutHandler.handleParsedEvent` tap (Phase 2a), it accumulates
 * prose/thinking buffers, evaluates rules against each delta plus tool content
 * (file writes and shell commands), applies the repeat policy from the main-authoritative
 * {@link TtsrStateStore}, and classifies every hit into an interrupt or a
 * deferred reminder.
 *
 * This phase is detection only: matches are returned, reported via
 * `onMatched`, and deferred ones are queued. Preparing and
 * handing guidance to native Steer is handled by the runtime, which consumes
 * {@link TtsrManager.takeInterrupts} / {@link TtsrManager.takeDeferred}.
 *
 * Dependencies are injected (rules, enablement, reporting) so the process
 * manager never imports the TTSR engine directly.
 */

import type { AgentId } from '../../shared/agentIds';
import { parseAiTabSpawnId } from '../coworking/coworking-session-id';
import type { LoadedTtsrRule, TtsrMatchedPayload, TtsrRuleRef } from '../../shared/ttsr-types';
import type { ParsedEvent } from '../parsers/agent-output-parser';
import { createTtsrAstMatcher, type TtsrAstMatcher } from './ttsr-ast';
import {
	classifyMatch,
	findRegexMatch,
	interruptModeAllows,
	ruleAppliesToContext,
	sameTtsrRuleDefinition,
	type TtsrDisposition,
	type TtsrMatchSource,
} from './ttsr-matcher';
import {
	TtsrStateStore,
	MAX_TTSR_INTERRUPTS,
	ttsrConversationKey,
	type TtsrInjectionReservation,
} from './ttsr-state-store';
import { extractToolSnapshots } from './ttsr-tool-extract';

/**
 * Largest prose buffer retained per stream. Long turns keep only the tail; a
 * rule that needs more context than this is better expressed as a tool rule.
 */
const MAX_BUFFER_CHARS = 32_768;

/**
 * How much already-scanned text is re-scanned with each delta, so a pattern
 * straddling a chunk boundary still matches without re-scanning the whole
 * buffer on every token.
 */
const SCAN_OVERLAP_CHARS = 1_024;

/**
 * Deferred reminders held for one conversation before the oldest is dropped.
 * They ride along with the next prompt, so an unbounded queue would eventually
 * cost more context than the guidance is worth.
 */
const MAX_DEFERRED_PER_SESSION = 10;

/**
 * Conversations kept alive purely for their queued reminders. Turns that end
 * with an empty queue are dropped immediately; this bounds the pathological
 * case (an Auto Run whose per-task session ids are never reused, each leaving a
 * reminder behind). Oldest-first eviction, since insertion order is age order.
 */
const MAX_RETAINED_SESSIONS = 50;

/**
 * The gate + rule set for one project root, resolved once per observed event.
 *
 * Threaded through {@link TtsrObserveContext} so a single event does not re-ask
 * for them per manager callback: resolving means a rule-cache lookup in the
 * runtime and, behind that, a settings read.
 */
export interface TtsrResolvedRules {
	/** Global gate AND the project's own `enabled` switch. */
	enabled: boolean;
	/** Active rules for the project, already filtered by the disabled list. */
	rules: LoadedTtsrRule[];
}

/** What the manager needs to know about the turn producing these events. */
export interface TtsrObserveContext {
	agentId: AgentId;
	/** Project root of the agent's workspace. Selects the rule set. */
	cwd: string;
	/** Provider conversation id, once the `session-id` event has landed. */
	providerSessionId?: string;
	/** Reject async structural work whose observed turn has ended or been replaced. */
	isCurrent?(): boolean;
	/**
	 * Pre-resolved gate + rules for this event. Callers on the hot path (the
	 * runtime) always pass it; without it the manager falls back to its
	 * `isEnabled` / `getRules` deps, one resolution per call.
	 */
	resolved?: TtsrResolvedRules;
}

/** One fired rule. */
export interface TtsrMatch {
	rule: LoadedTtsrRule;
	source: TtsrMatchSource;
	disposition: TtsrDisposition;
	/** The substring that tripped the rule. */
	matchedText: string;
	filePath?: string;
	/** Workspace authority retained after the producing process exits. */
	projectRoot?: string;
}

export interface TtsrManagerDeps {
	/**
	 * Active rule set for a project root. Implementations should cache. Only
	 * consulted when the caller did not pass a resolved pair on the context.
	 */
	getRules(cwd: string): LoadedTtsrRule[];
	/**
	 * Master gate: global `ttsrEnabled` AND the `ttsr` Encore flag AND the
	 * project's `.maestro/ttsr.yaml` `enabled`. When false, `observe` is a
	 * no-op before any work is done. Same fallback role as {@link getRules}.
	 */
	isEnabled(cwd: string): boolean;
	/** Optional observability sink for `ttsr:matched`. */
	onMatched?(payload: TtsrMatchedPayload): void;
	/** Shared across sessions; defaults to a fresh in-memory store. */
	store?: TtsrStateStore;
	/** Structural matcher for `astCondition` rules; defaults to the ast-grep one. */
	astMatcher?: TtsrAstMatcher;
}

interface StreamBuffer {
	text: string;
	/** Index up to which `text` has already been scanned. */
	scanned: number;
}

interface SessionState {
	buffers: Map<TtsrMatchSource, StreamBuffer>;
	providerSessionId?: string;
	interrupts: TtsrMatch[];
	/**
	 * Last AST-scanned content per `${source}:${filePath}`, so a re-emitted or
	 * repeated tool payload is not re-parsed (the plan's AST throttle).
	 */
	astSeen: Map<string, string>;
}

interface ConversationState {
	deferred: TtsrMatch[];
}

function toRuleRef(rule: LoadedTtsrRule): TtsrRuleRef {
	return { name: rule.name, path: rule.path };
}

/**
 * The conversation a spawn id belongs to: `{maestroSessionId}-ai-{tabId}`.
 *
 * Spawn ids are not stable across turns - a forced-parallel turn spawns as
 * `{maestroSessionId}-ai-{tabId}-fp-{timestamp}` - while repeat policy, interrupt budget and queued reminders belong to the
 * conversation, which is the tab. Stream and AST state remain per raw turn ID. Keying on the raw id would mint a fresh
 * conversation per such turn: a `once` rule would re-fire every turn, the store
 * would accrete a dead record per turn, and a reminder queued under one id would
 * never be drained under the next.
 *
 * Canonical `{sessionId}-ai-{tabId}` ids normalize to themselves, so persisted
 * state written before this keyed the same way. Any other spawn flavor (batch,
 * synopsis, group chat) is passed through unchanged.
 */
function conversationIdFor(spawnSessionId: string): string {
	const parsed = parseAiTabSpawnId(spawnSessionId);
	return parsed ? `${parsed.maestroSessionId}-ai-${parsed.tabId}` : spawnSessionId;
}

export class TtsrManager {
	private readonly sessions = new Map<string, SessionState>();
	private readonly conversations = new Map<string, ConversationState>();
	private readonly held = new Set<TtsrMatch>();
	private readonly injections = new WeakMap<TtsrMatch, TtsrInjectionReservation>();
	readonly store: TtsrStateStore;
	private readonly astMatcher: TtsrAstMatcher;

	constructor(private readonly deps: TtsrManagerDeps) {
		this.store = deps.store ?? new TtsrStateStore();
		this.astMatcher = deps.astMatcher ?? createTtsrAstMatcher();
	}

	/** Per-turn stream state, keyed by the raw process ID, including forced-parallel suffixes. */
	private session(spawnSessionId: string): SessionState {
		const sessionId = spawnSessionId;
		let state = this.sessions.get(sessionId);
		if (!state) {
			state = { buffers: new Map(), interrupts: [], astSeen: new Map() };
			this.sessions.set(sessionId, state);
		}
		return state;
	}

	/** Read-only counterpart to {@link TtsrManager.session}: no entry is created. */
	private stateOf(spawnSessionId: string): SessionState | undefined {
		return this.sessions.get(spawnSessionId);
	}

	/** Shared, bounded reminder history; stream/AST state stays under the raw turn ID. */
	private conversation(sessionId: string): ConversationState {
		const id = conversationIdFor(sessionId);
		let state = this.conversations.get(id);
		if (!state) {
			state = { deferred: [] };
			this.conversations.set(id, state);
			while (this.conversations.size > MAX_RETAINED_SESSIONS) {
				const oldest = this.conversations.keys().next().value!;
				for (const match of this.conversations.get(oldest)!.deferred) this.releaseMatch(match);
				this.conversations.delete(oldest);
			}
		}
		return state;
	}

	/** Reset per-turn buffers. Called when a turn is spawned. */
	beginTurn(sessionId: string, providerSessionId?: string): void {
		this.sessions.delete(sessionId);
		this.session(sessionId);
		if (providerSessionId) this.setProviderSessionId(sessionId, providerSessionId);
	}

	/**
	 * Record the provider conversation id once the agent emits it, folding any
	 * repeat state recorded before it arrived into the real conversation.
	 */
	setProviderSessionId(sessionId: string, providerSessionId: string): void {
		if (!providerSessionId) return;
		const state = this.session(sessionId);
		if (state.providerSessionId === providerSessionId) return;
		state.providerSessionId = providerSessionId;
		this.store.adoptPendingTurn(conversationIdFor(sessionId), sessionId, providerSessionId);
		// The stable pending bucket contains only finished turns/restart history;
		// live unknown siblings retain their own raw pending buckets.
		this.store.adoptProviderSessionId(conversationIdFor(sessionId), providerSessionId);
	}

	/** Conversation key used for this session's repeat bookkeeping. */
	private keyFor(sessionId: string): string {
		return ttsrConversationKey(
			conversationIdFor(sessionId),
			this.stateOf(sessionId)?.providerSessionId,
			this.stateOf(sessionId) ? sessionId : undefined
		);
	}

	private messageCountFor(sessionId: string): number {
		return this.store.getMessageCount(
			this.stateOf(sessionId)?.providerSessionId
				? this.keyFor(sessionId)
				: ttsrConversationKey(conversationIdFor(sessionId))
		);
	}

	/** Unknown siblings share repeat eligibility, but adoption moves only their own tokens. */
	private isEligible(sessionId: string, rule: LoadedTtsrRule): boolean {
		const count = this.messageCountFor(sessionId);
		if (!this.store.isEligible(rule, this.keyFor(sessionId), count)) return false;
		if (this.stateOf(sessionId)?.providerSessionId) return true;
		const conversation = conversationIdFor(sessionId);
		if (!this.store.isEligible(rule, ttsrConversationKey(conversation), count)) return false;
		for (const [id, state] of this.sessions) {
			if (
				id !== sessionId &&
				!state.providerSessionId &&
				conversationIdFor(id) === conversation &&
				!this.store.isEligible(rule, this.keyFor(id), count)
			)
				return false;
		}
		return true;
	}

	/**
	 * Evaluate one parsed event. Returns every rule that fired, in the order
	 * the streams were examined. Safe to call for every event of every agent:
	 * it short-circuits when TTSR is off or the agent has no applicable rules.
	 */
	observe(sessionId: string, event: ParsedEvent, ctx: TtsrObserveContext): TtsrMatch[] {
		const { enabled, rules } = this.resolve(ctx);
		if (!enabled || rules.length === 0) return [];
		this.session(sessionId);

		if (event.type === 'init' && event.sessionId) {
			this.setProviderSessionId(sessionId, event.sessionId);
		}

		const matches: TtsrMatch[] = [];

		// ── Prose / thinking ──
		// Double-count guard: when `textAlreadyStreamed` is set, this complete
		// `assistant` event's prose was already delivered token-by-token via the
		// preceding `stream_event` text deltas, which were themselves buffered and
		// evaluated on the delta events. Re-buffering it here would duplicate the
		// text in the scan window (breaking overlap math and repeat counts), so
		// skip the prose path. The tool-snapshot path below still runs, because
		// tool inputs arrive only on the complete assistant event, not the deltas.
		if (
			(event.type === 'text' || event.type === 'result') &&
			event.text &&
			!event.textAlreadyStreamed
		) {
			const source: TtsrMatchSource = event.isReasoning ? 'thinking' : 'text';
			// A final result is a complete snapshot, not another stream delta.
			// Scan it independently so echoes or divergent final answers cannot
			// fabricate a boundary with prose already observed during this turn.
			const scanText =
				event.type === 'result' ? event.text : this.appendToBuffer(sessionId, source, event.text);
			matches.push(...this.evaluate(sessionId, rules, scanText, { agentId: ctx.agentId, source }));
		}

		// ── Tool content: what is being written, or the command being run ──
		for (const snapshot of extractToolSnapshots(event, ctx.cwd)) {
			matches.push(
				...this.evaluate(sessionId, rules, snapshot.content, {
					agentId: ctx.agentId,
					source: snapshot.source,
					filePath: snapshot.filePath,
					cwd: ctx.cwd,
				})
			);
		}

		if (matches.length > 0) this.record(sessionId, ctx, matches);
		return matches;
	}

	/**
	 * Cheap synchronous gate for {@link observeAst}, so the hot path allocates no
	 * promise for the overwhelming majority of events (no tool payload, or no
	 * `astCondition` rule in the project).
	 */
	needsAstCheck(event: ParsedEvent, ctx: TtsrObserveContext): boolean {
		if (!event.toolName && !event.toolUseBlocks?.length) return false;
		const { enabled, rules } = this.resolve(ctx);
		if (!enabled) return false;
		return rules.some((rule) => rule.astCondition.length > 0);
	}

	/**
	 * Async companion to {@link observe}: run `astCondition` patterns over the
	 * edit/write content this event carries. Kept off the synchronous path so a
	 * parse never stalls the agent's stream (Phase 2 anti-pattern guard).
	 *
	 * Matches land in the same interrupt/deferred buckets as regex hits, so
	 * Phase 3 drains one queue regardless of how a rule fired.
	 */
	async observeAst(
		sessionId: string,
		event: ParsedEvent,
		ctx: TtsrObserveContext
	): Promise<TtsrMatch[]> {
		const { enabled, rules } = this.resolve(ctx);
		if (!enabled) return [];

		const astRules = rules.filter((rule) => rule.astCondition.length > 0);
		if (astRules.length === 0) return [];

		const state = this.session(sessionId);
		const candidates: TtsrMatch[] = [];

		for (const snapshot of extractToolSnapshots(event, ctx.cwd)) {
			if (!this.astMatcher.supports(snapshot.filePath)) continue;

			// Skip a payload identical to the last one seen for the same target: an
			// agent that re-emits a partial tool call must not re-parse it.
			const seenKey = `${snapshot.source}:${snapshot.filePath ?? ''}`;
			if (state.astSeen.get(seenKey) === snapshot.content) continue;
			state.astSeen.set(seenKey, snapshot.content);

			const matchCtx = {
				agentId: ctx.agentId,
				source: snapshot.source,
				filePath: snapshot.filePath,
				cwd: ctx.cwd,
			};

			for (const rule of astRules) {
				if (!ruleAppliesToContext(rule, matchCtx)) continue;
				if (!this.isEligible(sessionId, rule)) continue;
				const matchedText = await this.astMatcher.find(
					rule.astCondition,
					snapshot.content,
					snapshot.filePath
				);
				if (this.stateOf(sessionId) !== state || (ctx.isCurrent && !ctx.isCurrent())) return [];
				if (matchedText === null) continue;

				candidates.push({
					rule,
					source: snapshot.source,
					disposition: classifyMatch(rule, snapshot.source),
					matchedText,
					filePath: snapshot.filePath,
				});
			}
		}

		// No await from here through record: eligibility and current provider key
		// are resolved together, after the entire structural pass succeeds.
		if (this.stateOf(sessionId) !== state || (ctx.isCurrent && !ctx.isCurrent())) return [];
		const current = this.resolve({ ...ctx, resolved: undefined });
		if (!current.enabled) return [];
		const key = this.keyFor(sessionId);
		const matches: TtsrMatch[] = [];
		for (const match of candidates) {
			const rule = current.rules.find((candidate) => sameTtsrRuleDefinition(candidate, match.rule));
			if (!rule || !this.isEligible(sessionId, rule)) continue;
			match.rule = rule;
			this.injections.set(
				match,
				this.store.reserveInjection(key, match.rule.name, this.messageCountFor(sessionId))
			);
			matches.push(match);
		}
		if (matches.length > 0) this.record(sessionId, ctx, matches);
		return matches;
	}

	/**
	 * Close a turn: advance the counter `after-gap` eligibility is measured in
	 * and drop the turn's buffers.
	 *
	 * There is no separate end-of-turn matching pass. Tier B agents (opencode)
	 * deliver their whole answer as a final `result` event, which reaches
	 * {@link TtsrManager.observe} like any other - so the Tier B fallback is the
	 * ordinary path, not a special case here.
	 */
	endTurn(sessionId: string): void {
		if (!this.stateOf(sessionId)?.providerSessionId) {
			this.store.adoptPendingTurn(conversationIdFor(sessionId), sessionId);
			this.store.noteTurnEnd(ttsrConversationKey(conversationIdFor(sessionId)));
		} else this.store.noteTurnEnd(this.keyFor(sessionId));
		this.sessions.delete(sessionId);
	}

	/** Whether this conversation may still abort a turn (interrupt budget). */
	canInterrupt(sessionId: string): boolean {
		if (this.stateOf(sessionId)?.providerSessionId)
			return this.store.canInterrupt(this.keyFor(sessionId));
		const conversation = conversationIdFor(sessionId);
		let count = this.store.getInterruptCount(ttsrConversationKey(conversation));
		for (const [id, state] of this.sessions) {
			if (!state.providerSessionId && conversationIdFor(id) === conversation)
				count += this.store.getInterruptCount(this.keyFor(id));
		}
		return count < MAX_TTSR_INTERRUPTS;
	}

	/** Charge one abort against this conversation's interrupt budget. */
	noteInterrupt(sessionId: string): void {
		this.store.noteInterrupt(this.keyFor(sessionId));
	}

	/** Give the charge back when an announced abort is withdrawn. */
	refundInterrupt(sessionId: string): void {
		this.store.refundInterrupt(this.keyFor(sessionId));
	}

	/**
	 * Re-arm rules whose guidance never reached the agent, so the cooldown their
	 * (undelivered) firing started does not silence them.
	 */
	clearInjections(sessionId: string, ruleNames: string[]): void {
		const key = this.keyFor(sessionId);
		for (const ruleName of ruleNames) this.store.clearInjection(key, ruleName);
	}

	/**
	 * Re-file matches that would have interrupted as deferred reminders, used
	 * when the conversation's interrupt budget is spent. The guidance still
	 * reaches the agent, on its next prompt instead of by force.
	 */
	deferMatches(sessionId: string, matches: TtsrMatch[]): void {
		const state = this.conversation(sessionId);
		state.deferred.push(...matches);
		this.trimDeferred(state);
	}

	/** Interrupting matches captured this turn, cleared by the read (Phase 3). */
	takeInterrupts(sessionId: string): TtsrMatch[] {
		const state = this.stateOf(sessionId);
		if (!state) return [];
		const out = state.interrupts;
		state.interrupts = [];
		return out;
	}

	/**
	 * Deferred reminders queued for this session, cleared by the read. They
	 * survive turn boundaries until the next prompt consumes them (Phase 3c).
	 */
	takeDeferred(sessionId: string): TtsrMatch[] {
		const state = this.conversations.get(conversationIdFor(sessionId));
		if (!state) return [];
		const out = state.deferred;
		state.deferred = [];
		for (const match of out) this.acceptMatch(match);
		return out;
	}

	/**
	 * Queued reminders WITHOUT clearing them, for the transactional spawn path:
	 * the prompt is built from this read, and {@link TtsrManager.commitDeferred}
	 * clears the queue only once the spawn has actually happened. A destructive
	 * read there would destroy the guidance whenever the spawn threw.
	 */
	peekDeferred(sessionId: string): TtsrMatch[] {
		return this.conversations.get(conversationIdFor(sessionId))?.deferred.slice() ?? [];
	}

	/** Commit the captured identities, even if the queue was trimmed while preparing. */
	commitDeferred(sessionId: string, matches: readonly TtsrMatch[]): void {
		const state = this.conversations.get(conversationIdFor(sessionId));
		const claimed = new Set(matches);
		if (state) state.deferred = state.deferred.filter((match) => !claimed.has(match));
		for (const match of matches) this.acceptMatch(match);
	}

	/** Atomically hand these exact deferred matches to the native queue owner. */
	claimDeferred(sessionId: string, matches: readonly TtsrMatch[]): boolean {
		const queued = this.peekDeferred(sessionId);
		if (!matches.every((match) => queued.includes(match))) return false;
		this.commitDeferred(sessionId, matches);
		return true;
	}

	/** Discard disabled/edited guidance and release only its own repeat reservation. */
	discardDeferred(sessionId: string, matches: readonly TtsrMatch[]): void {
		const state = this.conversations.get(conversationIdFor(sessionId));
		if (!state) return;
		const discarded = new Set(matches);
		state.deferred = state.deferred.filter((match) => !discarded.has(match));
		for (const match of matches) this.releaseMatch(match);
	}

	/** Pin repeat reservations until a preparing spawn commits or rolls back. */
	holdDeferred(matches: readonly TtsrMatch[]): void {
		for (const match of matches) this.held.add(match);
	}

	releaseDeferred(matches: readonly TtsrMatch[]): void {
		for (const match of matches) {
			this.held.delete(match);
			if (![...this.conversations.values()].some((state) => state.deferred.includes(match)))
				this.releaseMatch(match);
		}
	}

	private acceptMatch(match: TtsrMatch): void {
		const reservation = this.injections.get(match);
		if (reservation) this.store.acceptInjection(reservation);
		this.injections.delete(match);
	}

	private releaseMatch(match: TtsrMatch): void {
		if (this.held.has(match)) return;
		const reservation = this.injections.get(match);
		if (reservation) this.store.releaseInjection(reservation);
		this.injections.delete(match);
	}

	/** True while this conversation still owes its next prompt a reminder. */
	hasDeferred(sessionId: string): boolean {
		return (this.conversations.get(conversationIdFor(sessionId))?.deferred.length ?? 0) > 0;
	}

	/** Drop all per-session state (session closed). */
	dispose(sessionId: string): void {
		// A disabled exit still owes queued guidance, but must not advance turns
		// or write state. Folding to pending changes no durable snapshot content.
		if (!this.stateOf(sessionId)?.providerSessionId)
			this.store.adoptPendingTurn(conversationIdFor(sessionId), sessionId);
		this.sessions.delete(sessionId);
		if (!this.hasDeferred(sessionId)) this.conversations.delete(conversationIdFor(sessionId));
	}

	// ── internals ──

	/**
	 * Gate + rules for this event: the caller's pre-resolved pair when it has one,
	 * otherwise the deps, gate first so a disabled project never pays for a rule
	 * load.
	 */
	private resolve(ctx: TtsrObserveContext): TtsrResolvedRules {
		if (ctx.resolved) return ctx.resolved;
		if (!this.deps.isEnabled(ctx.cwd)) return { enabled: false, rules: [] };
		return { enabled: true, rules: this.deps.getRules(ctx.cwd) };
	}

	/**
	 * Append a delta and return the slice worth scanning: the new text plus a
	 * bounded overlap so patterns spanning a chunk boundary still match.
	 */
	private appendToBuffer(sessionId: string, source: TtsrMatchSource, delta: string): string {
		const buffers = this.session(sessionId).buffers;
		let buffer = buffers.get(source);
		if (!buffer) {
			buffer = { text: '', scanned: 0 };
			buffers.set(source, buffer);
		}

		buffer.text += delta;
		if (buffer.text.length > MAX_BUFFER_CHARS) {
			const dropped = buffer.text.length - MAX_BUFFER_CHARS;
			buffer.text = buffer.text.slice(dropped);
			buffer.scanned = Math.max(0, buffer.scanned - dropped);
		}

		const from = Math.max(0, buffer.scanned - SCAN_OVERLAP_CHARS);
		const scanText = buffer.text.slice(from);
		buffer.scanned = buffer.text.length;
		return scanText;
	}

	/** Run every eligible rule against one chunk of text. */
	private evaluate(
		sessionId: string,
		rules: LoadedTtsrRule[],
		text: string,
		ctx: { agentId: AgentId; source: TtsrMatchSource; filePath?: string; cwd?: string }
	): TtsrMatch[] {
		if (!text) return [];
		const key = this.keyFor(sessionId);
		const matches: TtsrMatch[] = [];

		for (const rule of rules) {
			if (!ruleAppliesToContext(rule, ctx)) continue;
			if (!this.isEligible(sessionId, rule)) continue;
			const matchedText = findRegexMatch(rule, text);
			if (matchedText === null) continue;

			// Recording the firing here starts the repeat cooldown, so a rule
			// cannot re-fire on every subsequent delta of the same turn.
			const match: TtsrMatch = {
				rule,
				source: ctx.source,
				disposition: classifyMatch(rule, ctx.source),
				matchedText,
				filePath: ctx.filePath,
			};
			this.injections.set(
				match,
				this.store.reserveInjection(key, rule.name, this.messageCountFor(sessionId))
			);
			matches.push(match);
		}

		return matches;
	}

	/**
	 * Bound the deferred queue. Oldest guidance loses: the newest violation is
	 * the one the agent just committed, and the block is prepended to a real user
	 * prompt, so an unbounded queue would cost more context than it is worth.
	 */
	private trimDeferred(state: ConversationState): void {
		if (state.deferred.length > MAX_DEFERRED_PER_SESSION) {
			for (const match of state.deferred.slice(0, -MAX_DEFERRED_PER_SESSION))
				this.releaseMatch(match);
			state.deferred = state.deferred.slice(-MAX_DEFERRED_PER_SESSION);
		}
	}

	/** Queue matches into their Phase 3 buckets and report them. */
	private record(sessionId: string, ctx: TtsrObserveContext, matches: TtsrMatch[]): void {
		const state = this.session(sessionId);
		const conversation = this.conversation(sessionId);
		for (const match of matches) {
			match.projectRoot = ctx.cwd;
			if (match.disposition === 'interrupt') state.interrupts.push(match);
			else conversation.deferred.push(match);
		}
		this.trimDeferred(conversation);

		if (!this.deps.onMatched) return;
		// One payload per source so the renderer can label the stream that fired.
		const bySource = new Map<TtsrMatchSource, TtsrMatch[]>();
		for (const match of matches) {
			const list = bySource.get(match.source);
			if (list) list.push(match);
			else bySource.set(match.source, [match]);
		}
		for (const [source, group] of bySource) {
			this.deps.onMatched({
				sessionId,
				agentId: ctx.agentId,
				source,
				rules: group.map((match) => toRuleRef(match.rule)),
				willInterrupt: group.some((match) => interruptModeAllows(match.rule.interruptMode, source)),
				filePath: group.find((match) => match.filePath)?.filePath,
			});
		}
	}
}
