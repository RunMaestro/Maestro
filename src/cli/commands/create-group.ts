// Create group command - create a new group in the Maestro desktop app.
// Supports appearance (emoji/icon/color) and hierarchy (--parent). Appearance
// flags are validated and normalized before anything is sent, and the running
// app echoes the effective persisted appearance so we can confirm it applied
// (and detect an older desktop that silently ignored icon/color).

import { withMaestroClient } from '../services/maestro-client';
import { formatError, formatSuccess } from '../output/formatter';
import { validateGroupAppearanceInput } from '../../shared/groupAppearance';
import type { GroupAppearanceEcho } from '../../shared/types';

interface CreateGroupOptions {
	emoji?: string;
	icon?: string;
	color?: string;
	parent?: string;
	json?: boolean;
}

interface CreateGroupResult {
	type?: string;
	success: boolean;
	groupId?: string;
	group?: GroupAppearanceEcho;
	error?: string;
}

const VERSION_MISMATCH =
	'The running Maestro desktop app is too old to apply group icon/color (it ignored the appearance fields). Update Maestro to use --icon/--color.';

function fail(msg: string, json?: boolean): never {
	if (json) {
		console.log(JSON.stringify({ success: false, error: msg }));
	} else {
		console.error(formatError(msg));
	}
	process.exit(1);
}

export async function createGroup(name: string, options: CreateGroupOptions): Promise<void> {
	if (!name || !name.trim()) {
		fail('Group name must not be empty', options.json);
	}

	const validation = validateGroupAppearanceInput({
		emoji: options.emoji,
		icon: options.icon,
		color: options.color,
	});
	if (!validation.ok) {
		fail(validation.error, options.json);
	}
	const appearance = validation.value;
	const appearanceRequested = appearance.icon !== undefined || appearance.color !== undefined;

	// Build the WebSocket message payload
	const payload: Record<string, unknown> = {
		type: 'create_group',
		name,
	};
	if (appearance.emoji !== undefined) payload.emoji = appearance.emoji;
	if (appearance.icon !== undefined) payload.icon = appearance.icon;
	if (appearance.color !== undefined) payload.color = appearance.color;
	if (options.parent) payload.parentGroupId = options.parent;

	let result: CreateGroupResult;
	try {
		result = await withMaestroClient(async (client) => {
			return client.sendCommand<CreateGroupResult>(payload, 'create_group_result');
		});
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error), options.json);
	}

	if (!result.success) {
		fail(result.error || 'Failed to create group', options.json);
	}

	// Version-mismatch guard: if we asked for icon/color the desktop must echo
	// the persisted appearance. An older build ignores unknown fields and
	// returns no group, so report a version mismatch instead of a false success.
	if (appearanceRequested && !result.group) {
		fail(VERSION_MISMATCH, options.json);
	}

	const group = result.group;
	if (options.json) {
		console.log(JSON.stringify({ success: true, groupId: result.groupId, name, group }));
	} else {
		console.log(formatSuccess(`Created group "${name}"`));
		console.log(`  ID: ${result.groupId}`);
		if (group?.icon) console.log(`  Icon: ${group.icon}`);
		if (group?.color) console.log(`  Color: ${group.color}`);
		if (group?.emoji && !group.icon) console.log(`  Emoji: ${group.emoji}`);
		if (group?.parentGroupId) console.log(`  Parent: ${group.parentGroupId}`);
	}
}
