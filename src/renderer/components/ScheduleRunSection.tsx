/**
 * ScheduleRunSection.tsx
 *
 * "Start" control for the Auto Run modal: run now (default) or once at a
 * specific future date/time. Sits alongside the worktree toggle so both
 * launch-shaping options live in the same place.
 *
 * Owns only the picker; the actual firing lives in scheduledAutoRunStore +
 * useScheduledAutoRunDispatcher.
 */

import { memo, useMemo } from 'react';
import { CalendarClock } from 'lucide-react';
import type { Theme } from '../types';
import { ToggleButtonGroup } from './ToggleButtonGroup';
import { formatFutureTime } from '../../shared/formatters';

export type RunStartMode = 'now' | 'scheduled';

interface ScheduleRunSectionProps {
	theme: Theme;
	startMode: RunStartMode;
	onStartModeChange: (mode: RunStartMode) => void;
	/** Raw `datetime-local` value (local wall clock, no timezone suffix). */
	scheduledAtLocal: string;
	onScheduledAtLocalChange: (value: string) => void;
}

/**
 * Format a Date as the `YYYY-MM-DDTHH:mm` string `<input type="datetime-local">`
 * expects. Built from local getters (not toISOString) so the value matches the
 * user's wall clock rather than UTC.
 */
export function toDateTimeLocalValue(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return (
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
		`T${pad(date.getHours())}:${pad(date.getMinutes())}`
	);
}

/**
 * Parse a `datetime-local` value into epoch ms, interpreting it in the local
 * timezone. Returns null when the value is empty or malformed.
 */
export function parseDateTimeLocalValue(value: string): number | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
	if (!match) return null;
	const [, year, month, day, hour, minute] = match;
	const parsed = new Date(
		Number(year),
		Number(month) - 1,
		Number(day),
		Number(hour),
		Number(minute),
		0,
		0
	);
	const time = parsed.getTime();
	return Number.isFinite(time) ? time : null;
}

export const ScheduleRunSection = memo(function ScheduleRunSection({
	theme,
	startMode,
	onStartModeChange,
	scheduledAtLocal,
	onScheduledAtLocalChange,
}: ScheduleRunSectionProps) {
	const isScheduled = startMode === 'scheduled';
	const scheduledFor = useMemo(
		() => (isScheduled ? parseDateTimeLocalValue(scheduledAtLocal) : null),
		[isScheduled, scheduledAtLocal]
	);
	const isPast = scheduledFor !== null && scheduledFor <= Date.now();

	return (
		<div className="mb-6">
			{/* Section header - matches "DOCUMENTS TO RUN" / "RUN IN WORKTREE" style */}
			<div className="flex items-center justify-between mb-3">
				<label className="text-xs font-bold uppercase" style={{ color: theme.colors.textDim }}>
					Start
				</label>
			</div>

			<div
				className="rounded-lg border transition-colors px-3 py-2.5"
				style={{
					borderColor: isScheduled ? theme.colors.accent + '40' : theme.colors.border,
					backgroundColor: isScheduled ? theme.colors.accent + '08' : 'transparent',
				}}
			>
				<div className="flex items-center gap-3">
					<CalendarClock
						className="w-3.5 h-3.5 shrink-0"
						style={{ color: isScheduled ? theme.colors.accent : theme.colors.textDim }}
					/>
					<ToggleButtonGroup<RunStartMode>
						options={[
							{ value: 'now', label: 'Now' },
							{ value: 'scheduled', label: 'At a set time' },
						]}
						value={startMode}
						onChange={onStartModeChange}
						theme={theme}
					/>
				</div>

				{isScheduled && (
					<div className="mt-3">
						<input
							type="datetime-local"
							value={scheduledAtLocal}
							min={toDateTimeLocalValue(new Date())}
							onChange={(e) => onScheduledAtLocalChange(e.target.value)}
							className="w-full px-2 py-1.5 rounded border bg-transparent outline-none text-sm font-mono"
							style={{
								borderColor: isPast ? theme.colors.error : theme.colors.border,
								color: theme.colors.textMain,
								// Tell Chromium which palette to draw the native calendar/clock
								// picker with, otherwise it renders a light picker over a dark modal.
								colorScheme: theme.mode === 'light' ? 'light' : 'dark',
							}}
							aria-label="Scheduled start time"
						/>
						<p
							className="text-[10px] mt-1.5"
							style={{ color: isPast ? theme.colors.error : theme.colors.textDim }}
						>
							{scheduledFor === null
								? 'Pick the date and time this Auto Run should start.'
								: isPast
									? 'Pick a time in the future.'
									: `Runs once ${formatFutureTime(scheduledFor)}. Maestro must be running then - ` +
										'if it was closed for more than 6 hours past the start time, the run is skipped.'}
						</p>
					</div>
				)}
			</div>
		</div>
	);
});
