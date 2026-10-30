/**
 * Context Ops domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: merge_context,
 * transfer_context, summarize_context, create_gist.
 */

import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';
import {
	TAB_CONTEXT_OP_MESSAGES,
	parseTabContextOpMessage,
	type TabContextOp,
	type TabContextOpResult,
} from '../../../../shared/tabContextOps';

/**
 * Shared body of the three context messages: validate, forward to the
 * renderer that owns the source agent, and ALWAYS answer with the typed
 * `*_result` (never a bare `error` frame), so a waiting client is never left
 * to its own timeout.
 */
function handleTabContextOp(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage,
	op: TabContextOp
): void {
	const reply = (result: TabContextOpResult) => {
		ctx.send(client, {
			type: TAB_CONTEXT_OP_MESSAGES[op].resultType,
			...result,
			requestId: message.requestId,
			timestamp: Date.now(),
		});
	};

	const parsed = parseTabContextOpMessage(op, message as Record<string, unknown>);
	if (!parsed.ok) {
		reply({ success: false, error: parsed.error });
		return;
	}

	if (!ctx.callbacks.tabContextOp) {
		reply({ success: false, error: 'Context operations not configured' });
		return;
	}

	ctx.callbacks
		.tabContextOp(parsed.request)
		.then(reply)
		.catch((error: unknown) => {
			const msg = error instanceof Error ? error.message : String(error);
			reply({ success: false, error: `Context ${op} failed: ${msg}` });
		});
}

/** Handle merge_context - Context: Merge Into from the AI tab overlay menu. */
export function handleMergeContext(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	handleTabContextOp(ctx, client, message, 'merge');
}

/** Handle transfer_context - Context: Send to Agent from the AI tab overlay menu. */
export function handleTransferContext(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	handleTabContextOp(ctx, client, message, 'transfer');
}

/** Handle summarize_context - Context: Compact from the AI tab overlay menu. */
export function handleSummarizeContext(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	handleTabContextOp(ctx, client, message, 'compact');
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
