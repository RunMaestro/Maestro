// Remove group command - delete a group from the Maestro desktop app.
//
// Deleting a group never deletes the agents inside it; the desktop ungroups
// any members (clears their groupId) and then removes the group. To guard
// against accidentally scattering a populated group from the command line,
// this refuses a non-empty group unless `--force` is passed.

import { withMaestroClient } from '../services/maestro-client';
import { resolveGroupId, getSessionsByGroup, readGroups } from '../services/storage';
import { formatError, formatSuccess } from '../output/formatter';

interface RemoveGroupOptions {
	force?: boolean;
	json?: boolean;
}

function emitError(message: string, options: RemoveGroupOptions): never {
	if (options.json) {
		console.log(JSON.stringify({ success: false, error: message }));
	} else {
		console.error(formatError(message));
	}
	return process.exit(1);
}

export async function removeGroup(groupId: string, options: RemoveGroupOptions): Promise<void> {
	// Resolve group ID (supports partial match)
	let resolvedGroupId: string;
	try {
		resolvedGroupId = resolveGroupId(groupId);
	} catch (error) {
		emitError(error instanceof Error ? error.message : String(error), options);
	}

	// Capture the name before deletion so we can report it afterward.
	const groupName = readGroups().find((g) => g.id === resolvedGroupId)?.name;

	// Guard: refuse to scatter a populated group unless --force
	const members = getSessionsByGroup(resolvedGroupId);
	if (members.length > 0 && !options.force) {
		emitError(
			`Group "${resolvedGroupId}" has ${members.length} agent(s). Move them out first, or pass --force to ungroup and delete.`,
			options
		);
	}

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<{
				type: string;
				success: boolean;
				groupId?: string;
				error?: string;
			}>(
				{
					type: 'delete_group',
					groupId: resolvedGroupId,
				},
				'delete_group_result'
			);
		});

		if (result.success) {
			if (options.json) {
				console.log(
					JSON.stringify({ success: true, groupId: resolvedGroupId, ungrouped: members.length })
				);
			} else {
				console.log(
					formatSuccess(`Removed group ${groupName ? `"${groupName}" ` : ''}${resolvedGroupId}`)
				);
				if (members.length > 0) {
					console.log(`  Ungrouped ${members.length} agent(s)`);
				}
			}
		} else {
			emitError(result.error || 'Failed to remove group', options);
		}
	} catch (error) {
		emitError(error instanceof Error ? error.message : String(error), options);
	}
}
