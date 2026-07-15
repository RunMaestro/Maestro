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
	const latestPercent = latest?.percentage ?? null;

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
							const pct = p.percentage;
							// Drive the bar width from the SAME value as the % label and color:
							// the provider-reported percentage when available, else the raw
							// tokens/window ratio. Otherwise a "50%" label could sit beside a
							// 30%-filled bar when the two sources disagree.
							const fillFraction =
								pct !== null
									? Math.min(1, Math.max(0, pct / 100))
									: p.contextWindow > 0
										? Math.min(1, Math.max(0, p.contextTokens / p.contextWindow))
										: 0;
							const barColor = getContextColor(pct ?? Math.round(fillFraction * 100), theme);
							// When the percentage is indeterminate (an accumulated multi-tool
							// turn whose raw tokens exceed the window), contextTokens can read
							// higher than the window - "310k / 200k" would imply an impossible
							// breach. Cap the shown figure to the window and flag it instead.
							const overflow =
								pct === null && p.contextWindow > 0 && p.contextTokens > p.contextWindow;
							const displayTokens = overflow ? p.contextWindow : p.contextTokens;
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
											style={{ color: barColor }}
											title={
												overflow
													? 'Accumulated across multiple internal calls in one turn'
													: undefined
											}
										>
											{pct !== null ? `${Math.round(pct)}%` : '~'} ·{' '}
											{formatTokensCompact(displayTokens)}
											{overflow ? '+' : ''}
											{p.contextWindow > 0 ? ` / ${formatTokensCompact(p.contextWindow)}` : ''}
										</span>
									</div>
									{/* Fill bar */}
									<div
										className="h-2 rounded-full overflow-hidden"
										style={{ backgroundColor: theme.colors.bgActivity }}
									>
										<div
											className="h-full rounded-full transition-all"
											style={{
												width: `${Math.max(fillFraction * 100, p.contextTokens > 0 ? 2 : 0)}%`,
												backgroundColor: barColor,
											}}
										/>
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
