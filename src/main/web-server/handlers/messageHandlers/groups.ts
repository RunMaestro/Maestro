/**
 * Groups domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: get_groups, create_group,
 * rename_group, delete_group, move_session_to_group.
 */

import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

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
	const emoji = message.emoji as string | undefined;
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

	if (!ctx.callbacks.createGroup) {
		ctx.sendError(client, 'Group creation not configured');
		return;
	}

	ctx.callbacks
		.createGroup(name, emoji, parentGroupId)
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
