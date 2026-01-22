/**
 * Preload API for group chat operations
 *
 * Provides the window.maestro.groupChat namespace for:
 * - Group chat creation and management
 * - Moderator and participant control
 * - Chat history and messages
 */

import { ipcRenderer } from 'electron';

/**
 * Moderator configuration
 */
export interface ModeratorConfig {
	customPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
}

/**
 * Participant definition
 */
export interface Participant {
	name: string;
	agentId: string;
	sessionId: string;
	addedAt: number;
}

/**
 * Chat message
 */
export interface ChatMessage {
	timestamp: string;
	from: string;
	content: string;
}

/**
 * History entry
 */
export interface GroupChatHistoryEntry {
	id: string;
	timestamp: number;
	summary: string;
	participantName: string;
	participantColor: string;
	type: 'delegation' | 'response' | 'synthesis' | 'error';
	elapsedTimeMs?: number;
	tokenCount?: number;
	cost?: number;
	fullResponse?: string;
}

/**
 * Moderator usage stats
 */
export interface ModeratorUsage {
	contextUsage: number;
	totalCost: number;
	tokenCount: number;
}

/**
 * Creates the Group Chat API object for preload exposure
 */
export function createGroupChatApi() {
	return {
		// Storage
		create: (name: string, moderatorAgentId: string, moderatorConfig?: ModeratorConfig) =>
			ipcRenderer.invoke('groupChat:create', name, moderatorAgentId, moderatorConfig),

		list: () => ipcRenderer.invoke('groupChat:list'),

		load: (id: string) => ipcRenderer.invoke('groupChat:load', id),

		delete: (id: string) => ipcRenderer.invoke('groupChat:delete', id),

		rename: (id: string, name: string) => ipcRenderer.invoke('groupChat:rename', id, name),

		update: (
			id: string,
			updates: {
				name?: string;
				moderatorAgentId?: string;
				moderatorConfig?: ModeratorConfig;
			}
		) => ipcRenderer.invoke('groupChat:update', id, updates),

		// Chat log
		appendMessage: (id: string, from: string, content: string) =>
			ipcRenderer.invoke('groupChat:appendMessage', id, from, content),

		getMessages: (id: string) => ipcRenderer.invoke('groupChat:getMessages', id),

		saveImage: (id: string, imageData: string, filename: string) =>
			ipcRenderer.invoke('groupChat:saveImage', id, imageData, filename),

		// Moderator
		startModerator: (id: string) => ipcRenderer.invoke('groupChat:startModerator', id),

		sendToModerator: (id: string, message: string, images?: string[], readOnly?: boolean) =>
			ipcRenderer.invoke('groupChat:sendToModerator', id, message, images, readOnly),

		stopModerator: (id: string) => ipcRenderer.invoke('groupChat:stopModerator', id),

		getModeratorSessionId: (id: string) =>
			ipcRenderer.invoke('groupChat:getModeratorSessionId', id),

		// Participants
		addParticipant: (id: string, name: string, agentId: string, cwd?: string) =>
			ipcRenderer.invoke('groupChat:addParticipant', id, name, agentId, cwd),

		sendToParticipant: (id: string, name: string, message: string, images?: string[]) =>
			ipcRenderer.invoke('groupChat:sendToParticipant', id, name, message, images),

		removeParticipant: (id: string, name: string) =>
			ipcRenderer.invoke('groupChat:removeParticipant', id, name),

		resetParticipantContext: (
			id: string,
			name: string,
			cwd?: string
		): Promise<{ newAgentSessionId: string }> =>
			ipcRenderer.invoke('groupChat:resetParticipantContext', id, name, cwd),

		// History
		getHistory: (id: string) => ipcRenderer.invoke('groupChat:getHistory', id),

		addHistoryEntry: (id: string, entry: Omit<GroupChatHistoryEntry, 'id'>) =>
			ipcRenderer.invoke('groupChat:addHistoryEntry', id, entry),

		deleteHistoryEntry: (groupChatId: string, entryId: string) =>
			ipcRenderer.invoke('groupChat:deleteHistoryEntry', groupChatId, entryId),

		clearHistory: (id: string) => ipcRenderer.invoke('groupChat:clearHistory', id),

		getHistoryFilePath: (id: string) => ipcRenderer.invoke('groupChat:getHistoryFilePath', id),

		// Export
		getImages: (id: string): Promise<Record<string, string>> =>
			ipcRenderer.invoke('groupChat:getImages', id),

		// Events
		onMessage: (callback: (groupChatId: string, message: ChatMessage) => void) => {
			const handler = (_: any, groupChatId: string, message: ChatMessage) =>
				callback(groupChatId, message);
			ipcRenderer.on('groupChat:message', handler);
			return () => ipcRenderer.removeListener('groupChat:message', handler);
		},

		onStateChange: (
			callback: (
				groupChatId: string,
				state: 'idle' | 'moderator-thinking' | 'agent-working'
			) => void
		) => {
			const handler = (
				_: any,
				groupChatId: string,
				state: 'idle' | 'moderator-thinking' | 'agent-working'
			) => callback(groupChatId, state);
			ipcRenderer.on('groupChat:stateChange', handler);
			return () => ipcRenderer.removeListener('groupChat:stateChange', handler);
		},

		onParticipantsChanged: (
			callback: (groupChatId: string, participants: Participant[]) => void
		) => {
			const handler = (_: any, groupChatId: string, participants: Participant[]) =>
				callback(groupChatId, participants);
			ipcRenderer.on('groupChat:participantsChanged', handler);
			return () => ipcRenderer.removeListener('groupChat:participantsChanged', handler);
		},

		onModeratorUsage: (callback: (groupChatId: string, usage: ModeratorUsage) => void) => {
			const handler = (_: any, groupChatId: string, usage: ModeratorUsage) =>
				callback(groupChatId, usage);
			ipcRenderer.on('groupChat:moderatorUsage', handler);
			return () => ipcRenderer.removeListener('groupChat:moderatorUsage', handler);
		},

		onHistoryEntry: (callback: (groupChatId: string, entry: GroupChatHistoryEntry) => void) => {
			const handler = (_: any, groupChatId: string, entry: GroupChatHistoryEntry) =>
				callback(groupChatId, entry);
			ipcRenderer.on('groupChat:historyEntry', handler);
			return () => ipcRenderer.removeListener('groupChat:historyEntry', handler);
		},

		onParticipantState: (
			callback: (groupChatId: string, participantName: string, state: 'idle' | 'working') => void
		) => {
			const handler = (
				_: any,
				groupChatId: string,
				participantName: string,
				state: 'idle' | 'working'
			) => callback(groupChatId, participantName, state);
			ipcRenderer.on('groupChat:participantState', handler);
			return () => ipcRenderer.removeListener('groupChat:participantState', handler);
		},

		onModeratorSessionIdChanged: (callback: (groupChatId: string, sessionId: string) => void) => {
			const handler = (_: any, groupChatId: string, sessionId: string) =>
				callback(groupChatId, sessionId);
			ipcRenderer.on('groupChat:moderatorSessionIdChanged', handler);
			return () => ipcRenderer.removeListener('groupChat:moderatorSessionIdChanged', handler);
		},
	};
}

export type GroupChatApi = ReturnType<typeof createGroupChatApi>;
