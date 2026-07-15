/**
 * KeyboardStats
 *
 * Renders the "Shortcuts" tab of the Usage Dashboard. Combines two data
 * sources:
 *
 * 1. Keyboard mastery (which shortcuts the user has ever fired) - sourced from
 *    `settingsStore.keyboardMasteryStats`. This is the same data backing the
 *    "85 / 87 mastered" display in the keyboard shortcuts help modal.
 * 2. Daily firing counts - fetched from
 *    `window.maestro.stats.getShortcutUsageByDay`. Every shortcut firing
 *    increments the local-time day's bucket; the UI zero-fills missing days so
 *    the bar geometry matches calendar reality.
 *
 * The mastery section is free (no schema needed); the daily chart relies on
 * the v7 `shortcut_usage_daily` migration.
 */

import { memo, useEffect, useMemo, useState } from 'react';
import { Keyboard, Trophy, Sparkles } from 'lucide-react';
import type { Theme, Shortcut } from '../../types';
import type { ShortcutUsageDay, StatsTimeRange } from '../../../shared/stats-types';
import { useSettingsStore } from '../../stores/settingsStore';
import { FIXED_SHORTCUTS } from '../../constants/shortcuts';
import { KEYBOARD_MASTERY_LEVELS, getLevelForPercentage } from '../../constants/keyboardMastery';
import { formatNumber } from '../../../shared/formatters';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import { logger } from '../../utils/logger';
import { MetricCard } from './SummaryCards';

interface KeyboardStatsProps {
	timeRange: StatsTimeRange;
	theme: Theme;
}

const RING_DIAMETER = 140;
const RING_STROKE = 12;

function MasteryRing({ percentage, theme }: { percentage: number; theme: Theme }) {
	const radius = (RING_DIAMETER - RING_STROKE) / 2;
	const circumference = 2 * Math.PI * radius;
	const dashOffset = circumference * (1 - percentage / 100);

	return (
		<svg
			width={RING_DIAMETER}
			height={RING_DIAMETER}
			viewBox={`0 0 ${RING_DIAMETER} ${RING_DIAMETER}`}
			role="img"
			aria-label={`${Math.round(percentage)} percent of keyboard shortcuts mastered`}
		>
			<circle
				cx={RING_DIAMETER / 2}
				cy={RING_DIAMETER / 2}
				r={radius}
				fill="none"
				stroke={`${theme.colors.border}`}
				strokeWidth={RING_STROKE}
			/>
			<circle
				cx={RING_DIAMETER / 2}
				cy={RING_DIAMETER / 2}
				r={radius}
				fill="none"
				stroke={theme.colors.accent}
				strokeWidth={RING_STROKE}
				strokeDasharray={circumference}
				strokeDashoffset={dashOffset}
				strokeLinecap="round"
				transform={`rotate(-90 ${RING_DIAMETER / 2} ${RING_DIAMETER / 2})`}
				style={{ transition: 'stroke-dashoffset 600ms ease-out' }}
			/>
			<text
				x="50%"
				y="46%"
				textAnchor="middle"
				dominantBaseline="middle"
				style={{
					fill: theme.colors.textMain,
					fontSize: 28,
					fontWeight: 700,
				}}
			>
				{Math.round(percentage)}%
			</text>
			<text
				x="50%"
				y="62%"
				textAnchor="middle"
				dominantBaseline="middle"
				style={{
					fill: theme.colors.textDim,
					fontSize: 11,
					textTransform: 'uppercase',
					letterSpacing: '0.08em',
				}}
			>
				Mastered
			</text>
		</svg>
	);
}

/**
 * Build a complete date series for the requested range, zero-filling any gaps.
 * The lower bound is inferred from the data itself for `all`, otherwise computed
 * from the time range to keep bar widths consistent across modal opens.
 */
function buildContinuousSeries(
	data: ShortcutUsageDay[],
	range: StatsTimeRange
): ShortcutUsageDay[] {
	const ymd = (d: Date) => {
		const yyyy = d.getFullYear();
		const mm = String(d.getMonth() + 1).padStart(2, '0');
		const dd = String(d.getDate()).padStart(2, '0');
		return `${yyyy}-${mm}-${dd}`;
	};

	const parseYmd = (s: string): Date | null => {
		const parts = s.split('-').map(Number);
		if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
		return new Date(parts[0], parts[1] - 1, parts[2]);
	};

	const lookup = new Map<string, number>();
	let earliest: Date | null = null;
	for (const entry of data) {
		lookup.set(entry.date, entry.count);
		const d = parseYmd(entry.date);
		if (d && (!earliest || d < earliest)) earliest = d;
	}

	const today = new Date();
	today.setHours(0, 0, 0, 0);

	let start: Date;
	switch (range) {
		case 'day':
			start = new Date(today);
			break;
		case 'week':
			start = new Date(today);
			start.setDate(today.getDate() - 6);
			break;
		case 'month':
			start = new Date(today);
			start.setDate(today.getDate() - 29);
			break;
		case 'quarter':
			start = new Date(today);
			start.setDate(today.getDate() - 89);
			break;
		case 'year':
			start = new Date(today);
			start.setDate(today.getDate() - 364);
			break;
		case 'all':
			start = earliest ?? new Date(today);
			break;
		default:
			start = new Date(today);
	}

	const series: ShortcutUsageDay[] = [];
	const cursor = new Date(start);
	while (cursor <= today) {
		const key = ymd(cursor);
		series.push({ date: key, count: lookup.get(key) ?? 0 });
		cursor.setDate(cursor.getDate() + 1);
	}
	return series;
}

/**
 * Pretty short label for a YYYY-MM-DD bucket. Hides labels on dense series so
 * the axis isn't crowded - the renderer only emits a label every Nth tick.
 */
function formatTickLabel(date: string, index: number, total: number): string {
	if (total <= 7) return date.slice(5); // MM-DD on small ranges
	const stride = Math.max(1, Math.ceil(total / 8));
	if (index % stride !== 0 && index !== total - 1) return '';
	return date.slice(5);
}

interface DailyBarChartProps {
	series: ShortcutUsageDay[];
	theme: Theme;
}

function DailyBarChart({ series, theme }: DailyBarChartProps) {
	const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
	const maxCount = useMemo(() => Math.max(1, ...series.map((d) => d.count)), [series]);
	const chartHeight = 160;
	const total = series.length;

	if (total === 0) {
		return (
			<div
				className="flex items-center justify-center"
				style={{ height: chartHeight, color: theme.colors.textDim }}
			>
				<span className="text-sm">No shortcut usage recorded yet</span>
			</div>
		);
	}

	return (
		<div className="relative">
			<div className="flex items-stretch gap-px" style={{ height: chartHeight }}>
				{series.map((entry, index) => {
					const heightPct = maxCount > 0 ? (entry.count / maxCount) * 100 : 0;
					const isHovered = hoveredIndex === index;
					const minVisible = entry.count > 0 ? 2 : 0;

					return (
						<div
							key={entry.date}
							className="relative flex-1 flex flex-col justify-end cursor-default"
							style={{ minWidth: 0, height: '100%' }}
							onMouseEnter={() => setHoveredIndex(index)}
							onMouseLeave={() => setHoveredIndex(null)}
						>
							<div
								className="w-full rounded-t transition-all duration-200"
								style={{
									height: `${Math.max(heightPct, minVisible)}%`,
									backgroundColor: isHovered ? theme.colors.accent : `${theme.colors.accent}60`,
									transform: isHovered ? 'scaleY(1.05)' : 'scaleY(1)',
									transformOrigin: 'bottom',
								}}
							/>
							{isHovered && (
								<div
									className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 rounded text-xs whitespace-nowrap z-10"
									style={{
										backgroundColor: theme.colors.bgActivity,
										color: theme.colors.textMain,
										border: `1px solid ${theme.colors.border}`,
										boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
									}}
								>
									<div style={{ fontWeight: 600 }}>{entry.date}</div>
									<div style={{ color: theme.colors.textDim }}>
										{formatNumber(entry.count)} shortcut
										{entry.count === 1 ? '' : 's'}
									</div>
								</div>
							)}
						</div>
					);
				})}
			</div>
			{/* X-axis labels */}
			<div
				className="flex gap-px mt-2 text-[10px]"
				style={{ color: theme.colors.textDim }}
				aria-hidden="true"
			>
				{series.map((entry, index) => (
					<div key={entry.date} className="flex-1 text-center truncate" style={{ minWidth: 0 }}>
						{formatTickLabel(entry.date, index, total)}
					</div>
				))}
			</div>
		</div>
	);
}

export const KeyboardStats = memo(function KeyboardStats({ timeRange, theme }: KeyboardStatsProps) {
	const masteryStats = useSettingsStore((s) => s.keyboardMasteryStats);
	const shortcuts = useSettingsStore((s) => s.shortcuts);
	const tabShortcuts = useSettingsStore((s) => s.tabShortcuts);

	const [series, setSeries] = useState<ShortcutUsageDay[] | null>(null);
	const [total, setTotal] = useState<number>(0);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		Promise.all([
			window.maestro.stats.getShortcutUsageByDay(timeRange),
			window.maestro.stats.getShortcutUsageTotal(timeRange),
		])
			.then(([byDay, totalCount]) => {
				if (cancelled) return;
				setSeries(byDay);
				setTotal(totalCount);
			})
			.catch((err) => {
				if (cancelled) return;
				logger.error('Failed to fetch shortcut usage stats', undefined, err);
				setSeries([]);
				setTotal(0);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});

		// Refresh on stats:updated so the chart reflects firings while the
		// modal is open.
		const unsubscribe = window.maestro.stats.onStatsUpdate(() => {
			Promise.all([
				window.maestro.stats.getShortcutUsageByDay(timeRange),
				window.maestro.stats.getShortcutUsageTotal(timeRange),
			])
				.then(([byDay, totalCount]) => {
					if (cancelled) return;
					setSeries(byDay);
					setTotal(totalCount);
				})
				.catch(() => {
					/* best-effort refresh; surface only initial-load errors */
				});
		});

		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [timeRange]);

	const allShortcuts = useMemo<Record<string, Shortcut>>(
		() => ({
			...shortcuts,
			...tabShortcuts,
			...FIXED_SHORTCUTS,
		}),
		[shortcuts, tabShortcuts]
	);

	const totalShortcuts = Object.keys(allShortcuts).length;
	const usedSet = useMemo(() => new Set(masteryStats.usedShortcuts), [masteryStats.usedShortcuts]);
	const usedCount = useMemo(
		() => Object.keys(allShortcuts).filter((id) => usedSet.has(id)).length,
		[allShortcuts, usedSet]
	);
	const percentage = totalShortcuts > 0 ? (usedCount / totalShortcuts) * 100 : 0;
	const currentLevel = getLevelForPercentage(percentage);
	const nextLevel = useMemo(() => {
		const idx = KEYBOARD_MASTERY_LEVELS.findIndex((lvl) => lvl.id === currentLevel.id);
		return idx >= 0 && idx < KEYBOARD_MASTERY_LEVELS.length - 1
			? KEYBOARD_MASTERY_LEVELS[idx + 1]
			: null;
	}, [currentLevel]);
	const shortcutsToNextLevel = useMemo(() => {
		if (!nextLevel || totalShortcuts === 0) return 0;
		const needed = Math.ceil((nextLevel.threshold / 100) * totalShortcuts);
		return Math.max(0, needed - usedCount);
	}, [nextLevel, usedCount, totalShortcuts]);

	const unusedShortcuts = useMemo(() => {
		return Object.values(allShortcuts).filter((s) => !usedSet.has(s.id));
	}, [allShortcuts, usedSet]);

	const continuousSeries = useMemo(() => {
		if (!series) return [];
		return buildContinuousSeries(series, timeRange);
	}, [series, timeRange]);

	const peakDay = useMemo(() => {
		let peak: ShortcutUsageDay | null = null;
		for (const entry of continuousSeries) {
			if (!peak || entry.count > peak.count) peak = entry;
		}
		return peak && peak.count > 0 ? peak : null;
	}, [continuousSeries]);

	return (
		<div className="space-y-6">
			{/* Mastery + summary cards */}
			<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
				<div
					className="p-4 rounded-lg flex items-center gap-4"
					style={{
						backgroundColor: theme.colors.bgMain,
						border: `1px solid ${theme.colors.border}`,
					}}
				>
					<MasteryRing percentage={percentage} theme={theme} />
					<div className="min-w-0">
						<div
							className="text-xs uppercase tracking-wide mb-1"
							style={{ color: theme.colors.textDim }}
						>
							Keyboard Mastery
						</div>
						<div className="text-lg font-semibold mb-1" style={{ color: theme.colors.textMain }}>
							{currentLevel.name}
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							{usedCount} / {totalShortcuts} shortcuts used
						</div>
						{nextLevel && shortcutsToNextLevel > 0 && (
							<div
								className="text-xs mt-2 flex items-center gap-1"
								style={{ color: theme.colors.accent }}
							>
								<Sparkles className="w-3 h-3" />
								{shortcutsToNextLevel} more to {nextLevel.name}
							</div>
						)}
						{!nextLevel && (
							<div
								className="text-xs mt-2 flex items-center gap-1"
								style={{ color: theme.colors.accent }}
							>
								<Trophy className="w-3 h-3" />
								Complete mastery
							</div>
						)}
					</div>
				</div>

				<MetricCard
					icon={<Keyboard className="w-4 h-4" />}
					label="Shortcut firings"
					value={loading ? '-' : formatNumber(total)}
					theme={theme}
					animationIndex={1}
					extra={
						<div className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
							in selected range
						</div>
					}
				/>

				<MetricCard
					icon={<Sparkles className="w-4 h-4" />}
					label="Peak day"
					value={peakDay ? formatNumber(peakDay.count) : '-'}
					theme={theme}
					animationIndex={2}
					extra={
						<div className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
							{peakDay ? peakDay.date : 'No data yet'}
						</div>
					}
				/>
			</div>

			{/* Daily bar chart */}
			<div
				className="p-4 rounded-lg"
				style={{
					backgroundColor: theme.colors.bgMain,
					border: `1px solid ${theme.colors.border}`,
				}}
				role="figure"
				aria-label="Daily keyboard shortcut firings"
			>
				<div className="flex items-center justify-between mb-3">
					<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						Daily Firings
					</h3>
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						{continuousSeries.length} day
						{continuousSeries.length === 1 ? '' : 's'}
					</span>
				</div>
				<DailyBarChart series={continuousSeries} theme={theme} />
			</div>

			{/* Unused shortcuts */}
			<div
				className="p-4 rounded-lg"
				style={{
					backgroundColor: theme.colors.bgMain,
					border: `1px solid ${theme.colors.border}`,
				}}
			>
				<div className="flex items-center justify-between mb-3">
					<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						Unused Shortcuts
					</h3>
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						{unusedShortcuts.length} remaining
					</span>
				</div>
				{unusedShortcuts.length === 0 ? (
					<div className="flex items-center gap-2 text-sm" style={{ color: theme.colors.accent }}>
						<Trophy className="w-4 h-4" />
						You've fired every shortcut at least once.
					</div>
				) : (
					<ul
						className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1.5 text-sm"
						style={{ color: theme.colors.textDim }}
					>
						{unusedShortcuts.map((s) => (
							<li key={s.id} className="flex items-center gap-2 min-w-0">
								<span
									className="w-1 h-1 rounded-full flex-shrink-0"
									style={{ backgroundColor: theme.colors.textDim }}
								/>
								<span className="truncate" title={s.label}>
									{s.label}
								</span>
								{s.keys.length > 0 && (
									<kbd
										className="px-1.5 py-0.5 rounded border font-mono text-[10px] font-bold flex-shrink-0 ml-auto"
										style={{
											backgroundColor: theme.colors.bgActivity,
											borderColor: theme.colors.border,
											color: theme.colors.textMain,
										}}
									>
										{formatShortcutKeys(s.keys)}
									</kbd>
								)}
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
});
