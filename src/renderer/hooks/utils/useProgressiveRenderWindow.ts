/**
 * useProgressiveRenderWindow - render the tail of a long list first, then
 * backfill the older head during idle time.
 *
 * Motivation (issue #1342): switching to an agent with a long transcript mounted
 * every log entry in a single synchronous React commit. Each entry runs the full
 * remark/rehype markdown pipeline, so the commit scaled linearly with transcript
 * size and blocked the main thread for seconds - the UI stayed frozen on the
 * PREVIOUS agent's view until it finished.
 *
 * This hook returns a `startIndex` into the list. Callers render
 * `items.slice(startIndex)`, which is the newest slice - the part the user is
 * actually looking at. The index then walks back toward 0 a chunk at a time on
 * `requestIdleCallback`, so the remaining history hydrates across many short
 * tasks that yield to input between them instead of one long blocking task.
 *
 * Invariants that make this safe for a live, streaming transcript:
 * - `startIndex` only ever DECREASES for a given conversation, except via the
 *   explicit `absorbPrepend` escape hatch. New items are appended at the tail,
 *   so they fall inside the window automatically and an already-rendered entry
 *   never disappears mid-session. Items prepended at the HEAD (scroll-to-top
 *   history backfill, issue #1407) are the one case that grows the index again,
 *   and only by exactly the number added, so nothing already on screen is hidden.
 * - The returned index is clamped so at least `initial` items stay visible, which
 *   keeps the view populated when entries are deleted and the list shrinks.
 * - `onBeforeExpand` fires synchronously before each expansion so the caller can
 *   snapshot scroll position; prepending content above the viewport would
 *   otherwise shift what the user is reading.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** Entries rendered in the first commit after a conversation switch. */
export const DEFAULT_INITIAL_RENDER_COUNT = 25;

/**
 * Entries added per idle tick. Deliberately small: each markdown entry can cost
 * several ms to render, so a large chunk would recreate the long-task jank this
 * hook exists to avoid.
 */
export const DEFAULT_BACKFILL_CHUNK = 8;

export interface UseProgressiveRenderWindowOptions {
	/** Entries rendered immediately. Default {@link DEFAULT_INITIAL_RENDER_COUNT}. */
	initial?: number;
	/** Entries added per idle tick. Default {@link DEFAULT_BACKFILL_CHUNK}. */
	chunk?: number;
	/** Called synchronously before each expansion (snapshot scroll position here). */
	onBeforeExpand?: () => void;
}

type IdleHandle = { kind: 'idle' | 'timeout'; id: number };

/** requestIdleCallback where available, timeout fallback otherwise (jsdom, older WebKit). */
function scheduleIdle(callback: () => void): IdleHandle {
	const ric = (
		window as unknown as {
			requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
		}
	).requestIdleCallback;
	if (typeof ric === 'function') {
		// The timeout bounds worst-case latency on a busy thread so backfill still
		// completes while the agent is streaming.
		return { kind: 'idle', id: ric(callback, { timeout: 200 }) };
	}
	return { kind: 'timeout', id: window.setTimeout(callback, 16) };
}

function cancelIdle(handle: IdleHandle): void {
	if (handle.kind === 'idle') {
		const cic = (window as unknown as { cancelIdleCallback?: (id: number) => void })
			.cancelIdleCallback;
		if (typeof cic === 'function') {
			cic(handle.id);
			return;
		}
	}
	window.clearTimeout(handle.id);
}

export interface ProgressiveRenderWindow {
	/** The index to slice from: render `items.slice(startIndex)`. */
	startIndex: number;
	/**
	 * Pull an item into the window right now, skipping the idle schedule. For
	 * jump-to-item affordances that must reach history the backfill has not
	 * reached yet - waiting for it would blow their timeout. Pass 0 to reveal all.
	 */
	revealTo: (index: number) => void;
	/**
	 * Account for `count` items just prepended at the HEAD of the list. Shifts
	 * the window by exactly that many so the visible slice is unchanged, then
	 * lets the normal idle loop walk back through the new history. Without this
	 * a scroll-to-top backfill would mount a whole page in one commit - the long
	 * task this hook exists to avoid. Call it in the same tick as the state
	 * update that grew the list so both land in one React commit.
	 */
	absorbPrepend: (count: number) => void;
}

/**
 * @param totalCount Total number of items in the list.
 * @param resetKey Identity of the list (e.g. `sessionId-tabId`). Changing it
 *   snaps the window back to the tail, for callers that are not remounted.
 */
export function useProgressiveRenderWindow(
	totalCount: number,
	resetKey: string,
	options: UseProgressiveRenderWindowOptions = {}
): ProgressiveRenderWindow {
	const {
		initial = DEFAULT_INITIAL_RENDER_COUNT,
		chunk = DEFAULT_BACKFILL_CHUNK,
		onBeforeExpand,
	} = options;

	const [startIndex, setStartIndex] = useState(() => Math.max(0, totalCount - initial));

	// Adjusting state during render when a prop changes - the React-documented
	// alternative to a reset useEffect, which would render one wasted full-list
	// frame (the exact frame this hook exists to avoid) before snapping back.
	const prevResetKeyRef = useRef(resetKey);
	if (prevResetKeyRef.current !== resetKey) {
		prevResetKeyRef.current = resetKey;
		setStartIndex(Math.max(0, totalCount - initial));
	}

	// Keep the callback in a ref so a caller passing an inline closure doesn't
	// cancel and reschedule the in-flight backfill tick on every render.
	const onBeforeExpandRef = useRef(onBeforeExpand);
	onBeforeExpandRef.current = onBeforeExpand;

	const expand = useCallback(() => {
		onBeforeExpandRef.current?.();
		setStartIndex((prev) => Math.max(0, prev - chunk));
	}, [chunk]);

	const revealTo = useCallback((index: number) => {
		// Monotonic like the idle path: only ever widens the window.
		setStartIndex((prev) => Math.min(prev, Math.max(0, index)));
	}, []);

	const absorbPrepend = useCallback((count: number) => {
		if (count <= 0) return;
		setStartIndex((prev) => prev + count);
	}, []);

	useEffect(() => {
		if (startIndex <= 0) return;
		const handle = scheduleIdle(expand);
		return () => cancelIdle(handle);
	}, [startIndex, expand]);

	// Clamp downward only: never re-hide an entry that has already been rendered,
	// but do reveal more when the list shrinks below the current window.
	return {
		startIndex: Math.min(startIndex, Math.max(0, totalCount - initial)),
		revealTo,
		absorbPrepend,
	};
}
