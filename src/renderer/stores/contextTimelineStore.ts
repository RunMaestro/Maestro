/**
 * contextTimelineStore - a per-agent, turn-by-turn record of how the context
 * window fills over the course of a run.
 *
 * Every supported provider normalizes its CLI usage into the shared `UsageStats`
 * shape, and that shape already streams to the renderer per turn over the
 * `process:usage` IPC channel (see useAgentUsageListener). This store taps that
 * SAME stream - it does not add a new listener or any provider-specific code -
 * and keeps a bounded history of points so the inspector panel can draw the
 * turn-by-turn evolution the latest-snapshot UI throws away.
 *
 * Unlike thoughtStreamStore (which gates capture behind an open panel because
 * thinking chunks are high-frequency and memory-heavy), usage events are
 * low-frequency - one per turn - so we capture ALWAYS. That way opening the
 * inspector shows the history that already accumulated, instead of an empty
 * panel that only fills on the next turn.
 *
 * Capture is in-memory only and does not survive an app restart. Each session's
 * buffer is bounded (oldest points dropped past the cap); a `trimmed` flag
 * surfaces that in the UI.
 *
 * Provider notes the panel surfaces (not enforced here - this store only stores
 * numbers): the `contextWindow` denominator is reported live only by some
 * providers (e.g. Codex) and falls back to a static table for others, so a
 * point's `percentage` is precise for some agents and approximate for others.
 */

import { create } from 'zustand';
import { generateId } from '../utils/ids';

/**
 * One turn's normalized context accounting. The provider-specific math
 * (combined vs separate input/output windows, cumulative copilot mapping) is
 * done by the listener before the point lands here, so this is plain numbers.
 */
export interface ContextTimelinePoint {
	/** Stable React key. */
	id: string;
	/** When this turn's usage arrived. */
	timestamp: number;
	/** AI tab the turn ran in (a session can run parallel tabs); null if unknown. */
	tabId: string | null;
	/** Raw normalized per-turn token counts (from UsageStats). */
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	/** Reasoning/thinking tokens when the provider reports them separately. */
	reasoningTokens: number;
	/** Cost for this turn when the provider reports it (0 when it does not). */
	totalCostUsd: number;
	/** Context tokens this turn occupies (calculateContextTokens, provider-aware). */
	contextTokens: number;
	/** Resolved context window used as the denominator (may be a static fallback). */
	contextWindow: number;
	/** Context fill 0-100, or null when it could not be determined this turn. */
	percentage: number | null;
	/**
	 * Monotonic sequence number assigned by main's capture log when the usage
	 * event was emitted (`UsageStats.captureSeq`). It is the exact dedup key
	 * between a live append and the same event arriving again through
	 * `hydrateSession`. Undefined for points built from an event that never
	 * passed through that listener.
	 */
	seq?: number;
}

/** Per-session capture buffer. */
export interface ContextTimelineBuffer {
	points: ContextTimelinePoint[];
	/** True once the cap forced us to drop the oldest points. */
	trimmed: boolean;
	/**
	 * True once this renderer has attempted to backfill the buffer from main's
	 * capture log. Distinguishes "genuinely no history" from "not asked yet", so
	 * the panel can hold the empty-state copy back until the answer is in and a
	 * reopen never refetches.
	 */
	hydrated?: boolean;
}

/**
 * Max points retained per session. One point per turn, so this is thousands of
 * turns of scrollback while keeping each buffer to a few hundred KB at most.
 */
export const MAX_POINTS_PER_SESSION = 2000;

/** Fields the listener supplies for a new point (id/timestamp are stamped here). */
export type ContextTimelinePointInput = Omit<ContextTimelinePoint, 'id' | 'timestamp'>;

/**
 * A point restored from main's capture log. Same shape as a live one except the
 * ORIGINAL capture timestamp comes with it - stamping `Date.now()` here would
 * make every restored turn claim it happened at the moment the panel opened.
 */
export type ContextTimelineHydrationPoint = ContextTimelinePointInput & { timestamp: number };

/**
 * A plain (structured-clone-safe) copy of the trigger element's viewport rect,
 * so the panel can anchor itself to the header gauge that opened it instead of
 * always docking bottom-left. Stored as plain numbers - never a live DOMRect.
 */
export interface TimelineAnchorRect {
	top: number;
	left: number;
	bottom: number;
	right: number;
	width: number;
	height: number;
}

/** Which presentation the inspector body uses. The bar list is the default. */
export type ContextTimelineView = 'bar' | 'graph';

interface ContextTimelineState {
	/** Session whose panel is currently focused/visible (null = panel hidden). */
	panelSessionId: string | null;
	/** Whether the visible panel is minimized to a status pill. */
	minimized: boolean;
	/**
	 * Bar list (per-turn rows) or x/y line graph (trend across turns). Lives
	 * alongside `minimized` so the choice survives closing and reopening the
	 * panel. Defaults to 'bar' so nothing changes until a user opts in.
	 */
	view: ContextTimelineView;
	/** Viewport rect of the element that opened the panel (null = dock bottom-left). */
	anchorRect: TimelineAnchorRect | null;
	/** Per-session capture buffers (capture runs for all sessions, always). */
	buffers: Record<string, ContextTimelineBuffer>;

	/** Record one turn's context accounting (always-on; no capture gate). */
	appendPoint: (sessionId: string, point: ContextTimelinePointInput) => void;
	/**
	 * Backfill a session from main's capture log (finding S1). Merges rather than
	 * replaces: a live event that landed while the fetch was in flight keeps its
	 * place and is not duplicated, because both sides carry the same `seq`.
	 */
	hydrateSession: (
		sessionId: string,
		points: ContextTimelineHydrationPoint[],
		trimmed: boolean
	) => void;
	/** Open (or refocus) the inspector for a session, optionally anchored to a rect. */
	openPanel: (sessionId: string, anchorRect?: TimelineAnchorRect | null) => void;
	/** Collapse the panel to a status pill; the buffer is untouched. */
	minimizePanel: () => void;
	/** Restore the panel from the minimized pill. */
	restorePanel: () => void;
	/** Switch between the bar list and the line graph. */
	setView: (view: ContextTimelineView) => void;
	/** Hide the panel. History is KEPT so reopening shows it again. */
	closePanel: () => void;
	/** Clear a session's recorded history without hiding the panel. */
	clearSession: (sessionId: string) => void;
	/** Drop a session's buffer entirely (call when the agent is deleted). */
	removeSession: (sessionId: string) => void;
}

export const useContextTimelineStore = create<ContextTimelineState>((set) => ({
	panelSessionId: null,
	minimized: false,
	view: 'bar',
	anchorRect: null,
	buffers: {},

	appendPoint: (sessionId, point) =>
		set((state) => {
			if (!sessionId) return state;
			const prev = state.buffers[sessionId] ?? { points: [], trimmed: false };
			const full: ContextTimelinePoint = {
				id: generateId(),
				timestamp: Date.now(),
				...point,
			};
			let points = [...prev.points, full];
			let trimmed = prev.trimmed;
			if (points.length > MAX_POINTS_PER_SESSION) {
				points = points.slice(points.length - MAX_POINTS_PER_SESSION);
				trimmed = true;
			}
			return { buffers: { ...state.buffers, [sessionId]: { points, trimmed } } };
		}),

	hydrateSession: (sessionId, incoming, trimmed) =>
		set((state) => {
			if (!sessionId) return state;
			const prev = state.buffers[sessionId] ?? { points: [], trimmed: false };
			// The dedup watermark: any capture whose seq is already in the buffer
			// arrived live during the fetch and must not be added twice.
			const seenSeqs = new Set(
				prev.points.map((p) => p.seq).filter((seq): seq is number => typeof seq === 'number')
			);
			const fresh = incoming
				.filter((p) => typeof p.seq !== 'number' || !seenSeqs.has(p.seq))
				.map((p) => ({ id: generateId(), ...p }));
			const mergedTrimmed = prev.trimmed || trimmed;
			if (fresh.length === 0) {
				return {
					buffers: {
						...state.buffers,
						[sessionId]: { ...prev, trimmed: mergedTrimmed, hydrated: true },
					},
				};
			}
			// Order by the emit-time seq so a hydrated backlog sorts correctly under
			// live points that arrived first. Points with no seq sort last, keeping
			// their relative order (Array.prototype.sort is stable).
			let points = [...prev.points, ...fresh].sort(
				(a, b) =>
					(a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER) ||
					a.timestamp - b.timestamp
			);
			let pointsTrimmed = mergedTrimmed;
			if (points.length > MAX_POINTS_PER_SESSION) {
				points = points.slice(points.length - MAX_POINTS_PER_SESSION);
				pointsTrimmed = true;
			}
			return {
				buffers: {
					...state.buffers,
					[sessionId]: { points, trimmed: pointsTrimmed, hydrated: true },
				},
			};
		}),

	openPanel: (sessionId, anchorRect = null) =>
		set((state) => ({
			panelSessionId: sessionId,
			minimized: false,
			anchorRect,
			// Preserve any history already captured for this session.
			buffers: state.buffers[sessionId]
				? state.buffers
				: { ...state.buffers, [sessionId]: { points: [], trimmed: false } },
		})),

	minimizePanel: () => set({ minimized: true }),

	restorePanel: () => set({ minimized: false }),

	setView: (view) => set({ view }),

	closePanel: () => set({ panelSessionId: null, minimized: false, anchorRect: null }),

	clearSession: (sessionId) =>
		set((state) => ({
			// `hydrated` stays true: Clear also wipes main's capture log, so
			// re-fetching would only put the just-cleared history straight back.
			buffers: { ...state.buffers, [sessionId]: { points: [], trimmed: false, hydrated: true } },
		})),

	removeSession: (sessionId) =>
		set((state) => {
			if (!state.buffers[sessionId]) return state;
			const buffers = { ...state.buffers };
			delete buffers[sessionId];
			// If the deleted session was focused in the panel, hide it.
			const panelSessionId = state.panelSessionId === sessionId ? null : state.panelSessionId;
			return { buffers, panelSessionId };
		}),
}));

/** Selector: the recorded points for a session (stable empty array when none). */
const EMPTY_POINTS: ContextTimelinePoint[] = [];
export function selectPoints(sessionId: string | undefined | null) {
	return (state: ContextTimelineState): ContextTimelinePoint[] =>
		(sessionId && state.buffers[sessionId]?.points) || EMPTY_POINTS;
}
