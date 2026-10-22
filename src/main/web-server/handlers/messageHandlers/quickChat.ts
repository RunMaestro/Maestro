/**
 * Quick Chat domain WebSocket message handler.
 *
 * Handles `quick_chat` - the CLI half of the Quick Chat window (`maestro-cli
 * quick-chat`). One message carrying an `action`, answered by the same
 * controller functions the window's own buttons call.
 */

import { getQuickChatController } from '../../../quick-chat';
import {
	parseQuickChatFontScaleRequest,
	parseQuickChatImages,
	parseQuickChatTabChoice,
	validateQuickChatBoundsRequest,
	type QuickChatBoundsRequest,
	type QuickChatCommand,
} from '../../../../shared/quickChat';
import { asThinkingMode } from '../../../../shared/types';
import { logger } from '../../../utils/logger';
import { LOG_CONTEXT } from './shared';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/** The message a command is about, when the caller named one. */
function messageIdOf(message: WebClientMessage): { messageId?: string } {
	return typeof message.messageId === 'string' && message.messageId
		? { messageId: message.messageId }
		: {};
}

/** Map a CLI action onto an engine command; null for window actions and status. */
function toEngineCommand(message: WebClientMessage): QuickChatCommand | { error: string } | null {
	switch (message.action) {
		case 'send': {
			const text = typeof message.text === 'string' ? message.text : '';
			const images = parseQuickChatImages(message.images);
			if (!images) return { error: 'Images must be data:image URLs' };
			if (!text.trim() && images.length === 0) return { error: 'Message cannot be empty' };
			return { type: 'send', text, ...(images.length > 0 && { images }) };
		}
		case 'new':
			return { type: 'new' };
		case 'keep':
			return { type: 'setPersistent', persistent: message.persistent !== false };
		case 'tab': {
			const choice = parseQuickChatTabChoice(message.tab);
			if (!choice) return { error: 'Give a tab id, new, or auto' };
			return { type: 'setTab', choice };
		}
		case 'thinking': {
			// `mode` is shared with other messages, which give it other values.
			const raw: unknown = message.mode;
			const mode = raw === 'cycle' ? 'cycle' : asThinkingMode(raw);
			if (!mode) return { error: 'Thinking mode must be off, on, sticky, or cycle' };
			return { type: 'setThinking', mode };
		}
		case 'agent': {
			const agentId = typeof message.agentId === 'string' ? message.agentId : '';
			if (!agentId) return { error: 'Agent id is required' };
			return { type: 'setAgent', agentId };
		}
		case 'reveal':
			return { type: 'reveal', ...messageIdOf(message) };
		case 'stop':
			return { type: 'stop' };
		case 'new-tab':
			return { type: 'moveToNewTab', ...messageIdOf(message) };
		case 'steer':
			return { type: 'steer', ...messageIdOf(message) };
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
	if (action === 'show' || action === 'hide' || action === 'toggle' || action === 'return') {
		const status = controller.windowAction(action);
		if (!status.enabled && action !== 'hide' && action !== 'return') {
			reply({ success: false, error: 'Quick Chat is turned off in Encore Features', status });
			return;
		}
		reply({ success: true, status });
		return;
	}

	if (action === 'bounds') {
		const request: QuickChatBoundsRequest = {};
		for (const key of ['x', 'y', 'width', 'height'] as const) {
			if (message[key] !== undefined) request[key] = message[key] as number;
		}
		const invalid = validateQuickChatBoundsRequest(request);
		if (invalid) {
			reply({ success: false, error: invalid });
			return;
		}
		reply({ success: true, status: controller.setBounds(request) });
		return;
	}

	if (action === 'pin') {
		reply({ success: true, status: controller.setPinned(message.pinned !== false) });
		return;
	}

	if (action === 'font') {
		// No request reads the current zoom; a malformed one is an error, not a no-op.
		if (message.fontScale === undefined) {
			reply({ success: true, status: controller.getStatus() });
			return;
		}
		const request = parseQuickChatFontScaleRequest(message.fontScale);
		if (!request) {
			reply({ success: false, error: 'Invalid text zoom request' });
			return;
		}
		reply({ success: true, status: controller.setFontScale(request) });
		return;
	}

	if (action === 'history') {
		reply({ success: true, recents: controller.getRecents(), status: controller.getStatus() });
		return;
	}

	if (action === 'recall') {
		const ref = typeof message.chatId === 'string' ? message.chatId : '';
		controller
			.recall(ref)
			.then((result) =>
				reply({
					success: result.ok,
					...(result.error ? { error: result.error } : {}),
					status: controller.getStatus(),
				})
			)
			.catch((error) => {
				const detail = error instanceof Error ? error.message : String(error);
				reply({ success: false, error: `Quick Chat recall failed: ${detail}` });
			});
		return;
	}

	// No mode (or tab) reads the current one, like a bare `font`.
	if (
		(action === 'thinking' && message.mode === undefined) ||
		(action === 'tab' && message.tab === undefined)
	) {
		reply({ success: true, status: controller.getStatus() });
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
