/**
 * Prompt Links WebSocket message handler: `maestro-cli prompt-link`.
 *
 * Handles `prompt_link_command` (create / list / revoke). Every action calls
 * the same service the desktop's `promptLinks:*` IPC channels call, so the CLI
 * and the Prompt Links window cannot drift.
 *
 * CLI sockets only. The same server answers LAN and tunnel browsers, and none
 * of them may mint a link that outlives their connection, or read the stored
 * prompts. The IPC side is closed to them: no `promptLinks:*` channel is in the
 * bridge's method inventory (`isRemoteMethodAllowed()` in bridgeDenyList.ts).
 */

import { logger } from '../../../utils/logger';
import { createPromptLink, listPromptLinks, revokePromptLink } from '../../../prompt-links';
import { parsePromptLinkCommandRequest } from '../../../../shared/promptLinks';
import { LOG_CONTEXT } from './shared';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

export async function handlePromptLinkCommand(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const sendResult = (payload: Record<string, unknown>) => {
		ctx.send(client, {
			type: 'prompt_link_command_result',
			...payload,
			requestId: message.requestId,
		});
	};

	if (!client.cli) {
		logger.warn(`Refused prompt_link_command from non-CLI client ${client.id}`, LOG_CONTEXT);
		sendResult({
			success: false,
			error: 'Prompt links cannot be managed over the web interface',
		});
		return;
	}

	const parsed = parsePromptLinkCommandRequest(message as Record<string, unknown>);
	if (!parsed.ok) {
		sendResult({ success: false, error: parsed.error });
		return;
	}
	const request = parsed.request;
	logger.info(`[Web] Received prompt_link_command: action=${request.action}`, LOG_CONTEXT);

	try {
		switch (request.action) {
			case 'list':
				sendResult({ success: true, links: listPromptLinks() });
				return;
			case 'revoke':
				sendResult({ success: true, link: await revokePromptLink(request.id) });
				return;
			case 'create': {
				const created = await createPromptLink(request.input);
				sendResult({ success: true, link: created.link, url: created.url });
				return;
			}
		}
	} catch (error) {
		sendResult({ success: false, error: error instanceof Error ? error.message : String(error) });
	}
}
