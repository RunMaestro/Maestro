/**
 * Quick Chat domain WebSocket message handler.
 *
 * Handles `quick_chat` - the CLI half of the Quick Chat window (`maestro-cli
 * quick-chat`). One message carrying an `action`, answered by the same
 * controller functions the window's own buttons call.
 */

import { getQuickChatController } from '../../../quick-chat';
import type { QuickChatCommand } from '../../../../shared/quickChat';
import { logger } from '../../../utils/logger';
import { LOG_CONTEXT } from './shared';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/** Map a CLI action onto an engine command; null for window actions and status. */
function toEngineCommand(message: WebClientMessage): QuickChatCommand | { error: string } | null {
	switch (message.action) {
		case 'send': {
			const text = typeof message.text === 'string' ? message.text : '';
			if (!text.trim()) return { error: 'Message cannot be empty' };
			return { type: 'send', text };
		}
		case 'new':
			return { type: 'new' };
		case 'keep':
			return { type: 'setPersistent', persistent: message.persistent !== false };
		case 'agent': {
			const agentId = typeof message.agentId === 'string' ? message.agentId : '';
			if (!agentId) return { error: 'Agent id is required' };
			return { type: 'setAgent', agentId };
		}
		case 'reveal':
			return { type: 'reveal' };
		case 'stop':
			return { type: 'stop' };
		default:
			return null;
	}
}

export function handleQuickChat(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const reply = (payload: Record<string, unknown>) => {
		ctx.send(client, { type: 'quick_chat_result', ...payload, requestId: message.requestId });
	};

	const controller = getQuickChatController();
	if (!controller) {
		reply({ success: false, error: 'Quick Chat is not available' });
		return;
	}

	const action = typeof message.action === 'string' ? message.action : '';
	logger.info(`[Web] Received quick_chat: action=${action}`, LOG_CONTEXT);

	if (action === 'status') {
		reply({ success: true, status: controller.getStatus() });
		return;
	}
	if (action === 'show' || action === 'hide' || action === 'toggle') {
		const status = controller.windowAction(action);
		if (!status.enabled && action !== 'hide') {
			reply({ success: false, error: 'Quick Chat is turned off in Encore Features', status });
			return;
		}
		reply({ success: true, status });
		return;
	}

	const command = toEngineCommand(message);
	if (!command) {
		reply({ success: false, error: `Unknown Quick Chat action: ${action || '(none)'}` });
		return;
	}
	if ('error' in command) {
		reply({ success: false, error: command.error });
		return;
	}

	controller
		.runCommand(command)
		.then((result) =>
			reply({
				success: result.ok,
				...(result.error ? { error: result.error } : {}),
				status: controller.getStatus(),
			})
		)
		.catch((error) => {
			const detail = error instanceof Error ? error.message : String(error);
			reply({ success: false, error: `Quick Chat ${action} failed: ${detail}` });
		});
}
