/**
 * The shapes a group chat is stored as.
 *
 * `metadata.json` holds a `GroupChat`; the desktop and the headless runtime read
 * and write the same file, so these are the on-disk contract rather than a
 * view model. `src/shared/group-chat-types.ts` carries the renderer-facing
 * types (two fields differ, see `Plans/maestro-tui-group-chat.md` W8); this
 * module is the storage side and is re-exported by the desktop's
 * `group-chat-storage.ts`.
 */

import type { ModeratorConfig } from '../../group-chat-types';

/**
 * Group chat participant
 * Note: This should stay in sync with shared/group-chat-types.ts
 */
export interface GroupChatParticipant {
	name: string;
	agentId: string;
	/** Internal process session ID (used for routing) */
	sessionId: string;
	/** Agent's session ID (e.g., Claude Code's session GUID for continuity) */
	agentSessionId?: string;
	addedAt: number;
	lastActivity?: number;
	lastSummary?: string;
	contextUsage?: number;
	// Color for this participant (assigned on join)
	color?: string;
	// Stats tracking
	tokenCount?: number;
	messageCount?: number;
	processingTimeMs?: number;
	/** Total cost in USD (optional, depends on provider) */
	totalCost?: number;
	/** SSH remote name (displayed as pill when running on SSH remote) */
	sshRemoteName?: string;
}

/**
 * Group chat metadata
 */
export interface GroupChat {
	id: string;
	name: string;
	createdAt: number;
	updatedAt: number;
	moderatorAgentId: string;
	/** Internal session ID prefix used for routing (e.g., 'group-chat-{id}-moderator') */
	moderatorSessionId: string;
	/** Claude Code agent session UUID (set after first message is processed) */
	moderatorAgentSessionId?: string;
	/** Custom configuration for the moderator agent */
	moderatorConfig?: ModeratorConfig;
	participants: GroupChatParticipant[];
	logPath: string;
	imagesDir: string;
	archived?: boolean;
	/**
	 * When true (the default), the moderator only hands work to an agent whose
	 * Maestro agent is idle. Undefined means enabled - read it through
	 * `requiresIdleParticipants()` in shared/group-chat-types.
	 */
	requireIdleParticipants?: boolean;
}

/**
 * Partial update for group chat metadata
 */
export type GroupChatUpdate = Partial<
	Pick<
		GroupChat,
		| 'name'
		| 'moderatorSessionId'
		| 'moderatorAgentSessionId'
		| 'moderatorAgentId'
		| 'moderatorConfig'
		| 'participants'
		| 'updatedAt'
		| 'archived'
		| 'requireIdleParticipants'
	>
>;

export interface ParticipantRemovalResult {
	chat: GroupChat;
	removed: boolean;
}

/**
 * Partial update for a participant
 */
export type ParticipantUpdate = Partial<
	Pick<
		GroupChatParticipant,
		| 'lastActivity'
		| 'lastSummary'
		| 'contextUsage'
		| 'tokenCount'
		| 'messageCount'
		| 'processingTimeMs'
		| 'agentSessionId'
		| 'totalCost'
	>
>;
