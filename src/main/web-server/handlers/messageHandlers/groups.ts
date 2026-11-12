/**
 * Groups domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: get_groups, create_group,
 * rename_group, delete_group, move_session_to_group.
 */

import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';
import {
	isGroupClearableField,
	validateGroupAppearance,
	validateGroupUpdate,
	type GroupClearableField,
	type GroupUpdateRequest,
} from '../../../../shared/groupAppearance';

/** Read an optional string field, rejecting a present-but-wrong-typed value. */
function optionalString(
	message: WebClientMessage,
	key: string
): { ok: true; value?: string } | { ok: false } {
	const raw = (message as Record<string, unknown>)[key];
	if (raw === undefined) return { ok: true };
	if (typeof raw !== 'string') return { ok: false };
	return { ok: true, value: raw };
}

/**
 * Handle get_groups message - return list of groups
 */
export function handleGetGroups(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	if (!ctx.callbacks.getGroups) {
		ctx.sendError(client, 'Groups not configured');
		return;
	}

	const groups = ctx.callbacks.getGroups();
	ctx.send(client, {
		type: 'groups_list',
		groups,
		requestId: message.requestId,
	});
}

/**
 * Handle create_group message - create a new group
 */
export function handleCreateGroup(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const name = message.name as string;
	const requestedParentGroupId = message.parentGroupId;

	if (
		requestedParentGroupId !== undefined &&
		(typeof requestedParentGroupId !== 'string' || !requestedParentGroupId.trim())
	) {
		ctx.sendError(client, 'Invalid parentGroupId');
		return;
	}

	const parentGroupId = requestedParentGroupId?.trim();

	if (!name || typeof name !== 'string') {
		ctx.sendError(client, 'Missing or invalid group name');
		return;
	}

	const emojiField = optionalString(message, 'emoji');
	const iconField = optionalString(message, 'icon');
	const colorField = optionalString(message, 'color');
	if (!emojiField.ok || !iconField.ok || !colorField.ok) {
		ctx.sendError(client, 'Invalid group appearance');
		return;
	}

	// Validate at the WebSocket boundary, not just in the CLI: every client
	// speaking this protocol reaches the same renderer state, so an unvalidated
	// direct socket write would persist an icon id the picker cannot draw.
	const appearance = validateGroupAppearance({
		emoji: emojiField.value,
		icon: iconField.value,
		color: colorField.value,
	});
	if (!appearance.ok) {
		ctx.sendError(client, appearance.error);
		return;
	}

	if (!ctx.callbacks.createGroup) {
		ctx.sendError(client, 'Group creation not configured');
		return;
	}

	ctx.callbacks
		.createGroup(name, appearance.value.emoji, parentGroupId, appearance.value)
		.then((result) => {
			ctx.send(client, {
				type: 'create_group_result',
				success: !!result,
				groupId: result?.id,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to create group: ${error.message}`);
		});
}

/**
 * Handle rename_group message - rename a group
 */
export function handleRenameGroup(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const groupId = message.groupId as string;
	const name = message.name as string;

	if (!groupId) {
		ctx.sendError(client, 'Missing groupId');
		return;
	}

	if (!name || typeof name !== 'string') {
		ctx.sendError(client, 'Missing or invalid group name');
		return;
	}

	if (!ctx.callbacks.renameGroup) {
		ctx.sendError(client, 'Group renaming not configured');
		return;
	}

	ctx.callbacks
		.renameGroup(groupId, name)
		.then((success) => {
			ctx.send(client, {
				type: 'rename_group_result',
				success,
				groupId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to rename group: ${error.message}`);
		});
}

/**
 * Handle update_group message - change a group's name, appearance, or parent.
 *
 * Everything is validated here, before the renderer is asked to mutate
 * anything, so a request carrying one bad field cannot half-apply. The renderer
 * still rejects a reparent that would break the one-level nesting rule, because
 * only it holds the group list.
 */
export function handleUpdateGroup(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const groupId = message.groupId as string;

	if (!groupId || typeof groupId !== 'string') {
		ctx.sendError(client, 'Missing groupId');
		return;
	}

	const fields = ['name', 'emoji', 'icon', 'color', 'parentGroupId'] as const;
	const request: GroupUpdateRequest = {};
	for (const field of fields) {
		const read = optionalString(message, field);
		if (!read.ok) {
			ctx.sendError(client, `Invalid ${field}`);
			return;
		}
		if (read.value !== undefined) request[field] = read.value;
	}

	const rawClear = (message as Record<string, unknown>).clear;
	if (rawClear !== undefined) {
		if (!Array.isArray(rawClear) || !rawClear.every(isGroupClearableField)) {
			ctx.sendError(client, 'Invalid clear list');
			return;
		}
		request.clear = rawClear as GroupClearableField[];
	}

	const validated = validateGroupUpdate(request);
	if (!validated.ok) {
		ctx.sendError(client, validated.error);
		return;
	}

	if (!ctx.callbacks.updateGroup) {
		ctx.sendError(client, 'Group updating not configured');
		return;
	}

	ctx.callbacks
		.updateGroup(groupId, validated.value)
		.then((success) => {
			ctx.send(client, {
				type: 'update_group_result',
				success,
				groupId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to update group: ${error.message}`);
		});
}

/**
 * Handle delete_group message - delete a group
 */
export function handleDeleteGroup(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const groupId = message.groupId as string;

	if (!groupId) {
		ctx.sendError(client, 'Missing groupId');
		return;
	}

	if (!ctx.callbacks.deleteGroup) {
		ctx.sendError(client, 'Group deletion not configured');
		return;
	}

	ctx.callbacks
		.deleteGroup(groupId)
		.then((success) => {
			ctx.send(client, {
				type: 'delete_group_result',
				success,
				groupId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to delete group: ${error.message}`);
		});
}

/**
 * Handle move_session_to_group message - move a session to a group (or ungrouped)
 */
export function handleMoveSessionToGroup(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	const groupId = message.groupId as string | null;

	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}

	// groupId can be null (for ungrouped), but must be present in message
	if (!('groupId' in message)) {
		ctx.sendError(client, 'Missing groupId (use null for ungrouped)');
		return;
	}

	if (!ctx.callbacks.moveSessionToGroup) {
		ctx.sendError(client, 'Move to group not configured');
		return;
	}

	ctx.callbacks
		.moveSessionToGroup(sessionId, groupId)
		.then((success) => {
			ctx.send(client, {
				type: 'move_session_to_group_result',
				success,
				sessionId,
				groupId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to move session to group: ${error.message}`);
		});
}
