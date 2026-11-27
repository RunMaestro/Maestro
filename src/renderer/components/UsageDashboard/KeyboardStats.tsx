/**
 * KeyboardStats
 *
 * Renders the "Shortcuts" tab of the Usage Dashboard. Two kinds of figure, and
 * the tab labels which is which:
 *
 * 1. ALL TIME: keyboard mastery (which bound shortcuts the user has ever
 *    fired), from `settingsStore.keyboardMasteryStats`, the same data behind
 *    the "85 / 87 mastered" display in the keyboard shortcuts help modal. The
 *    range picker does not move it.
 * 2. SELECTED RANGE: firings per local day (`shortcut_usage_daily`), firings
 *    per shortcut (`shortcut_usage_by_id`, recorded since stats schema v14),
 *    and the total. The day axis covers the range's whole window, zero-filled.
 */

import { memo, useMemo } from 'react';
import { Keyboard, Trophy, Sparkles } from 'lucide-react';
import type { Theme, Shortcut } from '../../types';
import type {
	ShortcutUsageByShortcut,
	ShortcutUsageDay,
	StatsTimeRange,
} from '../../../shared/stats-types';
import { useSettingsStore } from '../../stores/settingsStore';
import { FIXED_SHORTCUTS } from '../../constants/shortcuts';
import {
	KEYBOARD_MASTERY_LEVELS,
	collectBoundShortcuts,
	countUsedBoundShortcuts,
	getLevelForPercentage,
} from '../../constants/keyboardMastery';
import { formatCalendarDay, formatNumber } from '../../../shared/formatters';
import { fillDaySeries } from '../../../shared/daySeries';
import { usageReadWindow } from '../../../shared/usageDashboardReads';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import { ChartTooltip, StatCardGrid } from '../widgets';
import type { StatCardDatum } from '../widgets';
import { buildShortcutsSummary } from './footerSummary';
import { usePublishFooterSummary } from './useFooterSummary';
import { DashboardPanelState } from './DashboardPanelState';
import { useBarChartFocus } from './useBarChartFocus';
import { useDashboardResource } from './useDashboardResource';

interface KeyboardStatsProps {
	timeRange: StatsTimeRange;
	theme: Theme;
}

/** Rows in the "Most used shortcuts" list. */
export const MOST_USED_SHORTCUTS_LIMIT = 10;

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
			className="flex-shrink-0"
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
				style={{ fill: theme.colors.textMain, fontSize: 28, fontWeight: 700 }}
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
 * One row per local day of the range's window, zero-filled. The window comes
 * from `usageReadWindow` (calendar-aligned, the same boundary the query used);
 * All Time starts at the first day with data.
 */
export function buildContinuousSeries(
	data: ShortcutUsageDay[],
	range: StatsTimeRange,
	now: number = Date.now()
): ShortcutUsageDay[] {
	const earliest = data.reduce<string | null>(
		(min, entry) => (min === null || entry.date < min ? entry.date : min),
		null
	);
	const window = usageReadWindow(range, earliest, now);
	return fillDaySeries(data, window.startYmd, window.endYmd, (date) => ({ date, count: 0 }));
}

function DailyBarChart({ series, theme }: { series: ShortcutUsageDay[]; theme: Theme }) {
	const maxCount = useMemo(() => Math.max(1, ...series.map((d) => d.count)), [series]);
	const { activeIndex, anchor, containerProps, barProps } = useBarChartFocus(series.length);
	const active = activeIndex !== null ? series[activeIndex] : null;
	const describe = (entry: ShortcutUsageDay) =>
		`${formatCalendarDay(entry.date)}: ${formatNumber(entry.count)} shortcut${entry.count === 1 ? '' : 's'}`;

	return (
		<div className="relative">
			<div
				{...containerProps}
				className="flex items-stretch gap-px outline-none rounded focus-visible:ring-2"
				style={{ height: 160 }}
				role="group"
				aria-label={`Shortcut firings per day, ${series.length} days`}
				data-testid="shortcut-daily-bars"
			>
				{series.map((entry, index) => {
					const heightPct = (entry.count / maxCount) * 100;
					const isActive = activeIndex === index;
					return (
						<div
							key={entry.date}
							{...barProps(index)}
							className="relative flex-1 flex flex-col justify-end cursor-default"
							style={{ minWidth: 0, height: '100%' }}
							data-testid={`shortcut-day-${entry.date}`}
						>
							<div
								className="w-full rounded-t transition-all duration-200"
								style={{
									height: `${entry.count > 0 ? Math.max(heightPct, 2) : 0}%`,
									backgroundColor: isActive ? theme.colors.accent : `${theme.colors.accent}60`,
								}}
							/>
						</div>
					);
				})}
			</div>
			<div
				className="flex justify-between mt-2 text-2xs"
				style={{ color: theme.colors.textDim }}
				aria-hidden="true"
			>
				<span>{series[0] ? formatCalendarDay(series[0].date) : ''}</span>
				<span>{series.length > 1 ? formatCalendarDay(series[series.length - 1].date) : ''}</span>
			</div>
			<span className="sr-only" aria-live="polite">
				{active ? describe(active) : ''}
			</span>
			{active && (
				<ChartTooltip anchor={anchor} theme={theme} testId="shortcut-day-tooltip">
					<div className="font-medium">{formatCalendarDay(active.date)}</div>
					<div style={{ color: theme.colors.textDim }}>
						{formatNumber(active.count)} shortcut{active.count === 1 ? '' : 's'}
					</div>
				</ChartTooltip>
			)}
		</div>
	);
}

function ShortcutKeys({ keys, theme }: { keys: string[]; theme: Theme }) {
	if (keys.length === 0) return null;
	return (
		<kbd
			className="px-1.5 py-0.5 rounded border font-mono text-2xs font-bold flex-shrink-0 ml-auto"
			style={{
				backgroundColor: theme.colors.bgActivity,
				borderColor: theme.colors.border,
				color: theme.colors.textMain,
			}}
		>
			{formatShortcutKeys(keys)}
		</kbd>
	);
}

interface ShortcutUsagePayload {
	byDay: ShortcutUsageDay[];
	total: number;
	byShortcut: ShortcutUsageByShortcut[];
}

export const KeyboardStats = memo(function KeyboardStats({ timeRange, theme }: KeyboardStatsProps) {
	const masteryStats = useSettingsStore((s) => s.keyboardMasteryStats);
	const shortcuts = useSettingsStore((s) => s.shortcuts);
	const tabShortcuts = useSettingsStore((s) => s.tabShortcuts);

	const { data, loading, error, refresh } = useDashboardResource<ShortcutUsagePayload>(
		`shortcut-usage:${timeRange}`,
		async () => {
			const [byDay, total, byShortcut] = await Promise.all([
				window.maestro.stats.getShortcutUsageByDay(timeRange),
				window.maestro.stats.getShortcutUsageTotal(timeRange),
				window.maestro.stats.getShortcutUsageByShortcut(timeRange),
			]);
			return { byDay, total, byShortcut };
		},
		'fetchShortcutUsage',
		{ tables: ['shortcut_usage'] }
	);
	const total = data?.total ?? 0;

	// Unbound shortcuts are excluded outright: the user cannot fire a chord that
	// does not exist, so listing one as "unused" is busywork and counting one in
	// the denominator holds the mastery ring below 100% forever.
	const boundShortcuts = useMemo(
		() => collectBoundShortcuts(shortcuts, tabShortcuts, FIXED_SHORTCUTS),
		[shortcuts, tabShortcuts]
	);
	// Every known shortcut by id, bound or not, to name the "most used" rows.
	const shortcutsById = useMemo(() => {
		const byId = new Map<string, Shortcut>();
		for (const map of [shortcuts, tabShortcuts, FIXED_SHORTCUTS]) {
			for (const [id, shortcut] of Object.entries(map ?? {})) byId.set(id, shortcut);
		}
		return byId;
	}, [shortcuts, tabShortcuts]);

	const totalShortcuts = boundShortcuts.length;
	const usedSet = useMemo(() => new Set(masteryStats.usedShortcuts), [masteryStats.usedShortcuts]);
	const usedCount = useMemo(
		() => countUsedBoundShortcuts(boundShortcuts, usedSet),
		[boundShortcuts, usedSet]
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

	usePublishFooterSummary(
		'shortcuts',
		loading
			? null
			: buildShortcutsSummary({
					presses: total,
					used: usedCount,
					bound: totalShortcuts,
					levelName: currentLevel.name,
				})
	);

	const unusedShortcuts = useMemo(
		() => boundShortcuts.filter((s) => !usedSet.has(s.id)),
		[boundShortcuts, usedSet]
	);

	const continuousSeries = useMemo(
		() => buildContinuousSeries(data?.byDay ?? [], timeRange),
		[data?.byDay, timeRange]
	);

	const peakDay = useMemo(() => {
		let peak: ShortcutUsageDay | null = null;
		for (const entry of continuousSeries) {
			if (!peak || entry.count > peak.count) peak = entry;
		}
		return peak && peak.count > 0 ? peak : null;
	}, [continuousSeries]);

	const mostUsed = useMemo(
		() => (data?.byShortcut ?? []).slice(0, MOST_USED_SHORTCUTS_LIMIT),
		[data?.byShortcut]
	);
	const mostUsedMax = mostUsed[0]?.count ?? 1;

	const rangeCards: StatCardDatum[] = [
		{
			label: 'Shortcut Firings',
			icon: Keyboard,
			value: total,
			caption: 'in the selected range',
		},
		{
			label: 'Peak Day',
			icon: Sparkles,
			value: peakDay?.count ?? 0,
			displayValue: peakDay ? formatNumber(peakDay.count) : '-',
			caption: peakDay ? formatCalendarDay(peakDay.date) : 'No firings in this range',
		},
	];

	const panelStyle = {
		backgroundColor: theme.colors.bgMain,
		border: `1px solid ${theme.colors.border}`,
	};

	return (
		<div className="space-y-6" data-testid="keyboard-stats">
			<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
				{/* Mastery is lifetime: say so, since every other figure follows the range. */}
				<div
					className="p-4 rounded-lg flex items-center gap-4 flex-wrap"
					style={panelStyle}
					data-testid="keyboard-mastery"
				>
					<MasteryRing percentage={percentage} theme={theme} />
					<div className="min-w-0">
						<div
							className="text-xs uppercase tracking-wide mb-1"
							style={{ color: theme.colors.textDim }}
						>
							Keyboard Mastery (all time)
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

				<div className="md:col-span-2">
					<DashboardPanelState
						theme={theme}
						loading={loading}
						error={error}
						onRetry={() => void refresh()}
						testId="shortcut-range-cards"
					>
						<StatCardGrid theme={theme} cards={rangeCards} />
					</DashboardPanelState>
				</div>
			</div>

			<div className="p-4 rounded-lg" style={panelStyle} data-testid="shortcut-daily-chart">
				<div className="flex items-center justify-between mb-3">
					<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						Daily Firings
					</h3>
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						{continuousSeries.length} day{continuousSeries.length === 1 ? '' : 's'}
					</span>
				</div>
				<DashboardPanelState
					theme={theme}
					loading={loading}
					error={error}
					empty={total === 0}
					emptyMessage="No shortcut firings in this range"
					onRetry={() => void refresh()}
					minHeight={160}
					testId="shortcut-daily"
				>
					<DailyBarChart series={continuousSeries} theme={theme} />
				</DashboardPanelState>
			</div>

			<div className="p-4 rounded-lg" style={panelStyle} data-testid="shortcut-most-used">
				<div className="flex items-center justify-between mb-3">
					<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						Most Used Shortcuts
					</h3>
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						in the selected range
					</span>
				</div>
				<DashboardPanelState
					theme={theme}
					loading={loading}
					error={error}
					empty={mostUsed.length === 0}
					emptyMessage="No per-shortcut counts in this range yet. Each shortcut you fire from now on is counted here."
					onRetry={() => void refresh()}
					testId="shortcut-most-used"
				>
					<ol className="space-y-1.5 text-sm">
						{mostUsed.map((row) => {
							const shortcut = shortcutsById.get(row.shortcutId);
							return (
								<li
									key={row.shortcutId}
									className="flex items-center gap-2 min-w-0"
									data-testid="shortcut-most-used-row"
								>
									<span
										className="truncate"
										style={{ color: theme.colors.textMain, minWidth: 0, flex: '0 1 40%' }}
										title={shortcut?.label ?? row.shortcutId}
									>
										{shortcut?.label ?? row.shortcutId}
									</span>
									<div
										className="flex-1 h-2 rounded"
										style={{ backgroundColor: `${theme.colors.border}60` }}
										aria-hidden="true"
									>
										<div
											className="h-2 rounded"
											style={{
												width: `${(row.count / mostUsedMax) * 100}%`,
												backgroundColor: theme.colors.accent,
											}}
										/>
									</div>
									<span
										className="font-mono text-xs w-14 text-right"
										style={{ color: theme.colors.textDim }}
									>
										{formatNumber(row.count)}
									</span>
									<ShortcutKeys keys={shortcut?.keys ?? []} theme={theme} />
								</li>
							);
						})}
					</ol>
				</DashboardPanelState>
			</div>

			<div className="p-4 rounded-lg" style={panelStyle} data-testid="shortcut-unused">
				<div className="flex items-center justify-between mb-3">
					<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						Unused Shortcuts (all time)
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
								<ShortcutKeys keys={s.keys} theme={theme} />
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
});
