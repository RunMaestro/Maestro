/**
 * thoughtStreamStore - live introspection of an agent's thinking/reasoning
 * stream AND its tool calls, for both Auto Runs and interactive sessions.
 *
 * This is a deliberately separate path from `useAgentThinkingListener` /
 * `useAgentToolExecutionListener`, which only record thinking and tool cells
 * into a tab's logs when that tab's `showThinking` mode is on. Auto Run agents
 * frequently run with thinking display off, so reading from those logs would
 * capture nothing. Here we tap the raw `process:thinking-chunk` and
 * `process:tool-execution` IPC streams directly and buffer them in memory,
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

/** Lifecycle status of a captured tool call. */
export type ToolActivityStatus = 'running' | 'completed' | 'failed';

/**
 * One tool call the agent made, reduced to a single plain-language line.
 *
 * A tool call arrives as two or more events (`running`, then
 * `completed`/`failed`); they are merged into ONE entry so the feed reads as a
 * list of actions rather than a list of state transitions.
 */
export interface ToolActivityEntry {
	id: string;
	/** When the tool call STARTED (the entry keeps its place in the feed). */
	timestamp: number;
	/** AI tab (or batch stream id) the call came from. */
	tabId: string;
	/** Provider correlation id, when the agent supplies one. */
	toolCallId?: string;
	/** Raw provider tool name, kept for search and tooltips. */
	toolName: string;
	/** Plain-language verb phrase, e.g. `Read`. */
	verb: string;
	/** Plain-language target, e.g. `src/App.tsx`. May be empty. */
	target: string;
	status: ToolActivityStatus;
}

/** Per-session capture buffer. */
export interface ThoughtBuffer {
	entries: ThoughtEntry[];
	/** Tool calls captured for this session, oldest-first. */
	activities: ToolActivityEntry[];
	/** True once the cap forced us to drop the oldest thoughts or activities. */
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
 * One row of the rendered feed: either a block of reasoning or a single tool
 * call. Discriminated so the panel can render each with its own treatment while
 * keeping ONE chronological list (a tool call that happened mid-paragraph should
 * appear between the two halves of that paragraph, not in a separate column).
 */
export type ActivityFeedItem =
	| { kind: 'thought'; id: string; timestamp: number; block: ThoughtBlock }
	| { kind: 'tool'; id: string; timestamp: number; activity: ToolActivityEntry };

/**
 * Merge thought blocks and tool calls into one oldest-first feed.
 *
 * Ties are broken toward the tool call: a tool call's timestamp is the instant it
 * was dispatched, which is the same instant the thinking block that decided on it
 * stops growing, so on a tie the tool belongs after the reasoning.
 *
 * Pure - safe to memoize on (blocks, activities).
 */
export function buildActivityFeed(
	blocks: ThoughtBlock[],
	activities: ToolActivityEntry[]
): ActivityFeedItem[] {
	const items: ActivityFeedItem[] = [
		...blocks.map((block) => ({
			kind: 'thought' as const,
			id: block.id,
			timestamp: block.startTimestamp,
			block,
		})),
		...activities.map((activity) => ({
			kind: 'tool' as const,
			id: activity.id,
			timestamp: activity.timestamp,
			activity,
		})),
	];
	return items.sort((a, b) => {
		if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
		if (a.kind === b.kind) return 0;
		return a.kind === 'thought' ? -1 : 1;
	});
}

/**
 * Max thoughts retained per session. A long run trims oldest-first past this.
 * ~5k coalesced flushes is plenty of scrollback while bounding memory.
 */
export const MAX_THOUGHTS_PER_SESSION = 5000;

/**
 * Max tool calls retained per session. Tool calls arrive orders of magnitude
 * less often than coalesced thinking flushes (one per action, not one per
 * frame), so a much smaller cap still covers a very long run.
 */
export const MAX_ACTIVITIES_PER_SESSION = 2000;

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
	/**
	 * Record a tool call, merging a `completed`/`failed` event into the matching
	 * `running` entry rather than appending a second line. No-op if not capturing.
	 */
	appendToolActivity: (
		sessionId: string,
		tabId: string,
		activity: {
			toolName: string;
			verb: string;
			target: string;
			status: ToolActivityStatus;
			toolCallId?: string;
			timestamp: number;
		}
	) => void;
	/** Clear a session's buffer without stopping capture. */
	clearBuffer: (sessionId: string) => void;
}

/** A fresh, empty capture buffer. */
function emptyBuffer(): ThoughtBuffer {
	return { entries: [], activities: [], trimmed: false };
}

/**
 * Find the entry a finalizing tool event belongs to, or -1 to append a new one.
 *
 * Providers that emit a `toolCallId` (Claude Code, OpenCode) are matched by id.
 * Codex and similar do not, so a `completed`/`failed` event is attributed to the
 * most recent still-`running` entry with the same tool name in the same tab -
 * the same rule `useAgentToolExecutionListener` uses for in-chat tool cells.
 */
function findActivityIndex(
	activities: ToolActivityEntry[],
	tabId: string,
	toolName: string,
	status: ToolActivityStatus,
	toolCallId?: string
): number {
	if (toolCallId) {
		return activities.findIndex((a) => a.toolCallId === toolCallId);
	}
	if (status === 'running') return -1;
	for (let i = activities.length - 1; i >= 0; i--) {
		const candidate = activities[i];
		if (
			candidate.tabId === tabId &&
			candidate.toolName === toolName &&
			candidate.status === 'running'
		) {
			return i;
		}
	}
	return -1;
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
				: { ...state.buffers, [sessionId]: emptyBuffer() },
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
			const prev = state.buffers[sessionId] ?? emptyBuffer();
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
				buffers: { ...state.buffers, [sessionId]: { ...prev, entries, trimmed } },
			};
		}),

	appendToolActivity: (sessionId, tabId, activity) =>
		set((state) => {
			if (!state.capturing[sessionId] || !activity.toolName) return state;
			const prev = state.buffers[sessionId] ?? emptyBuffer();
			const existingIdx = findActivityIndex(
				prev.activities,
				tabId,
				activity.toolName,
				activity.status,
				activity.toolCallId
			);

			let activities: ToolActivityEntry[];
			let trimmed = prev.trimmed;
			if (existingIdx >= 0) {
				const existing = prev.activities[existingIdx];
				// Keep the original start timestamp so the entry does not jump to the
				// top of the feed when it finishes, and keep the richer label: the
				// `running` event carries the tool input, the finalizing one often
				// carries only a status.
				const merged: ToolActivityEntry = {
					...existing,
					status: activity.status,
					verb: activity.target ? activity.verb : existing.verb,
					target: activity.target || existing.target,
				};
				activities = [
					...prev.activities.slice(0, existingIdx),
					merged,
					...prev.activities.slice(existingIdx + 1),
				];
			} else {
				activities = [
					...prev.activities,
					{
						id: generateId(),
						timestamp: activity.timestamp,
						tabId,
						toolCallId: activity.toolCallId,
						toolName: activity.toolName,
						verb: activity.verb,
						target: activity.target,
						status: activity.status,
					},
				];
				if (activities.length > MAX_ACTIVITIES_PER_SESSION) {
					activities = activities.slice(activities.length - MAX_ACTIVITIES_PER_SESSION);
					trimmed = true;
				}
			}

			return {
				buffers: { ...state.buffers, [sessionId]: { ...prev, activities, trimmed } },
			};
		}),

	clearBuffer: (sessionId) =>
		set((state) => ({
			buffers: { ...state.buffers, [sessionId]: emptyBuffer() },
		})),
}));

/** Selector: is a given session actively capturing its thought stream? */
export function selectIsCapturing(sessionId: string | undefined | null) {
	return (state: ThoughtStreamState): boolean => !!sessionId && !!state.capturing[sessionId];
}
