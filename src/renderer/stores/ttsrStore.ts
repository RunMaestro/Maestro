/**
 * Renderer-side TTSR display cache.
 *
 * Gate B of the TTSR plan: main owns every authoritative bit of TTSR state
 * (matching, repeat policy, injected-rule records). Nothing here is a source of
 * truth - it is a cache of the last push events so exit handling can tell a TTSR
 * abort apart from a failed turn.
 *
 * The {@link TtsrStore.matches} map is the display side of the same deal: it
 * counts `ttsr:matched` pushes so a non-interrupting rule is visible somewhere
 * instead of firing in total silence. Those counts are per-renderer and since
 * app start (in a browser client, since this browser session) - they are NOT
 * persisted and are NOT the injection counts main keeps in `ttsr-state.json`.
 */

import { create } from 'zustand';
import type {
	TtsrAbortPendingPayload,
	TtsrMatchedPayload,
	TtsrScope,
	TtsrTriggeredPayload,
} from '../../shared/ttsr-types';

/**
 * How long an abort-pending mark may suppress a turn's exit.
 *
 * The mark is normally cleared by `ttsr:triggered` or `ttsr:abortCleared`, but
 * neither arrives if main dies mid-abort or the renderer stops listening (the
 * Encore flag flipped off between the two events). An entry that outlives this
 * would suppress EVERY future exit on that session id until the app reloads, so
 * it stops counting instead. The driver's own exit-wait is 5 seconds; 30 is
 * generous enough that no live abort is ever cut short.
 */
export const TTSR_ABORT_PENDING_TTL_MS = 30_000;

interface TtsrAbortPendingEntry {
	payload: TtsrAbortPendingPayload;
	/** When the mark was set, for the {@link TTSR_ABORT_PENDING_TTL_MS} check. */
	at: number;
}

/** What the Rules panel shows for one rule that has fired this session. */
export interface TtsrRuleMatchStats {
	count: number;
	lastMatchedAt: number;
	lastSource: TtsrScope;
	/** True when the last match was allowed to abort the turn. */
	lastWillInterrupt: boolean;
	lastFilePath?: string;
}

/**
 * Key for the {@link TtsrStore.matches} map.
 *
 * Rule paths are project-relative, so two projects can hold a rule at the same
 * path. The NUL separator cannot occur in either half, so the pair is
 * unambiguous no matter what the path or the root looks like.
 */
export function matchKey(projectRoot: string, rulePath: string): string {
	return `${projectRoot}\u0000${rulePath}`;
}

interface TtsrStore {
	/** Turns currently being aborted by TTSR, keyed by process session id. */
	abortPending: Record<string, TtsrAbortPendingEntry>;
	/** Last corrective turn per process session id. Recorded but not yet surfaced by any component. */
	lastTriggered: Record<string, TtsrTriggeredPayload>;
	/**
	 * Per-rule match stats keyed by {@link matchKey}, surfaced as the Rules
	 * panel's match line. Bounded by the number of rules on disk, so it needs no
	 * eviction.
	 */
	matches: Record<string, TtsrRuleMatchStats>;
	noteAbortPending: (payload: TtsrAbortPendingPayload) => void;
	noteTriggered: (payload: TtsrTriggeredPayload) => void;
	/** Record a `ttsr:matched` push against every rule it names. */
	noteMatched: (projectRoot: string, payload: TtsrMatchedPayload) => void;
	clearAbortPending: (sessionId: string) => void;
	/** Drop every mark at once (the hook unmounting, or TTSR being turned off). */
	clearAllAbortPending: () => void;
}

export const useTtsrStore = create<TtsrStore>()((set) => ({
	abortPending: {},
	lastTriggered: {},
	matches: {},

	noteAbortPending: (payload) =>
		set((state) => ({
			abortPending: {
				...state.abortPending,
				[payload.sessionId]: { payload, at: Date.now() },
			},
		})),

	noteTriggered: (payload) =>
		set((state) => {
			// The abort is over the moment the corrective payload lands: the process
			// has already exited and the respawn is about to run.
			const { [payload.sessionId]: _done, ...abortPending } = state.abortPending;
			return {
				abortPending,
				lastTriggered: { ...state.lastTriggered, [payload.sessionId]: payload },
			};
		}),

	noteMatched: (projectRoot, payload) =>
		set((state) => {
			if (payload.rules.length === 0) return state;
			const at = Date.now();
			const matches = { ...state.matches };
			for (const rule of payload.rules) {
				const key = matchKey(projectRoot, rule.path);
				matches[key] = {
					count: (matches[key]?.count ?? 0) + 1,
					lastMatchedAt: at,
					lastSource: payload.source,
					lastWillInterrupt: payload.willInterrupt,
					lastFilePath: payload.filePath,
				};
			}
			return { ...state, matches };
		}),

	clearAbortPending: (sessionId) =>
		set((state) => {
			if (!(sessionId in state.abortPending)) return state;
			const { [sessionId]: _dropped, ...abortPending } = state.abortPending;
			return { ...state, abortPending };
		}),

	clearAllAbortPending: () =>
		set((state) =>
			Object.keys(state.abortPending).length === 0 ? state : { ...state, abortPending: {} }
		),
}));

/**
 * True while TTSR is aborting this turn - i.e. the `ttsrAbortPending` flag.
 *
 * Callable outside React (exit listeners run from IPC callbacks), so it reads
 * the store directly rather than subscribing. A mark older than
 * {@link TTSR_ABORT_PENDING_TTL_MS} is treated as orphaned: it stops suppressing
 * and is dropped, so a lost `triggered`/`abortCleared` costs one turn rather
 * than every exit for the rest of the app's life.
 */
export function isTtsrAbortPending(sessionId: string): boolean {
	const entry = useTtsrStore.getState().abortPending[sessionId];
	if (!entry) return false;
	if (Date.now() - entry.at <= TTSR_ABORT_PENDING_TTL_MS) return true;
	useTtsrStore.getState().clearAbortPending(sessionId);
	return false;
}
