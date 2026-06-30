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

import { useEffect, useMemo, useRef } from 'react';
import { Gauge, Minus, X, Trash2 } from 'lucide-react';
import type { Theme } from '../types';
import {
	useContextTimelineStore,
	selectPoints,
	type ContextTimelinePoint,
} from '../stores/contextTimelineStore';
import { useSessionStore } from '../stores/sessionStore';
import { useModalLayer } from '../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { getContextColor } from '../utils/theme';
import { formatTokensCompact, formatCost } from '../../shared/formatters';

interface ContextTimelinePanelProps {
	theme: Theme;
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
	const minimized = useContextTimelineStore((s) => s.minimized);
	const points = useContextTimelineStore(selectPoints(panelSessionId));
	const buffer = useContextTimelineStore((s) =>
		panelSessionId ? s.buffers[panelSessionId] : undefined
	);
	const minimizePanel = useContextTimelineStore((s) => s.minimizePanel);
	const closePanel = useContextTimelineStore((s) => s.closePanel);
	const clearSession = useContextTimelineStore((s) => s.clearSession);

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

	// Escape minimizes (least destructive). Only while the full panel is open.
	useModalLayer(MODAL_PRIORITIES.CONTEXT_TIMELINE, 'Context Timeline', minimizePanel, {
		enabled: !!panelSessionId && !minimized,
		blocksLowerLayers: false,
		capturesFocus: false,
		focusTrap: 'none',
	});

	// Auto-tail: when pinned to the top, follow new turns (newest is at the top).
	useEffect(() => {
		if (minimized) return;
		if (!stickToTopRef.current) return;
		const el = scrollRef.current;
		if (el) el.scrollTop = 0;
	}, [ordered, minimized]);

	if (!panelSessionId || minimized) return null;

	const label = sessionName || panelSessionId.slice(0, 8);

	return (
		<div
			className="fixed bottom-4 left-4 z-[9997] flex flex-col rounded-lg border shadow-2xl select-none"
			style={{
				width: 360,
				maxWidth: 'calc(100vw - 2rem)',
				height: '70vh',
				maxHeight: 600,
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
