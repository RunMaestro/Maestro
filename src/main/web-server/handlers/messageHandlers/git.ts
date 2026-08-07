/**
 * Git domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: get_git_status, get_git_diff,
 * get_git_branches, list_worktrees.
 */

import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/**
 * Handle get_git_status message - fetch git status for a session
 */
export function handleGetGitStatus(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;

	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}

	if (!ctx.callbacks.getGitStatus) {
		ctx.sendError(client, 'Git status not configured');
		return;
	}

	ctx.callbacks
		.getGitStatus(sessionId)
		.then((status) => {
			ctx.send(client, {
				type: 'git_status',
				sessionId,
				status,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to get git status: ${error.message}`);
		});
}

/**
 * Handle get_git_diff message - fetch git diff for a session
 */
export function handleGetGitDiff(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	const filePath = message.filePath as string | undefined;

	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}

	if (!ctx.callbacks.getGitDiff) {
		ctx.sendError(client, 'Git diff not configured');
		return;
	}

	ctx.callbacks
		.getGitDiff(sessionId, filePath)
		.then((diff) => {
			ctx.send(client, {
				type: 'git_diff',
				sessionId,
				diff,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to get git diff: ${error.message}`);
		});
}

/**
 * Handle get_git_branches message - list local + remote branches for a session's
 * cwd, used by the mobile Run-in-Worktree base-branch picker.
 */
export function handleGetGitBranches(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;

	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}

	if (!ctx.callbacks.getGitBranchesForSession) {
		ctx.sendError(client, 'Git branches not configured');
		return;
	}

	ctx.callbacks
		.getGitBranchesForSession(sessionId)
		.then((result) => {
			ctx.send(client, {
				type: 'git_branches',
				sessionId,
				branches: result.branches,
				currentBranch: result.currentBranch,
				requestId: message.requestId,
			});
		})
		.catch((error: unknown) => {
			ctx.reportHandlerError(
				client,
				error,
				'get_git_branches',
				{ sessionId, requestId: message.requestId },
				'Failed to get git branches'
			);
		});
}

/**
 * Handle list_worktrees message - list existing worktrees for a session's cwd,
 * used by mobile Run-in-Worktree to offer "use existing" alongside "create new".
 */
export function handleListWorktrees(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;

	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}

	if (!ctx.callbacks.listWorktreesForSession) {
		ctx.sendError(client, 'List worktrees not configured');
		return;
	}

	ctx.callbacks
		.listWorktreesForSession(sessionId)
		.then((result) => {
			ctx.send(client, {
				type: 'worktrees_list',
				sessionId,
				worktrees: result.worktrees,
				requestId: message.requestId,
			});
		})
		.catch((error: unknown) => {
			ctx.reportHandlerError(
				client,
				error,
				'list_worktrees',
				{ sessionId, requestId: message.requestId },
				'Failed to list worktrees'
			);
		});
}
