/**
 * Scheduled Tasks - the time-driven slice of Maestro Cue.
 *
 * A "scheduled task" is any Cue subscription whose trigger is a clock:
 *
 *   - `time.once`      one-shot, fires at `fire_at`, then self-destructs
 *   - `time.scheduled` recurring, fires at `schedule_times` on `schedule_days`
 *   - `time.heartbeat` recurring, fires every `interval_minutes`
 *
 * The Cue modal's Scheduled Tasks tab, the `maestro-cli cue schedule` command,
 * and the IPC layer between them all speak the shapes in this file, so a task
 * created from the CLI and a task created from the UI are the same object on
 * disk. Everything here is pure and renderer-safe - filesystem work lives in
 * `src/main/cue/cue-scheduled-tasks.ts`.
 */

import type { CueAction, CueScheduleDay } from './contracts';
import { CUE_SCHEDULE_DAYS } from './contracts';

/** Cue events that make a subscription a scheduled task. */
export const SCHEDULED_TASK_EVENTS = ['time.once', 'time.scheduled', 'time.heartbeat'] as const;
export type ScheduledTaskEvent = (typeof SCHEDULED_TASK_EVENTS)[number];

/** How a task repeats. Mirrors the three events one-for-one. */
export type ScheduledTaskKind = 'once' | 'daily' | 'interval';

/** Pipeline a CLI/UI-authored task lands in when the caller names none. */
export const DEFAULT_SCHEDULED_TASK_PIPELINE = 'Tasks';

/** Maximum label length before truncation. */
export const SCHEDULED_TASK_LABEL_MAX = 60;

/** Default grace window (minutes) for a missed `time.once` fire. */
export const DEFAULT_GRACE_MINUTES = 360;

/** Upper bound the Cue validator enforces on both grace and interval minutes. */
export const MAX_SCHEDULE_MINUTES = 10080;

/** One scheduled task, resolved against the agent that owns it. */
export interface ScheduledTask {
	/** Subscription name - unique within one agent's cue.yaml. */
	name: string;
	kind: ScheduledTaskKind;
	event: ScheduledTaskEvent;
	enabled: boolean;
	agentId: string;
	agentName: string;
	projectRoot: string;
	action: CueAction;
	/** Short human label. Falls back to the prompt when the author set none. */
	label: string;
	prompt: string;
	pipelineName: string;
	/** ISO-8601 with offset. `once` only. */
	fireAt?: string;
	/** `HH:MM` strings. `daily` only. */
	scheduleTimes?: string[];
	/** Day filter. `daily` only; absent means every day. */
	scheduleDays?: CueScheduleDay[];
	/** `interval` only. */
	intervalMinutes?: number;
	/** Grace window for a missed one-shot fire. `once` only. */
	graceMinutes?: number;
	/** Toast body when `action === 'notify'`. */
	notifyMessage?: string;
	/** Whether the notify toast sticks until dismissed. */
	notifySticky?: boolean;
	/**
	 * Epoch ms of the next projected fire, or `null` when it cannot be known
	 * (an `interval` task's phase depends on engine run state, and an expired
	 * one-shot has nothing left to project).
	 */
	nextFireAtMs: number | null;
}

/** Fields accepted when creating a task. */
export interface ScheduledTaskCreateInput {
	/** Agent that runs the task. Resolved to a projectRoot by the caller. */
	agentId: string;
	kind: ScheduledTaskKind;
	/** ISO-8601 with offset. Required for `once`. */
	fireAt?: string;
	/** `HH:MM` strings. Required for `daily`. */
	scheduleTimes?: string[];
	scheduleDays?: CueScheduleDay[];
	/** Required for `interval`. */
	intervalMinutes?: number;
	/** Prompt to send. One of `prompt` / `notify` is required. */
	prompt?: string;
	notify?: { message: string; sticky?: boolean };
	/** Subscription name. Auto-generated when omitted. */
	name?: string;
	label?: string;
	pipelineName?: string;
	graceMinutes?: number;
	/** Keep a `once` task on disk after a failed run (default: consume it). */
	keepOnFailure?: boolean;
}

/**
 * Fields accepted when editing an existing task. Every field is optional -
 * only what is present is written. `undefined` means "leave alone"; there is
 * deliberately no way to null a field out, because every field this patch can
 * touch is required by the event that uses it.
 */
export interface ScheduledTaskUpdateInput {
	fireAt?: string;
	scheduleTimes?: string[];
	scheduleDays?: CueScheduleDay[];
	intervalMinutes?: number;
	prompt?: string;
	label?: string;
	enabled?: boolean;
	notify?: { message: string; sticky?: boolean };
}

/** Map a scheduled-task event to its recurrence kind. */
export function kindForEvent(event: ScheduledTaskEvent): ScheduledTaskKind {
	if (event === 'time.once') return 'once';
	if (event === 'time.scheduled') return 'daily';
	return 'interval';
}

/** Map a recurrence kind back to the Cue event that implements it. */
export function eventForKind(kind: ScheduledTaskKind): ScheduledTaskEvent {
	if (kind === 'once') return 'time.once';
	if (kind === 'daily') return 'time.scheduled';
	return 'time.heartbeat';
}

/** True when `event` is one of the three clock-driven events. */
export function isScheduledTaskEvent(event: string): event is ScheduledTaskEvent {
	return (SCHEDULED_TASK_EVENTS as readonly string[]).includes(event);
}

/**
 * Parse a duration string like `30s`, `20m`, `2h`, `1d` into milliseconds.
 * Returns `null` when the input is not a bare integer plus one unit letter.
 */
export function parseScheduleDuration(input: string): number | null {
	const match = /^(\d+)([smhd])$/.exec(input.trim());
	if (!match) return null;
	const n = parseInt(match[1], 10);
	if (!Number.isFinite(n) || n < 0) return null;
	const unit = match[2];
	const multiplier =
		unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
	return n * multiplier;
}

/**
 * Parse a `--at` style timestamp. Accepts ISO-8601 with an explicit timezone
 * OR the naive local form `YYYY-MM-DD HH:MM[:SS]`, which is interpreted in the
 * system's local zone. Returns `null` when unparseable.
 */
export function parseScheduleTimestamp(input: string): Date | null {
	const trimmed = input.trim();
	const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
	if (local) {
		const date = new Date(
			parseInt(local[1], 10),
			parseInt(local[2], 10) - 1,
			parseInt(local[3], 10),
			parseInt(local[4], 10),
			parseInt(local[5], 10),
			local[6] ? parseInt(local[6], 10) : 0
		);
		return Number.isFinite(date.getTime()) ? date : null;
	}
	const ms = Date.parse(trimmed);
	if (!Number.isFinite(ms)) return null;
	return new Date(ms);
}

/** Normalize `9:5` to `09:05`; returns `null` when the input is not `H:MM`. */
export function normalizeScheduleTime(input: string): string | null {
	const match = /^(\d{1,2}):(\d{1,2})$/.exec(input.trim());
	if (!match) return null;
	const hour = parseInt(match[1], 10);
	const minute = parseInt(match[2], 10);
	if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
	return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Parse a comma-separated day list (`mon,wed,fri`) into validated days. */
export function parseScheduleDays(input: string): CueScheduleDay[] | null {
	const parts = input
		.split(',')
		.map((part) => part.trim().toLowerCase())
		.filter((part) => part.length > 0);
	if (parts.length === 0) return null;
	const days: CueScheduleDay[] = [];
	for (const part of parts) {
		if (!(CUE_SCHEDULE_DAYS as string[]).includes(part)) return null;
		if (!days.includes(part as CueScheduleDay)) days.push(part as CueScheduleDay);
	}
	// Keep canonical week order so two equivalent lists serialize identically.
	return CUE_SCHEDULE_DAYS.filter((day) => days.includes(day));
}

/** Collapse whitespace and truncate to the label budget. */
export function truncateTaskLabel(text: string): string {
	const collapsed = text.replace(/\s+/g, ' ').trim();
	if (collapsed.length <= SCHEDULED_TASK_LABEL_MAX) return collapsed;
	return collapsed.slice(0, SCHEDULED_TASK_LABEL_MAX - 1).trimEnd() + '…';
}

/**
 * Compact day abbreviations. `T` is Tuesday and `Th` is Thursday - the extra
 * letter is what disambiguates them, so neither may be shortened further.
 */
export const SCHEDULE_DAY_ABBR: Record<CueScheduleDay, string> = {
	mon: 'M',
	tue: 'T',
	wed: 'W',
	thu: 'Th',
	fri: 'F',
	sat: 'Sa',
	sun: 'Su',
};

const WEEKDAYS: CueScheduleDay[] = ['mon', 'tue', 'wed', 'thu', 'fri'];
const WEEKEND: CueScheduleDay[] = ['sat', 'sun'];

/** Minimum run length worth collapsing. Two days read better spelled out
 *  (`M, T` is shorter than `M-T` is clear). */
const MIN_RUN_TO_COLLAPSE = 3;

/**
 * Render a day filter as compactly as it can be read.
 *
 * The full `mon, tue, wed, thu, fri, sat, sun` was 30 characters on almost
 * every row of the Scheduled Tasks table, wrapping each one onto two lines and
 * carrying almost no information (most schedules are simply "every day").
 * Named sets win over abbreviations, and abbreviations collapse into runs:
 *
 *   all seven / none  -> `Every day`
 *   mon-fri           -> `Weekdays`
 *   sat+sun           -> `Weekends`
 *   mon,tue,wed       -> `M-W`     (runs of 3+ collapse)
 *   mon,wed,fri       -> `M, W, F` (isolated days stay listed)
 */
export function describeScheduleDays(days?: CueScheduleDay[]): string {
	if (!days || days.length === 0 || days.length >= CUE_SCHEDULE_DAYS.length) return 'Every day';

	// Canonical week order regardless of how the YAML listed them.
	const ordered = CUE_SCHEDULE_DAYS.filter((day) => days.includes(day));
	const has = (set: CueScheduleDay[]) =>
		ordered.length === set.length && set.every((day) => ordered.includes(day));

	if (has(WEEKDAYS)) return 'Weekdays';
	if (has(WEEKEND)) return 'Weekends';

	const parts: string[] = [];
	let runStart = 0;
	for (let i = 0; i <= ordered.length; i++) {
		const index = i < ordered.length ? CUE_SCHEDULE_DAYS.indexOf(ordered[i]) : -1;
		const prevIndex = CUE_SCHEDULE_DAYS.indexOf(ordered[i - 1]);
		const continuesRun = i > 0 && index === prevIndex + 1;
		if (continuesRun) continue;

		if (i > 0) {
			const run = ordered.slice(runStart, i);
			if (run.length >= MIN_RUN_TO_COLLAPSE) {
				parts.push(`${SCHEDULE_DAY_ABBR[run[0]]}-${SCHEDULE_DAY_ABBR[run[run.length - 1]]}`);
			} else {
				parts.push(...run.map((day) => SCHEDULE_DAY_ABBR[day]));
			}
		}
		runStart = i;
	}
	return parts.join(', ');
}

/** `90` -> `1h 30m`, `120` -> `2h`, `1440` -> `1d`. */
export function describeIntervalMinutes(minutes: number): string {
	if (minutes < 60) return `${minutes}m`;
	if (minutes % 1440 === 0) return `${minutes / 1440}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * A one-shot's fire time in the reader's own locale and zone (`Aug 22, 4:00 PM`).
 * The raw ISO string is what's on disk and what JSON consumers get, but it is
 * unreadable in a table cell - and it is in UTC, so it silently disagrees with
 * the wall clock the user typed. Falls back to the raw value when unparseable.
 */
export function describeFireAt(fireAt: string): string {
	const ms = Date.parse(fireAt);
	if (!Number.isFinite(ms)) return fireAt;
	return new Date(ms).toLocaleString(undefined, {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	});
}

/**
 * One-line description of when a task fires, for a table cell or a CLI row.
 * Deliberately terse: the caller supplies its own "in 5m" relative column.
 */
export function describeSchedule(task: ScheduledTask): string {
	if (task.kind === 'once') return task.fireAt ? describeFireAt(task.fireAt) : 'unscheduled';
	if (task.kind === 'interval')
		return `Every ${describeIntervalMinutes(task.intervalMinutes ?? 0)}`;
	const times = (task.scheduleTimes ?? []).join(', ');
	return `${times} · ${describeScheduleDays(task.scheduleDays)}`;
}
