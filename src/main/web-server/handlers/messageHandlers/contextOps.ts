/**
 * Context Ops domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: merge_context,
 * transfer_context, summarize_context, create_gist.
 */

import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/**
 * Handle merge_context message - merge context from source to target session
 */
export function handleMergeContext(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sourceSessionId = message.sourceSessionId as string;
	const targetSessionId = message.targetSessionId as string;

	if (!sourceSessionId || !targetSessionId) {
		ctx.sendError(client, 'Missing sourceSessionId or targetSessionId');
		return;
	}

	if (sourceSessionId === targetSessionId) {
		ctx.sendError(client, 'Source and target sessions must be different');
		return;
	}

	if (!ctx.callbacks.mergeContext) {
		ctx.sendError(client, 'Context merge not configured');
		return;
	}

	ctx.callbacks
		.mergeContext(sourceSessionId, targetSessionId)
		.then((success) => {
			ctx.send(client, {
				type: 'merge_context_result',
				success,
				requestId: message.requestId,
				timestamp: Date.now(),
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to merge context: ${error.message}`);
		});
}

/**
 * Handle transfer_context message - transfer context from source to target session
 */
export function handleTransferContext(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sourceSessionId = message.sourceSessionId as string;
	const targetSessionId = message.targetSessionId as string;

	if (!sourceSessionId || !targetSessionId) {
		ctx.sendError(client, 'Missing sourceSessionId or targetSessionId');
		return;
	}

	if (sourceSessionId === targetSessionId) {
		ctx.sendError(client, 'Source and target sessions must be different');
		return;
	}

	if (!ctx.callbacks.transferContext) {
		ctx.sendError(client, 'Context transfer not configured');
		return;
	}

	ctx.callbacks
		.transferContext(sourceSessionId, targetSessionId)
		.then((success) => {
			ctx.send(client, {
				type: 'transfer_context_result',
				success,
				requestId: message.requestId,
				timestamp: Date.now(),
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to transfer context: ${error.message}`);
		});
}

/**
 * Handle summarize_context message - summarize context for a session
 */
export function handleSummarizeContext(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;

	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}

	if (!ctx.callbacks.summarizeContext) {
		ctx.sendError(client, 'Context summarize not configured');
		return;
	}

	ctx.callbacks
		.summarizeContext(sessionId)
		.then((success) => {
			ctx.send(client, {
				type: 'summarize_context_result',
				success,
				requestId: message.requestId,
				timestamp: Date.now(),
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to summarize context: ${error.message}`);
		});
}

/**
 * Handle create_gist message - publish a session's transcript to a GitHub gist.
 * Always replies with `create_gist_result` (even on failure) so waiting
 * clients don't hang until their request timeout.
 */
export function handleCreateGist(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const reply = (result: { success: boolean; gistUrl?: string; error?: string }) => {
		ctx.send(client, {
			type: 'create_gist_result',
			...result,
			requestId: message.requestId,
		});
	};

	const sessionId = message.sessionId;
	if (typeof sessionId !== 'string' || !sessionId) {
		reply({ success: false, error: 'Missing sessionId' });
		return;
	}

	// Strict validation - avoid truthy coercion so a string like "false"
	// cannot flip a private gist to public.
	if (message.description !== undefined && typeof message.description !== 'string') {
		reply({ success: false, error: 'description must be a string when provided' });
		return;
	}
	if (message.isPublic !== undefined && typeof message.isPublic !== 'boolean') {
		reply({ success: false, error: 'isPublic must be a boolean when provided' });
		return;
	}
	// `agentSessionId` narrows the publish to one provider session (a headless
	// `send -s <id>` conversation) instead of the agent's open AI tabs. Reject a
	// blank string rather than treating it as absent: silently falling back to
	// the tabs is how a caller aiming at one conversation publishes another.
	const rawAgentSessionId = message.agentSessionId;
	let agentSessionId: string | undefined;
	if (rawAgentSessionId !== undefined) {
		if (typeof rawAgentSessionId !== 'string' || !rawAgentSessionId) {
			reply({
				success: false,
				error: 'agentSessionId must be a non-empty string when provided',
			});
			return;
		}
		agentSessionId = rawAgentSessionId;
	}
	const description = message.description ?? '';
	const isPublic = message.isPublic ?? false;

	if (!ctx.callbacks.createGist) {
		reply({ success: false, error: 'Gist creation not configured' });
		return;
	}

	ctx.callbacks
		.createGist(sessionId, description, isPublic, agentSessionId)
		.then((result) => {
			reply(result);
		})
		.catch((error: unknown) => {
			const msg = error instanceof Error ? error.message : String(error);
			reply({ success: false, error: `Failed to create gist: ${msg}` });
		});
}
