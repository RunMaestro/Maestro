/**
 * context-timeline-log - a bounded, in-memory record of the RAW per-turn usage
 * captures that main fans out on `process:usage`.
 *
 * Why this exists (finding S1): `contextTimelineStore` in the renderer is the
 * only place turn history lives, and it is populated exclusively by live
 * `process:usage` events. Every fresh renderer therefore opens the Context
 * Timeline at zero turns - a web-desktop client, a window reload, and a second
 * desktop window all start empty even when the agent has a long history in
 * another renderer. Main sees every event, so main keeps the log and serves it
 * over IPC (`contextTimeline:getCaptures`).
 *
 * What is stored is deliberately the RAW `UsageStats` (decision 2 of the S1
 * decision record), not a finished timeline point. The four skip guards and the
 * context-window precedence that turn a usage event into a point live only in
 * the renderer (`useAgentUsageListener` / `buildContextTimelinePoint`), and the
 * precedence is under active change. The renderer replays these raw captures
 * through that exact code, so guards and precedence are reproduced by
 * construction instead of forked into main.
 *
 * Memory-only by design (decision 3): this dies with the app, so a full restart
 * legitimately shows an empty timeline. Disk persistence is a follow-up.
 */

import type { UsageStats } from './types';

/**
 * Max captures retained per raw session id. Mirrors `MAX_POINTS_PER_SESSION`
 * in `src/renderer/stores/contextTimelineStore.ts` - the renderer buffer is the
 * consumer, so a larger log here would only be trimmed away on arrival.
 */
export const MAX_CAPTURES_PER_SESSION = 2000;

/** One raw usage event as main saw it, with a monotonic dedup watermark. */
export interface UsageCapture {
	/** Process-wide monotonic sequence number; also stamped onto the live event. */
	seq: number;
	/** When main received the event. */
	timestamp: number;
	/** The RAW session id (may be `{base}-ai-{tab}`, `{base}-synopsis-{ts}`, ...). */
	sessionId: string;
	/** The unmodified usage payload that went out on `process:usage`. */
	usageStats: UsageStats;
}

/** What `getUsageCaptures` returns for one agent (base) session. */
export interface UsageCaptureQueryResult {
	captures: UsageCapture[];
	/** True once the cap forced the oldest captures to be dropped. */
	trimmed: boolean;
}

interface SessionCaptureLog {
	captures: UsageCapture[];
	trimmed: boolean;
}

/**
 * Keyed by the RAW session id. Main has no `parseSessionId` (it exists only in
 * `src/renderer/utils/sessionIdParser.ts`) and porting it here would fork the
 * one parser, so retrieval below does a cheap PREFIX superset match and the
 * renderer - which does have the parser - filters the result down to an exact
 * base-session match. A false positive can therefore never reach the timeline.
 */
const logsByRawSessionId = new Map<string, SessionCaptureLog>();

let nextSeq = 1;

/**
 * Record one raw usage event.
 *
 * @returns the monotonic `seq` assigned to it, so the caller can stamp the same
 * number onto the outgoing live event and give the renderer an exact dedup key.
 */
export function appendUsageCapture(sessionId: string, usageStats: UsageStats): number {
	const seq = nextSeq++;
	if (!sessionId) return seq;

	let log = logsByRawSessionId.get(sessionId);
	if (!log) {
		log = { captures: [], trimmed: false };
		logsByRawSessionId.set(sessionId, log);
	}

	log.captures.push({ seq, timestamp: Date.now(), sessionId, usageStats });
	if (log.captures.length > MAX_CAPTURES_PER_SESSION) {
		log.captures.splice(0, log.captures.length - MAX_CAPTURES_PER_SESSION);
		log.trimmed = true;
	}

	return seq;
}

/** True when `rawId` is `baseSessionId` itself or one of its derived ids. */
function belongsToBaseSession(rawId: string, baseSessionId: string): boolean {
	return rawId === baseSessionId || rawId.startsWith(`${baseSessionId}-`);
}

/**
 * Every capture belonging to an agent (base) session, oldest first.
 *
 * Parallel AI tabs of one agent produce separate raw ids, so this merges them
 * into a single seq-ordered stream - the same order the renderer's live
 * listener appended them in, since `seq` is assigned at emit time.
 */
export function getUsageCaptures(baseSessionId: string): UsageCaptureQueryResult {
	if (!baseSessionId) return { captures: [], trimmed: false };

	let captures: UsageCapture[] = [];
	let trimmed = false;
	for (const [rawId, log] of logsByRawSessionId) {
		if (!belongsToBaseSession(rawId, baseSessionId)) continue;
		captures = captures.concat(log.captures);
		trimmed = trimmed || log.trimmed;
	}

	captures.sort((a, b) => a.seq - b.seq);
	// A multi-tab agent can hold up to the per-raw-id cap in each tab, so the
	// merged stream is capped again before it crosses the wire.
	if (captures.length > MAX_CAPTURES_PER_SESSION) {
		captures = captures.slice(captures.length - MAX_CAPTURES_PER_SESSION);
		trimmed = true;
	}

	return { captures, trimmed };
}

/** Drop every capture for an agent (base) session - call when the agent is deleted. */
export function removeSessionCaptures(baseSessionId: string): void {
	if (!baseSessionId) return;
	for (const rawId of [...logsByRawSessionId.keys()]) {
		if (belongsToBaseSession(rawId, baseSessionId)) {
			logsByRawSessionId.delete(rawId);
		}
	}
}

/** Test-only reset of the module-level log and seq counter. */
export function __resetUsageCaptureLogForTests(): void {
	logsByRawSessionId.clear();
	nextSeq = 1;
}
