import { answerBoardCommand, type BoardCommandReply } from '../../../../shared/board/commands';
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
	if (
		typeof message.action === 'string' &&
		message.action.startsWith('source-') &&
		client.cli !== true
	) {
		ctx.send(client, {
			type: 'board_command_result',
			requestId: message.requestId,
			ok: false,
			error: { code: 'protected-field', message: 'Local CLI session required for source cleanup' },
		});
		return;
	}
	try {
		ctx.send(client, await answerBoardCommand(message, executeBoardCommand));
	} catch (error) {
		ctx.reportHandlerError(
			client,
			error,
			'board_command',
			{ requestId: message.requestId },
			'Board command failed',
			(detail) =>
				({
					type: 'board_command_result',
					requestId: typeof message.requestId === 'string' ? message.requestId : undefined,
					ok: false,
					error: { code: 'runtime-unavailable', message: detail },
				}) satisfies BoardCommandReply
		);
	}
}
