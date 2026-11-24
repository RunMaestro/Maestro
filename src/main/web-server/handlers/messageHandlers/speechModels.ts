import { transcribeAudioFileRequest } from '../../../local-models/dictation';
import { installLocalModel, listLocalModels } from '../../../local-models/service';
import type { MessageHandlerContext, WebClient, WebClientMessage } from './types';

export async function handleSpeechModels(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const type = `${message.type}_result`;
	const { requestId } = message;
	if (!client.cli) {
		ctx.send(client, {
			type,
			requestId,
			success: false,
			error: 'Speech model commands require maestro-cli',
		});
		return;
	}

	try {
		switch (message.type) {
			case 'local_models_list':
				ctx.send(client, { type, requestId, success: true, listings: await listLocalModels() });
				return;
			case 'local_models_download':
				ctx.send(client, {
					type,
					requestId,
					success: true,
					result: await installLocalModel(message.modelId),
				});
				return;
			case 'local_models_transcribe':
				ctx.send(client, {
					type,
					requestId,
					success: true,
					result: await transcribeAudioFileRequest(message.path),
				});
		}
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		ctx.send(client, { type, requestId, success: false, error: detail });
	}
}
