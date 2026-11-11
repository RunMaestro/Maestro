/**
 * @file group-chat-storage.ts
 * @description Storage utilities for the Group Chat feature, bound to Electron.
 *
 * The implementation lives in the library (`src/shared/maestro-lib/groupchat/storage.ts`)
 * and takes its root as an input. This module supplies the desktop's root and
 * keeps every export name and signature the main process already imports:
 * the custom sync path when one is configured, otherwise Electron's userData,
 * re-read on every call so it respects both the custom storage location
 * setting and demo mode.
 */

import * as path from 'path';
import { app } from 'electron';
import Store from 'electron-store';
import { v4 as uuidv4 } from 'uuid';
import { GROUP_CHATS_DIR_NAME } from '../../shared/maestro-lib/paths/resolve';
import { createGroupChatStore } from '../../shared/maestro-lib/groupchat/storage';
import type { BootstrapSettings } from '../stores/types';

export { extractFirstSentence } from '../../shared/maestro-lib/groupchat/storage';
export type {
	GroupChat,
	GroupChatParticipant,
	GroupChatUpdate,
	ParticipantRemovalResult,
	ParticipantUpdate,
} from '../../shared/maestro-lib/groupchat/types';

const bootstrapStore = new Store<BootstrapSettings>({
	name: 'maestro-bootstrap',
	defaults: {},
});

/**
 * Get the group chats directory path.
 * Uses custom sync path if configured, otherwise falls back to Electron's userData.
 */
export function getGroupChatsDir(): string {
	const customPath = bootstrapStore.get('customSyncPath');
	return path.join(customPath || app.getPath('userData'), GROUP_CHATS_DIR_NAME);
}

/** Convert a group-chat-owned file name into one safe on all supported filesystems. */
export function sanitizeGroupChatFileName(name: string): string {
	const sanitized = name
		.replace(/[\x00-\x1f<>:"/\\|?*]/g, '-')
		.trim()
		.replace(/[. ]+$/g, '')
		.slice(0, 240);
	const safeName = sanitized || 'participant';
	return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(safeName)
		? `_${safeName}`
		: safeName;
}

const store = createGroupChatStore({ groupChatsDir: getGroupChatsDir, generateId: uuidv4 });

export const {
	getGroupChatDir,
	createGroupChat,
	loadGroupChat,
	listGroupChats,
	deleteGroupChat,
	updateGroupChat,
	addParticipantToChat,
	removeParticipantFromChat,
	removeParticipantFromChatWithResult,
	getParticipant,
	updateParticipant,
	addGroupChatHistoryEntry,
	getGroupChatHistory,
	deleteGroupChatHistoryEntry,
	clearGroupChatHistory,
	getGroupChatHistoryFilePath,
} = store;
