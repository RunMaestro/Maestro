/**
 * ContextTimelinePanel - floating, per-agent inspector of how the context
 * window filled, turn by turn.
 *
 * Mounted once, app-wide (next to ThoughtStreamPanel in App.tsx). It reads
 * `contextTimelineStore` and renders nothing until a session's inspector is
 * opened - by clicking the context-usage readout in the Main Panel header.
 *
 * Every supported provider feeds this through the one shared per-turn usage
 * stream (see useAgentUsageListener), so it is provider-agnostic. The honest
 * caveat it surfaces: the window denominator is reported live by some providers
 * (e.g. Codex) and a static estimate for others, so a turn's percentage is
 * exact for some agents and approximate for others - and a provider that only
 * reports usage at the end of a run (e.g. Factory Droid) shows a single point
 * rather than an evolving series.
 *
 * Anchored bottom-LEFT so it never collides with the Thought Stream (which docks
 * bottom-right inside the Right Panel). Closing hides it but KEEPS the history;
 * "Clear" wipes the focused session's recorded points.
 *
 * It is a HOVER surface, not a window: it closes once the pointer leaves both it
 * and the gauge, and it never shares the screen with the Context Details popover
 * the same gauge shows on hover (MainPanelHeader hides that one while this is
 * open). The two are alternatives for one spot, so they default to one size.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Gauge, Trash2, BarChart3, LineChart } from 'lucide-react';
import type { Theme } from '../types';
import {
	useContextTimelineStore,
	selectPoints,
	CONTEXT_SURFACE_CLOSE_DELAY_MS,
	CONTEXT_SURFACE_GAP,
	CONTEXT_SURFACE_WIDTH,
	type ContextTimelinePoint,
	type TimelineAnchorRect,
} from '../stores/contextTimelineStore';
import { useSessionStore } from '../stores/sessionStore';
// IMPORTANT: the context-backed accessor, NOT hooks/ui/useLayerStack (which
// creates a fresh private stack). This one reads the app's shared layer stack.
import { useLayerStack } from '../contexts/LayerStackContext';
import { getContextColor } from '../utils/theme';
import { computeOverLimitDisplay } from '../utils/contextUsage';
import { formatTokensCompact, formatCost } from '../../shared/formatters';
import { useEventListener } from '../hooks/utils/useEventListener';
import {
	hydrateContextTimeline,
	forgetContextTimelineCaptures,
} from '../services/contextTimelineHydration';
import { ContextTimelineGraph } from './ContextTimelineGraph';
import { useResizableModal } from '../hooks/ui/useResizableModal';
import { ResizeHandles } from './ui/ResizeHandles';

interface ContextTimelinePanelProps {
	theme: Theme;
}

/**
 * Height used only when the panel opens with no Context Details popover on screen
 * to measure (keyboard, programmatic open). The width is always
 * CONTEXT_SURFACE_WIDTH, which that popover shares - see its doc in the store.
 */
const PANEL_FALLBACK_HEIGHT = 620;
/** Narrower than this and the breakdown line starts wrapping again. */
const PANEL_MIN_WIDTH = 380;
const PANEL_MIN_HEIGHT = 260;
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = CONTEXT_SURFACE_GAP;
/** Key under which the user's dragged size is remembered (settingsStore.modalSizes). */
const PANEL_RESIZE_KEY = 'context-timeline';
/** The header context gauge that opens this panel; re-queried for its live rect. */
const HEADER_CONTEXT_WIDGET_SELECTOR = '[data-testid="header-context-widget"]';

/**
 * Position the panel near the element that opened it, clamped to the viewport.
 * The size is passed in rather than read from a constant so the user's dragged
 * size drives the anchoring too: a panel widened past its default still has to
 * stay pinned to the gauge and inside the window.
 */
function anchoredStyle(anchor: TimelineAnchorRect, size: { width: number; height: number }) {
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const width = Math.min(size.width, vw - VIEWPORT_MARGIN * 2);
	const height = Math.min(size.height, vh - VIEWPORT_MARGIN * 2);
	// Right-align the panel under the trigger and open downward by default.
	let left = anchor.right - width;
	let top = anchor.bottom + ANCHOR_GAP;
	// If it would run off the bottom, flip to open above the trigger instead.
	if (top + height > vh - VIEWPORT_MARGIN) {
		top = anchor.top - ANCHOR_GAP - height;
	}
	left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - width - VIEWPORT_MARGIN));
	top = Math.max(VIEWPORT_MARGIN, Math.min(top, vh - height - VIEWPORT_MARGIN));
	return { top, left, width, height };
}

/** Default dock (bottom-left) used when the panel was opened without an anchor. */
function fallbackStyle(size: { width: number; height: number }): CSSProperties {
	return {
		bottom: 16,
		left: 16,
		width: size.width,
		maxWidth: 'calc(100vw - 2rem)',
		height: size.height,
		maxHeight: 'calc(100vh - 2rem)',
	};
}

/** Time-of-day stamp for a turn (e.g. "3:42:07 PM"). */
function formatPointTime(ts: number): string {
	return new Date(ts).toLocaleTimeString([], {
		hour: 'numeric',
		minute: '2-digit',
		second: '2-digit',
	});
}

/** A small token-count chip used in the per-turn breakdown line. */
function TokenChip({ label, value, color }: { label: string; value: number; color: string }) {
	if (!value) return null;
	return (
		<span className="inline-flex items-center gap-1 whitespace-nowrap" style={{ color }}>
			<span className="opacity-70">{label}</span>
			<span className="font-mono tabular-nums">{formatTokensCompact(value)}</span>
		</span>
	);
}

export function ContextTimelinePanel({ theme }: ContextTimelinePanelProps) {
	const panelSessionId = useContextTimelineStore((s) => s.panelSessionId);
	const anchorRect = useContextTimelineStore((s) => s.anchorRect);
	const view = useContextTimelineStore((s) => s.view);
	const setView = useContextTimelineStore((s) => s.setView);
	const points = useContextTimelineStore(selectPoints(panelSessionId));
	const buffer = useContextTimelineStore((s) =>
		panelSessionId ? s.buffers[panelSessionId] : undefined
	);
	const closePanel = useContextTimelineStore((s) => s.closePanel);
	const clearSession = useContextTimelineStore((s) => s.clearSession);
	const sourceSize = useContextTimelineStore((s) => s.sourceSize);

	// Drag-to-resize, remembered per user in settingsStore.modalSizes - one key for
	// every agent, so a size set on one is the size on all of them. `topLeft`
	// rather than the default `center`: this panel is pinned to the gauge and
	// grows from one edge, so a centered scale factor would move it twice as fast
	// as the cursor. The DEFAULT is the popover the click replaced, so the swap
	// lands in the same space; a dragged size still wins over it.
	const resizable = useResizableModal({
		resizeKey: PANEL_RESIZE_KEY,
		defaultSize: sourceSize ?? { width: CONTEXT_SURFACE_WIDTH, height: PANEL_FALLBACK_HEIGHT },
		minSize: { width: PANEL_MIN_WIDTH, height: PANEL_MIN_HEIGHT },
		anchor: 'topLeft',
	});

	// Reclamp the anchored position on viewport resize so an open panel never ends
	// up partly offscreen after the Electron window changes size (anchoredStyle
	// reads the live window dimensions, so a re-render is all it needs).
	const [, bumpResizeTick] = useState(0);
	useEventListener('resize', () => bumpResizeTick((n) => n + 1));

	const session = useSessionStore((s) =>
		panelSessionId ? s.sessions.find((sess) => sess.id === panelSessionId) : undefined
	);
	const sessionName = session?.name;

	// Backfill from main's capture log (finding S1). Without this a web-desktop
	// client, a reloaded window or a second desktop window opens at zero turns
	// even when the agent has a long history in another renderer. The store's
	// `hydrated` flag makes a reopen a no-op, and hydration merges by `seq` so a
	// live turn arriving mid-fetch is neither lost nor duplicated.
	useEffect(() => {
		if (!panelSessionId || !session) return;
		void hydrateContextTimeline(panelSessionId, session);
	}, [panelSessionId, session]);

	const scrollRef = useRef<HTMLDivElement>(null);
	// Newest turn renders on top, so "following" means staying pinned to the TOP.
	const stickToTopRef = useRef(true);

	const trimmed = buffer?.trimmed ?? false;
	// Until the backfill has answered, "no points" means "not asked yet" - showing
	// the empty-state copy here would flash it at a web-desktop client that does
	// have history.
	const hydrated = buffer?.hydrated ?? false;

	// Newest-first for display (the latest turn sits at the top).
	const ordered = useMemo(() => [...points].reverse(), [points]);

	const latest: ContextTimelinePoint | undefined = points[points.length - 1];
	const latestWindow = latest?.contextWindow ?? 0;
	// True (unclamped) fill for the newest turn. Reading the stored
	// tokens/window rather than the point's `percentage` is what keeps this
	// readout alive past 100%: the stored percentage is null once a turn breaches
	// the window, which used to blank the number exactly when it mattered most.
	const latestPercent =
		latest && latest.contextWindow > 0
			? computeOverLimitDisplay(latest.contextTokens, latest.contextWindow).truePercentage
			: (latest?.percentage ?? null);

	// Per-panel headroom scale (option A, Decision 3): every rendered row shares
	// ONE track maximum so bar lengths stay comparable across turns, while each
	// row's percentage still divides by its OWN stored window - a mid-session
	// window change must not retroactively distort older rows. When nothing
	// exceeds the window this equals the window and the track behaves as before.
	// Every row's OWN window counts toward the track maximum, not just the latest
	// one. Seeding from `latestWindow` alone broke the geometry the moment the
	// window changed mid-session: an older 800k/1M row against a latest 200k
	// window made `scaleMax` 800k, so that row filled the whole track while its
	// label read 80% - an under-limit row drawn as if it were at the limit.
	const scaleMax = useMemo(
		() => points.reduce((max, p) => Math.max(max, p.contextTokens, p.contextWindow), 0),
		[points]
	);

	// This is a PASSIVE inspector that does NOT register a layer: any registered
	// layer trips hasOpenLayers()/hasOpenModal() and suppresses global shortcuts +
	// file-tree keys while the panel is open. It does READ the shared stack to
	// hide itself while a real modal is open, so its high z-index can't float
	// above lower-z dialogs (Create PR, expanded Auto Run) that own the foreground.
	const { hasOpenModal } = useLayerStack();

	// The gauge opens and closes it and moving the pointer away dismisses it, so
	// Escape is the keyboard's way out. Handled locally rather than through the layer stack for
	// the reason above, and gated on the panel actually being on screen: while a
	// modal is open this component renders nothing, and swallowing that modal's
	// Escape from behind it would be indistinguishable from the modal hanging.
	useEventListener('keydown', (event: Event) => {
		const e = event as KeyboardEvent;
		if (e.key !== 'Escape') return;
		if (!panelSessionId || hasOpenModal()) return;
		e.stopPropagation();
		closePanel();
	});

	// Hover-dismiss. The panel closes once the pointer has left BOTH it and the
	// gauge that opened it, after the same grace period the Context Details popover
	// uses, so crossing the gap between them is not leaving. It is tracked from one
	// window-level `mouseover` rather than onMouseLeave on each element because the
	// gauge lives in MainPanelHeader and this panel in AppShell, and "is the pointer
	// over either?" needs a single place to be asked. `mouseover`, not `mousemove`:
	// a browser tab's <webview> keeps its pointer events to itself, so moving from
	// the panel onto one produces no host mousemove at all, while the host still
	// sees a mouseover targeting the webview element.
	//
	// Two things must NOT dismiss it. A resize drag routinely carries the pointer
	// outside, so nothing closes while one is in progress and the check re-runs
	// when it ends. And a panel opened from the keyboard, with the pointer parked
	// elsewhere, stays until the pointer has actually been over it: `armed` is what
	// separates hovering away from never having hovered at all.
	const pointerInsideRef = useRef(false);
	const hoverArmedRef = useRef(false);
	const hoverDismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const cancelHoverDismiss = useCallback(() => {
		if (hoverDismissTimerRef.current) {
			clearTimeout(hoverDismissTimerRef.current);
			hoverDismissTimerRef.current = null;
		}
	}, []);

	const evaluateHoverDismiss = useCallback(() => {
		if (pointerInsideRef.current) hoverArmedRef.current = true;
		if (!panelSessionId || resizable.isResizing || pointerInsideRef.current) {
			cancelHoverDismiss();
			return;
		}
		if (!hoverArmedRef.current || hoverDismissTimerRef.current) return;
		hoverDismissTimerRef.current = setTimeout(() => {
			hoverDismissTimerRef.current = null;
			closePanel();
		}, CONTEXT_SURFACE_CLOSE_DELAY_MS);
	}, [panelSessionId, resizable.isResizing, cancelHoverDismiss, closePanel]);

	// Each open starts from where the pointer actually is. A click leaves the gauge
	// hovered (`:hover` also covers the popover, which is the gauge's descendant),
	// so a mouse open is armed at once; a keyboard open is not. Declared before the
	// re-check below so that effect reads this open's state, not the last one's.
	useEffect(() => {
		cancelHoverDismiss();
		const gauge = panelSessionId ? document.querySelector(HEADER_CONTEXT_WIDGET_SELECTOR) : null;
		const overGauge = !!gauge?.matches(':hover');
		pointerInsideRef.current = overGauge;
		hoverArmedRef.current = overGauge;
	}, [panelSessionId, cancelHoverDismiss]);

	// Re-check when the inputs change - chiefly a resize drag ending with the
	// pointer already outside, which produces no further event to react to.
	useEffect(() => {
		evaluateHoverDismiss();
	}, [evaluateHoverDismiss]);

	useEffect(() => cancelHoverDismiss, [cancelHoverDismiss]);

	useEventListener(
		'mouseover',
		(event: Event) => {
			// Hidden behind a modal, the pointer is necessarily "outside" a panel that
			// is not drawn, and that must not close it out from under the user.
			if (hasOpenModal()) return;
			const target = event.target instanceof Node ? event.target : null;
			const panel = resizable.modalRef.current;
			const gauge = document.querySelector(HEADER_CONTEXT_WIDGET_SELECTOR);
			pointerInsideRef.current =
				!!target && (!!panel?.contains(target) || !!gauge?.contains(target));
			evaluateHoverDismiss();
		},
		{ enabled: !!panelSessionId }
	);

	// Leaving the window entirely targets nothing, so no mouseover fires for it.
	useEventListener(
		'mouseout',
		(event: Event) => {
			if ((event as MouseEvent).relatedTarget !== null || hasOpenModal()) return;
			pointerInsideRef.current = false;
			evaluateHoverDismiss();
		},
		{ enabled: !!panelSessionId }
	);

	// Auto-tail: when pinned to the top, follow new turns (newest is at the top).
	useEffect(() => {
		if (!stickToTopRef.current) return;
		const el = scrollRef.current;
		if (el) el.scrollTop = 0;
	}, [ordered]);

	if (!panelSessionId) return null;
	if (hasOpenModal()) return null;

	const label = sessionName || panelSessionId.slice(0, 8);

	// Prefer the gauge's LIVE rect so the panel stays attached to it through layout
	// shifts and resizes (the resize listener above forces this re-render); fall
	// back to the click-time rect if the gauge is no longer in the DOM.
	const liveAnchor: TimelineAnchorRect | null = anchorRect
		? (document.querySelector(HEADER_CONTEXT_WIDGET_SELECTOR)?.getBoundingClientRect() ??
			anchorRect)
		: null;

	return (
		<div
			ref={resizable.modalRef}
			className="fixed z-[9997] flex flex-col rounded-lg border shadow-2xl select-none"
			style={{
				...(liveAnchor ? anchoredStyle(liveAnchor, resizable.size) : fallbackStyle(resizable.size)),
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
			}}
			data-modal-resize-key={PANEL_RESIZE_KEY}
		>
			<ResizeHandles
				onResizeStart={resizable.onResizeStart}
				accentColor={theme.colors.accent}
				onResetSize={resizable.onResetSize}
				canReset={resizable.canReset}
			/>

			{/* Header */}
			<div
				className="flex items-center gap-2 px-3 py-2.5 border-b shrink-0"
				style={{ borderColor: theme.colors.border }}
			>
				<Gauge className="w-4 h-4 shrink-0" style={{ color: theme.colors.accent }} />
				<div className="flex flex-col min-w-0 flex-1">
					<span
						className="text-xs font-semibold leading-tight"
						style={{ color: theme.colors.textMain }}
					>
						Context Timeline
					</span>
					<span
						className="text-2xs truncate leading-tight"
						style={{ color: theme.colors.textDim }}
						title={label}
					>
						{label} · {points.length} turn{points.length === 1 ? '' : 's'}
						{trimmed ? ' (trimmed)' : ''}
					</span>
				</div>
				{latestPercent !== null && (
					<span
						className="text-xs font-mono font-bold tabular-nums mr-1"
						style={{ color: getContextColor(latestPercent, theme) }}
						title="Latest context fill"
					>
						{Math.round(latestPercent)}%
					</span>
				)}
				{/* Bar / graph toggle. Defaults to the bar list, so nothing changes for
				    existing users until they opt in; the choice lives in the store so
				    it survives closing and reopening the panel. */}
				<div
					className="flex items-center rounded overflow-hidden mr-1 shrink-0"
					style={{ border: `1px solid ${theme.colors.border}` }}
					role="group"
					aria-label="Timeline view"
				>
					<button
						onClick={() => setView('bar')}
						title="Bar view (one row per turn)"
						aria-pressed={view === 'bar'}
						data-testid="timeline-view-bar"
						className="p-1 transition-colors"
						style={{
							backgroundColor: view === 'bar' ? theme.colors.bgActivity : 'transparent',
							color: view === 'bar' ? theme.colors.accent : theme.colors.textDim,
						}}
					>
						<BarChart3 className="w-3.5 h-3.5" />
					</button>
					<button
						onClick={() => setView('graph')}
						title="Graph view (trend across turns)"
						aria-pressed={view === 'graph'}
						data-testid="timeline-view-graph"
						className="p-1 transition-colors"
						style={{
							backgroundColor: view === 'graph' ? theme.colors.bgActivity : 'transparent',
							color: view === 'graph' ? theme.colors.accent : theme.colors.textDim,
						}}
					>
						<LineChart className="w-3.5 h-3.5" />
					</button>
				</div>
				<button
					onClick={() => {
						clearSession(panelSessionId);
						// Also wipe main's capture log, or the next open hydrates the
						// history the user just cleared straight back in.
						forgetContextTimelineCaptures(panelSessionId);
					}}
					title="Clear recorded history"
					className="p-1 rounded hover:bg-white/10 transition-colors shrink-0"
				>
					<Trash2 className="w-4 h-4" style={{ color: theme.colors.textDim }} />
				</button>
			</div>

			{/* Window readout */}
			{latestWindow > 0 && (
				<div
					className="px-3 py-1.5 border-b shrink-0 text-2xs"
					style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
				>
					Window: {formatTokensCompact(latestWindow)} tokens · denominator is provider-reported when
					available, otherwise estimated
				</div>
			)}

			{/* Body: one row per turn, newest on top */}
			<div
				ref={scrollRef}
				onScroll={(e) => {
					stickToTopRef.current = e.currentTarget.scrollTop < 24;
				}}
				className="flex-1 overflow-y-auto px-3 py-2 scrollbar-thin select-text"
			>
				{ordered.length === 0 ? (
					<p className="text-xs italic mt-2" style={{ color: theme.colors.textDim }}>
						{hydrated
							? 'No usage recorded yet for this agent. The timeline fills as the agent takes turns, and it does not survive an app restart.'
							: 'Loading recorded history...'}
					</p>
				) : view === 'graph' ? (
					<ContextTimelineGraph
						// Oldest to newest: `points` is the store's natural order, NOT the
						// reversed list the bar rows below render from.
						points={points}
						scaleMax={scaleMax}
						theme={theme}
					/>
				) : (
					<div className="flex flex-col gap-2.5">
						{ordered.map((p) => {
							// ONE value drives the label, the bar width and the color, so they
							// cannot disagree: the true (unclamped) ratio of this row's stored
							// tokens to this row's stored window, with the bar measured against
							// the shared headroom scale. A row with no window at all still has
							// no denominator to divide by and stays "~".
							const hasWindow = p.contextWindow > 0;
							const display = computeOverLimitDisplay(p.contextTokens, p.contextWindow, scaleMax);
							const barColor = getContextColor(display.truePercentage, theme);
							// The 100% boundary is per row, because each row's limit is its
							// OWN stored window. A single shared tick drawn from the latest
							// window would sit at the wrong place on every row recorded
							// under a different one. Drawn only when there is headroom
							// beyond that row's limit within the shared track.
							const tickPercent =
								hasWindow && scaleMax > p.contextWindow ? (p.contextWindow / scaleMax) * 100 : null;
							return (
								<div key={p.id} className="flex flex-col gap-1">
									<div className="flex items-center justify-between gap-2">
										<span
											className="text-2xs font-mono select-none"
											style={{ color: theme.colors.textDim }}
											title={new Date(p.timestamp).toLocaleString()}
										>
											{formatPointTime(p.timestamp)}
										</span>
										<span
											className="text-2xs font-mono tabular-nums"
											data-testid="timeline-row-label"
											style={{ color: barColor }}
											title={
												display.overLimit
													? `Over the context limit: ${formatTokensCompact(p.contextTokens)} against a ${formatTokensCompact(p.contextWindow)} window`
													: undefined
											}
										>
											{hasWindow ? `${display.truePercentage}%` : '~'} ·{' '}
											{formatTokensCompact(p.contextTokens)}
											{hasWindow ? ` / ${formatTokensCompact(p.contextWindow)}` : ''}
										</span>
									</div>
									{/* Fill bar */}
									<div
										className="h-2 rounded-full overflow-hidden relative"
										style={{ backgroundColor: theme.colors.bgActivity }}
										data-testid="timeline-bar-track"
									>
										<div
											className="h-full rounded-full transition-all"
											data-testid="timeline-bar-fill"
											style={{
												width: `${Math.max(display.fillFraction * 100, p.contextTokens > 0 ? 2 : 0)}%`,
												backgroundColor: barColor,
											}}
										/>
										{/* The persistent 100% boundary; only drawn once some turn
											    has pushed the track past the window. */}
										{tickPercent !== null && (
											<div
												className="absolute top-0 bottom-0 w-px pointer-events-none"
												data-testid="timeline-limit-tick"
												style={{ left: `${tickPercent}%`, backgroundColor: theme.colors.textMain }}
												title="100% of the context window"
											/>
										)}
									</div>
									{/* Per-turn token breakdown */}
									<div className="flex flex-wrap gap-x-3 gap-y-0.5 text-2xs">
										<TokenChip label="in" value={p.inputTokens} color={theme.colors.textMain} />
										<TokenChip
											label="cache r"
											value={p.cacheReadInputTokens}
											color={theme.colors.textDim}
										/>
										<TokenChip
											label="cache w"
											value={p.cacheCreationInputTokens}
											color={theme.colors.textDim}
										/>
										<TokenChip label="out" value={p.outputTokens} color={theme.colors.textMain} />
										<TokenChip
											label="reason"
											value={p.reasoningTokens}
											color={theme.colors.textDim}
										/>
										{p.totalCostUsd > 0 && (
											<span
												className="inline-flex items-center gap-1 whitespace-nowrap font-mono"
												style={{ color: theme.colors.success }}
											>
												{formatCost(p.totalCostUsd)}
											</span>
										)}
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}
