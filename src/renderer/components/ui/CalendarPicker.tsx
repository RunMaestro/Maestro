/**
 * CalendarPicker - themed month-grid date picker.
 *
 * A general UI primitive (first used by the tab snooze flow). Renders a single
 * month with weekday headers, month navigation, and a "Today" shortcut. Dates
 * before `minDate` are disabled so callers can forbid picking the past.
 *
 * Pure presentation: it emits the selected Date (local midnight) and holds no
 * state beyond which month is on screen.
 */

import { useMemo, useState, useCallback } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Theme } from '../../types';

export interface CalendarPickerProps {
	theme: Theme;
	/** Currently selected date, or null when nothing is picked yet. */
	value: Date | null;
	/** Fired with local midnight of the clicked day. */
	onChange: (date: Date) => void;
	/** Days strictly before this date are disabled. Defaults to today. */
	minDate?: Date;
}

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function startOfDay(date: Date): Date {
	const next = new Date(date);
	next.setHours(0, 0, 0, 0);
	return next;
}

function isSameDay(a: Date, b: Date): boolean {
	return (
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate()
	);
}

export function CalendarPicker({ theme, value, onChange, minDate }: CalendarPickerProps) {
	const today = useMemo(() => startOfDay(new Date()), []);
	const floor = useMemo(() => (minDate ? startOfDay(minDate) : today), [minDate, today]);

	// Which month is on screen - starts on the selection, else today.
	const [viewDate, setViewDate] = useState<Date>(() => {
		const anchor = value ?? today;
		return new Date(anchor.getFullYear(), anchor.getMonth(), 1);
	});

	/**
	 * The 6-week grid for the visible month: leading blanks for the weekday
	 * offset, then each day. Blanks keep the columns aligned under the headers.
	 */
	const cells = useMemo(() => {
		const year = viewDate.getFullYear();
		const month = viewDate.getMonth();
		const leadingBlanks = new Date(year, month, 1).getDay();
		const daysInMonth = new Date(year, month + 1, 0).getDate();

		const result: Array<Date | null> = [];
		for (let i = 0; i < leadingBlanks; i++) result.push(null);
		for (let day = 1; day <= daysInMonth; day++) result.push(new Date(year, month, day));
		return result;
	}, [viewDate]);

	const shiftMonth = useCallback((delta: number) => {
		setViewDate((prev) => new Date(prev.getFullYear(), prev.getMonth() + delta, 1));
	}, []);

	const jumpToToday = useCallback(() => {
		setViewDate(new Date(today.getFullYear(), today.getMonth(), 1));
		onChange(today);
	}, [today, onChange]);

	// Disable back-navigation once the visible month is the floor's month.
	const canGoBack =
		viewDate.getFullYear() > floor.getFullYear() ||
		(viewDate.getFullYear() === floor.getFullYear() && viewDate.getMonth() > floor.getMonth());

	return (
		<div className="select-none">
			{/* Month header with navigation */}
			<div className="flex items-center justify-between mb-2">
				<button
					type="button"
					onClick={() => shiftMonth(-1)}
					disabled={!canGoBack}
					aria-label="Previous month"
					className={`p-1 rounded transition-colors ${
						canGoBack ? 'hover:bg-white/10' : 'opacity-30 cursor-default'
					}`}
					style={{ color: theme.colors.textDim }}
				>
					<ChevronLeft className="w-4 h-4" />
				</button>

				<div className="flex items-center gap-2">
					<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						{viewDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
					</span>
					<button
						type="button"
						onClick={jumpToToday}
						className="text-2xs px-1.5 py-0.5 rounded hover:bg-white/10 transition-colors"
						style={{ color: theme.colors.textDim, border: `1px solid ${theme.colors.border}` }}
					>
						Today
					</button>
				</div>

				<button
					type="button"
					onClick={() => shiftMonth(1)}
					aria-label="Next month"
					className="p-1 rounded hover:bg-white/10 transition-colors"
					style={{ color: theme.colors.textDim }}
				>
					<ChevronRight className="w-4 h-4" />
				</button>
			</div>

			{/* Weekday headers */}
			<div className="grid grid-cols-7 gap-0.5 mb-1">
				{WEEKDAY_LABELS.map((label, index) => (
					<div
						key={`${label}-${index}`}
						className="text-center text-2xs font-medium py-1"
						style={{ color: theme.colors.textDim }}
					>
						{label}
					</div>
				))}
			</div>

			{/* Day grid */}
			<div className="grid grid-cols-7 gap-0.5">
				{cells.map((date, index) => {
					if (!date) return <div key={`blank-${index}`} />;

					const disabled = date.getTime() < floor.getTime();
					const selected = value != null && isSameDay(date, value);
					const isToday = isSameDay(date, today);

					return (
						<button
							key={date.getTime()}
							type="button"
							onClick={() => onChange(date)}
							disabled={disabled}
							aria-pressed={selected}
							className={`h-7 rounded text-xs transition-colors ${
								disabled ? 'opacity-25 cursor-default' : selected ? '' : 'hover:bg-white/10'
							}`}
							style={{
								backgroundColor: selected ? theme.colors.accent : 'transparent',
								color: selected
									? theme.colors.bgMain
									: isToday
										? theme.colors.accent
										: theme.colors.textMain,
								fontWeight: selected || isToday ? 600 : 400,
							}}
						>
							{date.getDate()}
						</button>
					);
				})}
			</div>
		</div>
	);
}
