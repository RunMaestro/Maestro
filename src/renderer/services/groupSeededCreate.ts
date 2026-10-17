/**
 * Seeding a new agent from its group's defaults, for a caller that is not the
 * New Agent dialog: `maestro-cli create-agent --group` and any bridge client.
 *
 * The dialog fills a form from the group's seed and lets the user change it. A
 * scripted create has no form, so the caller's explicit flags stand where the
 * user's edits would. The rules are the dialog's own, from
 * `shared/groupAgentDefaults.ts`: the same seed (`resolveGroupDefaultsSeed`),
 * the same provider-bound rule and the same extras, so an agent a script makes
 * and an agent a person clicks into existence are the same agent.
 *
 * Nothing is written here. The caller stamps `fields` and `extras` onto the
 * record it builds and, once the agent is in the store, hands `extras` to
 * `applySeededTokenProxy`.
 */

import {
	groupDefaultLabel,
	groupDefaultsCreateExtras,
	groupDefaultsCreateFields,
	resolveGroupDefaultsSeed,
	type GroupDefaultsCreateExtras,
	type GroupDefaultsCreateFields,
	type GroupSeededCreateReport,
} from '../../shared/groupAgentDefaults';
import { isWorktreeGroup, type Group, type ToolType } from '../../shared/types';
import { useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { logger } from '../utils/logger';

export interface GroupSeededCreate extends GroupSeededCreateReport {
	/** What the new agent's record starts with: the seed under the caller's explicit fields. */
	fields: GroupDefaultsCreateFields;
	/** The seed's defaults the create has no field for; stamp them and apply the proxy. */
	extras: GroupDefaultsCreateExtras;
}

/**
 * The saved SSH remotes' ids, or `undefined` when they cannot be read. Unknown
 * judges no remote gone: an unresolvable remote fails the launch by name, where
 * a remote wrongly dropped would run the agent on this machine.
 */
async function readSshRemoteIds(): Promise<string[] | undefined> {
	try {
		const result = await window.maestro.sshRemote.getConfigs();
		return result.success
			? (result.configs ?? []).map((remote: { id: string }) => remote.id)
			: undefined;
	} catch (error) {
		logger.error('Failed to load SSH remote configs for a group seed:', undefined, error);
		return undefined;
	}
}

/** The group a create can be seeded from: a user group that holds defaults. */
export function seedableGroup(groupId: string | undefined, groups: Group[]): Group | undefined {
	if (!groupId) return undefined;
	const group = groups.find((candidate) => candidate.id === groupId);
	if (!group || isWorktreeGroup(group)) return undefined;
	return group.defaults && Object.keys(group.defaults).length > 0 ? group : undefined;
}

/**
 * Work out what a create in `groupId` starts with. `explicit` is what the
 * caller set on purpose, and always wins. A group with no defaults, a worktree
 * group, no group at all, or `seed: false` (`--no-group-defaults`) leaves
 * `explicit` as it came.
 */
export async function seedRemoteCreate(request: {
	groupId?: string;
	toolType: ToolType;
	explicit: GroupDefaultsCreateFields;
	seed?: boolean;
}): Promise<GroupSeededCreate> {
	const group =
		request.seed === false
			? undefined
			: seedableGroup(request.groupId, useSessionStore.getState().groups);
	if (!group?.defaults) {
		return { seededFromGroup: null, fields: request.explicit, extras: {}, skipped: [] };
	}

	const endpoints = useSettingsStore.getState().localModelEndpoints ?? [];
	const resolved = resolveGroupDefaultsSeed(group.defaults, {
		sshRemoteIds: group.defaults.sessionSshRemoteConfig?.enabled
			? await readSshRemoteIds()
			: undefined,
		endpoints,
	});
	const fields = groupDefaultsCreateFields(resolved.seed, request.toolType, request.explicit);
	// Judged against the agent as it will be, not as the seed had it: an explicit
	// provider, remote or gateway decides what the new agent can take.
	const { extras, skipped } = groupDefaultsCreateExtras(
		resolved.seed,
		{
			toolType: request.toolType,
			customEnvVars: fields.customEnvVars,
			gatewayUrl: fields.gatewayUrl,
			sessionSshRemoteConfig: fields.sessionSshRemoteConfig,
		},
		{ endpoints }
	);

	const notes = [...resolved.skipped, ...skipped].map((skip) => `${skip.label}: ${skip.reason}`);
	if (resolved.sshRemoteMissing) {
		notes.push(
			`${groupDefaultLabel('sessionSshRemoteConfig')}: the remote saved in the group no longer exists, so the agent runs on this machine.`
		);
	}
	return { seededFromGroup: group.id, fields, extras, skipped: notes };
}
