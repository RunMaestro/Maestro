// Update group settings command - write a group's Group Settings profile (the
// defaults a new agent starts with) and its pill label in the running desktop
// app, through the `update_group_settings` WS message.
//
// The flags are the ones `update-agent` takes, read by the same reader
// (`services/agent-setting-flags.ts`, `services/peer-flags.ts`), and applied by
// the app with the validator the Group Settings dialog saves with.
//
// Profile only is the default: nothing already in the group changes, which is
// the safe half of the dialog's choice. `--publish` also writes THIS call's
// change into the agents already in the group, by the same rules the dialog's
// "Update N agents" button uses. A publish has no undo on the CLI (the app
// raises its Undo toast), so it asks first, or needs `--yes`.

import { getSessionsByGroup, readGroups, resolveGroupId } from '../services/storage';
import {
	describeGroupSettings,
	groupSettingsBlocker,
	readGroupSettingsFlags,
	verifyPersistedGroupSettings,
	type GroupSettingsFlagOptions,
} from '../services/group-settings';
import {
	errorFrameMessage,
	failCommand,
	sendSimpleCommand,
	failFromError,
} from '../services/session-command';
import { formatGroupSettingsUpdate } from '../output/formatter';
import { isQuiet } from '../output/verbosity';
import { canPrompt, confirmOnTerminal } from '../utils/confirm';
import type { GroupSettingsUpdateResult } from '../../shared/groupSettingsUpdate';

interface UpdateGroupSettingsOptions extends GroupSettingsFlagOptions {
	yes?: boolean;
	json?: boolean;
}

export async function updateGroupSettings(
	groupId: string,
	options: UpdateGroupSettingsOptions
): Promise<void> {
	let resolvedGroupId: string;
	try {
		resolvedGroupId = resolveGroupId(groupId);
	} catch (error) {
		return failFromError(error, options.json);
	}
	const group = readGroups().find((candidate) => candidate.id === resolvedGroupId);
	if (!group) return failCommand(`Group not found: ${groupId}`, options.json);

	const blocker = groupSettingsBlocker(group);
	if (blocker) return failCommand(blocker, options.json);

	// Everything that can be refused without the app is refused before it is asked.
	let request;
	try {
		request = readGroupSettingsFlags(options, group);
	} catch (error) {
		return failFromError(error, options.json);
	}

	if (request.publish) {
		const members = getSessionsByGroup(resolvedGroupId);
		if (members.length > 0 && !options.yes) {
			const what = `--publish writes this change into ${members.length} ${
				members.length === 1 ? 'agent' : 'agents'
			} already in "${group.name}". The CLI cannot undo it (the app raises an Undo toast).`;
			if (!canPrompt()) {
				return failCommand(`${what} Re-run with --yes to confirm.`, options.json);
			}
			if (!(await confirmOnTerminal(`${what} Continue?`))) {
				return failCommand('Cancelled. Nothing was written.', options.json);
			}
		}
	}

	let result: GroupSettingsUpdateResult;
	try {
		result = (await sendSimpleCommand(
			{ type: 'update_group_settings', groupId: resolvedGroupId, ...request },
			'update_group_settings_result'
		)) as unknown as GroupSettingsUpdateResult;
	} catch (error) {
		return failFromError(error, options.json);
	}
	if (!result.success) {
		return failCommand(
			result.error || errorFrameMessage(result) || 'Failed to update group settings',
			options.json
		);
	}

	const mismatch = verifyPersistedGroupSettings(resolvedGroupId, {
		defaults: result.defaults ?? null,
		shortLabel: result.shortLabel ?? null,
	});
	if (mismatch) return failCommand(mismatch, options.json);

	const stored = readGroups().find((candidate) => candidate.id === resolvedGroupId) ?? group;
	const report = describeGroupSettings(stored);
	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				groupId: resolvedGroupId,
				group: report,
				changed: result.changed ?? [],
				...(result.publish ? { publish: result.publish } : {}),
			})
		);
		return;
	}
	if (isQuiet()) return;
	console.log(formatGroupSettingsUpdate(report, result.changed ?? [], result.publish));
}
