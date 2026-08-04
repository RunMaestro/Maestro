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
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Gauge, Minus, X, Trash2 } from 'lucide-react';
import type { Theme } from '../types';
import {
	useContextTimelineStore,
	selectPoints,
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

interface ContextTimelinePanelProps {
	theme: Theme;
}

const PANEL_WIDTH = 360;
const PANEL_MAX_HEIGHT = 600;
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 8;
/** The header context gauge that opens this panel; re-queried for its live rect. */
const HEADER_CONTEXT_WIDGET_SELECTOR = '[data-testid="header-context-widget"]';

/** Position the panel near the element that opened it, clamped to the viewport. */
function anchoredStyle(anchor: TimelineAnchorRect): CSSProperties {
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const width = Math.min(PANEL_WIDTH, vw - VIEWPORT_MARGIN * 2);
	const height = Math.min(PANEL_MAX_HEIGHT, Math.round(vh * 0.7));
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
const FALLBACK_STYLE: CSSProperties = {
	bottom: 16,
	left: 16,
	width: PANEL_WIDTH,
	maxWidth: 'calc(100vw - 2rem)',
	height: '70vh',
	maxHeight: PANEL_MAX_HEIGHT,
};

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
	const minimized = useContextTimelineStore((s) => s.minimized);
	const points = useContextTimelineStore(selectPoints(panelSessionId));
	const buffer = useContextTimelineStore((s) =>
		panelSessionId ? s.buffers[panelSessionId] : undefined
	);
	const minimizePanel = useContextTimelineStore((s) => s.minimizePanel);
	const closePanel = useContextTimelineStore((s) => s.closePanel);
	const clearSession = useContextTimelineStore((s) => s.clearSession);

	// Reclamp the anchored position on viewport resize so an open panel never ends
	// up partly offscreen after the Electron window changes size (anchoredStyle
	// reads the live window dimensions, so a re-render is all it needs).
	const [, bumpResizeTick] = useState(0);
	useEventListener('resize', () => bumpResizeTick((n) => n + 1));

	const sessionName = useSessionStore((s) =>
		panelSessionId ? s.sessions.find((sess) => sess.id === panelSessionId)?.name : undefined
	);

	const scrollRef = useRef<HTMLDivElement>(null);
	// Newest turn renders on top, so "following" means staying pinned to the TOP.
	const stickToTopRef = useRef(true);

	const trimmed = buffer?.trimmed ?? false;

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
	const scaleMax = useMemo(
		() => points.reduce((max, p) => Math.max(max, p.contextTokens), latestWindow),
		[points, latestWindow]
	);
	// The 100% boundary inside the track, drawn only when there IS headroom
	// beyond it (i.e. some turn went over the limit).
	const tickPercent =
		scaleMax > latestWindow && latestWindow > 0 ? (latestWindow / scaleMax) * 100 : null;

	// This is a PASSIVE inspector, so it deliberately does NOT register a layer:
	// any layer (modal or overlay) trips hasOpenLayers()/hasOpenModal() and
	// suppresses global shortcuts + file-tree keys while it is open. It is closed
	// with its own X / minimize buttons instead. It does read the shared stack to
	// hide itself while a real modal is open, so its high z-index can't float
	// above lower-z dialogs (Create PR, expanded Auto Run) that own the foreground.
	const { hasOpenModal } = useLayerStack();

	// Auto-tail: when pinned to the top, follow new turns (newest is at the top).
	useEffect(() => {
		if (minimized) return;
		if (!stickToTopRef.current) return;
		const el = scrollRef.current;
		if (el) el.scrollTop = 0;
	}, [ordered, minimized]);

	if (!panelSessionId || minimized) return null;
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
			className="fixed z-[9997] flex flex-col rounded-lg border shadow-2xl select-none"
			style={{
				...(liveAnchor ? anchoredStyle(liveAnchor) : FALLBACK_STYLE),
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
			}}
		>
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
						className="text-[10px] truncate leading-tight"
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
				<button
					onClick={() => clearSession(panelSessionId)}
					title="Clear recorded history"
					className="p-1 rounded hover:bg-white/10 transition-colors shrink-0"
				>
					<Trash2 className="w-4 h-4" style={{ color: theme.colors.textDim }} />
				</button>
				<button
					onClick={minimizePanel}
					title="Minimize"
					className="p-1 rounded hover:bg-white/10 transition-colors shrink-0"
				>
					<Minus className="w-4 h-4" style={{ color: theme.colors.textDim }} />
				</button>
				<button
					onClick={closePanel}
					title="Close (keeps history)"
					className="p-1 rounded hover:bg-white/10 transition-colors shrink-0"
				>
					<X className="w-4 h-4" style={{ color: theme.colors.textDim }} />
				</button>
			</div>

			{/* Window readout */}
			{latestWindow > 0 && (
				<div
					className="px-3 py-1.5 border-b shrink-0 text-[10px]"
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
						No usage recorded yet. The timeline fills as the agent takes turns.
					</p>
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
							return (
								<div key={p.id} className="flex flex-col gap-1">
									<div className="flex items-center justify-between gap-2">
										<span
											className="text-[10px] font-mono select-none"
											style={{ color: theme.colors.textDim }}
											title={new Date(p.timestamp).toLocaleString()}
										>
											{formatPointTime(p.timestamp)}
										</span>
										<span
											className="text-[10px] font-mono tabular-nums"
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
									<div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px]">
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
