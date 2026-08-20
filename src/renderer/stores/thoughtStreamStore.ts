/**
 * thoughtStreamStore - live introspection of an agent's thinking/reasoning
 * stream for an Auto Run (goal-based or task/spec-driven).
 *
 * This is a deliberately separate path from `useAgentThinkingListener`, which
 * only records thinking into a tab's logs when that tab's `showThinking` mode
 * is on. Auto Run agents frequently run with thinking display off, so reading
 * from those logs would capture nothing. Here we tap the raw
 * `process:thinking-chunk` IPC stream directly and buffer it in memory,
 * independent of the per-tab display setting.
 *
 * Capture is AMBIENT: every thinking chunk an owned session emits is buffered
 * whether or not the panel is open. That is the whole point of the feature -
 * you go looking at the thought stream BECAUSE a run has been hanging, and if
 * capture only started when you opened the panel you would be handed an empty
 * log at exactly the moment you need the history. Nothing is buffered for an
 * agent that never thinks, so an idle app pays nothing.
 *
 * Lifecycle (driven by the panel UI):
 * - Open:     show the panel for a session, already backfilled with history.
 * - Minimize: collapse the panel to the Auto Run card affordance.
 * - Close:    hide the panel. The buffer survives, so reopening still shows
 *             the run's reasoning; `clearBuffer` is the explicit discard.
 *
 * Capture is in-memory only - buffers do not survive an app restart. Memory is
 * bounded on three axes so an all-day fleet of agents cannot grow without
 * limit: entries per session, characters per session, and how many sessions
 * retain a buffer at all (least-recently-active evicted first). A `trimmed`
 * flag surfaces per-session dropping in the UI.
 */

import { create } from 'zustand';
import { generateId } from '../utils/ids';

/** A single captured unit of thinking (one coalesced stream flush). */
export interface ThoughtEntry {
	id: string;
	timestamp: number;
	/** AI tab the thought came from (a session can run parallel tabs). */
	tabId: string;
	text: string;
}

/** Per-session capture buffer. */
export interface ThoughtBuffer {
	entries: ThoughtEntry[];
	/** True once a cap forced us to drop the oldest thoughts. */
	trimmed: boolean;
	/** Running character total, maintained incrementally to keep trimming O(dropped). */
	chars: number;
	/** Timestamp of the newest thought - drives cross-session LRU eviction. */
	lastAppendAt: number;
}

/**
 * A display-time grouping of consecutive thought entries. The capture path emits
 * one entry per coalesced stream flush, which is far too granular to stamp
 * individually. We instead group a continuous run of thinking into one block - a
 * single timestamp + the concatenated text - and start a fresh block when the
 * agent pauses (gap > THOUGHT_BLOCK_GAP_MS) or a different tab streams.
 */
export interface ThoughtBlock {
	/** Id of the first entry in the block (stable React key). */
	id: string;
	/** When the block's first thought arrived. */
	startTimestamp: number;
	/** When the block's most recent thought arrived. */
	endTimestamp: number;
	/** AI tab the block came from. */
	tabId: string;
	/** Concatenated text of every entry in the block. */
	text: string;
}

/**
 * Pause (ms) that ends one thought block and starts the next. Within active
 * thinking, coalesced flushes arrive sub-second; iteration boundaries, tool
 * calls, and agent re-spawns leave multi-second gaps. 3s splits those cleanly
 * without fragmenting a single reasoning paragraph.
 */
export const THOUGHT_BLOCK_GAP_MS = 3000;

/**
 * Group a chronological entry list into display blocks (oldest-first). The
 * caller reverses for newest-on-top display. Pure - safe to memoize on entries.
 */
export function groupThoughtsIntoBlocks(
	entries: ThoughtEntry[],
	gapMs: number = THOUGHT_BLOCK_GAP_MS
): ThoughtBlock[] {
	const blocks: ThoughtBlock[] = [];
	for (const entry of entries) {
		const last = blocks[blocks.length - 1];
		if (last && last.tabId === entry.tabId && entry.timestamp - last.endTimestamp <= gapMs) {
			last.text += entry.text;
			last.endTimestamp = entry.timestamp;
		} else {
			blocks.push({
				id: entry.id,
				startTimestamp: entry.timestamp,
				endTimestamp: entry.timestamp,
				tabId: entry.tabId,
				text: entry.text,
			});
		}
	}
	return blocks;
}

/**
 * Max thoughts retained per session. A long run trims oldest-first past this.
 * ~5k coalesced flushes is plenty of scrollback while bounding memory.
 */
export const MAX_THOUGHTS_PER_SESSION = 5000;

/**
 * Max characters retained per session (~1MB of UTF-16 text). The entry cap
 * alone does not bound memory: one flush can carry a whole reasoning paragraph,
 * so 5k entries could be tens of megabytes. This is the cap that actually holds
 * under an all-day run.
 */
export const MAX_THOUGHT_CHARS_PER_SESSION = 500_000;

/**
 * Max sessions retaining a buffer at once. Ambient capture means a fleet of
 * agents all buffer in parallel, so the least-recently-active session's buffer
 * is dropped past this. The focused panel session is never evicted.
 */
export const MAX_CAPTURED_SESSIONS = 12;

/**
 * How long after the last captured thought a session still counts as "live".
 * Purely a display affordance (pulsing brain, "live" label) - capture itself
 * never stops.
 */
export const THOUGHT_LIVE_WINDOW_MS = 5000;

/** An empty buffer, used when a session thinks for the first time. */
function emptyBuffer(): ThoughtBuffer {
	return { entries: [], trimmed: false, chars: 0, lastAppendAt: 0 };
}

/**
 * Drop the least-recently-active session buffers until at most
 * MAX_CAPTURED_SESSIONS remain. `protectedIds` (the session that just appended
 * and the focused panel session) are never evicted.
 */
function evictColdSessions(
	buffers: Record<string, ThoughtBuffer>,
	protectedIds: (string | null)[]
): Record<string, ThoughtBuffer> {
	const ids = Object.keys(buffers);
	if (ids.length <= MAX_CAPTURED_SESSIONS) return buffers;
	const keep = new Set(protectedIds.filter((id): id is string => !!id));
	const evictable = ids
		.filter((id) => !keep.has(id))
		.sort((a, b) => buffers[a].lastAppendAt - buffers[b].lastAppendAt);
	const next = { ...buffers };
	let overflow = ids.length - MAX_CAPTURED_SESSIONS;
	for (const id of evictable) {
		if (overflow <= 0) break;
		delete next[id];
		overflow--;
	}
	return next;
}

interface ThoughtStreamState {
	/** Session whose panel is currently focused/visible (null = panel hidden). */
	panelSessionId: string | null;
	/** Whether the visible panel is minimized to the status bar. */
	minimized: boolean;
	/** Per-session capture buffers, written whether or not the panel is open. */
	buffers: Record<string, ThoughtBuffer>;

	/** Open (or refocus) the panel for a session, backfilled with its buffer. */
	openPanel: (sessionId: string) => void;
	/** Collapse the panel to the Auto Run card affordance. */
	minimizePanel: () => void;
	/** Restore the panel from the minimized state. */
	restorePanel: () => void;
	/** Hide the panel. Buffers keep filling so a later reopen still has history. */
	closePanel: () => void;
	/** Append a coalesced thinking flush to a session's buffer. */
	appendThought: (sessionId: string, tabId: string, text: string) => void;
	/** Discard a session's buffered thoughts (explicit user action). */
	clearBuffer: (sessionId: string) => void;
}

export const useThoughtStreamStore = create<ThoughtStreamState>((set) => ({
	panelSessionId: null,
	minimized: false,
	buffers: {},

	openPanel: (sessionId) =>
		set((state) => ({
			panelSessionId: sessionId,
			minimized: false,
			// Ambient capture usually got here first; seed an empty buffer only so
			// the panel has something to render for a session that has not thought.
			buffers: state.buffers[sessionId]
				? state.buffers
				: { ...state.buffers, [sessionId]: emptyBuffer() },
		})),

	minimizePanel: () => set({ minimized: true }),

	restorePanel: () => set({ minimized: false }),

	closePanel: () => set({ panelSessionId: null, minimized: false }),

	appendThought: (sessionId, tabId, text) =>
		set((state) => {
			if (!text) return state;
			const prev = state.buffers[sessionId] ?? emptyBuffer();
			const timestamp = Date.now();
			const entry: ThoughtEntry = { id: generateId(), timestamp, tabId, text };

			let entries = prev.entries.concat(entry);
			let chars = prev.chars + text.length;
			let trimmed = prev.trimmed;

			if (entries.length > MAX_THOUGHTS_PER_SESSION) {
				const dropCount = entries.length - MAX_THOUGHTS_PER_SESSION;
				for (let i = 0; i < dropCount; i++) chars -= entries[i].text.length;
				entries = entries.slice(dropCount);
				trimmed = true;
			}
			// Drop whole oldest entries until the character budget is met. The
			// newest entry always survives, even if it alone exceeds the budget.
			let dropped = 0;
			while (chars > MAX_THOUGHT_CHARS_PER_SESSION && dropped < entries.length - 1) {
				chars -= entries[dropped].text.length;
				dropped++;
			}
			if (dropped > 0) {
				entries = entries.slice(dropped);
				trimmed = true;
			}

			const buffers = {
				...state.buffers,
				[sessionId]: { entries, trimmed, chars, lastAppendAt: timestamp },
			};
			return { buffers: evictColdSessions(buffers, [sessionId, state.panelSessionId]) };
		}),

	clearBuffer: (sessionId) =>
		set((state) => ({
			buffers: { ...state.buffers, [sessionId]: emptyBuffer() },
		})),
}));

/** Selector: how many thoughts are buffered for a session. */
export function selectThoughtCount(sessionId: string | undefined | null) {
	return (state: ThoughtStreamState): number =>
		sessionId ? (state.buffers[sessionId]?.entries.length ?? 0) : 0;
}

/**
 * Selector: has this session produced a thought within the live window? Used
 * for the pulsing "thinking right now" affordance. Callers that need it to go
 * stale on its own must re-render on a timer - `selectLastAppendAt` gives them
 * the timestamp to schedule against.
 */
export function selectLastAppendAt(sessionId: string | undefined | null) {
	return (state: ThoughtStreamState): number =>
		sessionId ? (state.buffers[sessionId]?.lastAppendAt ?? 0) : 0;
}

/** True when a thought arrived recently enough to call the stream live. */
export function isThoughtStreamLive(lastAppendAt: number, now: number = Date.now()): boolean {
	return lastAppendAt > 0 && now - lastAppendAt <= THOUGHT_LIVE_WINDOW_MS;
}
