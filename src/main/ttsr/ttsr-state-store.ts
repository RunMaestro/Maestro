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

/**
 * Build the conversation key used by every store method.
 *
 * `maestroSessionId` must be the STABLE conversation id (`{sessionId}-ai-{tabId}`),
 * not a raw spawn id: a forced-parallel turn spawns as `…-fp-{timestamp}`, so
 * keying on the raw id would mint one dead conversation record per turn. The
 * manager normalizes before it ever reaches here.
 */
export function ttsrConversationKey(
	maestroSessionId: string,
	providerSessionId?: string,
	pendingTurnId?: string
): string {
	return `${maestroSessionId}|${providerSessionId || (pendingTurnId ? `-turn:${pendingTurnId}` : TTSR_PENDING_PROVIDER_ID)}`;
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
	/** Automatic correction handoffs here. Bounded by {@link MAX_TTSR_INTERRUPTS}. */
	interruptCount: number;
	/** Epoch ms of the last mutation. Drives the persistence layer's TTL prune. */
	updatedAt: number;
}

/** Maximum automatic correction handoffs per conversation. The persisted name
 * remains compatible with older TTSR state; remaining guidance is deferred. */
export const MAX_TTSR_INTERRUPTS = 5;

/**
 * How long a conversation's bookkeeping outlives its last mutation.
 *
 * Long enough that resuming a month-old conversation still remembers what
 * already fired; short enough that the file (and this map) does not accumulate
 * every conversation the user has ever had.
 */
export const TTSR_STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Newest conversations retained once the TTL prune is not enough on its own. */
export const MAX_PERSISTED_CONVERSATIONS = 500;

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

/** In-memory repeat reservation. Only accepted guidance enters the durable history. */
export interface TtsrInjectionReservation {
	key: string;
	ruleName: string;
	messageCount: number;
}

export class TtsrStateStore {
	private readonly conversations = new Map<string, TtsrConversationState>();
	private readonly onChange?: () => void;
	private readonly reservations = new Map<string, Set<TtsrInjectionReservation>>();

	constructor(options: TtsrStateStoreOptions = {}) {
		this.onChange = options.onChange;
	}

	private ensure(key: string): TtsrConversationState {
		let state = this.conversations.get(key);
		if (!state) {
			state = emptyConversation();
			this.conversations.set(key, state);
			this.prune();
		}
		return state;
	}

	/**
	 * Bound the in-memory map with the same TTL + cap policy the persisted
	 * snapshot applies, so memory never holds what disk has already dropped.
	 *
	 * Auto Run mints a fresh Maestro session id per task, so a long-running
	 * automation would otherwise leave one live record per task behind for the
	 * life of the process. Only ever runs on the turn that creates a new
	 * conversation, past the cap - never on the stdout hot path.
	 */
	private prune(): void {
		if (this.conversations.size <= MAX_PERSISTED_CONVERSATIONS) return;

		const now = Date.now();
		for (const [key, state] of this.conversations) {
			if (now - state.updatedAt > TTSR_STATE_TTL_MS) this.clearConversation(key);
		}
		if (this.conversations.size <= MAX_PERSISTED_CONVERSATIONS) return;

		// Oldest-touched first; the conversation that just triggered this is the
		// newest, so it can never evict itself.
		const byAge = [...this.conversations.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
		const excess = this.conversations.size - MAX_PERSISTED_CONVERSATIONS;
		for (let i = 0; i < excess; i += 1) this.clearConversation(byAge[i][0]);
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
		const delivered = this.conversations.get(key)?.rules[ruleName];
		let pendingCount = 0;
		let lastInjectedAt = delivered?.lastInjectedAt ?? 0;
		for (const item of this.reservations.get(key) ?? []) {
			if (item.ruleName !== ruleName) continue;
			pendingCount += 1;
			lastInjectedAt = Math.max(lastInjectedAt, item.messageCount);
		}
		if (pendingCount === 0) return delivered ?? null;
		return { lastInjectedAt, injectionCount: (delivered?.injectionCount ?? 0) + pendingCount };
	}

	/** Advance the turn counter. Called once per completed turn. */
	noteTurnEnd(key: string): void {
		const state = this.ensure(key);
		state.messageCount += 1;
		this.touch(state);
	}

	/** Automatic correction handoffs in this conversation. */
	getInterruptCount(key: string): number {
		return this.conversations.get(key)?.interruptCount ?? 0;
	}

	/** Whether another automatic correction handoff is allowed. */
	canInterrupt(key: string): boolean {
		return this.getInterruptCount(key) < MAX_TTSR_INTERRUPTS;
	}

	/** Charge one abort against the conversation's interrupt budget. */
	noteInterrupt(key: string): void {
		const state = this.ensure(key);
		state.interruptCount += 1;
		this.touch(state);
	}

	/**
	 * Give back one abort charge for an announced abort that never happened (the
	 * signal threw, so the turn is still running). The budget counts turns TTSR
	 * really cost the user; a withdrawn abort cost none.
	 */
	refundInterrupt(key: string): void {
		const state = this.conversations.get(key);
		if (!state || state.interruptCount <= 0) return;
		state.interruptCount -= 1;
		this.touch(state);
	}

	/**
	 * Forget that a rule fired in this conversation, re-arming it immediately.
	 *
	 * Used when the guidance never reached the agent, so the cooldown it started
	 * would silence a rule that was never actually stated. The whole record is
	 * dropped rather than decremented: the previous `lastInjectedAt` is not
	 * retained, and leaving a stale one would keep an `after-gap` rule muted.
	 */
	clearInjection(key: string, ruleName: string): void {
		const state = this.conversations.get(key);
		for (const reservation of this.reservations.get(key) ?? []) {
			if (reservation.ruleName === ruleName) this.releaseInjection(reservation);
		}
		if (!state?.rules[ruleName]) return;
		delete state.rules[ruleName];
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

	/** Reserve repeat eligibility while the guidance still has no durable owner. */
	reserveInjection(
		key: string,
		ruleName: string,
		messageCount = this.getMessageCount(key)
	): TtsrInjectionReservation {
		this.ensure(key);
		const reservation = { key, ruleName, messageCount };
		let pending = this.reservations.get(key);
		if (!pending) this.reservations.set(key, (pending = new Set()));
		pending.add(reservation);
		return reservation;
	}

	/** Native held queue or successful prompt spawn now owns this guidance. */
	acceptInjection(reservation: TtsrInjectionReservation): void {
		if (!this.reservations.get(reservation.key)?.has(reservation)) return;
		this.releaseInjection(reservation);
		const state = this.ensure(reservation.key);
		const existing = state.rules[reservation.ruleName];
		state.rules[reservation.ruleName] = {
			lastInjectedAt: Math.max(existing?.lastInjectedAt ?? 0, reservation.messageCount),
			injectionCount: (existing?.injectionCount ?? 0) + 1,
		};
		this.touch(state);
	}

	/** Undelivered/evicted guidance must not silence its rule. */
	releaseInjection(reservation: TtsrInjectionReservation): void {
		const pending = this.reservations.get(reservation.key);
		pending?.delete(reservation);
		if (pending?.size === 0) this.reservations.delete(reservation.key);
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
		key: string,
		messageCount = this.getMessageCount(key)
	): boolean {
		const ruleState = this.getRuleState(key, rule.name);
		if (!ruleState || ruleState.lastInjectedAt === null) return true;
		if (rule.repeatMode === 'once') return false;
		return messageCount - ruleState.lastInjectedAt >= rule.repeatGap;
	}

	/**
	 * Fold the pending bucket for `maestroSessionId` into the real conversation
	 * once the provider session id is known, so a rule that fired before the
	 * `session-id` event still counts against its repeat policy.
	 */
	adoptProviderSessionId(maestroSessionId: string, providerSessionId: string): void {
		if (!providerSessionId || providerSessionId === TTSR_PENDING_PROVIDER_ID) return;
		this.moveConversation(
			ttsrConversationKey(maestroSessionId),
			ttsrConversationKey(maestroSessionId, providerSessionId)
		);
	}

	/** Transfer only one turn's unknown-provider history, never its live siblings'. */
	adoptPendingTurn(maestroSessionId: string, turnId: string, providerSessionId?: string): void {
		this.moveConversation(
			ttsrConversationKey(maestroSessionId, undefined, turnId),
			ttsrConversationKey(maestroSessionId, providerSessionId),
			!!providerSessionId
		);
	}

	private moveConversation(pendingKey: string, targetKey: string, notify = true): void {
		if (pendingKey === targetKey) return;
		const pending = this.conversations.get(pendingKey);
		if (!pending) return;
		this.conversations.delete(pendingKey);
		const reservations = this.reservations.get(pendingKey);
		if (reservations) {
			this.reservations.delete(pendingKey);
			let target = this.reservations.get(targetKey);
			if (!target) this.reservations.set(targetKey, (target = new Set()));
			for (const reservation of reservations) {
				reservation.key = targetKey;
				target.add(reservation);
			}
		}

		const target = this.conversations.get(targetKey);
		if (!target) {
			this.conversations.set(targetKey, pending);
			if (notify) this.touch(pending);
			return;
		}

		this.mergeState(target, pending);
		if (notify) this.touch(target);
	}

	/** Same merge policy for adoption and normalized durable snapshots. */
	private mergeState(target: TtsrConversationState, pending: TtsrConversationState): void {
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
		target.updatedAt = Math.max(target.updatedAt, pending.updatedAt);
	}

	/** Forget one conversation (session deleted, rules reloaded from scratch). */
	clearConversation(key: string): void {
		this.reservations.delete(key);
		if (this.conversations.delete(key)) this.onChange?.();
	}

	/** Deep copy of all state, for persistence. */
	snapshot(): TtsrStateSnapshot {
		const out: TtsrStateSnapshot = {};
		for (const [key, state] of this.conversations) {
			// Pending raw turn IDs are only live ownership. Persist their accepted
			// history in the stable pending bucket, so fp timestamps cannot accrete.
			const stableKey = key.replace(/\|-turn:.*$/, `|${TTSR_PENDING_PROVIDER_ID}`);
			const copied = {
				messageCount: state.messageCount,
				rules: { ...state.rules },
				interruptCount: state.interruptCount,
				updatedAt: state.updatedAt,
			};
			if (out[stableKey]) this.mergeState(out[stableKey], copied);
			else out[stableKey] = copied;
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
		this.reservations.clear();
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
		// The persistence layer prunes on read too; this keeps a snapshot handed in
		// from anywhere else (a test, a future importer) under the same bound.
		this.prune();
	}
}
