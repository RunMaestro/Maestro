/**
 * Group lifecycle prompts: a prompt a group runs when an agent joins it
 * (Onboarding) and another it runs before an agent leaves it (Offboarding).
 *
 * Unlike a group's defaults (`GroupAgentDefaults`), which are copied into a new
 * agent once and never read again, these are read at the moment of the event:
 * an agent is created in the group, a worktree agent is created under one of
 * its agents, or one of those is removed. An edit applies to the next event.
 *
 * This module is pure and dependency-light so the renderer (the dialog, the
 * runner), the WebSocket boundary and the CLI read and write one shape:
 *
 * - the stored record (`GroupLifecycle`, on `Group.lifecycle`),
 * - the wire patch a CLI flag or bridge client sends (`GroupLifecyclePatch`),
 * - the checks a save must pass (`groupLifecycleProblem`),
 * - which hook an event fires (`lifecycleHookFor`),
 * - the variables a prompt may use, beyond the general template set.
 */

import { asTierLevel, TIER_LEVELS, type ModelTier } from './tierLevels';
import type { Group } from './types';

// ============================================================================
// Vocabulary
// ============================================================================

export const GROUP_LIFECYCLE_STAGES = ['onboarding', 'offboarding'] as const;
export type GroupLifecycleStage = (typeof GROUP_LIFECYCLE_STAGES)[number];

/** The kind of agent an event is about: a plain agent, or a worktree agent. */
export const GROUP_LIFECYCLE_TRIGGERS = ['agent', 'worktree'] as const;
export type GroupLifecycleTrigger = (typeof GROUP_LIFECYCLE_TRIGGERS)[number];

export const GROUP_LIFECYCLE_STAGE_LABELS: Readonly<Record<GroupLifecycleStage, string>> =
	Object.freeze({ onboarding: 'Onboarding', offboarding: 'Offboarding' });

/** What each stage does, in the sentence under its title. */
export const GROUP_LIFECYCLE_STAGE_SUMMARIES: Readonly<Record<GroupLifecycleStage, string>> =
	Object.freeze({
		onboarding: 'Runs once when an agent joins this group',
		offboarding: 'Runs once before an agent leaves this group',
	});

/** The name of each trigger, per stage, as the checkboxes read. */
export const GROUP_LIFECYCLE_TRIGGER_LABELS: Readonly<
	Record<GroupLifecycleStage, Readonly<Record<GroupLifecycleTrigger, string>>>
> = Object.freeze({
	onboarding: Object.freeze({ agent: 'Agent created', worktree: 'Worktree created' }),
	offboarding: Object.freeze({ agent: 'Agent removed', worktree: 'Worktree removed' }),
});

/** How long removal waits for an Offboarding turn when the hook names no limit. */
export const DEFAULT_OFFBOARDING_TIMEOUT_MINUTES = 5;
/** The longest wait a hook may ask for. Removal is a thing a person is waiting on. */
export const MAX_OFFBOARDING_TIMEOUT_MINUTES = 60;
/** The choices the dialog offers. The CLI takes any whole number in range. */
export const OFFBOARDING_TIMEOUT_CHOICES: readonly number[] = [1, 2, 5, 10, 15, 30, 60];

/** The longest prompt a hook stores. A prompt is instructions, not a document. */
export const MAX_LIFECYCLE_PROMPT_CHARS = 20_000;
/** The longest tab name a hook stores. */
export const MAX_LIFECYCLE_TAB_NAME_CHARS = 60;

// ============================================================================
// Stored shape
// ============================================================================

/** One stage's prompt and the rules for when and where it runs. */
export interface GroupLifecycleHook {
	/** Off keeps the prompt but fires nothing. */
	enabled: boolean;
	/** The prompt, with `{{VARIABLES}}` filled in when it runs. */
	prompt: string;
	/** Which kinds of agent fire the hook. */
	triggers: GroupLifecycleTrigger[];
	/**
	 * The agent that runs the prompt. Absent: the agent joining or leaving runs
	 * it itself. Set: another agent (a steward) runs it, which is the only way to
	 * tear down for an agent whose own provider can no longer run.
	 */
	runsInAgentId?: string;
	/** Name of the tab the prompt runs in. Absent: the stage's label. */
	tabName?: string;
	/** Model tier the turn runs at. Absent: the running agent's own model. */
	tier?: ModelTier;
	/** Offboarding only: minutes removal waits for the turn before it goes ahead. */
	timeoutMinutes?: number;
}

/** A group's lifecycle prompts. Either stage may be absent. */
export interface GroupLifecycle {
	onboarding?: GroupLifecycleHook;
	offboarding?: GroupLifecycleHook;
}

/** The hook a stage starts as in the dialog: off, empty, both triggers. */
export function defaultLifecycleHook(stage: GroupLifecycleStage): GroupLifecycleHook {
	return {
		enabled: false,
		prompt: '',
		triggers: [...GROUP_LIFECYCLE_TRIGGERS],
		...(stage === 'offboarding' ? { timeoutMinutes: DEFAULT_OFFBOARDING_TIMEOUT_MINUTES } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTrigger(value: unknown): value is GroupLifecycleTrigger {
	return (GROUP_LIFECYCLE_TRIGGERS as readonly unknown[]).includes(value);
}

/**
 * Read one stored hook, keeping only well-formed fields. A store written by
 * hand, or by a newer build, must never make the runner throw: what cannot be
 * read is dropped, and a hook with no usable fields reads as absent.
 */
export function normalizeLifecycleHook(
	raw: unknown,
	stage: GroupLifecycleStage
): GroupLifecycleHook | undefined {
	if (!isRecord(raw)) return undefined;
	const triggers = Array.isArray(raw.triggers)
		? GROUP_LIFECYCLE_TRIGGERS.filter((trigger) => (raw.triggers as unknown[]).includes(trigger))
		: [...GROUP_LIFECYCLE_TRIGGERS];
	const hook: GroupLifecycleHook = {
		enabled: raw.enabled === true,
		prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
		triggers,
	};
	if (typeof raw.runsInAgentId === 'string' && raw.runsInAgentId.trim()) {
		hook.runsInAgentId = raw.runsInAgentId.trim();
	}
	if (typeof raw.tabName === 'string' && raw.tabName.trim()) hook.tabName = raw.tabName.trim();
	const tier = asTierLevel(raw.tier);
	if (tier) hook.tier = tier;
	if (stage === 'offboarding' && typeof raw.timeoutMinutes === 'number') {
		hook.timeoutMinutes = raw.timeoutMinutes;
	}
	return isLifecycleHookEmpty(hook) ? undefined : hook;
}

/** Read a stored `Group.lifecycle`. `undefined` when it holds no hook. */
export function normalizeGroupLifecycle(raw: unknown): GroupLifecycle | undefined {
	if (!isRecord(raw)) return undefined;
	const lifecycle: GroupLifecycle = {};
	for (const stage of GROUP_LIFECYCLE_STAGES) {
		const hook = normalizeLifecycleHook(raw[stage], stage);
		if (hook) lifecycle[stage] = hook;
	}
	return Object.keys(lifecycle).length > 0 ? lifecycle : undefined;
}

/**
 * A hook with nothing to keep: off, and no prompt. Saving one removes the
 * stage, so a group never stores a placeholder.
 */
export function isLifecycleHookEmpty(hook: GroupLifecycleHook): boolean {
	return !hook.enabled && hook.prompt.trim() === '';
}

/** The record to store: empty hooks dropped, `undefined` when none is left. */
export function compactGroupLifecycle(
	lifecycle: GroupLifecycle | undefined
): GroupLifecycle | undefined {
	if (!lifecycle) return undefined;
	const compact: GroupLifecycle = {};
	for (const stage of GROUP_LIFECYCLE_STAGES) {
		const hook = lifecycle[stage];
		if (hook && !isLifecycleHookEmpty(hook)) compact[stage] = cleanHook(hook, stage);
	}
	return Object.keys(compact).length > 0 ? compact : undefined;
}

/** A hook with its optional fields trimmed, and absent where blank. */
function cleanHook(hook: GroupLifecycleHook, stage: GroupLifecycleStage): GroupLifecycleHook {
	const clean: GroupLifecycleHook = {
		enabled: hook.enabled,
		prompt: hook.prompt,
		triggers: GROUP_LIFECYCLE_TRIGGERS.filter((trigger) => hook.triggers.includes(trigger)),
	};
	if (hook.runsInAgentId?.trim()) clean.runsInAgentId = hook.runsInAgentId.trim();
	if (hook.tabName?.trim()) clean.tabName = hook.tabName.trim();
	if (hook.tier) clean.tier = hook.tier;
	if (stage === 'offboarding' && hook.timeoutMinutes !== undefined) {
		clean.timeoutMinutes = hook.timeoutMinutes;
	}
	return clean;
}

/** `group` with its lifecycle replaced. An empty lifecycle removes the field. */
export function withGroupLifecycle(group: Group, lifecycle: GroupLifecycle | undefined): Group {
	const { lifecycle: _previous, ...rest } = group;
	const compact = compactGroupLifecycle(lifecycle);
	return compact ? { ...rest, lifecycle: compact } : rest;
}

// ============================================================================
// Checks
// ============================================================================

/** What a save is judged against that only the app holds. */
export interface GroupLifecycleCheckContext {
	/** Every agent that exists. A steward must be one of them. */
	liveAgentIds: readonly string[];
}

/** A problem with one stage, named so the dialog can put it under the field. */
export interface GroupLifecycleProblem {
	stage: GroupLifecycleStage;
	field: 'prompt' | 'triggers' | 'runsIn' | 'tabName' | 'timeout';
	error: string;
}

/**
 * The first reason a lifecycle cannot be saved, or `null`. A hook that is off
 * is still checked for the values it holds, so turning it on later cannot
 * reveal a problem that was saved without a word.
 */
export function groupLifecycleProblem(
	lifecycle: GroupLifecycle | undefined,
	context: GroupLifecycleCheckContext
): GroupLifecycleProblem | null {
	for (const stage of GROUP_LIFECYCLE_STAGES) {
		const hook = lifecycle?.[stage];
		if (!hook || isLifecycleHookEmpty(hook)) continue;
		const label = GROUP_LIFECYCLE_STAGE_LABELS[stage];
		if (hook.enabled && hook.prompt.trim() === '') {
			return { stage, field: 'prompt', error: `${label} is on but has no prompt.` };
		}
		if (hook.prompt.length > MAX_LIFECYCLE_PROMPT_CHARS) {
			return {
				stage,
				field: 'prompt',
				error: `The ${label} prompt is ${hook.prompt.length} characters. The limit is ${MAX_LIFECYCLE_PROMPT_CHARS}.`,
			};
		}
		if (hook.enabled && hook.triggers.length === 0) {
			return {
				stage,
				field: 'triggers',
				error: `${label} is on but no event fires it. Choose at least one.`,
			};
		}
		if (hook.runsInAgentId && !context.liveAgentIds.includes(hook.runsInAgentId)) {
			return {
				stage,
				field: 'runsIn',
				error: `${label} runs in an agent that no longer exists. Choose another agent, or let the agent itself run it.`,
			};
		}
		if ((hook.tabName?.trim().length ?? 0) > MAX_LIFECYCLE_TAB_NAME_CHARS) {
			return {
				stage,
				field: 'tabName',
				error: `The ${label} tab name is longer than ${MAX_LIFECYCLE_TAB_NAME_CHARS} characters.`,
			};
		}
		if (
			stage === 'offboarding' &&
			hook.timeoutMinutes !== undefined &&
			(!Number.isInteger(hook.timeoutMinutes) ||
				hook.timeoutMinutes < 1 ||
				hook.timeoutMinutes > MAX_OFFBOARDING_TIMEOUT_MINUTES)
		) {
			return {
				stage,
				field: 'timeout',
				error: `The Offboarding time limit must be a whole number of minutes from 1 to ${MAX_OFFBOARDING_TIMEOUT_MINUTES}.`,
			};
		}
	}
	return null;
}

// ============================================================================
// Firing
// ============================================================================

/**
 * The kind of agent an event is about. A worktree agent links to its parent by
 * `parentSessionId` (or, for the legacy model, `worktreeParentPath`).
 */
export function lifecycleTriggerFor(agent: {
	parentSessionId?: string;
	worktreeParentPath?: string;
}): GroupLifecycleTrigger {
	return agent.parentSessionId || agent.worktreeParentPath ? 'worktree' : 'agent';
}

/**
 * The hook `stage` fires for an agent of kind `trigger` in `group`, or `null`
 * when nothing should run: no group, a hook that is off, a blank prompt, or a
 * trigger the hook does not list.
 */
export function lifecycleHookFor(
	group: Pick<Group, 'lifecycle'> | undefined,
	stage: GroupLifecycleStage,
	trigger: GroupLifecycleTrigger
): GroupLifecycleHook | null {
	const hook = normalizeGroupLifecycle(group?.lifecycle)?.[stage];
	if (!hook || !hook.enabled || hook.prompt.trim() === '') return null;
	return hook.triggers.includes(trigger) ? hook : null;
}

/** The tab name a hook's turn runs in. */
export function lifecycleTabName(hook: GroupLifecycleHook, stage: GroupLifecycleStage): string {
	return hook.tabName?.trim() || GROUP_LIFECYCLE_STAGE_LABELS[stage];
}

/** How long removal waits for an Offboarding turn, in milliseconds. */
export function offboardingTimeoutMs(hook: GroupLifecycleHook): number {
	const minutes = hook.timeoutMinutes ?? DEFAULT_OFFBOARDING_TIMEOUT_MINUTES;
	const bounded = Math.min(Math.max(Math.round(minutes), 1), MAX_OFFBOARDING_TIMEOUT_MINUTES);
	return bounded * 60_000;
}

// ============================================================================
// Template variables
// ============================================================================

/**
 * The variables only a lifecycle prompt has, filled in before the general set
 * (`substituteTemplateVariables`). Every general variable describes the agent
 * joining or leaving, even when another agent runs the prompt: that agent is
 * what the prompt is about.
 */
export const LIFECYCLE_TEMPLATE_VARIABLES = [
	{
		variable: '{{LIFECYCLE_EVENT}}',
		description: 'What happened: agent-created, worktree-created, agent-removed, worktree-removed',
	},
	{
		variable: '{{PARENT_AGENT_NAME}}',
		description: "A worktree agent's parent agent name (empty for a plain agent)",
	},
	{
		variable: '{{PARENT_PATH}}',
		description: "A worktree agent's parent repository path (empty for a plain agent)",
	},
] as const;

/** The event name a prompt sees in `{{LIFECYCLE_EVENT}}`. */
export function lifecycleEventName(
	stage: GroupLifecycleStage,
	trigger: GroupLifecycleTrigger
): string {
	return `${trigger}-${stage === 'onboarding' ? 'created' : 'removed'}`;
}

export interface LifecycleTemplateValues {
	event: string;
	parentAgentName?: string;
	parentPath?: string;
}

/** Fill in the lifecycle-only variables. The general set is the caller's next step. */
export function substituteLifecycleVariables(
	template: string,
	values: LifecycleTemplateValues
): string {
	const replacements: Record<string, string> = {
		LIFECYCLE_EVENT: values.event,
		PARENT_AGENT_NAME: values.parentAgentName ?? '',
		PARENT_PATH: values.parentPath ?? '',
	};
	return template.replace(
		/\{\{(LIFECYCLE_EVENT|PARENT_AGENT_NAME|PARENT_PATH)\}\}/g,
		(_match, key: string) => replacements[key]
	);
}

// ============================================================================
// The wire patch (CLI flags, bridge clients)
// ============================================================================

/** The fields a patch may set on one stage. Each is optional; `null` clears an optional field. */
export interface GroupLifecycleHookPatch {
	enabled?: boolean;
	prompt?: string;
	triggers?: GroupLifecycleTrigger[];
	/** An agent id, or `null` for the agent itself. */
	runsInAgentId?: string | null;
	/** A name, or `null` for the stage's label. */
	tabName?: string | null;
	/** A tier, or `null` for the running agent's own model. */
	tier?: ModelTier | null;
	/** Offboarding only. Minutes, or `null` for the default. */
	timeoutMinutes?: number | null;
}

/** A change to a group's lifecycle. A stage set to `null` is removed. */
export type GroupLifecyclePatch = Partial<
	Record<GroupLifecycleStage, GroupLifecycleHookPatch | null>
>;

const HOOK_PATCH_KEYS = [
	'enabled',
	'prompt',
	'triggers',
	'runsInAgentId',
	'tabName',
	'tier',
	'timeoutMinutes',
] as const;

export type GroupLifecyclePatchParse =
	| { ok: true; patch: GroupLifecyclePatch }
	| { ok: false; error: string };

/** Read a patch that arrived over a wire, or say what is wrong with its shape. */
export function parseGroupLifecyclePatch(raw: unknown): GroupLifecyclePatchParse {
	if (!isRecord(raw)) return { ok: false, error: 'lifecyclePatch must be an object.' };
	const unknownStages = Object.keys(raw).filter(
		(key) => !(GROUP_LIFECYCLE_STAGES as readonly string[]).includes(key)
	);
	if (unknownStages.length > 0) {
		return {
			ok: false,
			error: `Not a lifecycle stage: ${unknownStages.join(', ')}. A group has ${GROUP_LIFECYCLE_STAGES.join(' and ')}.`,
		};
	}
	const patch: GroupLifecyclePatch = {};
	for (const stage of GROUP_LIFECYCLE_STAGES) {
		const value = raw[stage];
		if (value === undefined) continue;
		if (value === null) {
			patch[stage] = null;
			continue;
		}
		const parsed = parseHookPatch(value, stage);
		if (!parsed.ok) return parsed;
		patch[stage] = parsed.hook;
	}
	if (Object.keys(patch).length === 0) return { ok: false, error: 'lifecyclePatch is empty.' };
	return { ok: true, patch };
}

function parseHookPatch(
	raw: unknown,
	stage: GroupLifecycleStage
): { ok: true; hook: GroupLifecycleHookPatch } | { ok: false; error: string } {
	const label = GROUP_LIFECYCLE_STAGE_LABELS[stage];
	if (!isRecord(raw)) return { ok: false, error: `${label} must be an object or null.` };
	const unknown = Object.keys(raw).filter(
		(key) => !(HOOK_PATCH_KEYS as readonly string[]).includes(key)
	);
	if (unknown.length > 0) {
		return { ok: false, error: `Not a ${label} setting: ${unknown.join(', ')}.` };
	}
	const hook: GroupLifecycleHookPatch = {};
	if (raw.enabled !== undefined) {
		if (typeof raw.enabled !== 'boolean')
			return { ok: false, error: `${label}: enabled must be true or false.` };
		hook.enabled = raw.enabled;
	}
	if (raw.prompt !== undefined) {
		if (typeof raw.prompt !== 'string')
			return { ok: false, error: `${label}: prompt must be text.` };
		hook.prompt = raw.prompt;
	}
	if (raw.triggers !== undefined) {
		if (!Array.isArray(raw.triggers) || !raw.triggers.every(isTrigger)) {
			return {
				ok: false,
				error: `${label}: triggers must be a list of ${GROUP_LIFECYCLE_TRIGGERS.join(', ')}.`,
			};
		}
		hook.triggers = GROUP_LIFECYCLE_TRIGGERS.filter((trigger) =>
			(raw.triggers as unknown[]).includes(trigger)
		);
	}
	for (const key of ['runsInAgentId', 'tabName'] as const) {
		const value = raw[key];
		if (value === undefined) continue;
		if (value !== null && typeof value !== 'string') {
			return { ok: false, error: `${label}: ${key} must be text or null.` };
		}
		hook[key] = value === null || value.trim() === '' ? null : value.trim();
	}
	if (raw.tier !== undefined) {
		if (raw.tier === null || raw.tier === 'default') {
			hook.tier = null;
		} else {
			const tier = asTierLevel(raw.tier);
			if (!tier) {
				return {
					ok: false,
					error: `${label}: tier must be default, ${TIER_LEVELS.join(', ')}.`,
				};
			}
			hook.tier = tier;
		}
	}
	if (raw.timeoutMinutes !== undefined) {
		if (stage !== 'offboarding') {
			return { ok: false, error: 'Only Offboarding has a time limit.' };
		}
		if (raw.timeoutMinutes !== null && typeof raw.timeoutMinutes !== 'number') {
			return { ok: false, error: 'Offboarding: timeoutMinutes must be a number or null.' };
		}
		hook.timeoutMinutes = raw.timeoutMinutes;
	}
	if (Object.keys(hook).length === 0) return { ok: false, error: `${label}: nothing to change.` };
	return { ok: true, hook };
}

/**
 * Fold a patch into the stored lifecycle. A stage the patch names starts from
 * the stored hook, or from the stage's default when there is none. The result
 * is compacted, so a stage switched off with its prompt cleared is removed.
 */
export function applyGroupLifecyclePatch(
	current: GroupLifecycle | undefined,
	patch: GroupLifecyclePatch
): GroupLifecycle | undefined {
	const next: GroupLifecycle = { ...(normalizeGroupLifecycle(current) ?? {}) };
	for (const stage of GROUP_LIFECYCLE_STAGES) {
		const change = patch[stage];
		if (change === undefined) continue;
		if (change === null) {
			delete next[stage];
			continue;
		}
		const hook: GroupLifecycleHook = { ...(next[stage] ?? defaultLifecycleHook(stage)) };
		if (change.enabled !== undefined) hook.enabled = change.enabled;
		if (change.prompt !== undefined) hook.prompt = change.prompt;
		if (change.triggers !== undefined) hook.triggers = [...change.triggers];
		if (change.runsInAgentId !== undefined) {
			if (change.runsInAgentId === null) delete hook.runsInAgentId;
			else hook.runsInAgentId = change.runsInAgentId;
		}
		if (change.tabName !== undefined) {
			if (change.tabName === null) delete hook.tabName;
			else hook.tabName = change.tabName;
		}
		if (change.tier !== undefined) {
			if (change.tier === null) delete hook.tier;
			else hook.tier = change.tier;
		}
		if (change.timeoutMinutes !== undefined) {
			if (change.timeoutMinutes === null) delete hook.timeoutMinutes;
			else hook.timeoutMinutes = change.timeoutMinutes;
		}
		next[stage] = hook;
	}
	return compactGroupLifecycle(next);
}

/** A request to run one stage's prompt now, on one agent of the group. Writes nothing. */
export interface GroupLifecycleRunRequest {
	stage: GroupLifecycleStage;
	agentId: string;
}

export function parseGroupLifecycleRunRequest(
	raw: unknown
): { ok: true; request: GroupLifecycleRunRequest } | { ok: false; error: string } {
	if (!isRecord(raw)) return { ok: false, error: 'runLifecycle must be an object.' };
	if (!(GROUP_LIFECYCLE_STAGES as readonly unknown[]).includes(raw.stage)) {
		return {
			ok: false,
			error: `runLifecycle.stage must be ${GROUP_LIFECYCLE_STAGES.join(' or ')}.`,
		};
	}
	if (typeof raw.agentId !== 'string' || raw.agentId.trim() === '') {
		return { ok: false, error: 'runLifecycle.agentId must name an agent.' };
	}
	return {
		ok: true,
		request: { stage: raw.stage as GroupLifecycleStage, agentId: raw.agentId.trim() },
	};
}

/** What running a stage's prompt did. */
export interface GroupLifecycleRunReport {
	stage: GroupLifecycleStage;
	/** The agent the prompt is about. */
	subjectAgentId: string;
	/** The agent the prompt runs in: the subject, or the hook's steward. */
	runAgentId: string;
	/** The tab it was queued in. */
	tabId: string;
	tabName: string;
}
