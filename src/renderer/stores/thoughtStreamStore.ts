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
 * Lifecycle (driven by the panel UI):
 * - Open:     start capturing for a session and show the panel.
 * - Minimize: collapse the panel to a status bar; capture KEEPS running so the
 *             user can come back and introspect later.
 * - Close:    stop capturing AND clear that session's buffer.
 *
 * Capture is in-memory only - buffers do not survive an app restart. Each
 * session's buffer is bounded (oldest thoughts dropped past the cap) so a long
 * run can't grow memory without limit; a `trimmed` flag surfaces that in the UI.
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
	/** True once the cap forced us to drop the oldest thoughts. */
	trimmed: boolean;
}

/**
 * A display-time grouping of consecutive thought entries. The capture path emits
 * one entry per coalesced stream flush (~per frame), which is far too granular to
 * stamp individually. We instead group a continuous run of thinking into one
 * block - a single timestamp + the concatenated text - and start a fresh block
 * when the agent pauses (gap > THOUGHT_BLOCK_GAP_MS) or a different tab streams.
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

interface ThoughtStreamState {
	/** Session whose panel is currently focused/visible (null = panel hidden). */
	panelSessionId: string | null;
	/** Whether the visible panel is minimized to the status bar. */
	minimized: boolean;
	/** Per-session capture buffers (may include minimized/background captures). */
	buffers: Record<string, ThoughtBuffer>;
	/** Which sessions are actively capturing chunks. */
	capturing: Record<string, boolean>;

	/** Open (or refocus) the panel for a session and begin capturing. */
	openPanel: (sessionId: string) => void;
	/** Collapse the panel to the status bar; capture continues. */
	minimizePanel: () => void;
	/** Restore the panel from the minimized status bar. */
	restorePanel: () => void;
	/** Hide the panel, stop capturing, and clear the focused session's buffer. */
	closePanel: () => void;
	/** Stop capturing a session and clear its buffer. */
	stopCapture: (sessionId: string) => void;
	/** Append a coalesced thinking flush to a session's buffer (no-op if not capturing). */
	appendThought: (sessionId: string, tabId: string, text: string) => void;
	/** Clear a session's buffer without stopping capture. */
	clearBuffer: (sessionId: string) => void;
}

export const useThoughtStreamStore = create<ThoughtStreamState>((set, get) => ({
	panelSessionId: null,
	minimized: false,
	buffers: {},
	capturing: {},

	openPanel: (sessionId) =>
		set((state) => ({
			panelSessionId: sessionId,
			minimized: false,
			capturing: { ...state.capturing, [sessionId]: true },
			// Preserve any existing buffer (e.g. reopening a minimized session);
			// otherwise start a fresh one.
			buffers: state.buffers[sessionId]
				? state.buffers
				: { ...state.buffers, [sessionId]: { entries: [], trimmed: false } },
		})),

	minimizePanel: () => set({ minimized: true }),

	restorePanel: () => set({ minimized: false }),

	closePanel: () => {
		const { panelSessionId } = get();
		if (panelSessionId) {
			get().stopCapture(panelSessionId);
		}
		set({ panelSessionId: null, minimized: false });
	},

	stopCapture: (sessionId) =>
		set((state) => {
			const capturing = { ...state.capturing };
			delete capturing[sessionId];
			const buffers = { ...state.buffers };
			delete buffers[sessionId];
			return { capturing, buffers };
		}),

	appendThought: (sessionId, tabId, text) =>
		set((state) => {
			if (!state.capturing[sessionId] || !text) return state;
			const prev = state.buffers[sessionId] ?? { entries: [], trimmed: false };
			const entry: ThoughtEntry = {
				id: generateId(),
				timestamp: Date.now(),
				tabId,
				text,
			};
			let entries = [...prev.entries, entry];
			let trimmed = prev.trimmed;
			if (entries.length > MAX_THOUGHTS_PER_SESSION) {
				entries = entries.slice(entries.length - MAX_THOUGHTS_PER_SESSION);
				trimmed = true;
			}
			return {
				buffers: { ...state.buffers, [sessionId]: { entries, trimmed } },
			};
		}),

	clearBuffer: (sessionId) =>
		set((state) => ({
			buffers: { ...state.buffers, [sessionId]: { entries: [], trimmed: false } },
		})),
}));

/** Selector: is a given session actively capturing its thought stream? */
export function selectIsCapturing(sessionId: string | undefined | null) {
	return (state: ThoughtStreamState): boolean => !!sessionId && !!state.capturing[sessionId];
}
