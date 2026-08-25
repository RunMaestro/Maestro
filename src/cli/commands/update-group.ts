// Update group command - change a group's name, appearance, or parent in the
// running desktop app via the update_group WS message.
//
// `rename-group` stays as-is for backward compatibility; this is the verb that
// covers everything the Left Bar's group editor can do, so a bootstrap script
// can reproduce a workspace's group structure and appearance without anyone
// clicking through the UI.

import { resolveGroupId } from '../services/storage';
import { sendSimpleCommand, failCommand } from '../services/session-command';
import { verifyPersistedGroup, describePersistedGroup } from '../services/group-appearance';
import { validateGroupUpdate, type GroupClearableField } from '../../shared/groupAppearance';
import { formatSuccess } from '../output/formatter';
import { isQuiet } from '../output/verbosity';

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

export async function updateGroup(groupId: string, options: UpdateGroupOptions): Promise<void> {
	let resolvedGroupId: string;
	try {
		resolvedGroupId = resolveGroupId(groupId);
	} catch (error) {
		return failCommand(error instanceof Error ? error.message : String(error), options.json);
	}

	const clear: GroupClearableField[] = [];
	if (options.clearEmoji) clear.push('emoji');
	if (options.clearIcon) clear.push('icon');
	if (options.clearColor) clear.push('color');
	if (options.clearParent) clear.push('parent');

	let parentGroupId: string | undefined;
	if (options.parent) {
		try {
			parentGroupId = resolveGroupId(options.parent);
		} catch (error) {
			return failCommand(error instanceof Error ? error.message : String(error), options.json);
		}
	}

	// Validate the whole request up front. The desktop validates again at the WS
	// boundary (other clients speak the same protocol), but failing here means a
	// bad flag never reaches the app at all, so there is nothing to half-apply.
	const validated = validateGroupUpdate({
		...(options.name !== undefined ? { name: options.name } : {}),
		...(options.emoji !== undefined ? { emoji: options.emoji } : {}),
		...(options.icon !== undefined ? { icon: options.icon } : {}),
		...(options.color !== undefined ? { color: options.color } : {}),
		...(parentGroupId ? { parentGroupId } : {}),
		...(clear.length > 0 ? { clear } : {}),
	});
	if (!validated.ok) {
		return failCommand(validated.error, options.json);
	}

	let result;
	try {
		result = await sendSimpleCommand(
			{ type: 'update_group', groupId: resolvedGroupId, ...validated.value },
			'update_group_result'
		);
	} catch (error) {
		return failCommand(error instanceof Error ? error.message : String(error), options.json);
	}

	if (!result.success) {
		return failCommand(String(result.error || 'Failed to update group'), options.json);
	}

	const mismatch = verifyPersistedGroup(resolvedGroupId, {
		name: validated.value.name,
		emoji: validated.value.emoji,
		icon: validated.value.icon,
		color: validated.value.color,
		parentGroupId: validated.value.parentGroupId,
		cleared: clear,
	});
	if (mismatch) {
		return failCommand(mismatch, options.json);
	}

	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				groupId: resolvedGroupId,
				group: describePersistedGroup(resolvedGroupId),
			})
		);
		return;
	}
	if (isQuiet()) return;
	console.log(formatSuccess(`Updated group ${resolvedGroupId}`));
}
