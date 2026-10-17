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
import { readGroups } from './storage';

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

	const checked = parseGroupSettingsUpdateRequest(request);
	if (!checked.ok) {
		throw new Error(
			checked.error === 'Nothing to update'
				? 'Specify at least one field to update (e.g. --provider, --model, --env, --nudge, --peer, --short-label, --clear). Run "maestro-cli update-group-settings --help" for the full list.'
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
	};
}

/**
 * Read the group back from disk and confirm it holds what the app said it
 * stored. Returns `null` when it does, or the error text to fail with.
 */
export function verifyPersistedGroupSettings(
	groupId: string,
	expected: { defaults: GroupAgentDefaults | null; shortLabel: string | null }
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
	if (actual.shortLabel !== expected.shortLabel) {
		mismatches.push(
			`the pill label on disk is ${actual.shortLabel ?? '(none)'}, expected ${expected.shortLabel ?? '(none)'}`
		);
	}
	return mismatches.length > 0
		? `The write did not persist: ${mismatches.join('; ')}. The running Maestro desktop app may be older than this CLI.`
		: null;
}
