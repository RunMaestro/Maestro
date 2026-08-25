import React, { useCallback, useMemo } from 'react';
import { Clock, Info } from 'lucide-react';
import type { Theme } from '../types';
import { parseScheduleTimestamp } from '../../shared/cue/scheduled-tasks';

/**
 * "Start: Now / At a set time" control for the Auto Run window.
 *
 * Sits alongside `WorktreeRunSection` and mirrors its visual language: a
 * section header, a bordered toggle container, and expanded content that only
 * appears once the toggle is on.
 *
 * Scheduling is backed by Maestro Cue (a `time.once` subscription with
 * `action: 'autorun'`), which is why the control is gated on the Cue Encore
 * Feature. Cue already owns fire timing, persistence across restarts, the
 * missed-fire grace window, and an activity log; a second scheduler inside the
 * Auto Run panel would duplicate all four and disagree with Cue about at least
 * one of them.
 */

/** Local-time `datetime-local` value (`YYYY-MM-DDTHH:mm`) for a Date. */
export function toDateTimeLocalValue(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return (
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
		`T${pad(date.getHours())}:${pad(date.getMinutes())}`
	);
}

/**
 * Parse a `datetime-local` value as LOCAL wall-clock time.
 *
 * Delegates to the shared Cue parser rather than `new Date(value)` so the CLI
 * scheduler and this picker agree on what "7:00" means. The distinction is not
 * cosmetic: treating the picker's value as UTC shifts every scheduled run by
 * the machine's offset, which is how "start at 6am" quietly becomes 1am.
 */
export function fromDateTimeLocalValue(value: string): Date | null {
	if (!value) return null;
	return parseScheduleTimestamp(value);
}

/** Smallest gap we accept between "now" and the scheduled time. */
const MIN_LEAD_MS = 60_000;

export interface ScheduleRunSectionProps {
	theme: Theme;
	/** Local `datetime-local` string, or '' when the run starts immediately. */
	value: string;
	onChange: (value: string) => void;
	/** False when the Maestro Cue Encore Feature is off. */
	cueEnabled: boolean;
	/** Opens Settings so the user can turn Cue on. */
	onOpenEncoreSettings?: () => void;
}

/**
 * Validate a scheduled start. Returns an error string, or null when the value
 * is a usable future time (or empty, meaning "now").
 */
export function validateScheduledStart(value: string, now: Date = new Date()): string | null {
	if (!value) return null;
	const parsed = fromDateTimeLocalValue(value);
	if (!parsed) return 'Pick a valid date and time.';
	const delta = parsed.getTime() - now.getTime();
	if (delta < MIN_LEAD_MS) return 'Pick a time at least a minute from now.';
	return null;
}

export function ScheduleRunSection({
	theme,
	value,
	onChange,
	cueEnabled,
	onOpenEncoreSettings,
}: ScheduleRunSectionProps) {
	const isEnabled = value !== '';

	// `min` stops the picker offering times already in the past. It is an
	// affordance, not the guard - a user can still type an earlier value, so
	// `validateScheduledStart` re-checks before the run is scheduled.
	const minValue = useMemo(() => toDateTimeLocalValue(new Date()), []);

	const error = useMemo(() => validateScheduledStart(value), [value]);

	const handleToggle = useCallback(() => {
		if (!cueEnabled) return;
		if (isEnabled) {
			onChange('');
		} else {
			// Default an hour out: the driving use case is "start once my token
			// limit resets", which is always some hours away, and a default of
			// "now" would make the toggle look like it did nothing.
			const inAnHour = new Date(Date.now() + 60 * 60 * 1000);
			inAnHour.setSeconds(0, 0);
			onChange(toDateTimeLocalValue(inAnHour));
		}
	}, [cueEnabled, isEnabled, onChange]);

	return (
		<div className="mb-6">
			<div className="flex items-center justify-between mb-3">
				<label className="text-xs font-bold uppercase" style={{ color: theme.colors.textDim }}>
					Start
				</label>
				{!cueEnabled && onOpenEncoreSettings && (
					<button
						className="text-xs cursor-pointer hover:underline outline-none bg-transparent border-none p-0"
						style={{ color: theme.colors.accent }}
						onClick={onOpenEncoreSettings}
					>
						Enable Maestro Cue →
					</button>
				)}
			</div>

			<div
				className="rounded-lg border transition-colors"
				style={{
					borderColor: isEnabled ? theme.colors.accent + '40' : theme.colors.border,
					backgroundColor: isEnabled ? theme.colors.accent + '08' : 'transparent',
				}}
			>
				<button
					onClick={cueEnabled ? handleToggle : undefined}
					disabled={!cueEnabled}
					aria-pressed={isEnabled}
					data-testid="schedule-run-toggle"
					className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg transition-colors ${
						!cueEnabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:bg-white/5'
					}`}
				>
					<Clock
						className="w-3.5 h-3.5 shrink-0"
						style={{ color: isEnabled ? theme.colors.accent : theme.colors.textDim }}
					/>
					<span
						className="text-xs font-medium"
						style={{ color: isEnabled ? theme.colors.accent : theme.colors.textMain }}
					>
						{isEnabled ? 'At a set time' : 'Now'}
					</span>
					<span className="ml-auto text-[10px]" style={{ color: theme.colors.textDim }}>
						{cueEnabled
							? isEnabled
								? 'Click to run immediately'
								: 'Click to schedule'
							: 'Requires Maestro Cue'}
					</span>
				</button>

				{isEnabled && (
					<div
						className="px-3 pb-3 pt-1 flex flex-col gap-2 border-t"
						style={{ borderColor: theme.colors.border }}
					>
						<input
							type="datetime-local"
							value={value}
							min={minValue}
							data-testid="schedule-run-datetime"
							aria-label="Scheduled start date and time"
							onChange={(e) => onChange(e.target.value)}
							className="px-2 py-1.5 rounded border text-xs outline-none"
							style={{
								backgroundColor: theme.colors.bgMain,
								borderColor: error ? theme.colors.error : theme.colors.border,
								color: theme.colors.textMain,
							}}
						/>
						{error ? (
							<p className="text-[10px]" style={{ color: theme.colors.error }}>
								{error}
							</p>
						) : (
							<div className="flex items-start gap-1.5">
								<Info className="w-3 h-3 shrink-0 mt-px" style={{ color: theme.colors.textDim }} />
								<p className="text-[10px]" style={{ color: theme.colors.textDim }}>
									Runs once at this time, in your local timezone. The schedule survives restarting
									Maestro and appears under Scheduled Tasks in the Cue window, where you can cancel
									it.
								</p>
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
