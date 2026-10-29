import { getMemoryCommandCli } from '../../../plugins/plugin-manager-singleton';
import { readBackgroundField } from '../../../../shared/focusPlacement';
import type { MemoryCommandCliRequest } from '../../../../shared/memoryCommandDraft';
import type { MessageHandlerContext, WebClient, WebClientMessage } from './types';

/** Native-only IPC remains closed to browsers. This entry requires the boot CLI secret. */
export async function handleMemoryCommand(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const respond = (result: Record<string, unknown>) =>
		ctx.send(client, {
			type: 'memory_command_result',
			...result,
			requestId: message.requestId,
		});
	const address = (client.socket as unknown as { _socket?: { remoteAddress?: string } })._socket
		?.remoteAddress;
	if (
		client.cliAuthenticated !== true ||
		!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '')
	) {
		respond({ success: false, error: 'MemoryCommandDenied' });
		return;
	}
	try {
		const action = message.action;
		if (
			!['select', 'generate', 'status', 'cancel', 'preview', 'save'].includes(String(action)) ||
			typeof message.viewerId !== 'string' ||
			!/^[a-zA-Z0-9-]{1,128}$/.test(message.viewerId)
		)
			throw new Error('MemoryCommandInvalid');
		let request: MemoryCommandCliRequest;
		if (action === 'select')
			request = { action, viewerId: message.viewerId, selection: message.selection };
		else {
			if (
				typeof message.draftRequestId !== 'string' ||
				!/^[a-f0-9-]{36}$/.test(message.draftRequestId)
			)
				throw new Error('MemoryCommandInvalid');
			request =
				action === 'save'
					? {
							action,
							viewerId: message.viewerId,
							draftRequestId: message.draftRequestId,
							draft: message.draft,
						}
					: {
							action: action as Exclude<MemoryCommandCliRequest['action'], 'select' | 'save'>,
							viewerId: message.viewerId,
							draftRequestId: message.draftRequestId,
							background: readBackgroundField(message),
							editor: message.editor === true,
						};
		}
		const workflow = getMemoryCommandCli();
		if (!workflow) throw new Error('MemoryCommandUnavailable');
		const result = await workflow(request);
		// Draft ID must not overwrite the transport correlation ID.
		const { requestId: draftRequestId, ...payload } = result;
		respond({ ...payload, draftRequestId });
	} catch {
		respond({ success: false, error: 'MemoryCommandUnavailable' });
	}
}
