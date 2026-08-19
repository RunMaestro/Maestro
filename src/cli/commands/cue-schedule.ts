/**
 * `maestro-cli cue schedule` - author, inspect, edit, and cancel Scheduled
 * Tasks: the clock-driven Cue subscriptions (`time.once`, `time.scheduled`,
 * `time.heartbeat`) in an agent's `.maestro/cue.yaml`.
 *
 * This is the primary agent surface whenever a user asks for a delayed prompt,
 * a reminder, or a repeating job ("in 20 minutes do X", "remind me at 4pm to
 * push rc", "every weekday at 9am summarize the PR queue").
 *
 * Modes, selected by flag:
 *   - default:            create a task (one-shot, daily, or interval)
 *   - `--list`:           enumerate scheduled tasks across every agent
 *   - `--cancel <name>`:  delete a task
 *   - `--reschedule <n>`: change WHEN an existing task fires
 *   - `--pause` / `--resume <name>`: flip `enabled` without deleting anything
 *
 * Filesystem work and validation live in `main/cue/cue-scheduled-tasks.ts`,
 * shared with the desktop app's Scheduled Tasks tab, so a task created here
 * and one created by clicking are the same object on disk. Writes do not need
 * the desktop app running - the engine's YAML watcher picks them up.
 */
import { readSessions } from '../services/storage';
import { humanizeDuration, DURATION_LADDER_DAYS } from '../../shared/duration';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import {
	cancelScheduledTask,
	collectScheduledTasks,
	createScheduledTask,
	updateScheduledTask,
	type ScheduledTaskAgent,
} from '../../main/cue/cue-scheduled-tasks';
import {
	DEFAULT_SCHEDULED_TASK_PIPELINE,
	MAX_SCHEDULE_MINUTES,
	describeSchedule,
	parseScheduleDays,
	parseScheduleDuration,
	parseScheduleTimestamp,
	normalizeScheduleTime,
	type ScheduledTask,
	type ScheduledTaskCreateInput,
	type ScheduledTaskKind,
	type ScheduledTaskUpdateInput,
} from '../../shared/cue/scheduled-tasks';
import type { CueScheduleDay } from '../../shared/cue/contracts';
import type { SessionInfo } from '../../shared/types';

export interface CueScheduleOptions {
	in?: string;
	at?: string;
	every?: string;
	dailyAt?: string;
	days?: string;
	list?: boolean;
	kind?: string;
	cancel?: string;
	reschedule?: string;
	pause?: string;
	resume?: string;
	agent?: string;
	prompt?: string;
	notify?: boolean;
	sticky?: boolean;
	message?: string;
	name?: string;
	label?: string;
	pipeline?: string;
	graceMinutes?: string;
	keepOnFailure?: boolean;
	json?: boolean;
}

/** Render `ms` as a compact human duration (`5m 30s`, `2h 15m`, `expired`). */
function formatRelativeDuration(ms: number): string {
	if (ms < 0) return 'expired';
	return humanizeDuration(ms, { units: DURATION_LADDER_DAYS, adjacentUnits: true });
}

/** Adapt a CLI `SessionInfo` to the agent shape the domain module wants. */
function toTaskAgent(session: SessionInfo): ScheduledTaskAgent {
	return {
		id: session.id,
		name: session.name,
		projectRoot: session.projectRoot,
		fallbackName: getAgentDisplayName(session.toolType),
	};
}

/**
 * Resolve `--agent` (display name OR id OR id prefix) to a `SessionInfo`.
 * Returns `null` when no match exists. Throws on ambiguous id-prefix matches.
 *
 * Lookup order: exact id → exact name → unique id prefix. Names are matched
 * case-sensitively to mirror the renderer's display behavior.
 */
function resolveAgent(input: string, sessions: SessionInfo[]): SessionInfo | null {
	const byId = sessions.find((s) => s.id === input);
	if (byId) return byId;
	const byName = sessions.find((s) => s.name === input);
	if (byName) return byName;
	const idPrefixMatches = sessions.filter((s) => s.id.startsWith(input));
	if (idPrefixMatches.length === 1) return idPrefixMatches[0];
	if (idPrefixMatches.length > 1) {
		throw new Error(
			`Ambiguous agent identifier "${input}" - matches multiple IDs (${idPrefixMatches
				.map((s) => `${s.id.slice(0, 8)} (${s.name})`)
				.join(', ')})`
		);
	}
	return null;
}

function errorOut(message: string, options: CueScheduleOptions, code?: string): never {
	if (options.json) {
		console.log(JSON.stringify({ ok: false, error: message, ...(code ? { code } : {}) }));
	} else {
		console.error(`Error: ${message}`);
	}
	process.exit(1);
}

/** CLI entry point. Routes to the mode selected by the flags. */
export async function cueSchedule(options: CueScheduleOptions): Promise<void> {
	if (options.list) return runList(options);
	if (options.cancel !== undefined) return runCancel(options);
	if (options.reschedule !== undefined) return runReschedule(options);
	if (options.pause !== undefined) return runToggle(options, options.pause, false);
	if (options.resume !== undefined) return runToggle(options, options.resume, true);
	return runCreate(options);
}

// ────────────────────────────────────────────────────────────────────────────
// Shared collection
// ────────────────────────────────────────────────────────────────────────────

/** Load every scheduled task, printing load warnings to stderr in human mode. */
function loadTasks(options: CueScheduleOptions): {
	tasks: ScheduledTask[];
	sessions: SessionInfo[];
} {
	const sessions = readSessions();
	const { tasks, warnings } = collectScheduledTasks(sessions.map(toTaskAgent));
	if (!options.json) {
		for (const warning of warnings) console.error(`Warning: ${warning}`);
	}
	return { tasks, sessions };
}

/** JSON row shape emitted by `--list`. The `time.once`-era keys are kept so
 *  existing scripts keep parsing; recurring rows leave `fire_at` empty. */
interface ScheduledTaskRow {
	name: string;
	kind: ScheduledTaskKind;
	event: string;
	enabled: boolean;
	fire_at: string;
	schedule: string;
	next_fire_at: string;
	in: string;
	agent_id: string;
	agent_name: string;
	project_root: string;
	action: string;
	label: string;
}

function toRow(task: ScheduledTask, now: number): ScheduledTaskRow {
	return {
		name: task.name,
		kind: task.kind,
		event: task.event,
		enabled: task.enabled,
		fire_at: task.fireAt ?? '',
		schedule: describeSchedule(task),
		next_fire_at: task.nextFireAtMs !== null ? new Date(task.nextFireAtMs).toISOString() : '',
		in: task.nextFireAtMs !== null ? formatRelativeDuration(task.nextFireAtMs - now) : '-',
		agent_id: task.agentId,
		agent_name: task.agentName,
		project_root: task.projectRoot,
		action: task.action,
		label: task.label,
	};
}

// ────────────────────────────────────────────────────────────────────────────
// --list
// ────────────────────────────────────────────────────────────────────────────

/** Render a fixed-width table. Column widths flex to the widest value. */
function renderTable(rows: ScheduledTaskRow[]): string {
	const pad = (text: string, width: number) =>
		text.length >= width ? text : text + ' '.repeat(width - text.length);
	const columns: { header: string; get: (row: ScheduledTaskRow) => string }[] = [
		{ header: 'NAME', get: (r) => r.name },
		{ header: 'KIND', get: (r) => (r.enabled ? r.kind : `${r.kind} (paused)`) },
		{ header: 'SCHEDULE', get: (r) => r.schedule },
		{ header: 'IN', get: (r) => r.in },
		{ header: 'AGENT', get: (r) => r.agent_name },
		{ header: 'ACTION', get: (r) => r.action },
		{ header: 'LABEL', get: (r) => r.label },
	];
	const widths = columns.map((col) =>
		Math.max(col.header.length, ...rows.map((row) => col.get(row).length))
	);
	const line = (cells: string[]) =>
		cells
			.map((cell, i) => (i === columns.length - 1 ? cell : pad(cell, widths[i])))
			.join('  ')
			.trimEnd();
	return [
		line(columns.map((col) => col.header)),
		...rows.map((row) => line(columns.map((col) => col.get(row)))),
	].join('\n');
}

async function runList(options: CueScheduleOptions): Promise<void> {
	const { tasks, sessions } = loadTasks(options);
	const now = Date.now();

	let filtered = tasks;
	if (options.kind && options.kind !== 'all') {
		const kind = options.kind.toLowerCase();
		if (!['once', 'daily', 'interval'].includes(kind)) {
			errorOut(`--kind must be one of: once, daily, interval, all`, options, 'BAD_KIND');
		}
		filtered = tasks.filter((task) => task.kind === kind);
	}
	if (options.agent) {
		let resolved: SessionInfo | null;
		try {
			resolved = resolveAgent(options.agent, sessions);
		} catch (err) {
			errorOut(err instanceof Error ? err.message : String(err), options, 'AMBIGUOUS_AGENT');
		}
		if (!resolved) errorOut(`agent "${options.agent}" not found`, options, 'AGENT_NOT_FOUND');
		filtered = filtered.filter((task) => task.agentId === resolved!.id);
	}

	const rows = filtered.map((task) => toRow(task, now));

	if (options.json) {
		console.log(JSON.stringify(rows));
		return;
	}
	if (rows.length === 0) {
		console.log('No scheduled tasks.');
		return;
	}
	console.log(renderTable(rows));
}

// ────────────────────────────────────────────────────────────────────────────
// Name → task resolution (shared by cancel / reschedule / pause / resume)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Find the single task named `name`, honoring `--agent` as a hard scope.
 * Errors out (never returns) when there is no match or the name is ambiguous:
 * these commands mutate on-disk config, so guessing the wrong agent would edit
 * a task the user never named.
 */
function resolveTaskByName(name: string, options: CueScheduleOptions): ScheduledTask {
	const { tasks, sessions } = loadTasks(options);
	let matches = tasks.filter((task) => task.name === name);

	if (options.agent) {
		let resolved: SessionInfo | null;
		try {
			resolved = resolveAgent(options.agent, sessions);
		} catch (err) {
			errorOut(err instanceof Error ? err.message : String(err), options, 'AMBIGUOUS_AGENT');
		}
		if (!resolved) errorOut(`agent "${options.agent}" not found`, options, 'AGENT_NOT_FOUND');
		matches = matches.filter((task) => task.agentId === resolved!.id);
		if (matches.length === 0) {
			errorOut(
				`No scheduled task named '${name}' on agent ${resolved!.name || resolved!.id}.`,
				options,
				'NOT_FOUND'
			);
		}
	}

	if (matches.length === 0) {
		errorOut(`No scheduled task named '${name}' found.`, options, 'NOT_FOUND');
	}
	if (matches.length > 1) {
		const list = matches.map((m) => `  ${m.agentId.slice(0, 8)}  ${m.agentName}`).join('\n');
		errorOut(
			`Multiple agents have a scheduled task named '${name}'. Pass --agent to disambiguate:\n${list}`,
			options,
			'AMBIGUOUS_NAME'
		);
	}
	return matches[0];
}

// ────────────────────────────────────────────────────────────────────────────
// --cancel / --pause / --resume / --reschedule
// ────────────────────────────────────────────────────────────────────────────

async function runCancel(options: CueScheduleOptions): Promise<void> {
	const name = options.cancel ?? '';
	if (name.length === 0) errorOut('--cancel requires a task name', options, 'MISSING_NAME');

	const task = resolveTaskByName(name, options);
	const result = await cancelScheduledTask(task.projectRoot, name);
	if (!result.removed) {
		errorOut(
			`Failed to remove '${name}': ${result.reason ?? 'unknown reason'}`,
			options,
			'REMOVE_FAILED'
		);
	}

	if (options.json) {
		console.log(JSON.stringify({ ok: true, removed: name, agent_id: task.agentId }));
		return;
	}
	console.log(`Cancelled task '${name}' on agent ${task.agentName}.`);
}

async function runToggle(
	options: CueScheduleOptions,
	name: string,
	enabled: boolean
): Promise<void> {
	if (name.length === 0) {
		errorOut(`--${enabled ? 'resume' : 'pause'} requires a task name`, options, 'MISSING_NAME');
	}
	const task = resolveTaskByName(name, options);
	const result = await updateScheduledTask(task.projectRoot, name, { enabled });
	if (!result.updated) {
		errorOut(
			`Failed to ${enabled ? 'resume' : 'pause'} '${name}': ${result.reason ?? 'unknown reason'}`,
			options,
			'UPDATE_FAILED'
		);
	}
	if (options.json) {
		console.log(JSON.stringify({ ok: true, name, enabled, agent_id: task.agentId }));
		return;
	}
	console.log(`${enabled ? 'Resumed' : 'Paused'} task '${name}' on agent ${task.agentName}.`);
}

async function runReschedule(options: CueScheduleOptions): Promise<void> {
	const name = options.reschedule ?? '';
	if (name.length === 0) errorOut('--reschedule requires a task name', options, 'MISSING_NAME');

	const task = resolveTaskByName(name, options);
	const timing = parseTiming(options);

	const patch: ScheduledTaskUpdateInput = {};
	if (timing.kind !== task.kind) {
		errorOut(
			`'${name}' is a ${task.kind} task; pass the matching timing flag (${timingFlagsFor(task.kind)}) to reschedule it.`,
			options,
			'KIND_MISMATCH'
		);
	}
	if (timing.kind === 'once') patch.fireAt = timing.fireAt;
	if (timing.kind === 'daily') {
		patch.scheduleTimes = timing.scheduleTimes;
		if (timing.scheduleDays) patch.scheduleDays = timing.scheduleDays;
	}
	if (timing.kind === 'interval') patch.intervalMinutes = timing.intervalMinutes;

	const result = await updateScheduledTask(task.projectRoot, name, patch);
	if (!result.updated) {
		errorOut(
			`Failed to reschedule '${name}': ${result.reason ?? 'unknown reason'}`,
			options,
			'UPDATE_FAILED'
		);
	}

	if (options.json) {
		console.log(
			JSON.stringify({
				ok: true,
				name,
				agent_id: task.agentId,
				kind: timing.kind,
				fire_at: timing.fireAt ?? '',
				schedule_times: timing.scheduleTimes ?? [],
				schedule_days: timing.scheduleDays ?? [],
				interval_minutes: timing.intervalMinutes ?? null,
			})
		);
		return;
	}
	console.log(`Rescheduled '${name}' on agent ${task.agentName}: ${describeTiming(timing)}`);
}

// ────────────────────────────────────────────────────────────────────────────
// Timing flags
// ────────────────────────────────────────────────────────────────────────────

interface ParsedTiming {
	kind: ScheduledTaskKind;
	fireAt?: string;
	fireAtDate?: Date;
	scheduleTimes?: string[];
	scheduleDays?: CueScheduleDay[];
	intervalMinutes?: number;
}

function timingFlagsFor(kind: ScheduledTaskKind): string {
	if (kind === 'once') return '--in / --at';
	if (kind === 'daily') return '--daily-at';
	return '--every';
}

function describeTiming(timing: ParsedTiming): string {
	if (timing.kind === 'once') {
		const relative = timing.fireAtDate
			? ` (in ${formatRelativeDuration(timing.fireAtDate.getTime() - Date.now())})`
			: '';
		return `fires at ${timing.fireAt}${relative}`;
	}
	if (timing.kind === 'daily') {
		const days = timing.scheduleDays?.length ? timing.scheduleDays.join(', ') : 'every day';
		return `fires at ${(timing.scheduleTimes ?? []).join(', ')} on ${days}`;
	}
	return `fires every ${timing.intervalMinutes} min`;
}

/**
 * Parse the timing flags into exactly one recurrence. The four flags are
 * mutually exclusive: a task fires once, on a daily clock, or on an interval -
 * never two of those at the same time.
 */
function parseTiming(options: CueScheduleOptions): ParsedTiming {
	const supplied = [
		options.in !== undefined ? '--in' : null,
		options.at !== undefined ? '--at' : null,
		options.dailyAt !== undefined ? '--daily-at' : null,
		options.every !== undefined ? '--every' : null,
	].filter((flag): flag is string => flag !== null);

	if (supplied.length === 0) {
		errorOut('one of --in, --at, --daily-at, or --every is required', options, 'MISSING_TIME');
	}
	if (supplied.length > 1) {
		errorOut(`${supplied.join(' and ')} are mutually exclusive`, options, 'CONFLICTING_TIME');
	}

	if (options.days !== undefined && options.dailyAt === undefined) {
		errorOut('--days requires --daily-at', options, 'DAYS_WITHOUT_SCHEDULE');
	}

	if (options.in !== undefined || options.at !== undefined) {
		let fireAtDate: Date;
		if (options.in !== undefined) {
			const ms = parseScheduleDuration(options.in);
			if (ms === null) {
				errorOut(
					`--in: unrecognized duration "${options.in}" (expected <n>s|m|h|d, e.g. 20m)`,
					options,
					'BAD_DURATION'
				);
			}
			fireAtDate = new Date(Date.now() + ms);
		} else {
			const parsed = parseScheduleTimestamp(options.at!);
			if (!parsed) {
				errorOut(
					`--at: unrecognized timestamp "${options.at}" (expected ISO-8601 with timezone or "YYYY-MM-DD HH:MM")`,
					options,
					'BAD_TIMESTAMP'
				);
			}
			fireAtDate = parsed;
		}
		// toISOString always produces `…Z`, satisfying the validator's
		// timezone-offset requirement without DST surprises across machines.
		return { kind: 'once', fireAt: fireAtDate.toISOString(), fireAtDate };
	}

	if (options.dailyAt !== undefined) {
		const times: string[] = [];
		for (const raw of options.dailyAt.split(',')) {
			if (raw.trim().length === 0) continue;
			const normalized = normalizeScheduleTime(raw);
			if (!normalized) {
				errorOut(
					`--daily-at: unrecognized time "${raw.trim()}" (expected HH:MM, e.g. 09:00)`,
					options,
					'BAD_TIME'
				);
			}
			times.push(normalized);
		}
		if (times.length === 0) {
			errorOut('--daily-at needs at least one HH:MM time', options, 'BAD_TIME');
		}
		let days: CueScheduleDay[] | undefined;
		if (options.days !== undefined) {
			const parsed = parseScheduleDays(options.days);
			if (!parsed) {
				errorOut(
					`--days: expected a comma-separated list of mon,tue,wed,thu,fri,sat,sun`,
					options,
					'BAD_DAYS'
				);
			}
			days = parsed;
		}
		return { kind: 'daily', scheduleTimes: times, scheduleDays: days };
	}

	const ms = parseScheduleDuration(options.every!);
	if (ms === null) {
		errorOut(
			`--every: unrecognized duration "${options.every}" (expected <n>m|h|d, e.g. 30m)`,
			options,
			'BAD_DURATION'
		);
	}
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1 || minutes > MAX_SCHEDULE_MINUTES) {
		errorOut(`--every: must be between 1m and 7d, got "${options.every}"`, options, 'BAD_DURATION');
	}
	return { kind: 'interval', intervalMinutes: minutes };
}

// ────────────────────────────────────────────────────────────────────────────
// create
// ────────────────────────────────────────────────────────────────────────────

async function runCreate(options: CueScheduleOptions): Promise<void> {
	const timing = parseTiming(options);

	if (!options.agent) errorOut('--agent <id-or-name> is required', options, 'MISSING_AGENT');
	const sessions = readSessions();
	let agent: SessionInfo | null;
	try {
		agent = resolveAgent(options.agent, sessions);
	} catch (err) {
		errorOut(err instanceof Error ? err.message : String(err), options, 'AMBIGUOUS_AGENT');
	}
	if (!agent) errorOut(`agent "${options.agent}" not found`, options, 'AGENT_NOT_FOUND');

	const promptText = options.prompt ?? '';
	const hasPrompt = promptText.length > 0;
	const hasNotify = options.notify === true;
	if (!hasPrompt && !hasNotify) {
		errorOut('one of --prompt or --notify (or both) is required', options, 'MISSING_ACTION');
	}
	if (options.sticky && !hasNotify) {
		errorOut('--sticky requires --notify', options, 'STICKY_WITHOUT_NOTIFY');
	}

	let graceMinutes: number | undefined;
	if (options.graceMinutes !== undefined) {
		if (timing.kind !== 'once') {
			errorOut('--grace-minutes only applies to one-shot tasks', options, 'GRACE_ON_RECURRING');
		}
		const n = Number(options.graceMinutes);
		if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > MAX_SCHEDULE_MINUTES) {
			errorOut(
				`--grace-minutes: must be an integer in [0, ${MAX_SCHEDULE_MINUTES}], got "${options.graceMinutes}"`,
				options,
				'BAD_GRACE'
			);
		}
		graceMinutes = n;
	}

	const notifyMessage =
		(options.message && options.message.length > 0 ? options.message : undefined) ??
		(options.label && options.label.length > 0 ? options.label : undefined) ??
		(hasPrompt ? promptText : undefined) ??
		'Task fired';

	const input: ScheduledTaskCreateInput = {
		agentId: agent.id,
		kind: timing.kind,
		fireAt: timing.fireAt,
		scheduleTimes: timing.scheduleTimes,
		scheduleDays: timing.scheduleDays,
		intervalMinutes: timing.intervalMinutes,
		prompt: hasPrompt ? promptText : undefined,
		notify: hasNotify ? { message: notifyMessage, sticky: options.sticky === true } : undefined,
		name: options.name,
		label: options.label,
		pipelineName: options.pipeline,
		graceMinutes,
		keepOnFailure: options.keepOnFailure === true,
	};

	let names: string[];
	try {
		names = createScheduledTask(toTaskAgent(agent), input).names;
	} catch (err) {
		errorOut(
			`failed to write cue.yaml: ${err instanceof Error ? err.message : String(err)}`,
			options,
			'WRITE_FAILED'
		);
	}

	const pipelineName = options.pipeline?.length
		? options.pipeline
		: DEFAULT_SCHEDULED_TASK_PIPELINE;
	const agentDisplay = agent.name || getAgentDisplayName(agent.toolType);

	if (options.json) {
		console.log(
			JSON.stringify({
				ok: true,
				names,
				kind: timing.kind,
				fire_at: timing.fireAt ?? '',
				schedule_times: timing.scheduleTimes ?? [],
				schedule_days: timing.scheduleDays ?? [],
				interval_minutes: timing.intervalMinutes ?? null,
				agent_id: agent.id,
				pipeline_name: pipelineName,
			})
		);
		return;
	}

	const quoted = names.map((n) => `'${n}'`).join(', ');
	const noun = names.length === 1 ? 'task' : 'tasks';
	console.log(`Scheduled ${noun} ${quoted} on agent ${agentDisplay}: ${describeTiming(timing)}`);
}
