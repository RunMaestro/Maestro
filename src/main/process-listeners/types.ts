/**
 * Type definitions for process event listeners.
 * Re-exports existing types and defines the dependency interface.
 */

import type { ProcessManager } from '../process-manager';
import type { WebServer } from '../web-server';
import type { AgentDetector } from '../agents';
import type { SafeSendFn } from '../utils/safe-send';
import type { StatsDB } from '../stats';
import type { GroupChat, GroupChatParticipant } from '../group-chat/group-chat-storage';
import type { GroupChatMessage, GroupChatState } from '../../shared/group-chat-types';
import type { ParticipantState } from '../ipc/handlers/groupChat';

// ==========================================================================
// Constants
// ==========================================================================

/**
 * Prefix for group chat session IDs.
 * Used for fast string check before expensive regex matching.
 * Session IDs starting with this prefix belong to group chat sessions.
 */
export const GROUP_CHAT_PREFIX = 'group-chat-';

// Re-export types from their canonical locations
export type { UsageStats, QueryCompleteData, ToolExecution } from '../process-manager/types';
export type { AgentError } from '../../shared/types';
export type { GroupChat, GroupChatParticipant };
export type { SafeSendFn } from '../utils/safe-send';
export type { GroupChatState };
export type { ParticipantState };

// Import emitters and state types from groupChat handlers
export type { groupChatEmitters, ModeratorUsage } from '../ipc/handlers/groupChat';

/**
 * Participant info parsed from session ID.
 * Matches return type of parseParticipantSessionId.
 */
export interface ParticipantInfo {
	groupChatId: string;
	participantName: string;
}

/**
 * Dependencies for process event listeners.
 * All external dependencies are injected to enable testing and modularity.
 */
export interface ProcessListenerDependencies {
	/** Function to get the process manager */
	getProcessManager: () => ProcessManager | null;
	/** Function to get the web server (may be null if not started) */
	getWebServer: () => WebServer | null;
	/** Function to get the agent detector */
	getAgentDetector: () => AgentDetector | null;
	/** Safe send function for IPC messages */
	safeSend: SafeSendFn;
	/** Broadcast helper that delivers IPC events to all renderer windows */
	broadcastToAllWindows: (channel: string, ...args: unknown[]) => void;
	/** Power manager instance */
	powerManager: {
		addBlockReason: (reason: string) => void;
		removeBlockReason: (reason: string) => void;
	};
	/** Group chat event emitters */
	groupChatEmitters: {
		emitStateChange?: (groupChatId: string, state: GroupChatState) => void;
		emitParticipantState?: (
			groupChatId: string,
			participantName: string,
			state: ParticipantState
		) => void;
		emitParticipantsChanged?: (groupChatId: string, participants: GroupChatParticipant[]) => void;
		emitModeratorSessionIdChanged?: (groupChatId: string, agentSessionId: string) => void;
		emitModeratorUsage?: (
			groupChatId: string,
			usage: { contextUsage: number; totalCost: number; tokenCount: number }
		) => void;
		emitMessage?: (groupChatId: string, message: GroupChatMessage) => void;
	};
	/** Group chat router functions */
	groupChatRouter: {
		routeModeratorResponse: (
			groupChatId: string,
			text: string,
			processManager: ProcessManager | undefined,
			agentDetector: AgentDetector | undefined,
			readOnly: boolean
		) => Promise<void>;
		routeAgentResponse: (
			groupChatId: string,
			participantName: string,
			text: string,
			processManager: ProcessManager | undefined
		) => Promise<void>;
		markParticipantResponded: (groupChatId: string, participantName: string) => boolean;
		spawnModeratorSynthesis: (
			groupChatId: string,
			processManager: ProcessManager,
			agentDetector: AgentDetector
		) => Promise<void>;
		getGroupChatReadOnlyState: (groupChatId: string) => boolean;
		respawnParticipantWithRecovery: (
			groupChatId: string,
			participantName: string,
			processManager: ProcessManager,
			agentDetector: AgentDetector
		) => Promise<void>;
	};
	/** Group chat storage functions */
	groupChatStorage: {
		loadGroupChat: (groupChatId: string) => Promise<GroupChat | null>;
		updateGroupChat: (groupChatId: string, updates: Record<string, unknown>) => Promise<GroupChat>;
		updateParticipant: (
			groupChatId: string,
			participantName: string,
			updates: Record<string, unknown>
		) => Promise<GroupChat>;
	};
	/** Session recovery functions */
	sessionRecovery: {
		needsSessionRecovery: (output: string, agentType?: string) => boolean;
		initiateSessionRecovery: (groupChatId: string, participantName: string) => Promise<boolean>;
	};
	/** Output buffer functions */
	outputBuffer: {
		appendToGroupChatBuffer: (sessionId: string, data: string) => number;
		getGroupChatBufferedOutput: (sessionId: string) => string | undefined;
		clearGroupChatBuffer: (sessionId: string) => void;
	};
	/** Output parser functions */
	outputParser: {
		extractTextFromStreamJson: (output: string, agentType?: string) => string;
		parseParticipantSessionId: (sessionId: string) => ParticipantInfo | null;
	};
	/** Usage aggregator functions */
	usageAggregator: {
		calculateContextTokens: (usageStats: {
			inputTokens: number;
			outputTokens: number;
			cacheReadInputTokens: number;
			cacheCreationInputTokens: number;
		}) => number;
	};
	/** Stats database getter */
	getStatsDB: () => StatsDB;
	/** Debug log function */
	debugLog: (prefix: string, message: string, ...args: unknown[]) => void;
	/** Regex patterns */
	patterns: {
		REGEX_MODERATOR_SESSION: RegExp;
		REGEX_MODERATOR_SESSION_TIMESTAMP: RegExp;
		REGEX_AI_SUFFIX: RegExp;
		REGEX_AI_TAB_ID: RegExp;
		/** Matches batch session IDs: {id}-batch-{timestamp} */
		REGEX_BATCH_SESSION: RegExp;
		/** Matches synopsis session IDs: {id}-synopsis-{timestamp} */
		REGEX_SYNOPSIS_SESSION: RegExp;
	};
	/** Logger instance */
	logger: {
		info: (message: string, context: string, data?: Record<string, unknown>) => void;
		error: (message: string, context: string, data?: Record<string, unknown>) => void;
		warn: (message: string, context: string, data?: Record<string, unknown>) => void;
		debug: (message: string, context: string, data?: Record<string, unknown>) => void;
	};
}
