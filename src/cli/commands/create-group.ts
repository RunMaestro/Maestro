// Create group command - create a new group in the Maestro desktop app

import { resolveGroupId } from '../services/storage';
import { sendSimpleCommand, failCommand } from '../services/session-command';
import { verifyPersistedGroup, describePersistedGroup } from '../services/group-appearance';
import { validateGroupAppearance } from '../../shared/groupAppearance';
import { formatSuccess } from '../output/formatter';
import { isQuiet } from '../output/verbosity';

interface CreateGroupOptions {
	emoji?: string;
	icon?: string;
	color?: string;
	parent?: string;
	json?: boolean;
}

export async function createGroup(name: string, options: CreateGroupOptions): Promise<void> {
	if (!name || !name.trim()) {
		return failCommand('Group name must not be empty', options.json);
	}

	// Validate everything before the first byte goes over the wire, so a bad
	// color can never leave a half-configured group behind.
	const appearance = validateGroupAppearance({
		emoji: options.emoji,
		icon: options.icon,
		color: options.color,
	});
	if (!appearance.ok) {
		return failCommand(appearance.error, options.json);
	}

	const payload: Record<string, unknown> = { type: 'create_group', name };
	if (appearance.value.emoji) payload.emoji = appearance.value.emoji;
	if (appearance.value.icon) payload.icon = appearance.value.icon;
	if (appearance.value.color) payload.color = appearance.value.color;

	let parentGroupId: string | undefined;
	if (options.parent) {
		try {
			// Accept a partial group ID here for the same reason every other
			// group verb does - a caller pasting a prefix should not get a
			// generic "failed to create group" from the desktop.
			parentGroupId = resolveGroupId(options.parent);
		} catch (error) {
			return failCommand(error instanceof Error ? error.message : String(error), options.json);
		}
		payload.parentGroupId = parentGroupId;
	}

	let result;
	try {
		result = await sendSimpleCommand(payload, 'create_group_result');
	} catch (error) {
		return failCommand(error instanceof Error ? error.message : String(error), options.json);
	}

	if (!result.success || !result.groupId) {
		return failCommand(String(result.error || 'Failed to create group'), options.json);
	}

	const groupId = String(result.groupId);
	const mismatch = verifyPersistedGroup(groupId, {
		name,
		emoji: appearance.value.emoji,
		icon: appearance.value.icon,
		color: appearance.value.color,
		parentGroupId,
	});
	if (mismatch) {
		return failCommand(mismatch, options.json);
	}

	if (options.json) {
		console.log(JSON.stringify({ success: true, groupId, group: describePersistedGroup(groupId) }));
		return;
	}
	if (isQuiet()) return;
	console.log(formatSuccess(`Created group "${name}"`));
	console.log(`  ID: ${groupId}`);
}
