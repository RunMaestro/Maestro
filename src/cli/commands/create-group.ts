// Create group command - create a new group in the Maestro desktop app

import { withMaestroClient } from '../services/maestro-client';
import { formatSuccess } from '../output/formatter';
import { writeCommandError } from '../output/command-error';

interface CreateGroupOptions {
	emoji?: string;
	parent?: string;
	json?: boolean;
}

export async function createGroup(name: string, options: CreateGroupOptions): Promise<void> {
	if (!name || !name.trim()) {
		const msg = 'Group name must not be empty';
		writeCommandError(options.json, msg);
		process.exit(1);
	}

	// Build the WebSocket message payload
	const payload: Record<string, unknown> = {
		type: 'create_group',
		name,
	};
	if (options.emoji) payload.emoji = options.emoji;
	if (options.parent) payload.parentGroupId = options.parent;

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<{
				type: string;
				success: boolean;
				groupId?: string;
				error?: string;
			}>(payload, 'create_group_result');
		});

		if (result.success) {
			if (options.json) {
				console.log(JSON.stringify({ success: true, groupId: result.groupId, name }));
			} else {
				console.log(formatSuccess(`Created group "${name}"`));
				console.log(`  ID: ${result.groupId}`);
			}
		} else {
			const msg = result.error || 'Failed to create group';
			writeCommandError(options.json, msg);
			process.exit(1);
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		writeCommandError(options.json, msg);
		process.exit(1);
	}
}
