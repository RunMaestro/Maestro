import { answerBoardCommand } from '../../../../shared/board/commands';
import { executeBoardCommand } from '../../../board/board-command-host';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

export async function handleBoardCommand(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	// Retain the live session/revocation check; no caller-supplied actor or human flag.
	if (!client.isAuthorized?.()) {
		ctx.send(client, {
			type: 'board_command_result',
			requestId: message.requestId,
			ok: false,
			error: { code: 'protected-field', message: 'Authorized host session required' },
		});
		return;
	}
	try {
		ctx.send(client, await answerBoardCommand(message, executeBoardCommand));
	} catch (error) {
		ctx.reportHandlerError(client, error, 'board_command', {}, 'Board command failed');
	}
}
