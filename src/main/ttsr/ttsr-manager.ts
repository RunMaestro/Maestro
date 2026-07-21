/**
 * `TtsrManager` - the per-session stream matcher.
 *
 * Fed by the `StdoutHandler.handleParsedEvent` tap (Phase 2a), it accumulates
 * prose/thinking buffers, evaluates rules against each delta plus edit/write
 * tool content, applies the repeat policy from the main-authoritative
 * {@link TtsrStateStore}, and classifies every hit into an interrupt or a
 * deferred reminder.
 *
 * This phase is detection only: matches are returned, reported via
 * `onMatched`, and deferred ones are queued. Aborting the in-flight process and
 * reinjecting the corrective turn is Phase 3, which consumes
 * {@link TtsrManager.takeInterrupts} / {@link TtsrManager.takeDeferred}.
 *
 * Dependencies are injected (rules, enablement, reporting) so the process
 * manager never imports the TTSR engine directly.
 */

import type { AgentId } from '../../shared/agentIds';
import type { LoadedTtsrRule, TtsrMatchedPayload, TtsrRuleRef } from '../../shared/ttsr-types';
import type { ParsedEvent } from '../parsers/agent-output-parser';
import { createTtsrAstMatcher, type TtsrAstMatcher } from './ttsr-ast';
import {
	classifyMatch,
	findRegexMatch,
	interruptModeAllows,
	ruleAppliesToContext,
	type TtsrDisposition,
	type TtsrMatchSource,
} from './ttsr-matcher';
import { TtsrStateStore, ttsrConversationKey } from './ttsr-state-store';
import { extractEditSnapshots } from './ttsr-tool-extract';

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

/** What the manager needs to know about the turn producing these events. */
export interface TtsrObserveContext {
	agentId: AgentId;
	/** Project root of the agent's workspace. Selects the rule set. */
	cwd: string;
	/** Provider conversation id, once the `session-id` event has landed. */
	providerSessionId?: string;
}

/** One fired rule. */
export interface TtsrMatch {
	rule: LoadedTtsrRule;
	source: TtsrMatchSource;
	disposition: TtsrDisposition;
	/** The substring that tripped the rule. */
	matchedText: string;
	filePath?: string;
}

export interface TtsrManagerDeps {
	/** Active rule set for a project root. Implementations should cache. */
	getRules(cwd: string): LoadedTtsrRule[];
	/**
	 * Master gate: global `ttsrEnabled` AND the `ttsr` Encore flag AND the
	 * project's `.maestro/ttsr.yaml` `enabled`. When false, `observe` is a
	 * no-op before any work is done.
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
	deferred: TtsrMatch[];
	/**
	 * Last AST-scanned content per `${source}:${filePath}`, so a re-emitted or
	 * repeated tool payload is not re-parsed (the plan's AST throttle).
	 */
	astSeen: Map<string, string>;
}

function toRuleRef(rule: LoadedTtsrRule): TtsrRuleRef {
	return { name: rule.name, path: rule.path };
}

export class TtsrManager {
	private readonly sessions = new Map<string, SessionState>();
	readonly store: TtsrStateStore;
	private readonly astMatcher: TtsrAstMatcher;

	constructor(private readonly deps: TtsrManagerDeps) {
		this.store = deps.store ?? new TtsrStateStore();
		this.astMatcher = deps.astMatcher ?? createTtsrAstMatcher();
	}

	private session(sessionId: string): SessionState {
		let state = this.sessions.get(sessionId);
		if (!state) {
			state = { buffers: new Map(), interrupts: [], deferred: [], astSeen: new Map() };
			this.sessions.set(sessionId, state);
		}
		return state;
	}

	/** Reset per-turn buffers. Called when a turn is spawned. */
	beginTurn(sessionId: string, providerSessionId?: string): void {
		const state = this.session(sessionId);
		state.buffers.clear();
		state.astSeen.clear();
		state.interrupts = [];
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
		this.store.adoptProviderSessionId(sessionId, providerSessionId);
	}

	/** Conversation key used for this session's repeat bookkeeping. */
	private keyFor(sessionId: string): string {
		return ttsrConversationKey(sessionId, this.sessions.get(sessionId)?.providerSessionId);
	}

	/**
	 * Evaluate one parsed event. Returns every rule that fired, in the order
	 * the streams were examined. Safe to call for every event of every agent:
	 * it short-circuits when TTSR is off or the agent has no applicable rules.
	 */
	observe(sessionId: string, event: ParsedEvent, ctx: TtsrObserveContext): TtsrMatch[] {
		if (!this.deps.isEnabled(ctx.cwd)) return [];

		const rules = this.deps.getRules(ctx.cwd);
		if (rules.length === 0) return [];

		if (event.type === 'init' && event.sessionId) {
			this.setProviderSessionId(sessionId, event.sessionId);
		}

		const matches: TtsrMatch[] = [];

		// ── Prose / thinking ──
		if ((event.type === 'text' || event.type === 'result') && event.text) {
			const source: TtsrMatchSource = event.isReasoning ? 'thinking' : 'text';
			const scanText = this.appendToBuffer(sessionId, source, event.text);
			matches.push(...this.evaluate(sessionId, rules, scanText, { agentId: ctx.agentId, source }));
		}

		// ── Edit/write tool content ──
		for (const snapshot of extractEditSnapshots(event)) {
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
		if (!this.deps.isEnabled(ctx.cwd)) return false;
		return this.deps.getRules(ctx.cwd).some((rule) => rule.astCondition.length > 0);
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
		if (!this.deps.isEnabled(ctx.cwd)) return [];

		const astRules = this.deps.getRules(ctx.cwd).filter((rule) => rule.astCondition.length > 0);
		if (astRules.length === 0) return [];

		const state = this.session(sessionId);
		const matches: TtsrMatch[] = [];

		for (const snapshot of extractEditSnapshots(event)) {
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
			const key = this.keyFor(sessionId);

			for (const rule of astRules) {
				if (!ruleAppliesToContext(rule, matchCtx)) continue;
				if (!this.store.isEligible(rule, key)) continue;
				const matchedText = await this.astMatcher.find(
					rule.astCondition,
					snapshot.content,
					snapshot.filePath
				);
				if (matchedText === null) continue;

				this.store.noteInjection(key, rule.name);
				matches.push({
					rule,
					source: snapshot.source,
					disposition: classifyMatch(rule, snapshot.source),
					matchedText,
					filePath: snapshot.filePath,
				});
			}
		}

		if (matches.length > 0) this.record(sessionId, ctx, matches);
		return matches;
	}

	/**
	 * Tier B fallback: match the accumulated final text at turn end for agents
	 * with no live prose stream (opencode), then advance the turn counter that
	 * `after-gap` eligibility is measured in.
	 */
	endTurn(sessionId: string, ctx: TtsrObserveContext, finalText?: string): TtsrMatch[] {
		let matches: TtsrMatch[] = [];
		if (finalText && this.deps.isEnabled(ctx.cwd)) {
			const rules = this.deps.getRules(ctx.cwd);
			if (rules.length > 0) {
				const scanText = this.appendToBuffer(sessionId, 'text', finalText);
				matches = this.evaluate(sessionId, rules, scanText, {
					agentId: ctx.agentId,
					source: 'text',
				});
				if (matches.length > 0) this.record(sessionId, ctx, matches);
			}
		}
		this.store.noteTurnEnd(this.keyFor(sessionId));
		const state = this.session(sessionId);
		state.buffers.clear();
		state.astSeen.clear();
		return matches;
	}

	/** Interrupting matches captured this turn, cleared by the read (Phase 3). */
	takeInterrupts(sessionId: string): TtsrMatch[] {
		const state = this.sessions.get(sessionId);
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
		const state = this.sessions.get(sessionId);
		if (!state) return [];
		const out = state.deferred;
		state.deferred = [];
		return out;
	}

	/** Drop all per-session state (session closed). */
	dispose(sessionId: string): void {
		this.sessions.delete(sessionId);
	}

	// ── internals ──

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
			if (!this.store.isEligible(rule, key)) continue;
			const matchedText = findRegexMatch(rule, text);
			if (matchedText === null) continue;

			// Recording the firing here starts the repeat cooldown, so a rule
			// cannot re-fire on every subsequent delta of the same turn.
			this.store.noteInjection(key, rule.name);
			matches.push({
				rule,
				source: ctx.source,
				disposition: classifyMatch(rule, ctx.source),
				matchedText,
				filePath: ctx.filePath,
			});
		}

		return matches;
	}

	/** Queue matches into their Phase 3 buckets and report them. */
	private record(sessionId: string, ctx: TtsrObserveContext, matches: TtsrMatch[]): void {
		const state = this.session(sessionId);
		for (const match of matches) {
			if (match.disposition === 'interrupt') state.interrupts.push(match);
			else state.deferred.push(match);
		}

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
