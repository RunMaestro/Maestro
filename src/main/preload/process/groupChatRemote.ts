import { ipcRenderer } from 'electron';

export function createGroupChatRemoteApi() {
	return {
		/**
		 * Subscribe to remote get group chats from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteGetGroupChats: (callback: (responseChannel: string) => void): (() => void) => {
			const handler = (_: unknown, responseChannel: string) => callback(responseChannel);
			ipcRenderer.on('remote:getGroupChats', handler);
			return () => ipcRenderer.removeListener('remote:getGroupChats', handler);
		},

		/**
		 * Send response for remote get group chats
		 */
		sendRemoteGetGroupChatsResponse: (responseChannel: string, result: any): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote start group chat from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteStartGroupChat: (
			callback: (topic: string, participantIds: string[], responseChannel: string) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				topic: string,
				participantIds: string[],
				responseChannel: string
			) => callback(topic, participantIds, responseChannel);
			ipcRenderer.on('remote:startGroupChat', handler);
			return () => ipcRenderer.removeListener('remote:startGroupChat', handler);
		},

		/**
		 * Send response for remote start group chat
		 */
		sendRemoteStartGroupChatResponse: (
			responseChannel: string,
			result: { chatId: string } | null
		): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote get group chat state from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteGetGroupChatState: (
			callback: (chatId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, chatId: string, responseChannel: string) =>
				callback(chatId, responseChannel);
			ipcRenderer.on('remote:getGroupChatState', handler);
			return () => ipcRenderer.removeListener('remote:getGroupChatState', handler);
		},

		/**
		 * Send response for remote get group chat state
		 */
		sendRemoteGetGroupChatStateResponse: (responseChannel: string, result: any): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote stop group chat from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteStopGroupChat: (
			callback: (chatId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, chatId: string, responseChannel: string) =>
				callback(chatId, responseChannel);
			ipcRenderer.on('remote:stopGroupChat', handler);
			return () => ipcRenderer.removeListener('remote:stopGroupChat', handler);
		},

		/**
		 * Send response for remote stop group chat
		 */
		sendRemoteStopGroupChatResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},

		/**
		 * Subscribe to remote send group chat message from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteSendGroupChatMessage: (
			callback: (chatId: string, message: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, chatId: string, message: string, responseChannel: string) =>
				callback(chatId, message, responseChannel);
			ipcRenderer.on('remote:sendGroupChatMessage', handler);
			return () => ipcRenderer.removeListener('remote:sendGroupChatMessage', handler);
		},

		/**
		 * Send response for remote send group chat message
		 */
		sendRemoteSendGroupChatMessageResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},
	};
}
