/**
 * Filesystem layer for Scheduled Tasks (the clock-driven Cue subscriptions).
 *
 * Every surface that lists, creates, edits, or cancels a scheduled task goes
 * through this module: the `maestro-cli cue schedule` command, the Cue modal's
 * Scheduled Tasks tab (via `cue:*ScheduledTask*` IPC), and anything added
 * later. Writes go straight to `<projectRoot>/.maestro/cue.yaml`, so the CLI
 * keeps working with the desktop app closed; the engine's YAML watcher picks
 * up the change on its own and callers must NOT force a reload.
 *
 * The shapes exchanged with callers live in `shared/cue/scheduled-tasks.ts` so
 * the renderer can type against them without importing anything from `main`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { generateUUID } from '../../shared/uuid';
import { CUE_CONFIG_PATH, LEGACY_CUE_CONFIG_PATH, MAESTRO_DIR } from '../../shared/maestro-paths';
import {
	DEFAULT_SCHEDULED_TASK_PIPELINE,
	MAX_SCHEDULE_MINUTES,
	eventForKind,
	isScheduledTaskEvent,
	kindForEvent,
	normalizeScheduleTime,
	truncateTaskLabel,
	type ScheduledTask,
	type ScheduledTaskCreateInput,
	type ScheduledTaskUpdateInput,
} from '../../shared/cue/scheduled-tasks';
import type { CueAction, CueSubscription } from '../../shared/cue/contracts';
import { applyCueTurnSettingsPatch, cueTurnSettingsOf } from '../../shared/cue/turn-settings';
import { patchSubscriptionInYaml } from './cue-subscription-edit';
import { loadCueConfigDetailed } from './cue-yaml-loader';
import { extractLeadingCommentBlock, writeCueYamlAtomicSync } from './cue-yaml-write';
import { removeSubscriptionFromYaml } from './cue-self-destruct';
import { calculateNextScheduledTime } from './triggers/cue-schedule-utils';

/** Minimal agent shape this module needs. Satisfied by both the CLI's
 *  `SessionInfo` and the main process's session store entries. */
export interface ScheduledTaskAgent {
	id: string;
	name?: string;
	projectRoot: string;
	/** Display fallback when the agent has no name (provider label). */
	fallbackName?: string;
}

export interface CollectScheduledTasksResult {
	tasks: ScheduledTask[];
	/** Human-readable notes about agents whose cue.yaml could not be read.
	 *  Non-fatal: a broken config for one agent must not hide the rest. */
	warnings: string[];
}

const SHORT_UUID_LENGTH = 8;

function shortUuid(): string {
	return generateUUID().replace(/-/g, '').slice(0, SHORT_UUID_LENGTH);
}

function agentDisplayName(agent: ScheduledTaskAgent): string {
	return agent.name || agent.fallbackName || agent.id.slice(0, SHORT_UUID_LENGTH);
}

/** Auto-generated subscription name for a one-shot: `task-YYYY-MM-DD-HHmm-<id>`. */
export function formatOnceTaskName(fireAt: Date): string {
	const yyyy = String(fireAt.getFullYear());
	const mm = String(fireAt.getMonth() + 1).padStart(2, '0');
	const dd = String(fireAt.getDate()).padStart(2, '0');
	const hh = String(fireAt.getHours()).padStart(2, '0');
	const mi = String(fireAt.getMinutes()).padStart(2, '0');
	return `task-${yyyy}-${mm}-${dd}-${hh}${mi}-${shortUuid()}`;
}

/** Auto-generated name for a recurring task: `task-daily-0900-<id>` / `task-every-30m-<id>`. */
export function formatRecurringTaskName(input: ScheduledTaskCreateInput): string {
	if (input.kind === 'daily') {
		const first = (input.scheduleTimes ?? [])[0] ?? '0000';
		return `task-daily-${first.replace(':', '')}-${shortUuid()}`;
	}
	return `task-every-${input.intervalMinutes ?? 0}m-${shortUuid()}`;
}

/** Path of the cue.yaml that already exists for a project, canonical first. */
function existingCueConfigPath(projectRoot: string): string | null {
	const canonical = path.join(projectRoot, CUE_CONFIG_PATH);
	if (fs.existsSync(canonical)) return canonical;
	const legacy = path.join(projectRoot, LEGACY_CUE_CONFIG_PATH);
	if (fs.existsSync(legacy)) return legacy;
	return null;
}

/**
 * Append `newSubs` to `<projectRoot>/.maestro/cue.yaml`, creating the file and
 * `.maestro/` directory when either is missing. A legacy `maestro-cue.yaml` is
 * migrated to the canonical path on the same write, mirroring what the engine's
 * own writers do.
 *
 * Names that already exist in the file are rejected: `removeSubscriptionFromYaml`
 * (used by cancel and by self-destruct) keys solely on name, so two subs sharing
 * one would both be deleted by a single later cancel.
 */
export function appendSubscriptionsToYaml(
	projectRoot: string,
	newSubs: Record<string, unknown>[]
): { filePath: string; created: boolean } {
	const canonicalPath = path.join(projectRoot, CUE_CONFIG_PATH);
	const existing = existingCueConfigPath(projectRoot);

	let parsed: Record<string, unknown> = { subscriptions: [] };
	let header = '';

	if (existing) {
		const raw = fs.readFileSync(existing, 'utf-8');
		header = extractLeadingCommentBlock(raw);
		const loaded = yaml.load(raw);
		if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
			parsed = loaded as Record<string, unknown>;
		}
	}

	const existingSubs = Array.isArray(parsed.subscriptions)
		? (parsed.subscriptions as unknown[])
		: [];

	const existingNames = new Set(
		existingSubs.flatMap((entry) =>
			entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string'
				? [(entry as { name: string }).name]
				: []
		)
	);
	for (const newSub of newSubs) {
		if (typeof newSub.name === 'string' && existingNames.has(newSub.name)) {
			throw new Error(`subscription "${newSub.name}" already exists in ${canonicalPath}`);
		}
	}

	parsed.subscriptions = [...existingSubs, ...newSubs];

	const dumped = yaml.dump(parsed, { lineWidth: -1, noRefs: true, sortKeys: false });
	const output = header + dumped;

	const maestroDir = path.join(projectRoot, MAESTRO_DIR);
	if (!fs.existsSync(maestroDir)) {
		fs.mkdirSync(maestroDir, { recursive: true });
	}
	writeCueYamlAtomicSync(canonicalPath, output);

	// Migrate off the legacy path on the same write so two competing config
	// files can't linger. The canonical file already wins on read, so a failed
	// cleanup is non-fatal - surface it rather than swallowing it.
	if (existing && existing !== canonicalPath) {
		try {
			fs.unlinkSync(existing);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`wrote ${canonicalPath} but failed to remove legacy ${existing}: ${message}`);
		}
	}

	return { filePath: canonicalPath, created: !existing };
}

/**
 * Project the next fire time for a task, in epoch ms. `null` when it cannot be
 * known: an `interval` task's phase lives in engine run state, not in YAML.
 */
function projectNextFire(sub: CueSubscription): number | null {
	if (sub.event === 'time.once') {
		if (!sub.fire_at) return null;
		const ms = Date.parse(sub.fire_at);
		return Number.isFinite(ms) ? ms : null;
	}
	if (sub.event === 'time.scheduled') {
		return calculateNextScheduledTime(sub.schedule_times ?? [], sub.schedule_days);
	}
	return null;
}

/**
 * The tab-delivery half of a task scheduled into an existing tab: an
 * `action: command` cli dispatch that names a `tab`. Such a task keeps its
 * prompt in `command.cli.message` (one copy, so an edit cannot leave two
 * disagreeing), which is why readers and the updater go through this.
 */
function tabDispatchOf(
	sub: Pick<CueSubscription, 'action' | 'command'>
): { tab: string; message: string } | null {
	if (sub.action !== 'command' || sub.command?.mode !== 'cli') return null;
	const { tab, message } = sub.command.cli;
	return tab ? { tab, message: message ?? '' } : null;
}

/** Convert one validated subscription into a `ScheduledTask` row. */
function toScheduledTask(sub: CueSubscription, agent: ScheduledTaskAgent): ScheduledTask {
	const event = sub.event as ScheduledTask['event'];
	const action: CueAction = sub.action ?? 'prompt';
	const tabDispatch = tabDispatchOf(sub);
	return {
		name: sub.name,
		kind: kindForEvent(event),
		event,
		enabled: sub.enabled !== false,
		agentId: agent.id,
		agentName: agentDisplayName(agent),
		projectRoot: agent.projectRoot,
		action,
		label: sub.label ?? '',
		// A command sub's `prompt` is a normalizer sentinel (the cli target), not
		// what the task says; the dispatched message is.
		prompt: tabDispatch ? tabDispatch.message : (sub.prompt ?? ''),
		...(tabDispatch ? { tabId: tabDispatch.tab } : {}),
		pipelineName: sub.pipeline_name ?? DEFAULT_SCHEDULED_TASK_PIPELINE,
		fireAt: sub.fire_at,
		scheduleTimes: sub.schedule_times,
		scheduleDays: sub.schedule_days,
		intervalMinutes: sub.interval_minutes,
		graceMinutes: sub.grace_minutes,
		notifyMessage: sub.notify?.message,
		notifySticky: sub.notify?.sticky,
		...cueTurnSettingsOf(sub),
		nextFireAtMs: projectNextFire(sub),
	};
}

/**
 * Collect every scheduled task across the given agents, sorted by next fire
 * (soonest first; tasks with no projection sink to the bottom, then by name).
 *
 * Agents with no cue.yaml are skipped silently - that is the normal "nothing
 * scheduled" state. Parse and schema errors become `warnings` so one bad file
 * can't hide every other agent's tasks.
 */
export function collectScheduledTasks(agents: ScheduledTaskAgent[]): CollectScheduledTasksResult {
	const tasks: ScheduledTask[] = [];
	const warnings: string[] = [];

	for (const agent of agents) {
		const result = loadCueConfigDetailed(agent.projectRoot);
		if (!result.ok) {
			if (result.reason === 'missing') continue;
			const detail = result.reason === 'parse-error' ? result.message : result.errors.join('; ');
			warnings.push(
				`failed to load cue.yaml for agent ${agentDisplayName(agent)} (${agent.id.slice(0, SHORT_UUID_LENGTH)}): ${detail}`
			);
			continue;
		}
		for (const sub of result.config.subscriptions) {
			if (!isScheduledTaskEvent(sub.event)) continue;
			tasks.push(toScheduledTask(sub, agent));
		}
	}

	tasks.sort((a, b) => {
		const aNext = a.nextFireAtMs;
		const bNext = b.nextFireAtMs;
		if (aNext !== null && bNext !== null) return aNext - bNext || a.name.localeCompare(b.name);
		if (aNext !== null) return -1;
		if (bNext !== null) return 1;
		return a.name.localeCompare(b.name);
	});

	return { tasks, warnings };
}

/** Validate `input` and build the subscription object(s) it describes.
 *  A task with both a prompt and a notify becomes two subscriptions that share
 *  a fire time, named `<base>-prompt` and `<base>-notify`. */
export function buildScheduledTaskSubscriptions(
	agent: ScheduledTaskAgent,
	input: ScheduledTaskCreateInput
): Record<string, unknown>[] {
	const promptText = input.prompt ?? '';
	const hasPrompt = promptText.length > 0;
	const hasNotify = input.notify !== undefined && input.notify.message.length > 0;
	if (!hasPrompt && !hasNotify) {
		throw new Error('a scheduled task needs a prompt, a notification, or both');
	}
	const turnSettings = cueTurnSettingsOf(input);
	if (turnSettings?.tier && turnSettings.model) {
		throw new Error('set a model tier or an exact model, not both');
	}
	if (turnSettings && !hasPrompt) {
		throw new Error('a model tier, model, or effort needs a prompt to run');
	}
	const tabId = input.tabId?.trim() || undefined;
	if (tabId && !hasPrompt) {
		throw new Error('a target tab needs a prompt to deliver');
	}
	if (tabId && turnSettings) {
		throw new Error(
			"a prompt delivered into an existing tab runs on that tab's model; drop the tier, model, or effort"
		);
	}

	const timing: Record<string, unknown> = {};
	let baseName: string;

	if (input.kind === 'once') {
		if (!input.fireAt) throw new Error('a one-shot task needs a fire time');
		const fireMs = Date.parse(input.fireAt);
		if (!Number.isFinite(fireMs)) throw new Error(`unparseable fire time "${input.fireAt}"`);
		// Re-emit as `…Z` so the validator's timezone requirement always holds,
		// no matter how the caller spelled the offset.
		timing.fire_at = new Date(fireMs).toISOString();
		if (input.graceMinutes !== undefined) {
			assertMinutes(input.graceMinutes, 'grace minutes', 0);
			timing.grace_minutes = input.graceMinutes;
		}
		if (input.keepOnFailure === true) timing.self_destruct_on_failure = false;
		baseName = input.name?.length ? input.name : formatOnceTaskName(new Date(fireMs));
	} else if (input.kind === 'daily') {
		const times = normalizeTimes(input.scheduleTimes);
		timing.schedule_times = times;
		if (input.scheduleDays?.length) timing.schedule_days = input.scheduleDays;
		baseName = input.name?.length
			? input.name
			: formatRecurringTaskName({ ...input, scheduleTimes: times });
	} else {
		if (input.intervalMinutes === undefined) {
			throw new Error('a repeating task needs an interval in minutes');
		}
		assertMinutes(input.intervalMinutes, 'interval minutes', 1);
		timing.interval_minutes = input.intervalMinutes;
		baseName = input.name?.length ? input.name : formatRecurringTaskName(input);
	}

	const event = eventForKind(input.kind);
	const pipelineName = input.pipelineName?.length
		? input.pipelineName
		: DEFAULT_SCHEDULED_TASK_PIPELINE;
	const labelSource =
		input.label ??
		(hasPrompt ? promptText : undefined) ??
		input.notify?.message ??
		`Task ${baseName}`;
	const label = truncateTaskLabel(labelSource);

	const dual = hasPrompt && hasNotify;
	const subs: Record<string, unknown>[] = [];

	if (hasPrompt && tabId) {
		// Into an existing conversation: the same `dispatch --tab --queue` an agent
		// would run by hand, done by Cue itself so no agent turn is spent as a relay.
		subs.push({
			name: dual ? `${baseName}-prompt` : baseName,
			event,
			enabled: true,
			action: 'command',
			command: {
				mode: 'cli',
				cli: { command: 'send', target: agent.id, tab: tabId, message: promptText },
			},
			...timing,
			agent_id: agent.id,
			pipeline_name: pipelineName,
			label,
		});
	} else if (hasPrompt) {
		subs.push({
			name: dual ? `${baseName}-prompt` : baseName,
			event,
			enabled: true,
			action: 'prompt',
			prompt: promptText,
			...turnSettings,
			...timing,
			agent_id: agent.id,
			pipeline_name: pipelineName,
			label,
		});
	}

	if (hasNotify) {
		const notifyConfig: Record<string, unknown> = { message: input.notify!.message };
		if (input.notify!.sticky === true) notifyConfig.sticky = true;
		subs.push({
			name: dual ? `${baseName}-notify` : baseName,
			event,
			enabled: true,
			action: 'notify',
			...timing,
			agent_id: agent.id,
			pipeline_name: pipelineName,
			label,
			notify: notifyConfig,
		});
	}

	return subs;
}

/** Create a task on `agent`. Returns the subscription names that were written. */
export function createScheduledTask(
	agent: ScheduledTaskAgent,
	input: ScheduledTaskCreateInput
): { names: string[]; filePath: string } {
	const subs = buildScheduledTaskSubscriptions(agent, input);
	const { filePath } = appendSubscriptionsToYaml(agent.projectRoot, subs);
	return { names: subs.map((sub) => sub.name as string), filePath };
}

/** Remove a task by name. Thin pass-through so callers import one module. */
export async function cancelScheduledTask(
	projectRoot: string,
	name: string
): Promise<{ removed: boolean; reason?: string }> {
	return removeSubscriptionFromYaml(projectRoot, name);
}

/**
 * Patch an existing scheduled task in place.
 *
 * Rewrites only the named subscription's changed keys and leaves the rest of
 * the file (including its leading comment header and every other sub) byte-for
 * -byte alone apart from a YAML round-trip. Rejects a patch that carries timing
 * fields belonging to a different recurrence than the task actually uses -
 * changing WHEN a task fires is in scope, changing HOW it repeats is not, since
 * that would leave stale keys the validator rejects.
 */
export async function updateScheduledTask(
	projectRoot: string,
	name: string,
	patch: ScheduledTaskUpdateInput
): Promise<{ updated: boolean; reason?: string }> {
	return patchSubscriptionInYaml(projectRoot, name, (target) => {
		const event = typeof target.event === 'string' ? target.event : '';
		if (!isScheduledTaskEvent(event)) {
			return `"${name}" is not a scheduled task (event: ${event})`;
		}
		const kind = kindForEvent(event);

		if (patch.fireAt !== undefined) {
			if (kind !== 'once') return 'only a one-shot task has a fire time';
			const ms = Date.parse(patch.fireAt);
			if (!Number.isFinite(ms)) return `unparseable fire time`;
			target.fire_at = new Date(ms).toISOString();
		}
		if (patch.scheduleTimes !== undefined) {
			if (kind !== 'daily') return 'only a daily task has schedule times';
			try {
				target.schedule_times = normalizeTimes(patch.scheduleTimes);
			} catch (err) {
				return errText(err);
			}
		}
		if (patch.scheduleDays !== undefined) {
			if (kind !== 'daily') return 'only a daily task has schedule days';
			if (patch.scheduleDays.length > 0) target.schedule_days = patch.scheduleDays;
			else delete target.schedule_days;
		}
		if (patch.intervalMinutes !== undefined) {
			if (kind !== 'interval') return 'only a repeating task has an interval';
			try {
				assertMinutes(patch.intervalMinutes, 'interval minutes', 1);
			} catch (err) {
				return errText(err);
			}
			target.interval_minutes = patch.intervalMinutes;
		}
		if (patch.prompt !== undefined) {
			const tabDispatch = tabDispatchOf(target as Pick<CueSubscription, 'action' | 'command'>);
			if (tabDispatch) {
				// The raw YAML object: `tabDispatchOf` just proved this shape.
				(target.command as { cli: { message?: string } }).cli.message = patch.prompt;
			} else {
				target.prompt = patch.prompt;
			}
		}
		if (patch.label !== undefined) target.label = truncateTaskLabel(patch.label);
		if (patch.enabled !== undefined) target.enabled = patch.enabled;
		if (patch.notify !== undefined) {
			const notifyConfig: Record<string, unknown> = { message: patch.notify.message };
			if (patch.notify.sticky === true) notifyConfig.sticky = true;
			target.notify = notifyConfig;
		}
		if (patch.turnSettings !== undefined) {
			const refusal = applyCueTurnSettingsPatch(target, patch.turnSettings);
			if (refusal !== null) return refusal;
		}
		return null;
	});
}

function normalizeTimes(times: string[] | undefined): string[] {
	if (!times || times.length === 0) throw new Error('a daily task needs at least one time');
	return times.map((time) => {
		const normalized = normalizeScheduleTime(time);
		if (!normalized) throw new Error(`invalid time "${time}" (expected HH:MM)`);
		return normalized;
	});
}

function assertMinutes(value: number, label: string, min: number): void {
	if (!Number.isInteger(value) || value < min || value > MAX_SCHEDULE_MINUTES) {
		throw new Error(
			`${label} must be an integer in [${min}, ${MAX_SCHEDULE_MINUTES}], got ${value}`
		);
	}
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
