/**
 * @file group-chat-types.ts
 * @description Shared type definitions for Group Chat feature.
 * Used by both main process and renderer.
 */

/**
 * Group chat participant
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
}

/**
 * Custom configuration for an agent (moderator)
 */
export interface ModeratorConfig {
  /** Custom path to the agent binary */
  customPath?: string;
  /** Custom CLI arguments */
  customArgs?: string;
  /** Custom environment variables */
  customEnvVars?: Record<string, string>;
}

/**
 * Group chat metadata
 */
export interface GroupChat {
  id: string;
  name: string;
  createdAt: number;
  updatedAt?: number;
  moderatorAgentId: string;
  moderatorSessionId: string;
  /** Custom configuration for the moderator agent */
  moderatorConfig?: ModeratorConfig;
  participants: GroupChatParticipant[];
  logPath: string;
  imagesDir: string;
  draftMessage?: string;
}

/**
 * Group chat message entry from the chat log
 */
export interface GroupChatMessage {
  timestamp: string;
  from: string;
  content: string;
  readOnly?: boolean;
}

/**
 * Group chat state for UI display
 */
export type GroupChatState = 'idle' | 'moderator-thinking' | 'agent-working';
