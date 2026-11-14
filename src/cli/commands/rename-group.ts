// Rename group command - change a group's name in the running desktop app via
// the rename_group WS message. Mirrors the Left Bar group "Rename" action.

import { resolveGroupId } from '../services/storage';
import {
	sendSimpleCommand,
	reportResult,
	failCommand,
	failFromError,
} from '../services/session-command';

interface RenameGroupOptions {
	json?: boolean;
}

export async function renameGroup(
	groupId: string,
	newName: string,
	options: RenameGroupOptions
): Promise<void> {
	const trimmed = (newName ?? '').trim();
	if (!trimmed) {
		failCommand('New name must not be empty', options.json);
	}

	let resolvedGroupId: string;
	try {
		resolvedGroupId = resolveGroupId(groupId);
	} catch (error) {
		failFromError(error, options.json);
	}

	try {
		const result = await sendSimpleCommand(
			{ type: 'rename_group', groupId: resolvedGroupId, name: trimmed },
			'rename_group_result'
		);
		reportResult(result, {
			json: options.json,
			successMessage: `Renamed group ${resolvedGroupId} to "${trimmed}"`,
			jsonExtra: { groupId: resolvedGroupId, name: trimmed },
		});
	} catch (error) {
		failFromError(error, options.json);
	}
}
