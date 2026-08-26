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
 * - Open:  show the panel for a session, already backfilled with history.
 * - Close: hide the panel. The buffer survives, so reopening still shows the
 *          run's reasoning; `clearBuffer` is the explicit discard.
 *
 * There is deliberately no minimize. Minimize only existed to keep a capture
 * alive while the panel was out of the way; with capture ambient, closing does
 * that already, and a second dismiss control that behaves almost identically to
 * the first is just a choice the user has to think about.
 *
 * The buffer is ONE chronological event list, not a thought list with a tool
 * list beside it. Reasoning and tool calls are captured into the same array in
 * arrival order, which is what lets the feed render a tool call BETWEEN the two
 * halves of the reasoning that produced it. Keeping two sequences and merging
 * them at display time cannot express that: a block is one timestamp, so a tool
 * call that happened mid-block has nowhere to go and surfaces after reasoning
 * that actually followed it. For a feature whose whole value is "watch what the
 * agent is doing, in order", that ordering is the product.
 *
 * Capture is in-memory only - buffers do not survive an app restart. Memory is
 * bounded on three axes so an all-day fleet of agents cannot grow without
 * limit: entries per session, characters per session, and how many sessions
 * retain a buffer at all (least-recently-active evicted first). A `trimmed`
 * flag surfaces per-session dropping in the UI.
 */

import { create } from 'zustand';
import { generateId } from '../utils/ids';
import type { ToolActivityLabel } from '../utils/toolActivityLabel';

/** A single captured unit of thinking (one coalesced stream flush). */
export interface ThoughtEntry {
	id: string;
	timestamp: number;
	/** AI tab the thought came from (a session can run parallel tabs). */
	tabId: string;
	text: string;
}

/**
 * How a tool call ended. `running` is also what we show when a provider sends
 * no status at all - an unfinished call is the honest reading of "we saw it
 * start and never saw it end".
 */
export type ToolActivityStatus = 'running' | 'completed' | 'failed';

/**
 * A single tool call on the timeline, already reduced to one plain-language
 * line. Discriminated from a ThoughtEntry by the presence of `tool`, so
 * ThoughtEntry needs no marker field and every existing consumer of it still
 * type-checks unchanged.
 */
export interface ToolActivityEntry {
	id: string;
	/** When the call STARTED. Preserved across the completion merge. */
	timestamp: number;
	/** AI tab (or batch stream id) the call came from. */
	tabId: string;
	tool: {
		/** Raw provider tool name, kept so search can match it. */
		name: string;
		/** The one-line rendering (verb + target). */
		label: ToolActivityLabel;
		status: ToolActivityStatus;
		/** Provider call id, when it sends one. Drives exact merge. */
		toolCallId?: string;
		/** When the call finished, once it has. */
		endedAt?: number;
	};
}

/** One event on a session's timeline: a unit of reasoning, or a tool call. */
export type StreamEvent = ThoughtEntry | ToolActivityEntry;

/** Narrow a timeline event to a tool call. */
export function isToolEvent(event: StreamEvent): event is ToolActivityEntry {
	return 'tool' in event;
}

/** Per-session capture buffer. */
export interface ThoughtBuffer {
	/** The session's single chronological timeline (thoughts AND tool calls). */
	entries: StreamEvent[];
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

/** One row of the rendered feed: a block of reasoning, or a tool call. */
export type ActivityFeedItem =
	| { kind: 'thought'; block: ThoughtBlock }
	| { kind: 'tool'; activity: ToolActivityEntry };

/**
 * Walk a session's timeline ONCE and produce the rendered feed (oldest-first;
 * the caller reverses for newest-on-top display).
 *
 * Consecutive thinking coalesces into a block, exactly as before. What is new
 * is that a tool call CLOSES the open block, so reasoning that arrived after an
 * action starts a fresh block below it. That is the whole ordering guarantee:
 * because both event kinds come off one array in arrival order, a tool call
 * physically sits between the reasoning before it and the reasoning after it,
 * and no sort can put it anywhere else.
 *
 * Closing on ANY tool call (not just the same tab's) matches the rule already
 * in force for thoughts, where a chunk from a different tab also starts a new
 * block. One rule, applied to every event.
 *
 * Pure - safe to memoize on the entries array.
 */
export function buildActivityFeed(
	events: StreamEvent[],
	gapMs: number = THOUGHT_BLOCK_GAP_MS
): ActivityFeedItem[] {
	const feed: ActivityFeedItem[] = [];
	for (const event of events) {
		if (isToolEvent(event)) {
			feed.push({ kind: 'tool', activity: event });
			continue;
		}
		const last = feed[feed.length - 1];
		// Only a thought block that is still the newest row can be extended.
		const open = last && last.kind === 'thought' ? last.block : null;
		if (open && open.tabId === event.tabId && event.timestamp - open.endTimestamp <= gapMs) {
			open.text += event.text;
			open.endTimestamp = event.timestamp;
		} else {
			feed.push({
				kind: 'thought',
				block: {
					id: event.id,
					startTimestamp: event.timestamp,
					endTimestamp: event.timestamp,
					tabId: event.tabId,
					text: event.text,
				},
			});
		}
	}
	return feed;
}

/**
 * Reasoning blocks only, for callers that render thinking without the actions.
 * A thin projection of `buildActivityFeed` rather than a second grouping loop,
 * so the two can never disagree about where a block starts.
 */
export function groupThoughtsIntoBlocks(
	entries: StreamEvent[],
	gapMs: number = THOUGHT_BLOCK_GAP_MS
): ThoughtBlock[] {
	const blocks: ThoughtBlock[] = [];
	for (const item of buildActivityFeed(entries, gapMs)) {
		if (item.kind === 'thought') blocks.push(item.block);
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

/**
 * Memory a timeline event costs against the per-session character budget. A
 * tool call is charged for its rendered line, so a run that is all actions and
 * no reasoning is still bounded by the same budget.
 */
function eventCharCost(event: StreamEvent): number {
	return isToolEvent(event)
		? event.tool.label.verb.length + event.tool.label.target.length
		: event.text.length;
}

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

/**
 * Append one event to a buffer and enforce both caps. Shared by the thinking
 * and tool-call paths so a timeline cannot be trimmed by two different rules.
 */
function pushEvent(prev: ThoughtBuffer, event: StreamEvent): ThoughtBuffer {
	let entries = prev.entries.concat(event);
	let chars = prev.chars + eventCharCost(event);
	let trimmed = prev.trimmed;

	if (entries.length > MAX_THOUGHTS_PER_SESSION) {
		const dropCount = entries.length - MAX_THOUGHTS_PER_SESSION;
		for (let i = 0; i < dropCount; i++) chars -= eventCharCost(entries[i]);
		entries = entries.slice(dropCount);
		trimmed = true;
	}
	// Drop whole oldest events until the character budget is met. The newest
	// event always survives, even if it alone exceeds the budget.
	let dropped = 0;
	while (chars > MAX_THOUGHT_CHARS_PER_SESSION && dropped < entries.length - 1) {
		chars -= eventCharCost(entries[dropped]);
		dropped++;
	}
	if (dropped > 0) {
		entries = entries.slice(dropped);
		trimmed = true;
	}

	return { entries, trimmed, chars, lastAppendAt: event.timestamp };
}

/**
 * Find the timeline slot a finalizing tool event belongs to, mirroring the
 * rules the in-chat transcript already uses:
 *  1. an exact `toolCallId` match, for providers that send one;
 *  2. otherwise the newest still-running call with the same tool name in the
 *     same tab (Codex and friends send no call id).
 * Returns -1 when this is a call we have not seen start.
 */
function findMergeTarget(
	entries: StreamEvent[],
	tabId: string,
	toolName: string,
	toolCallId: string | undefined,
	finalizing: boolean
): number {
	if (toolCallId) {
		for (let i = entries.length - 1; i >= 0; i--) {
			const event = entries[i];
			if (isToolEvent(event) && event.tool.toolCallId === toolCallId) return i;
		}
		return -1;
	}
	if (!finalizing) return -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		const event = entries[i];
		if (
			isToolEvent(event) &&
			event.tabId === tabId &&
			event.tool.name === toolName &&
			event.tool.status === 'running'
		) {
			return i;
		}
	}
	return -1;
}

interface ThoughtStreamState {
	/** Session whose panel is currently focused/visible (null = panel hidden). */
	panelSessionId: string | null;
	/** Per-session capture buffers, written whether or not the panel is open. */
	buffers: Record<string, ThoughtBuffer>;

	/** Open (or refocus) the panel for a session, backfilled with its buffer. */
	openPanel: (sessionId: string) => void;
	/** Hide the panel. Buffers keep filling so a later reopen still has history. */
	closePanel: () => void;
	/** Append a coalesced thinking flush to a session's buffer. */
	appendThought: (sessionId: string, tabId: string, text: string) => void;
	/**
	 * Record a tool call on the same timeline as the reasoning. A completion is
	 * merged into the entry its start created, so the feed lists ACTIONS rather
	 * than state transitions.
	 */
	appendToolActivity: (
		sessionId: string,
		tabId: string,
		activity: {
			toolName: string;
			label: ToolActivityLabel;
			status: ToolActivityStatus;
			toolCallId?: string;
			timestamp?: number;
		}
	) => void;
	/** Discard a session's buffered thoughts (explicit user action). */
	clearBuffer: (sessionId: string) => void;
}

export const useThoughtStreamStore = create<ThoughtStreamState>((set) => ({
	panelSessionId: null,
	buffers: {},

	openPanel: (sessionId) =>
		set((state) => ({
			panelSessionId: sessionId,
			// Ambient capture usually got here first; seed an empty buffer only so
			// the panel has something to render for a session that has not thought.
			buffers: state.buffers[sessionId]
				? state.buffers
				: { ...state.buffers, [sessionId]: emptyBuffer() },
		})),

	closePanel: () => set({ panelSessionId: null }),

	appendThought: (sessionId, tabId, text) =>
		set((state) => {
			if (!text) return state;
			const prev = state.buffers[sessionId] ?? emptyBuffer();
			const entry: ThoughtEntry = { id: generateId(), timestamp: Date.now(), tabId, text };
			const buffers = { ...state.buffers, [sessionId]: pushEvent(prev, entry) };
			return { buffers: evictColdSessions(buffers, [sessionId, state.panelSessionId]) };
		}),

	appendToolActivity: (sessionId, tabId, activity) =>
		set((state) => {
			const toolName = (activity.toolName || '').trim();
			if (!toolName) return state;
			const prev = state.buffers[sessionId] ?? emptyBuffer();
			const timestamp = activity.timestamp ?? Date.now();
			const finalizing = activity.status !== 'running';

			const targetIdx = findMergeTarget(
				prev.entries,
				tabId,
				toolName,
				activity.toolCallId,
				finalizing
			);

			if (targetIdx >= 0) {
				const existing = prev.entries[targetIdx] as ToolActivityEntry;
				// Merge IN PLACE: the entry keeps both its slot on the timeline and
				// its START timestamp, so a call that finishes does not jump to the
				// top of the feed or reorder the reasoning around it.
				const merged: ToolActivityEntry = {
					...existing,
					tool: {
						...existing.tool,
						status: activity.status,
						// A completion event often carries no input, so the running
						// event's label is usually the descriptive one. Only take the
						// new label when it actually says more.
						label:
							!existing.tool.label.target && activity.label.target
								? activity.label
								: existing.tool.label,
						toolCallId: existing.tool.toolCallId ?? activity.toolCallId,
						...(finalizing ? { endedAt: timestamp } : {}),
					},
				};
				const entries = prev.entries.slice();
				entries[targetIdx] = merged;
				const buffers = {
					...state.buffers,
					[sessionId]: { ...prev, entries, lastAppendAt: timestamp },
				};
				return { buffers: evictColdSessions(buffers, [sessionId, state.panelSessionId]) };
			}

			const entry: ToolActivityEntry = {
				id: generateId(),
				timestamp,
				tabId,
				tool: {
					name: toolName,
					label: activity.label,
					status: activity.status,
					...(activity.toolCallId ? { toolCallId: activity.toolCallId } : {}),
					...(finalizing ? { endedAt: timestamp } : {}),
				},
			};
			const buffers = { ...state.buffers, [sessionId]: pushEvent(prev, entry) };
			return { buffers: evictColdSessions(buffers, [sessionId, state.panelSessionId]) };
		}),

	clearBuffer: (sessionId) =>
		set((state) => ({
			buffers: { ...state.buffers, [sessionId]: emptyBuffer() },
		})),
}));

/**
 * Selector: how many timeline events are buffered for a session (reasoning and
 * tool calls together). This is what the "is there anything to look at" entry
 * points gate on - an agent that only ran tools and never narrated still has a
 * feed worth opening.
 */
export function selectActivityCount(sessionId: string | undefined | null) {
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
