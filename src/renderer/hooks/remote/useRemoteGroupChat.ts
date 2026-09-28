/**
 * Wires the five group chat requests from the WebSocket bridge (maestro-cli
 * `group-chat`, the web/mobile client) to the renderer service that answers
 * them. Without these listeners every request times out in main.
 *
 * Every listener answers exactly once, including on an unexpected throw, so a
 * caller gets a failure instead of waiting out main's timeout.
 */

import { useEffect } from 'react';
import { captureException } from '../../utils/sentry';
import {
	getRemoteGroupChatState,
	listRemoteGroupChats,
	sendRemoteGroupChatMessage,
	startRemoteGroupChat,
	stopGroupChatWork,
} from '../../services/remoteGroupChat';

function report(operation: string, error: unknown, extra: Record<string, unknown> = {}): void {
	captureException(error, { extra: { context: `remoteGroupChat:${operation}`, ...extra } });
}

export function useRemoteGroupChat(): void {
	useEffect(() => {
		const { process } = window.maestro;

		const unsubscribers = [
			process.onRemoteGetGroupChats((responseChannel) => {
				listRemoteGroupChats()
					.then((chats) => process.sendRemoteGetGroupChatsResponse(responseChannel, chats))
					.catch((error) => {
						report('list', error);
						process.sendRemoteGetGroupChatsResponse(responseChannel, []);
					});
			}),

			process.onRemoteStartGroupChat((topic, participantIds, responseChannel, options) => {
				startRemoteGroupChat(topic, participantIds, options)
					.then((result) => process.sendRemoteStartGroupChatResponse(responseChannel, result))
					.catch((error) => {
						report('start', error, { participantCount: participantIds.length });
						process.sendRemoteStartGroupChatResponse(responseChannel, {
							error: error instanceof Error ? error.message : String(error),
						});
					});
			}),

			process.onRemoteGetGroupChatState((chatId, responseChannel) => {
				getRemoteGroupChatState(chatId)
					.then((state) => process.sendRemoteGetGroupChatStateResponse(responseChannel, state))
					.catch((error) => {
						report('state', error, { chatId });
						process.sendRemoteGetGroupChatStateResponse(responseChannel, null);
					});
			}),

			process.onRemoteSendGroupChatMessage((chatId, message, responseChannel) => {
				sendRemoteGroupChatMessage(chatId, message)
					.then((ok) => process.sendRemoteSendGroupChatMessageResponse(responseChannel, ok))
					.catch((error) => {
						report('send', error, { chatId });
						process.sendRemoteSendGroupChatMessageResponse(responseChannel, false);
					});
			}),

			process.onRemoteStopGroupChat((chatId, responseChannel) => {
				stopGroupChatWork(chatId)
					.then(() => process.sendRemoteStopGroupChatResponse(responseChannel, true))
					.catch((error) => {
						report('stop', error, { chatId });
						process.sendRemoteStopGroupChatResponse(responseChannel, false);
					});
			}),
		];

		return () => {
			for (const unsubscribe of unsubscribers) unsubscribe();
		};
	}, []);
}
