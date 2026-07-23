// Update group command - change a group's name, appearance (emoji/icon/color)
// and hierarchy (--parent) in the running desktop app via the update_group WS
// message. Clearing is explicit via --clear-* flags; clearing --parent promotes
// the group to the top level. Appearance is validated/normalized before sending
// so invalid input fails before any state change (no partial mutation).

import { withMaestroClient, UnsupportedCommandError } from '../services/maestro-client';
import { formatError, formatSuccess } from '../output/formatter';
import { resolveGroupId } from '../services/storage';
import { validateGroupAppearanceInput } from '../../shared/groupAppearance';
import type { GroupAppearanceEcho, GroupClearField } from '../../shared/types';

interface UpdateGroupOptions {
	name?: string;
	emoji?: string;
	icon?: string;
	color?: string;
	parent?: string;
	clearEmoji?: boolean;
	clearIcon?: boolean;
	clearColor?: boolean;
	clearParent?: boolean;
	json?: boolean;
}

interface UpdateGroupResult {
	type?: string;
	success: boolean;
	groupId?: string;
	group?: GroupAppearanceEcho;
	error?: string;
}

const VERSION_MISMATCH =
	'The running Maestro desktop app is too old to support group updates (update-group / icon / color). Update Maestro to use this command.';

function fail(msg: string, json?: boolean): never {
	if (json) {
		console.log(JSON.stringify({ success: false, error: msg }));
	} else {
		console.error(formatError(msg));
	}
	process.exit(1);
}

export async function updateGroup(groupId: string, options: UpdateGroupOptions): Promise<void> {
	let resolvedGroupId: string;
	try {
		resolvedGroupId = resolveGroupId(groupId);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error), options.json);
	}

	// Reject set + clear on the same field (ambiguous intent).
	if (options.emoji !== undefined && options.clearEmoji) {
		fail('Cannot combine --emoji with --clear-emoji', options.json);
	}
	if (options.icon !== undefined && options.clearIcon) {
		fail('Cannot combine --icon with --clear-icon', options.json);
	}
	if (options.color !== undefined && options.clearColor) {
		fail('Cannot combine --color with --clear-color', options.json);
	}
	if (options.parent !== undefined && options.clearParent) {
		fail('Cannot combine --parent with --clear-parent', options.json);
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

	const clear: GroupClearField[] = [];
	if (options.clearEmoji) clear.push('emoji');
	if (options.clearIcon) clear.push('icon');
	if (options.clearColor) clear.push('color');
	if (options.clearParent) clear.push('parent');

	// Resolve a requested parent (partial IDs allowed, same as the group ID).
	let resolvedParent: string | undefined;
	if (options.parent !== undefined) {
		if (!options.parent.trim()) {
			fail(
				'--parent requires a group ID (use --clear-parent to promote to top level)',
				options.json
			);
		}
		try {
			resolvedParent = resolveGroupId(options.parent);
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error), options.json);
		}
		if (resolvedParent === resolvedGroupId) {
			fail('A group cannot be its own parent', options.json);
		}
	}

	const trimmedName = options.name?.trim();
	if (options.name !== undefined && !trimmedName) {
		fail('New name must not be empty', options.json);
	}

	// Build the update payload.
	const payload: Record<string, unknown> = {
		type: 'update_group',
		groupId: resolvedGroupId,
	};
	if (trimmedName) payload.name = trimmedName;
	if (appearance.emoji !== undefined) payload.emoji = appearance.emoji;
	if (appearance.icon !== undefined) payload.icon = appearance.icon;
	if (appearance.color !== undefined) payload.color = appearance.color;
	if (resolvedParent !== undefined) payload.parentGroupId = resolvedParent;
	if (clear.length > 0) payload.clear = clear;

	const hasChange =
		trimmedName !== undefined ||
		appearance.emoji !== undefined ||
		appearance.icon !== undefined ||
		appearance.color !== undefined ||
		resolvedParent !== undefined ||
		clear.length > 0;
	if (!hasChange) {
		fail(
			'No updates specified. Pass --name/--emoji/--icon/--color/--parent or a --clear-* flag.',
			options.json
		);
	}

	const appearanceRequested = appearance.icon !== undefined || appearance.color !== undefined;

	let result: UpdateGroupResult;
	try {
		result = await withMaestroClient(async (client) => {
			return client.sendCommand<UpdateGroupResult>(payload, 'update_group_result');
		});
	} catch (error) {
		// A wholly unsupported command (older desktop) is echoed back unhandled.
		if (error instanceof UnsupportedCommandError) {
			fail(VERSION_MISMATCH, options.json);
		}
		fail(error instanceof Error ? error.message : String(error), options.json);
	}

	if (!result.success) {
		fail(result.error || 'Failed to update group', options.json);
	}

	// Defensive version-mismatch guard (older builds that partially handle the
	// message but drop the echo).
	if (appearanceRequested && !result.group) {
		fail(VERSION_MISMATCH, options.json);
	}

	const group = result.group;
	if (options.json) {
		console.log(JSON.stringify({ success: true, groupId: resolvedGroupId, group }));
	} else {
		console.log(formatSuccess(`Updated group ${resolvedGroupId}`));
		if (group?.name) console.log(`  Name: ${group.name}`);
		if (group?.icon) console.log(`  Icon: ${group.icon}`);
		if (group?.color) console.log(`  Color: ${group.color}`);
		if (group?.emoji && !group.icon) console.log(`  Emoji: ${group.emoji}`);
		console.log(`  Parent: ${group?.parentGroupId ?? '(top level)'}`);
	}
}
