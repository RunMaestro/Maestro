/**
 * DayBarTimeline - one stacked bar per local calendar day, for the dashboard's
 * small "X over time" strips (Wizard runs, Resilience outages).
 *
 * The caller passes one entry per day it wants drawn, already gap-filled: build
 * the day keys with `localDaysBetween()` / `usageReadWindow()` so every day of
 * the range has a slot and quiet days read as gaps (and a DST change cannot
 * skip a day, as stepping by 24 hours of milliseconds could).
 *
 * Segments stack bottom-up in the order given. Hover a bar, or Tab to the strip
 * and use the arrow keys, to read a day in the shared `ChartTooltip`.
 */

import { memo, type ReactNode } from 'react';
import type { Theme } from '../../types';
import { ChartTooltip } from '../widgets';
import { formatCalendarDay } from '../../../shared/formatters';
import { useBarChartFocus } from './useBarChartFocus';

export interface DayBarSegment {
	value: number;
	color: string;
}

export interface DayBarEntry {
	/** Local `YYYY-MM-DD`. */
	date: string;
	/** Bottom-up. */
	segments: DayBarSegment[];
}

export interface DayBarLegendItem {
	label: string;
	color: string;
}

interface DayBarTimelineProps {
	days: DayBarEntry[];
	theme: Theme;
	title: string;
	legend: DayBarLegendItem[];
	/** Accessible name for the strip. */
	ariaLabel: string;
	/** Tooltip body for one day (the date heading is drawn for you). */
	renderTooltip: (day: DayBarEntry) => ReactNode;
	/** One-line text for a screen reader when a day is highlighted. */
	describeDay: (day: DayBarEntry) => string;
	testId?: string;
}

function dayTotal(day: DayBarEntry): number {
	return day.segments.reduce((sum, segment) => sum + segment.value, 0);
}

export const DayBarTimeline = memo(function DayBarTimeline({
	days,
	theme,
	title,
	legend,
	ariaLabel,
	renderTooltip,
	describeDay,
	testId,
}: DayBarTimelineProps) {
	const max = Math.max(1, ...days.map(dayTotal));
	const { activeIndex, anchor, containerProps, barProps } = useBarChartFocus(days.length);
	const active = activeIndex !== null ? days[activeIndex] : null;

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid={testId}
		>
			<div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
				<h4 className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
					{title}
				</h4>
				<div className="flex items-center gap-3 text-xs" style={{ color: theme.colors.textDim }}>
					{legend.map((item) => (
						<span key={item.label} className="flex items-center gap-1">
							<span
								className="inline-block w-2.5 h-2.5 rounded-sm"
								style={{ backgroundColor: item.color }}
							/>
							{item.label}
						</span>
					))}
				</div>
			</div>

			<div
				{...containerProps}
				className="flex items-end justify-center gap-0.5 h-20 outline-none rounded focus-visible:ring-2"
				role="group"
				aria-label={ariaLabel}
				data-testid={testId ? `${testId}-bars` : undefined}
			>
				{days.map((day, i) => {
					const total = dayTotal(day);
					const isActive = activeIndex === i;
					return (
						<div
							key={day.date}
							{...barProps(i)}
							className="flex-1 flex flex-col-reverse justify-start h-full cursor-default"
							// Cap the column so a 1-3 day range reads as bars, not slabs.
							style={{ maxWidth: 48, minWidth: 1 }}
							data-testid={testId ? `${testId}-day-${day.date}` : undefined}
							data-active={isActive ? 'true' : undefined}
						>
							{total === 0 ? (
								<div
									className="w-full"
									style={{ height: 2, backgroundColor: `${theme.colors.border}80` }}
								/>
							) : (
								day.segments.map((segment, s) =>
									segment.value > 0 ? (
										<div
											key={s}
											className="w-full"
											style={{
												height: `${(segment.value / max) * 100}%`,
												backgroundColor: segment.color,
												opacity: isActive ? 1 : 0.75,
											}}
										/>
									) : null
								)
							)}
						</div>
					);
				})}
			</div>

			<div className="flex justify-between mt-1 text-2xs" style={{ color: theme.colors.textDim }}>
				<span>{days[0] ? formatCalendarDay(days[0].date) : ''}</span>
				<span>{days.length > 1 ? formatCalendarDay(days[days.length - 1].date) : ''}</span>
			</div>

			<span className="sr-only" aria-live="polite">
				{active ? describeDay(active) : ''}
			</span>
			{active && (
				<ChartTooltip
					anchor={anchor}
					theme={theme}
					testId={testId ? `${testId}-tooltip` : undefined}
				>
					<div className="font-medium mb-1">{formatCalendarDay(active.date)}</div>
					<div style={{ color: theme.colors.textDim }}>{renderTooltip(active)}</div>
				</ChartTooltip>
			)}
		</div>
	);
});
