/**
 * Shared plumbing for the CLI verbs that read and write a group's Group
 * Settings profile (`group-settings`, `update-group-settings`).
 *
 * Writing goes through the running app: the renderer owns the group list and
 * the validator the dialog saves with, so the verb sends a typed patch
 * (`update_group_settings`) and the app builds the profile. What this module
 * adds is the half that needs no app: reading the flags into that patch,
 * describing a stored group, and reading the group back after a write, since
 * the desktop answers as soon as the renderer accepted the message and an older
 * one would drop a field it does not know.
 */

import { AGENT_IDS } from '../../shared/agentIds';
import { canonicalJson } from '../../shared/canonicalJson';
import { GROUP_SHORT_LABEL_MAX_LENGTH, groupBadgeLabel } from '../../shared/formatters';
import {
	parseGroupSettingsUpdateRequest,
	type GroupSettingsUpdateRequest,
} from '../../shared/groupSettingsUpdate';
import { applyPeerAgentEdits } from '../../shared/peerAgents';
import {
	GROUP_LIFECYCLE_STAGES,
	GROUP_LIFECYCLE_TRIGGERS,
	normalizeGroupLifecycle,
	type GroupLifecycle,
	type GroupLifecycleHookPatch,
	type GroupLifecyclePatch,
	type GroupLifecycleStage,
} from '../../shared/groupLifecycle';
import type { Group, GroupAgentDefaults } from '../../shared/types';
import { isWorktreeGroup } from '../../shared/types';
import { readRunOnFlags } from './run-on';
import {
	buildConfigPatch,
	buildSshPatch,
	hasSshFlags,
	type AgentSettingFlagOptions,
	type SshFlagOptions,
} from './agent-setting-flags';
import { hasPeerFlags, readPeerFlags, type PeerFlagOptions } from './peer-flags';
import { resolveCliPath } from '../utils/parse';
import { readGroups, resolveAgentId } from './storage';
import { readInputFile } from './system-one-input';

/** Every flag `update-group-settings` reads. */
export interface GroupSettingsFlagOptions
	extends PeerFlagOptions, AgentSettingFlagOptions, SshFlagOptions {
	cwd?: string;
	provider?: string;
	runOn?: string;
	runOnContext?: string;
	shortLabel?: string;
	clear?: boolean;
	publish?: boolean;
	onboarding?: string;
	onboardingPrompt?: string;
	onboardingEvents?: string;
	onboardingRunsIn?: string;
	onboardingTab?: string;
	onboardingTier?: string;
	offboarding?: string;
	offboardingPrompt?: string;
	offboardingEvents?: string;
	offboardingRunsIn?: string;
	offboardingTab?: string;
	offboardingTier?: string;
	offboardingTimeout?: string;
}

/** The lifecycle flags of one stage, read off the options by the stage's name. */
function stageFlags(options: GroupSettingsFlagOptions, stage: GroupLifecycleStage) {
	return stage === 'onboarding'
		? {
				state: options.onboarding,
				prompt: options.onboardingPrompt,
				events: options.onboardingEvents,
				runsIn: options.onboardingRunsIn,
				tab: options.onboardingTab,
				tier: options.onboardingTier,
				timeout: undefined,
			}
		: {
				state: options.offboarding,
				prompt: options.offboardingPrompt,
				events: options.offboardingEvents,
				runsIn: options.offboardingRunsIn,
				tab: options.offboardingTab,
				tier: options.offboardingTier,
				timeout: options.offboardingTimeout,
			};
}

/**
 * Read the `--onboarding-*` and `--offboarding-*` flags into the patch the app
 * applies. The app judges the result (a steward that exists, a prompt on a
 * hook that is on); this reads the words and refuses the malformed ones.
 */
export function readLifecycleFlags(
	options: GroupSettingsFlagOptions
): GroupLifecyclePatch | undefined {
	const patch: GroupLifecyclePatch = {};
	for (const stage of GROUP_LIFECYCLE_STAGES) {
		const flags = stageFlags(options, stage);
		const flag = (name: string) => `--${stage}${name ? `-${name}` : ''}`;
		if (flags.state?.trim().toLowerCase() === 'clear') {
			const others = [
				flags.prompt,
				flags.events,
				flags.runsIn,
				flags.tab,
				flags.tier,
				flags.timeout,
			];
			if (others.some((value) => value !== undefined)) {
				throw new Error(
					`${flag('')} clear removes the hook; it cannot ride with other ${stage} flags.`
				);
			}
			patch[stage] = null;
			continue;
		}
		const hook: GroupLifecycleHookPatch = {};
		if (flags.state !== undefined) {
			const state = flags.state.trim().toLowerCase();
			if (state !== 'on' && state !== 'off') {
				throw new Error(`${flag('')} must be on, off or clear.`);
			}
			hook.enabled = state === 'on';
		}
		if (flags.prompt !== undefined) {
			hook.prompt = flags.prompt.startsWith('@')
				? readInputFile(flags.prompt.slice(1)).text
				: flags.prompt;
		}
		if (flags.events !== undefined) {
			const words = flags.events
				.split(',')
				.map((word) => word.trim().toLowerCase())
				.filter(Boolean);
			const unknown = words.filter(
				(word) => !(GROUP_LIFECYCLE_TRIGGERS as readonly string[]).includes(word)
			);
			if (unknown.length > 0) {
				throw new Error(
					`${flag('events')} takes ${GROUP_LIFECYCLE_TRIGGERS.join(', ')} (comma separated). Not: ${unknown.join(', ')}.`
				);
			}
			hook.triggers = GROUP_LIFECYCLE_TRIGGERS.filter((trigger) => words.includes(trigger));
		}
		if (flags.runsIn !== undefined) {
			const raw = flags.runsIn.trim();
			hook.runsInAgentId = raw === '' || raw.toLowerCase() === 'self' ? null : resolveAgentId(raw);
		}
		if (flags.tab !== undefined) hook.tabName = flags.tab.trim() || null;
		if (flags.tier !== undefined) {
			const tier = flags.tier.trim().toLowerCase();
			hook.tier =
				tier === 'default' || tier === '' ? null : (tier as GroupLifecycleHookPatch['tier']);
		}
		if (flags.timeout !== undefined) {
			const raw = flags.timeout.trim();
			const minutes = Number(raw);
			if (raw !== '' && (!Number.isFinite(minutes) || !Number.isInteger(minutes))) {
				throw new Error(`${flag('timeout')} takes a whole number of minutes.`);
			}
			hook.timeoutMinutes = raw === '' ? null : minutes;
		}
		if (Object.keys(hook).length > 0) patch[stage] = hook;
	}
	return Object.keys(patch).length > 0 ? patch : undefined;
}

const VALID_PROVIDER_TYPES: ReadonlySet<string> = new Set(
	AGENT_IDS.filter((id) => id !== 'terminal')
);

/**
 * Read the flags into the request the app applies. Throws an Error naming the
 * flag when one is malformed, or when the combination is one the app would
 * refuse (a clear beside a set, a publish of a clear).
 *
 * `group` is the stored group, read so a value that builds on another can see
 * it: a peer note needs the row it annotates, and a Run on context needs the
 * profile's provider.
 */
export function readGroupSettingsFlags(
	options: GroupSettingsFlagOptions,
	group: Group
): GroupSettingsUpdateRequest {
	const patch: Record<string, unknown> = { ...buildConfigPatch(options) };
	// A group stores no provenance for the window, so the marker is not sent.
	delete patch.contextWindowSource;

	if (options.cwd !== undefined) {
		const raw = options.cwd.trim();
		const remote =
			options.sshRemote !== undefined
				? buildSshPatch(options).enabled === true
				: group.defaults?.sessionSshRemoteConfig?.enabled === true;
		// A path on an SSH remote means nothing on this machine, so it is stored
		// as typed. A local one is made absolute here: the app's cwd is unrelated.
		patch.projectRoot = raw === '' ? null : remote ? raw : resolveCliPath(raw);
	}

	if (options.provider !== undefined) {
		const raw = options.provider.trim().toLowerCase();
		if (raw === '' || raw === 'none') {
			patch.toolType = null;
		} else if (VALID_PROVIDER_TYPES.has(raw)) {
			patch.toolType = raw;
		} else {
			throw new Error(
				`Invalid provider "${options.provider}". Must be one of: ${[...VALID_PROVIDER_TYPES].join(', ')}, or none for no default provider`
			);
		}
	}

	if (options.runOn !== undefined || options.runOnContext !== undefined) {
		const toolType =
			patch.toolType !== undefined ? (patch.toolType as string | null) : group.defaults?.toolType;
		if (!toolType) {
			throw new Error(
				'--run-on needs a default provider, which this group has none of. Set one with --provider in this call or before it.'
			);
		}
		const edit = readRunOnFlags(options, { toolType, runOn: group.defaults?.runOn });
		if (edit.kind === 'refused') throw new Error(edit.error);
		if (edit.kind === 'set') patch.runOn = edit.target ?? null;
	}

	if (hasPeerFlags(options)) {
		const peers = readPeerFlags(options);
		// The same arithmetic the app runs, so a note on a peer with no row is
		// refused before the app is asked.
		if (peers.peerAgentEdits) {
			const applied = applyPeerAgentEdits(group.defaults?.peerAgents, peers.peerAgentEdits);
			if (!applied.ok) throw new Error(applied.error);
		}
		Object.assign(patch, peers);
	}

	const request: GroupSettingsUpdateRequest = {};
	if (Object.keys(patch).length > 0) request.configPatch = patch;
	if (hasSshFlags(options)) request.sshPatch = buildSshPatch(options);

	if (options.shortLabel !== undefined) {
		const label = options.shortLabel.trim();
		if (label.length > GROUP_SHORT_LABEL_MAX_LENGTH) {
			throw new Error(
				`--short-label is ${label.length} characters. The pill holds ${GROUP_SHORT_LABEL_MAX_LENGTH}.`
			);
		}
		request.shortLabel = label;
	}
	if (options.clear) request.clearDefaults = true;
	if (options.publish) request.publish = true;
	const lifecyclePatch = readLifecycleFlags(options);
	if (lifecyclePatch) request.lifecyclePatch = lifecyclePatch;

	const checked = parseGroupSettingsUpdateRequest(request);
	if (!checked.ok) {
		throw new Error(
			checked.error === 'Nothing to update'
				? 'Specify at least one field to update (e.g. --provider, --model, --env, --nudge, --peer, --short-label, --onboarding-prompt, --clear). Run "maestro-cli update-group-settings --help" for the full list.'
				: checked.error
		);
	}
	return checked.request;
}

/** Why a group takes no Group Settings, or `undefined` when it does. */
export function groupSettingsBlocker(group: Group): string | undefined {
	return isWorktreeGroup(group)
		? `"${group.name}" is a worktree group. Its agents are created by the worktree flow and take no defaults, so there is nothing to set here.`
		: undefined;
}

/** A group's Group Settings, as `group-settings --json` prints it. */
export interface GroupSettingsReport {
	id: string;
	name: string;
	emoji: string;
	kind: 'user' | 'worktree';
	/** The hand-picked pill label, or `null` when the group holds none. */
	shortLabel: string | null;
	/** What the Left Bar draws on a bookmarked agent's pill. */
	badgeLabel: string;
	/** `automatic`: Maestro abbreviated the name. */
	badgeLabelSource: 'custom' | 'automatic';
	/** The defaults a new agent in the group starts with, or `null` when none. */
	defaults: GroupAgentDefaults | null;
	/** The Onboarding and Offboarding prompts, or `null` when the group holds none. */
	lifecycle: GroupLifecycle | null;
}

export function describeGroupSettings(group: Group): GroupSettingsReport {
	const shortLabel = group.shortLabel?.trim() || null;
	return {
		id: group.id,
		name: group.name,
		emoji: group.emoji,
		kind: isWorktreeGroup(group) ? 'worktree' : 'user',
		shortLabel,
		badgeLabel: groupBadgeLabel(group),
		badgeLabelSource: shortLabel ? 'custom' : 'automatic',
		defaults: group.defaults && Object.keys(group.defaults).length > 0 ? group.defaults : null,
		lifecycle: normalizeGroupLifecycle(group.lifecycle) ?? null,
	};
}

/**
 * Read the group back from disk and confirm it holds what the app said it
 * stored. Returns `null` when it does, or the error text to fail with.
 */
export function verifyPersistedGroupSettings(
	groupId: string,
	expected: {
		defaults: GroupAgentDefaults | null;
		shortLabel: string | null;
		/** Checked only when the write reported it: an older app sends none. */
		lifecycle?: GroupLifecycle | null;
	}
): string | null {
	let stored: Group | undefined;
	try {
		stored = readGroups().find((group) => group.id === groupId);
	} catch (error) {
		return `Could not verify the group after writing it: ${
			error instanceof Error ? error.message : String(error)
		}`;
	}
	if (!stored) return `Group ${groupId} was not found after the write.`;

	const actual = describeGroupSettings(stored);
	const mismatches: string[] = [];
	if (canonicalJson(actual.defaults) !== canonicalJson(expected.defaults)) {
		mismatches.push('the defaults on disk are not the ones the app reported storing');
	}
	if (
		expected.lifecycle !== undefined &&
		canonicalJson(actual.lifecycle) !== canonicalJson(expected.lifecycle)
	) {
		mismatches.push('the lifecycle prompts on disk are not the ones the app reported storing');
	}
	if (actual.shortLabel !== expected.shortLabel) {
		mismatches.push(
			`the pill label on disk is ${actual.shortLabel ?? '(none)'}, expected ${expected.shortLabel ?? '(none)'}`
		);
	}
	return mismatches.length > 0
		? `The write did not persist: ${mismatches.join('; ')}. The running Maestro desktop app may be older than this CLI.`
		: null;
}
