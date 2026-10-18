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
import * as fs from 'fs';
import { readLiveSessions } from '../services/storage';
import { resolveCliPath } from '../utils/parse';
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
import type {
	CueAutoRunConfig,
	CueAutoRunWorktree,
	CueScheduleDay,
} from '../../shared/cue/contracts';
import { parseCueAutoRunWorktree } from '../../shared/cue/autorun-worktree';
import { formatCueTurnSettings, parseCueTurnSettingsInput } from '../../shared/cue/turn-settings';
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
	autoRun?: string[];
	resetOnCompletion?: boolean;
	loop?: boolean;
	maxLoops?: string;
	model?: string;
	effort?: string;
	perDocument?: boolean;
	ignoreModelHints?: boolean;
	/** Commander's `--no-auto-resume`: true unless the flag was passed. */
	autoResume?: boolean;
	autoResumeAfter?: string;
	maxAutoResumes?: string;
	worktreeBranch?: string;
	worktreeAgent?: string;
	worktreePath?: string;
	baseBranch?: string;
	createPr?: boolean;
	tier?: string;
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
	const sessions = readLiveSessions();
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
	/** What an `autorun` task will launch: documents, run options, and the
	 *  worktree it fires in. Present only on autorun rows, so a schedule written
	 *  with `--auto-run` can be read back and checked. */
	auto_run?: CueAutoRunConfig;
	tier: string;
	model: string;
	effort: string;
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
		...(task.autoRun ? { auto_run: task.autoRun } : {}),
		tier: task.tier ?? '',
		model: task.model ?? '',
		effort: task.effort ?? '',
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
			`'${name}' is ${task.kind === 'interval' ? 'an' : 'a'} ${task.kind} task; pass the matching timing flag (${timingFlagsFor(task.kind)}) to reschedule it.`,
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

/**
 * The flags that only describe an Auto Run, by the name the user typed.
 * `--model` and `--effort` are NOT here: with `--auto-run` they describe the
 * run (see `buildAutoRunConfig`), without it they are the prompt run's model
 * choice (see `runCreate`).
 */
const AUTO_RUN_ONLY_FLAGS: ReadonlyArray<[keyof CueScheduleOptions, string]> = [
	['resetOnCompletion', '--reset-on-completion'],
	['loop', '--loop'],
	['maxLoops', '--max-loops'],
	['perDocument', '--per-document'],
	['ignoreModelHints', '--ignore-model-hints'],
	['autoResumeAfter', '--auto-resume-after'],
	['maxAutoResumes', '--max-auto-resumes'],
	['worktreeBranch', '--worktree-branch'],
	['worktreeAgent', '--worktree-agent'],
	['worktreePath', '--worktree-path'],
	['baseBranch', '--base-branch'],
	['createPr', '--create-pr'],
];

/** Parse a whole-number flag, or exit naming the flag that was wrong. */
function parseCountFlag(
	raw: string | undefined,
	flag: string,
	code: string,
	options: CueScheduleOptions
): number | undefined {
	if (raw === undefined) return undefined;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 1) {
		errorOut(`${flag}: must be a positive integer, got "${raw}"`, options, code);
	}
	return n;
}

/**
 * Build `auto_run.worktree` from the three ways the CLI can name one, or
 * `undefined` when the run stays in the agent's own checkout. Mirrors the
 * "Run in Worktree" choice in the Auto Run window: a branch to create, a
 * worktree agent that is already open, or a worktree already on disk.
 */
function buildAutoRunWorktree(
	options: CueScheduleOptions,
	sessions: SessionInfo[]
): CueAutoRunWorktree | undefined {
	const selectors = [options.worktreeBranch, options.worktreeAgent, options.worktreePath].filter(
		(value) => value !== undefined
	);
	if (selectors.length > 1) {
		errorOut(
			'pass only one of --worktree-branch, --worktree-agent, --worktree-path',
			options,
			'WORKTREE_CONFLICT'
		);
	}
	if (selectors.length === 0) {
		const stray =
			options.baseBranch !== undefined ? '--base-branch' : options.createPr ? '--create-pr' : null;
		if (stray) {
			errorOut(
				`${stray} requires --worktree-branch, --worktree-agent, or --worktree-path`,
				options,
				'WORKTREE_FLAG_WITHOUT_WORKTREE'
			);
		}
		return undefined;
	}

	let raw: CueAutoRunWorktree;
	if (options.worktreeBranch !== undefined) {
		raw = { mode: 'create-new', branch: options.worktreeBranch };
	} else if (options.worktreeAgent !== undefined) {
		let target: SessionInfo | null;
		try {
			target = resolveAgent(options.worktreeAgent, sessions);
		} catch (err) {
			errorOut(err instanceof Error ? err.message : String(err), options, 'AMBIGUOUS_AGENT');
		}
		if (!target) {
			errorOut(`worktree agent "${options.worktreeAgent}" not found`, options, 'AGENT_NOT_FOUND');
		}
		raw = { mode: 'existing-open', agent_id: target.id };
	} else {
		const worktreePath = resolveCliPath(options.worktreePath!);
		if (!fs.existsSync(worktreePath)) {
			errorOut(`--worktree-path: "${worktreePath}" does not exist`, options, 'BAD_WORKTREE_PATH');
		}
		raw = { mode: 'existing-closed', path: worktreePath };
	}
	if (options.baseBranch !== undefined) raw.base_branch = options.baseBranch;
	if (options.createPr) raw.create_pr = true;

	const parsed = parseCueAutoRunWorktree(raw);
	if (!parsed.ok) errorOut(`worktree: ${parsed.error}`, options, 'BAD_WORKTREE');
	return parsed.value;
}

/**
 * Build the Auto Run payload for `--auto-run`, or `undefined` when the flag was
 * not passed. This is the CLI half of the Auto Run window's Schedule button:
 * both hand the same `CueAutoRunConfig` to `createScheduledTask`.
 *
 * Documents are resolved to absolute paths and must exist NOW. They are pinned
 * when the task is written, so a typo would otherwise surface hours later as a
 * launch that failed with nobody watching.
 */
function buildAutoRunConfig(
	options: CueScheduleOptions,
	promptText: string,
	sessions: SessionInfo[]
): CueAutoRunConfig | undefined {
	const requested = options.autoRun ?? [];
	if (requested.length === 0) {
		// `--no-auto-resume` is the one flag here that is defined when absent
		// (commander defaults a negatable flag to true), so it is tested by value.
		const stray =
			AUTO_RUN_ONLY_FLAGS.find(([key]) => options[key] !== undefined)?.[1] ??
			(options.autoResume === false ? '--no-auto-resume' : undefined);
		if (stray) errorOut(`${stray} requires --auto-run`, options, 'AUTO_RUN_FLAG_WITHOUT_AUTO_RUN');
		return undefined;
	}
	if (options.notify) {
		errorOut('--auto-run cannot be combined with --notify', options, 'AUTO_RUN_WITH_NOTIFY');
	}

	const documents = requested.map((doc) => resolveCliPath(doc));
	for (const doc of documents) {
		if (!/\.md$/i.test(doc)) {
			errorOut(`--auto-run: "${doc}" is not a .md document`, options, 'BAD_AUTO_RUN_DOCUMENT');
		}
		if (!fs.existsSync(doc)) {
			errorOut(`--auto-run: "${doc}" does not exist`, options, 'BAD_AUTO_RUN_DOCUMENT');
		}
	}

	const maxLoops = parseCountFlag(options.maxLoops, '--max-loops', 'BAD_MAX_LOOPS', options);
	const autoResumeAfter = parseCountFlag(
		options.autoResumeAfter,
		'--auto-resume-after',
		'BAD_AUTO_RESUME',
		options
	);
	const maxAutoResumes = parseCountFlag(
		options.maxAutoResumes,
		'--max-auto-resumes',
		'BAD_AUTO_RESUME',
		options
	);
	const worktree = buildAutoRunWorktree(options, sessions);

	return {
		documents,
		...(options.resetOnCompletion ? { reset_on_completion: documents.map(() => true) } : {}),
		...(promptText ? { prompt: promptText } : {}),
		// A loop ceiling without --loop still means "loop", as on `auto-run`.
		...(options.loop || maxLoops !== undefined ? { loop_enabled: true } : {}),
		...(maxLoops !== undefined ? { max_loops: maxLoops } : {}),
		...(options.model ? { model: options.model } : {}),
		...(options.effort ? { effort: options.effort } : {}),
		...(options.perDocument ? { task_selection_mode: 'document' as const } : {}),
		...(options.ignoreModelHints ? { ignore_model_hints: true } : {}),
		...(options.autoResume === false ? { auto_resume_on_error: false } : {}),
		...(autoResumeAfter !== undefined ? { auto_resume_after_min: autoResumeAfter } : {}),
		...(maxAutoResumes !== undefined ? { max_auto_resumes: maxAutoResumes } : {}),
		...(worktree ? { worktree } : {}),
	};
}

async function runCreate(options: CueScheduleOptions): Promise<void> {
	const timing = parseTiming(options);

	if (!options.agent) errorOut('--agent <id-or-name> is required', options, 'MISSING_AGENT');
	const sessions = readLiveSessions();
	let agent: SessionInfo | null;
	try {
		agent = resolveAgent(options.agent, sessions);
	} catch (err) {
		errorOut(err instanceof Error ? err.message : String(err), options, 'AMBIGUOUS_AGENT');
	}
	if (!agent) errorOut(`agent "${options.agent}" not found`, options, 'AGENT_NOT_FOUND');

	const promptText = options.prompt ?? '';
	const autoRun = buildAutoRunConfig(options, promptText, sessions);
	// With --auto-run the prompt is the run's own instructions, not a message
	// to send, so it travels inside the Auto Run payload instead.
	const hasPrompt = promptText.length > 0 && !autoRun;
	const hasNotify = options.notify === true;
	if (!hasPrompt && !hasNotify && !autoRun) {
		errorOut(
			'one of --prompt or --notify (or both) is required, or --auto-run <documents...>',
			options,
			'MISSING_ACTION'
		);
	}
	if (options.sticky && !hasNotify) {
		errorOut('--sticky requires --notify', options, 'STICKY_WITHOUT_NOTIFY');
	}

	// `--model` and `--effort` mean two things. With --auto-run they are the
	// run's own model and effort and already travel in the Auto Run payload
	// (`buildAutoRunConfig`). Without it they are the prompt run's model choice,
	// stored on the subscription next to `--tier`. A tier has no Auto Run
	// counterpart, so that combination is refused rather than silently dropped.
	if (autoRun && options.tier !== undefined) {
		errorOut(
			'--tier cannot be combined with --auto-run (use --model)',
			options,
			'TIER_WITH_AUTO_RUN'
		);
	}
	const turnModel = autoRun ? undefined : options.model;
	const turnEffort = autoRun ? undefined : options.effort;
	const turnInput = parseCueTurnSettingsInput({
		tier: options.tier,
		model: turnModel,
		effort: turnEffort,
	});
	if (!turnInput.ok) errorOut(turnInput.error, options, turnInput.code);
	const { tier, model, effort } = turnInput.settings;
	if ((tier || model || effort) && !hasPrompt) {
		errorOut('--tier, --model, and --effort need --prompt', options, 'MODEL_WITHOUT_PROMPT');
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
		autoRun,
		name: options.name,
		label: options.label,
		pipelineName: options.pipeline,
		graceMinutes,
		// A scheduled Auto Run is always kept on a failed launch, as it is from
		// the Auto Run window: the alternative is a run that never happened and
		// left nothing behind to say why.
		keepOnFailure: options.keepOnFailure === true || autoRun !== undefined,
		tier,
		model,
		effort,
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
				tier: tier ?? '',
				model: model ?? '',
				effort: effort ?? '',
			})
		);
		return;
	}

	const quoted = names.map((n) => `'${n}'`).join(', ');
	const noun = names.length === 1 ? 'task' : 'tasks';
	const modelLabel = formatCueTurnSettings({ tier, model, effort });
	const modelNote = modelLabel ? ` (${modelLabel})` : '';
	console.log(
		`Scheduled ${noun} ${quoted} on agent ${agentDisplay}: ${describeTiming(timing)}${modelNote}`
	);
}
