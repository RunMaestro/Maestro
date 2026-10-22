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
	autoRunTaskLabel,
	eventForKind,
	isScheduledTaskEvent,
	kindForEvent,
	normalizeScheduleTime,
	truncateTaskLabel,
	type ScheduledTask,
	type ScheduledTaskCreateInput,
	type ScheduledTaskUpdateInput,
} from '../../shared/cue/scheduled-tasks';
import { parseCueAutoRunWorktree } from '../../shared/cue/autorun-worktree';
import { readCueGateSetting, writeCueGateFields, type CueGateSetting } from '../../shared/cue/gate';
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

export interface CueYamlMergeOptions {
	/**
	 * Replace an existing subscription that shares a name with a new one, in
	 * place. Without it a shared name is reported in `conflicts` and the new
	 * subscription is left out.
	 */
	replaceExisting?: boolean;
	/** Settings to add. Only keys the file does not set are written. */
	settings?: Record<string, unknown>;
}

export interface CueYamlMergeResult {
	/** The whole new file: the original leading comment block, then the YAML. */
	content: string;
	/** Names appended to the end of `subscriptions`. */
	added: string[];
	/** Names replaced in place (`replaceExisting` only). */
	replaced: string[];
	/** Names already present and not replaced. */
	conflicts: string[];
	/** Settings keys the file did not set, which were added. */
	settingsAdded: string[];
	/** Settings keys the file already set to a different value, which were kept. */
	settingsKept: string[];
}

function subscriptionName(entry: unknown): string | undefined {
	return entry &&
		typeof entry === 'object' &&
		typeof (entry as { name?: unknown }).name === 'string'
		? (entry as { name: string }).name
		: undefined;
}

/**
 * Merge subscriptions (and optionally settings) into a cue.yaml's text, without
 * touching the disk. `raw` is the current file, or null when there is none.
 * Every existing subscription keeps its place; the leading comment block (the
 * `# Pipeline: ...` header) is preserved. Comments elsewhere in the body do not
 * survive, since js-yaml has no comment model.
 *
 * Throws when `raw` is not valid YAML.
 */
export function mergeSubscriptionsIntoCueYaml(
	raw: string | null,
	newSubs: Record<string, unknown>[],
	options: CueYamlMergeOptions = {}
): CueYamlMergeResult {
	let parsed: Record<string, unknown> = { subscriptions: [] };
	let header = '';
	if (raw !== null) {
		header = extractLeadingCommentBlock(raw);
		const loaded = yaml.load(raw);
		if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
			parsed = loaded as Record<string, unknown>;
		}
	}

	const settingsAdded: string[] = [];
	const settingsKept: string[] = [];
	if (options.settings && Object.keys(options.settings).length > 0) {
		const current =
			parsed.settings && typeof parsed.settings === 'object' && !Array.isArray(parsed.settings)
				? (parsed.settings as Record<string, unknown>)
				: {};
		const merged: Record<string, unknown> = { ...current };
		for (const [key, value] of Object.entries(options.settings)) {
			if (!(key in current)) {
				merged[key] = value;
				settingsAdded.push(key);
			} else if (JSON.stringify(current[key]) !== JSON.stringify(value)) settingsKept.push(key);
		}
		parsed.settings = merged;
	}

	const subs = Array.isArray(parsed.subscriptions) ? [...(parsed.subscriptions as unknown[])] : [];
	const indexByName = new Map<string, number>();
	subs.forEach((entry, i) => {
		const name = subscriptionName(entry);
		if (name !== undefined && !indexByName.has(name)) indexByName.set(name, i);
	});

	const added: string[] = [];
	const replaced: string[] = [];
	const conflicts: string[] = [];
	for (const sub of newSubs) {
		const name = subscriptionName(sub);
		const existing = name !== undefined ? indexByName.get(name) : undefined;
		if (existing === undefined) {
			subs.push(sub);
			if (name !== undefined) {
				indexByName.set(name, subs.length - 1);
				added.push(name);
			}
		} else if (options.replaceExisting) {
			subs[existing] = sub;
			replaced.push(name!);
		} else {
			conflicts.push(name!);
		}
	}
	parsed.subscriptions = subs;

	const dumped = yaml.dump(parsed, { lineWidth: -1, noRefs: true, sortKeys: false });
	return { content: header + dumped, added, replaced, conflicts, settingsAdded, settingsKept };
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

	const merge = mergeSubscriptionsIntoCueYaml(
		existing ? fs.readFileSync(existing, 'utf-8') : null,
		newSubs
	);
	if (merge.conflicts.length > 0) {
		throw new Error(`subscription "${merge.conflicts[0]}" already exists in ${canonicalPath}`);
	}
	const output = merge.content;

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

/** Convert one validated subscription into a `ScheduledTask` row. */
function toScheduledTask(sub: CueSubscription, agent: ScheduledTaskAgent): ScheduledTask {
	const event = sub.event as ScheduledTask['event'];
	const action: CueAction = sub.action ?? 'prompt';
	const gate = readCueGateSetting(sub);
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
		prompt: sub.prompt ?? '',
		pipelineName: sub.pipeline_name ?? DEFAULT_SCHEDULED_TASK_PIPELINE,
		fireAt: sub.fire_at,
		scheduleTimes: sub.schedule_times,
		scheduleDays: sub.schedule_days,
		intervalMinutes: sub.interval_minutes,
		graceMinutes: sub.grace_minutes,
		notifyMessage: sub.notify?.message,
		notifySticky: sub.notify?.sticky,
		autoRun: sub.auto_run,
		...(gate ? { gate: gate.condition } : {}),
		...(gate?.onUnavailable ? { gateOnUnavailable: gate.onUnavailable } : {}),
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
	const hasAutoRun = (input.autoRun?.documents.length ?? 0) > 0;
	if (!hasPrompt && !hasNotify && !hasAutoRun) {
		throw new Error('a scheduled task needs a prompt, a notification, or an Auto Run');
	}
	// An Auto Run already carries its own prompt box and drives the agent for
	// the whole run, so pairing it with a sibling prompt/notify sub would fire
	// two competing jobs at the same instant in the same agent.
	if (hasAutoRun && (hasPrompt || hasNotify)) {
		throw new Error('an Auto Run task cannot also carry a prompt or a notification');
	}
	// A policy with no gate would be written to disk and mean nothing, so it
	// is refused rather than dropped: the caller asked for a gate it did not
	// describe.
	if (input.gateOnUnavailable !== undefined && !input.gate?.trim()) {
		throw new Error('a gate policy needs a gate condition');
	}
	const gate: CueGateSetting | null = input.gate?.trim()
		? { condition: input.gate, onUnavailable: input.gateOnUnavailable }
		: null;
	const turnSettings = cueTurnSettingsOf(input);
	if (turnSettings?.tier && turnSettings.model) {
		throw new Error('set a model tier or an exact model, not both');
	}
	if (turnSettings && !hasPrompt) {
		throw new Error('a model tier, model, or effort needs a prompt to run');
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
		(hasAutoRun ? autoRunTaskLabel(input.autoRun!.documents) : undefined) ??
		`Task ${baseName}`;
	const label = truncateTaskLabel(labelSource);

	const dual = hasPrompt && hasNotify;
	const subs: Record<string, unknown>[] = [];

	if (hasPrompt) {
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

	if (hasAutoRun) {
		const autoRunConfig: Record<string, unknown> = { documents: input.autoRun!.documents };
		const resets = input.autoRun!.reset_on_completion;
		if (resets && resets.some(Boolean)) autoRunConfig.reset_on_completion = resets;
		if (input.autoRun!.prompt) autoRunConfig.prompt = input.autoRun!.prompt;
		if (input.autoRun!.loop_enabled) autoRunConfig.loop_enabled = true;
		if (input.autoRun!.max_loops !== undefined) autoRunConfig.max_loops = input.autoRun!.max_loops;
		if (input.autoRun!.model) autoRunConfig.model = input.autoRun!.model;
		if (input.autoRun!.effort) autoRunConfig.effort = input.autoRun!.effort;
		// `task` is what an absent field means, so only the non-default is written.
		if (input.autoRun!.task_selection_mode === 'document') {
			autoRunConfig.task_selection_mode = 'document';
		}
		if (input.autoRun!.ignore_model_hints) autoRunConfig.ignore_model_hints = true;
		// Auto-resume is ON when absent, so only the opt-out is written; the two
		// numbers are written whenever the caller chose them.
		if (input.autoRun!.auto_resume_on_error === false) autoRunConfig.auto_resume_on_error = false;
		if (input.autoRun!.auto_resume_after_min !== undefined) {
			autoRunConfig.auto_resume_after_min = input.autoRun!.auto_resume_after_min;
		}
		if (input.autoRun!.max_auto_resumes !== undefined) {
			autoRunConfig.max_auto_resumes = input.autoRun!.max_auto_resumes;
		}
		if (input.autoRun!.worktree) {
			// Refused here, not at fire time: a block that cannot be resolved would
			// otherwise be found out hours later, by a run nobody is watching.
			const worktree = parseCueAutoRunWorktree(input.autoRun!.worktree);
			if (!worktree.ok) throw new Error(`auto_run.worktree ${worktree.error}`);
			autoRunConfig.worktree = worktree.value;
		}
		subs.push({
			name: baseName,
			event,
			enabled: true,
			action: 'autorun',
			...timing,
			agent_id: agent.id,
			pipeline_name: pipelineName,
			label,
			auto_run: autoRunConfig,
		});
	}

	// Every subscription the task became carries the gate, so a prompt and its
	// paired notification are skipped together and stay one visual trigger.
	// `writeCueGateFields` refuses a condition the validator would reject.
	if (gate) {
		for (const sub of subs) writeCueGateFields(sub, gate);
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
		if (patch.prompt !== undefined) target.prompt = patch.prompt;
		if (patch.label !== undefined) target.label = truncateTaskLabel(patch.label);
		if (patch.enabled !== undefined) target.enabled = patch.enabled;
		if (patch.notify !== undefined) {
			const notifyConfig: Record<string, unknown> = { message: patch.notify.message };
			if (patch.notify.sticky === true) notifyConfig.sticky = true;
			target.notify = notifyConfig;
		}
		if (patch.gate !== undefined || patch.gateOnUnavailable !== undefined) {
			// `gate: null` removes the gate; a string sets it. A policy alone
			// changes the policy of the gate the task already has.
			let gate: CueGateSetting | null;
			if (patch.gate === null) {
				gate = null;
			} else {
				const current = readCueGateSetting(target);
				const condition = patch.gate ?? current?.condition;
				if (condition === undefined) return `"${name}" has no gate to set a policy on`;
				gate = { condition, onUnavailable: patch.gateOnUnavailable ?? current?.onUnavailable };
			}
			try {
				writeCueGateFields(target, gate);
			} catch (err) {
				return errText(err);
			}
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
