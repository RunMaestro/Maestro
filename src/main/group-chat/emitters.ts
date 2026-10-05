/**
 * @file emitters.ts
 * @description The desktop's group chat UI-update emitters.
 *
 * The object lives here, not in the IPC handler module, so the engine's adapter
 * (`desktop-engine.ts`) can reach it without importing the IPC module, which
 * imports the router: that import cycle is gone. `ipc/handlers/groupChat.ts`
 * fills the fields when it registers its handlers and re-exports the object and
 * both types, so every existing import path keeps resolving.
 *
 * Fields are optional and may be reassigned (tests overwrite them), so callers
 * read them at call time and never capture one.
 */

import type {
	GroupChatHistoryEntry,
	GroupChatMessage,
	GroupChatState,
} from '../../shared/group-chat-types';
import type {
	GroupChatParticipant,
	ModeratorUsage,
	ParticipantState,
} from '../../shared/maestro-lib/groupchat/types';

export type { ModeratorUsage, ParticipantState };

/**
 * Module-level object to store emitter functions after initialization.
 * These can be used by other modules to emit messages and state changes.
 */
export const groupChatEmitters: {
	emitMessage?: (groupChatId: string, message: GroupChatMessage) => void;
	emitStateChange?: (groupChatId: string, state: GroupChatState) => void;
	emitParticipantsChanged?: (groupChatId: string, participants: GroupChatParticipant[]) => void;
	emitModeratorUsage?: (groupChatId: string, usage: ModeratorUsage) => void;
	emitHistoryEntry?: (groupChatId: string, entry: GroupChatHistoryEntry) => void;
	emitParticipantState?: (
		groupChatId: string,
		participantName: string,
		state: ParticipantState
	) => void;
	emitModeratorSessionIdChanged?: (groupChatId: string, sessionId: string) => void;
	emitParticipantLiveOutput?: (groupChatId: string, participantName: string, chunk: string) => void;
	emitAutoRunTriggered?: (groupChatId: string, participantName: string, filename?: string) => void;
	/** Tells the renderer to force-complete the batch run for a participant (clears stuck AUTO badge). */
	emitAutoRunBatchComplete?: (groupChatId: string, participantName: string) => void;
} = {};
