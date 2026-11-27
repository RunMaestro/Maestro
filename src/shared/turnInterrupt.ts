/**
 * Stopping a running turn: the wire shape every Stop path shares.
 *
 * The desktop Stop pill, the REST route (`POST /api/session/:id/interrupt`) and
 * `maestro-cli interrupt` all run one renderer function, `interruptTurn()` in
 * `src/renderer/services/turnInterrupt.ts`. Main forwards a remote stop to the
 * window that owns the agent and waits for this result, so the caller learns
 * whether anything was running and whether it stopped.
 *
 * Lives in shared/ because both processes read it: the renderer builds the
 * result, main narrows it (`parseInterruptTurnResult`) and decides which live
 * processes to wait for (`isTurnProcessInScope`).
 */

/** Why a stop did not happen. */
export type InterruptTurnCode =
	| 'AGENT_NOT_FOUND'
	| 'TAB_NOT_FOUND'
	| 'SIGNAL_FAILED'
	| 'RENDERER_UNAVAILABLE'
	| 'RENDERER_TIMEOUT';

export interface InterruptTurnResult {
	success: boolean;
	error?: string;
	code?: InterruptTurnCode;
	sessionId: string;
	/** The tab asked for; null means the whole agent (what the Stop pill stops). */
	tabId: string | null;
	/** Something in scope was running. False means the call was a no-op. */
	wasBusy: boolean;
	/** A live turn process (or a terminal command) was signalled. */
	interrupted: boolean;
	/** Tabs whose turn this call ended. */
	stoppedTabIds: string[];
	/**
	 * The queue items whose turns this call ended (the `queuedItemId` on each stopped tab's
	 * running user entry), read in the same tick as the signal. Absent from a build that does
	 * not name them, and from a stop that ended nothing; a turn sent straight from the composer
	 * has none. A Federation client tells by it which waiting message was the stopped turn.
	 */
	stoppedItemIds?: string[];
	/**
	 * Every turn process that was live when the request arrived has exited, so
	 * `tab show` and `session list` already read idle. Set by main, which owns
	 * the process table; the renderer always reports false.
	 */
	exited: boolean;
}

/** The most queue item ids a stop's answer names (`stoppedItemIds`); one per stopped tab. */
export const MAX_STOPPED_ITEM_IDS = 64;

/** The longest queue item id a stop's answer may name. */
const MAX_STOPPED_ITEM_ID_CHARS = 200;

/**
 * The `stoppedItemIds` of a stop's answer from another process or machine: strings only, each
 * bounded, at most {@link MAX_STOPPED_ITEM_IDS}. Undefined when the answer names none (a build
 * that does not name them), never a guess.
 */
export function parseStoppedItemIds(raw: unknown): string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	return raw
		.filter(
			(id): id is string =>
				typeof id === 'string' && id.length > 0 && id.length <= MAX_STOPPED_ITEM_ID_CHARS
		)
		.slice(0, MAX_STOPPED_ITEM_IDS);
}

/** How long main waits for the renderer to run the stop and answer. */
export const INTERRUPT_TURN_RENDERER_TIMEOUT_MS = 5000;

/**
 * How long main then waits for the stopped processes to leave its table. Covers
 * the stop ladder (SIGINT, SIGTERM after 2 s, SIGKILL 2 s later) with margin.
 */
export const INTERRUPT_TURN_EXIT_WAIT_MS = 6000;

/** The CLI's budget for the whole round trip: renderer answer plus exit wait. */
export const INTERRUPT_TURN_REPLY_TIMEOUT_MS = 20000;

/**
 * True when `processId` is a turn process inside the stop's scope.
 *
 * Agent scope (`tabId` null) is every `{agentId}-ai-*` process: per-tab turns,
 * their forced-parallel `-fp-<n>` siblings, and a turn the store records idle;
 * plus an Auto Run task's `{agentId}-batch-*` turn, which runs on no tab and is
 * the agent's running turn all the same (stopping it ends that task or that
 * goal iteration, and the run goes on or stops by its own flags). Tab scope is
 * that tab's process and its `-fp-<n>` siblings only. Synopsis and terminal ids
 * never match.
 */
export function isTurnProcessInScope(
	processId: string,
	agentId: string,
	tabId: string | null
): boolean {
	if (tabId === null) {
		return processId.startsWith(`${agentId}-ai-`) || processId.startsWith(`${agentId}-batch-`);
	}
	const tabProcessId = `${agentId}-ai-${tabId}`;
	return processId === tabProcessId || processId.startsWith(`${tabProcessId}-fp-`);
}

/** A failed stop, before or instead of anything being signalled. */
export function interruptTurnFailure(
	sessionId: string,
	tabId: string | null,
	code: InterruptTurnCode,
	error: string
): InterruptTurnResult {
	return {
		success: false,
		error,
		code,
		sessionId,
		tabId,
		wasBusy: false,
		interrupted: false,
		stoppedTabIds: [],
		exited: false,
	};
}

const INTERRUPT_TURN_CODES: ReadonlySet<string> = new Set<InterruptTurnCode>([
	'AGENT_NOT_FOUND',
	'TAB_NOT_FOUND',
	'SIGNAL_FAILED',
	'RENDERER_UNAVAILABLE',
	'RENDERER_TIMEOUT',
]);

/**
 * Narrow the renderer's reply. The ids always come from the request, never the
 * reply, so a malformed answer cannot redirect what the caller is told it
 * stopped. A reply that is not an object reads as a failure, never a no-op.
 */
export function parseInterruptTurnResult(
	raw: unknown,
	sessionId: string,
	tabId: string | null
): InterruptTurnResult {
	if (typeof raw !== 'object' || raw === null) {
		return interruptTurnFailure(sessionId, tabId, 'SIGNAL_FAILED', 'malformed-interrupt-result');
	}
	const r = raw as Record<string, unknown>;
	const stoppedItemIds = parseStoppedItemIds(r.stoppedItemIds);
	const code =
		typeof r.code === 'string' && INTERRUPT_TURN_CODES.has(r.code)
			? (r.code as InterruptTurnCode)
			: undefined;
	return {
		success: r.success === true,
		...(typeof r.error === 'string' && { error: r.error }),
		...(code && { code }),
		sessionId,
		tabId,
		wasBusy: r.wasBusy === true,
		interrupted: r.interrupted === true,
		stoppedTabIds: Array.isArray(r.stoppedTabIds)
			? r.stoppedTabIds.filter((id): id is string => typeof id === 'string')
			: [],
		...(stoppedItemIds ? { stoppedItemIds } : {}),
		exited: false,
	};
}
