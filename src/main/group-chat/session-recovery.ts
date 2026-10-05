/**
 * Session Recovery for Group Chat, bound to the desktop's storage.
 *
 * Detection and the recovery steps live in the library
 * (`src/shared/maestro-lib/groupchat/session-recovery.ts`); the steps that read
 * or write a chat take a store, and this module hands them the desktop's. It
 * keeps every export the main process already imports.
 */

import { loadGroupChat, updateParticipant, getGroupChatDir } from './group-chat-storage';
import {
	createSessionRecovery,
	detectSessionNotFoundError,
	needsSessionRecovery,
} from '../../shared/maestro-lib/groupchat/session-recovery';

export { detectSessionNotFoundError, needsSessionRecovery };

const recovery = createSessionRecovery({
	store: {
		loadGroupChat: (groupChatId) => loadGroupChat(groupChatId),
		updateParticipant: (groupChatId, participantName, updates) =>
			updateParticipant(groupChatId, participantName, updates),
	},
});

export const { buildRecoveryContext, initiateSessionRecovery } = recovery;

/**
 * Get the group chat folder path for a given group chat ID
 *
 * This is re-exported for convenience in the recovery flow.
 */
export { getGroupChatDir };
