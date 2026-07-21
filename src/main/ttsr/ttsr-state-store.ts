/**
 * Main-authoritative TTSR runtime state (Gate B).
 *
 * Repeat/injection bookkeeping lives here, in the main process, because the
 * matcher runs mid-stream inside `StdoutHandler` and cannot wait for a renderer
 * round-trip. The renderer only ever receives a display cache via
 * `ttsr:triggered`; it never owns this state.
 *
 * State is keyed by `(maestroSessionId, providerSessionId, ruleName)`. The
 * provider session id is not known until the agent emits its `session-id`
 * event, which can land after the first matched delta, so matches recorded
 * before then go into a pending bucket that {@link TtsrStateStore.adoptProviderSessionId}
 * folds into the real conversation once the id arrives.
 */

import type { LoadedTtsrRule } from '../../shared/ttsr-types';

/** Placeholder provider id used before the agent's `session-id` event lands. */
export const TTSR_PENDING_PROVIDER_ID = '-';

/** Build the conversation key used by every store method. */
export function ttsrConversationKey(maestroSessionId: string, providerSessionId?: string): string {
	return `${maestroSessionId}|${providerSessionId || TTSR_PENDING_PROVIDER_ID}`;
}

/** Per-rule firing history within one conversation. */
export interface TtsrRuleState {
	/** `messageCount` at the last injection; `null` when the rule never fired. */
	lastInjectedAt: number | null;
	injectionCount: number;
}

/** Everything the store tracks for one conversation. */
export interface TtsrConversationState {
	/** Completed turns in this conversation. Drives `after-gap` eligibility. */
	messageCount: number;
	rules: Record<string, TtsrRuleState>;
	/** Turns TTSR has aborted here. Bounded by {@link MAX_TTSR_INTERRUPTS}. */
	interruptCount: number;
	/** Epoch ms of the last mutation. Drives the persistence layer's TTL prune. */
	updatedAt: number;
}

/**
 * Hard ceiling on how many turns TTSR may abort in one conversation.
 *
 * Every abort costs a full turn's tokens and the agent is not obliged to comply,
 * so a rule the agent keeps tripping would otherwise interrupt forever (the
 * default `after-gap` policy re-arms every few turns, and each aborted turn
 * advances that counter itself). Past the budget, matches still fire - they just
 * degrade to deferred `<system-reminder>`s that ride the next prompt instead of
 * killing the process.
 */
export const MAX_TTSR_INTERRUPTS = 5;

/** Serializable snapshot, handed to the main-side persistence layer. */
export type TtsrStateSnapshot = Record<string, TtsrConversationState>;

export interface TtsrStateStoreOptions {
	/**
	 * Fired after every mutation so the persistence layer can schedule a write.
	 * Deliberately a plain callback rather than an EventEmitter: the store is
	 * touched mid-stream and must not pay for listener dispatch.
	 */
	onChange?(): void;
}

function emptyConversation(): TtsrConversationState {
	return { messageCount: 0, rules: {}, interruptCount: 0, updatedAt: Date.now() };
}

export class TtsrStateStore {
	private readonly conversations = new Map<string, TtsrConversationState>();
	private readonly onChange?: () => void;

	constructor(options: TtsrStateStoreOptions = {}) {
		this.onChange = options.onChange;
	}

	private ensure(key: string): TtsrConversationState {
		let state = this.conversations.get(key);
		if (!state) {
			state = emptyConversation();
			this.conversations.set(key, state);
		}
		return state;
	}

	/** Stamp the conversation as freshly touched and notify the persistence layer. */
	private touch(state: TtsrConversationState): void {
		state.updatedAt = Date.now();
		this.onChange?.();
	}

	/** Completed turns seen for this conversation. */
	getMessageCount(key: string): number {
		return this.conversations.get(key)?.messageCount ?? 0;
	}

	/** Firing history for one rule, or `null` when it has never fired here. */
	getRuleState(key: string, ruleName: string): TtsrRuleState | null {
		return this.conversations.get(key)?.rules[ruleName] ?? null;
	}

	/** Advance the turn counter. Called once per completed turn. */
	noteTurnEnd(key: string): void {
		const state = this.ensure(key);
		state.messageCount += 1;
		this.touch(state);
	}

	/** Turns TTSR has already aborted in this conversation. */
	getInterruptCount(key: string): number {
		return this.conversations.get(key)?.interruptCount ?? 0;
	}

	/** Whether this conversation may still be interrupted (budget not spent). */
	canInterrupt(key: string): boolean {
		return this.getInterruptCount(key) < MAX_TTSR_INTERRUPTS;
	}

	/** Charge one abort against the conversation's interrupt budget. */
	noteInterrupt(key: string): void {
		const state = this.ensure(key);
		state.interruptCount += 1;
		this.touch(state);
	}

	/** Record that a rule fired, which starts its repeat cooldown. */
	noteInjection(key: string, ruleName: string): void {
		const state = this.ensure(key);
		const existing = state.rules[ruleName];
		state.rules[ruleName] = {
			lastInjectedAt: state.messageCount,
			injectionCount: (existing?.injectionCount ?? 0) + 1,
		};
		this.touch(state);
	}

	/**
	 * Whether the rule's repeat policy permits another firing right now.
	 *
	 * - `once`: eligible only until its first injection.
	 * - `after-gap`: eligible again once `repeatGap` turns have completed since
	 *   the injection turn.
	 */
	isEligible(
		rule: Pick<LoadedTtsrRule, 'name' | 'repeatMode' | 'repeatGap'>,
		key: string
	): boolean {
		const state = this.conversations.get(key);
		const ruleState = state?.rules[rule.name];
		if (!ruleState || ruleState.lastInjectedAt === null) return true;
		if (rule.repeatMode === 'once') return false;
		return (state?.messageCount ?? 0) - ruleState.lastInjectedAt >= rule.repeatGap;
	}

	/**
	 * Fold the pending bucket for `maestroSessionId` into the real conversation
	 * once the provider session id is known, so a rule that fired before the
	 * `session-id` event still counts against its repeat policy.
	 */
	adoptProviderSessionId(maestroSessionId: string, providerSessionId: string): void {
		if (!providerSessionId || providerSessionId === TTSR_PENDING_PROVIDER_ID) return;
		const pendingKey = ttsrConversationKey(maestroSessionId);
		const pending = this.conversations.get(pendingKey);
		if (!pending) return;
		this.conversations.delete(pendingKey);

		const targetKey = ttsrConversationKey(maestroSessionId, providerSessionId);
		const target = this.conversations.get(targetKey);
		if (!target) {
			this.conversations.set(targetKey, pending);
			this.touch(pending);
			return;
		}

		target.messageCount = Math.max(target.messageCount, pending.messageCount);
		// Summed, not maxed: aborts recorded before the provider id landed were
		// really spent, and the budget must not be refunded by the adoption.
		target.interruptCount += pending.interruptCount;
		for (const [ruleName, pendingRule] of Object.entries(pending.rules)) {
			const existing = target.rules[ruleName];
			target.rules[ruleName] = existing
				? {
						lastInjectedAt: Math.max(existing.lastInjectedAt ?? 0, pendingRule.lastInjectedAt ?? 0),
						injectionCount: existing.injectionCount + pendingRule.injectionCount,
					}
				: pendingRule;
		}
		this.touch(target);
	}

	/** Forget one conversation (session deleted, rules reloaded from scratch). */
	clearConversation(key: string): void {
		if (this.conversations.delete(key)) this.onChange?.();
	}

	/** Deep copy of all state, for persistence. */
	snapshot(): TtsrStateSnapshot {
		const out: TtsrStateSnapshot = {};
		for (const [key, state] of this.conversations) {
			out[key] = {
				messageCount: state.messageCount,
				rules: { ...state.rules },
				interruptCount: state.interruptCount,
				updatedAt: state.updatedAt,
			};
		}
		return out;
	}

	/**
	 * Replace all state from a persisted snapshot (app restart, session reload).
	 * Every field is re-validated: the snapshot comes off disk and a corrupted
	 * record must degrade to "this rule never fired" rather than throw on the
	 * stream's hot path.
	 *
	 * Does not fire `onChange` - hydration is the persistence layer's own write
	 * being read back, so re-scheduling a save would be a pointless round trip.
	 */
	hydrate(snapshot: TtsrStateSnapshot): void {
		this.conversations.clear();
		const now = Date.now();
		for (const [key, state] of Object.entries(snapshot ?? {})) {
			if (!state || typeof state !== 'object') continue;
			const messageCount = Number.isFinite(state.messageCount) ? state.messageCount : 0;
			const rules: Record<string, TtsrRuleState> = {};
			for (const [ruleName, ruleState] of Object.entries(state.rules ?? {})) {
				if (!ruleState || typeof ruleState !== 'object') continue;
				rules[ruleName] = {
					lastInjectedAt:
						typeof ruleState.lastInjectedAt === 'number' ? ruleState.lastInjectedAt : null,
					injectionCount: Number.isFinite(ruleState.injectionCount) ? ruleState.injectionCount : 0,
				};
			}
			// A record written before `updatedAt` existed reads as touched now, so a
			// schema upgrade never silently expires a live conversation's history.
			const updatedAt = Number.isFinite(state.updatedAt) ? state.updatedAt : now;
			// Likewise for `interruptCount`: a pre-budget record starts with a full
			// budget rather than an unusable NaN.
			const interruptCount = Number.isFinite(state.interruptCount) ? state.interruptCount : 0;
			this.conversations.set(key, { messageCount, rules, interruptCount, updatedAt });
		}
	}
}
