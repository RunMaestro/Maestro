/**
 * @file group-chat-storage.ts
 * @description Storage utilities for Group Chat feature.
 *
 * Group chats are stored in the Maestro config directory under 'group-chats/'.
 * Each group chat has its own directory containing:
 * - metadata.json: GroupChat metadata
 * - chat.log: Pipe-delimited message log
 * - images/: Directory for image attachments
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import Store from 'electron-store';
import { v4 as uuidv4 } from 'uuid';
import type { ToolType } from '../../shared/types';
import type { ModeratorConfig, GroupChatHistoryEntry } from '../../shared/group-chat-types';

/**
 * Valid agent IDs that can be used as moderators.
 * Must match available agents from agent-detector.
 */
const VALID_MODERATOR_AGENT_IDS: ToolType[] = ['claude-code', 'codex', 'opencode'];

/**
 * Bootstrap settings store for custom storage location.
 * This is the same store used in main/index.ts for settings sync.
 */
interface BootstrapSettings {
  customSyncPath?: string;
}

const bootstrapStore = new Store<BootstrapSettings>({
  name: 'maestro-bootstrap',
  defaults: {},
});

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
}

/**
 * Partial update for group chat metadata
 */
export type GroupChatUpdate = Partial<Pick<GroupChat, 'name' | 'moderatorSessionId' | 'moderatorAgentSessionId' | 'moderatorAgentId' | 'moderatorConfig' | 'participants' | 'updatedAt'>>;

/**
 * Get the Maestro config directory path.
 * Uses custom sync path if configured, otherwise falls back to Electron's userData.
 * This respects both the custom storage location setting and demo mode.
 */
function getConfigDir(): string {
  const customPath = bootstrapStore.get('customSyncPath');
  return customPath || app.getPath('userData');
}

/**
 * Get the group chats directory path
 */
export function getGroupChatsDir(): string {
  return path.join(getConfigDir(), 'group-chats');
}

/**
 * Get the directory path for a specific group chat
 */
export function getGroupChatDir(id: string): string {
  return path.join(getGroupChatsDir(), id);
}

/**
 * Get the metadata file path for a group chat
 */
function getMetadataPath(id: string): string {
  return path.join(getGroupChatDir(id), 'metadata.json');
}

/**
 * Get the log file path for a group chat
 */
function getLogPath(id: string): string {
  return path.join(getGroupChatDir(id), 'chat.log');
}

/**
 * Get the images directory path for a group chat
 */
function getImagesDir(id: string): string {
  return path.join(getGroupChatDir(id), 'images');
}

/**
 * Sanitizes a chat name by removing invalid filesystem characters.
 *
 * @param name - Raw chat name
 * @returns Sanitized chat name
 */
function sanitizeChatName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '') // Remove filesystem-invalid chars
    .trim()
    .slice(0, 255) || 'Untitled Chat'; // Limit length, fallback if empty
}

/**
 * Creates a new group chat with the specified name and moderator agent.
 *
 * @param name - Display name for the group chat
 * @param moderatorAgentId - ID of the agent to use as moderator (e.g., 'claude-code')
 * @param moderatorConfig - Optional custom configuration for the moderator agent
 * @returns The created GroupChat object
 * @throws Error if moderatorAgentId is not a valid agent ID
 */
export async function createGroupChat(
  name: string,
  moderatorAgentId: string,
  moderatorConfig?: ModeratorConfig
): Promise<GroupChat> {
  // Validate agent ID against whitelist
  if (!VALID_MODERATOR_AGENT_IDS.includes(moderatorAgentId as ToolType)) {
    throw new Error(
      `Invalid moderator agent ID: ${moderatorAgentId}. Must be one of: ${VALID_MODERATOR_AGENT_IDS.join(', ')}`
    );
  }

  // Sanitize the chat name
  const sanitizedName = sanitizeChatName(name);

  const id = uuidv4();
  const now = Date.now();
  const chatDir = getGroupChatDir(id);
  const logPath = getLogPath(id);
  const imagesDir = getImagesDir(id);

  // Create directory structure
  await fs.mkdir(chatDir, { recursive: true });
  await fs.mkdir(imagesDir, { recursive: true });

  // Create empty log file
  await fs.writeFile(logPath, '', 'utf-8');

  // Create metadata
  const groupChat: GroupChat = {
    id,
    name: sanitizedName,
    createdAt: now,
    updatedAt: now,
    moderatorAgentId,
    moderatorSessionId: '',  // Will be set when moderator is spawned
    moderatorConfig,
    participants: [],
    logPath,
    imagesDir,
  };

  // Write metadata
  const metadataPath = getMetadataPath(id);
  await fs.writeFile(metadataPath, JSON.stringify(groupChat, null, 2), 'utf-8');

  return groupChat;
}

/**
 * Loads an existing group chat by ID.
 *
 * @param id - The group chat ID
 * @returns The GroupChat object, or null if not found
 */
export async function loadGroupChat(id: string): Promise<GroupChat | null> {
  try {
    const metadataPath = getMetadataPath(id);
    const content = await fs.readFile(metadataPath, 'utf-8');
    if (!content.trim()) {
      // Empty file treated as non-existent
      return null;
    }
    return JSON.parse(content) as GroupChat;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    // Handle JSON parse errors as corrupted/invalid metadata
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

/**
 * Lists all group chats.
 *
 * @returns Array of all GroupChat objects
 */
export async function listGroupChats(): Promise<GroupChat[]> {
  const groupChatsDir = getGroupChatsDir();

  try {
    const entries = await fs.readdir(groupChatsDir, { withFileTypes: true });
    const chats: GroupChat[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const chat = await loadGroupChat(entry.name);
        if (chat) {
          chats.push(chat);
        }
      }
    }

    return chats;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * Deletes a group chat and all its data.
 *
 * @param id - The group chat ID to delete
 */
export async function deleteGroupChat(id: string): Promise<void> {
  const chatDir = getGroupChatDir(id);
  await fs.rm(chatDir, { recursive: true, force: true });
}

/**
 * Updates a group chat's metadata.
 *
 * @param id - The group chat ID
 * @param updates - Partial update object
 * @returns The updated GroupChat object
 * @throws Error if the group chat doesn't exist
 */
export async function updateGroupChat(
  id: string,
  updates: GroupChatUpdate
): Promise<GroupChat> {
  const chat = await loadGroupChat(id);
  if (!chat) {
    throw new Error(`Group chat not found: ${id}`);
  }

  const updated: GroupChat = {
    ...chat,
    ...updates,
    updatedAt: Date.now(),
  };

  const metadataPath = getMetadataPath(id);
  await fs.writeFile(metadataPath, JSON.stringify(updated, null, 2), 'utf-8');

  return updated;
}

/**
 * Add a participant to a group chat.
 *
 * @param id - The group chat ID
 * @param participant - The participant to add
 * @returns The updated GroupChat object
 */
export async function addParticipantToChat(
  id: string,
  participant: GroupChatParticipant
): Promise<GroupChat> {
  const chat = await loadGroupChat(id);
  if (!chat) {
    throw new Error(`Group chat not found: ${id}`);
  }

  // Check for duplicate names
  if (chat.participants.some(p => p.name === participant.name)) {
    throw new Error(`Participant with name '${participant.name}' already exists`);
  }

  const updated = await updateGroupChat(id, {
    participants: [...chat.participants, participant],
  });

  return updated;
}

/**
 * Remove a participant from a group chat by name.
 *
 * @param id - The group chat ID
 * @param participantName - The name of the participant to remove
 * @returns The updated GroupChat object
 */
export async function removeParticipantFromChat(
  id: string,
  participantName: string
): Promise<GroupChat> {
  const chat = await loadGroupChat(id);
  if (!chat) {
    throw new Error(`Group chat not found: ${id}`);
  }

  const updated = await updateGroupChat(id, {
    participants: chat.participants.filter(p => p.name !== participantName),
  });

  return updated;
}

/**
 * Get a participant by name from a group chat.
 *
 * @param id - The group chat ID
 * @param participantName - The name of the participant
 * @returns The participant, or undefined if not found
 */
export async function getParticipant(
  id: string,
  participantName: string
): Promise<GroupChatParticipant | undefined> {
  const chat = await loadGroupChat(id);
  if (!chat) {
    return undefined;
  }

  return chat.participants.find(p => p.name === participantName);
}

/**
 * Partial update for a participant
 */
export type ParticipantUpdate = Partial<Pick<
  GroupChatParticipant,
  'lastActivity' | 'lastSummary' | 'contextUsage' | 'tokenCount' | 'messageCount' | 'processingTimeMs' | 'agentSessionId' | 'totalCost'
>>;

/**
 * Update a participant's stats in a group chat.
 *
 * @param id - The group chat ID
 * @param participantName - The name of the participant to update
 * @param updates - Partial update object for stats
 * @returns The updated GroupChat object
 */
export async function updateParticipant(
  id: string,
  participantName: string,
  updates: ParticipantUpdate
): Promise<GroupChat> {
  const chat = await loadGroupChat(id);
  if (!chat) {
    throw new Error(`Group chat not found: ${id}`);
  }

  const participantIndex = chat.participants.findIndex(p => p.name === participantName);
  if (participantIndex === -1) {
    throw new Error(`Participant '${participantName}' not found in group chat`);
  }

  // Update the participant with new stats
  const updatedParticipants = [...chat.participants];
  updatedParticipants[participantIndex] = {
    ...updatedParticipants[participantIndex],
    ...updates,
  };

  return updateGroupChat(id, { participants: updatedParticipants });
}

// ============================================================================
// Group Chat History Storage (JSONL format)
// ============================================================================

/**
 * Get the history file path for a group chat
 */
function getHistoryPath(id: string): string {
  return path.join(getGroupChatDir(id), 'history.jsonl');
}

/**
 * Adds a history entry to a group chat's history log.
 *
 * @param groupChatId - The ID of the group chat
 * @param entry - The history entry to add (without id, which will be generated)
 * @returns The created history entry with generated id
 */
export async function addGroupChatHistoryEntry(
  groupChatId: string,
  entry: Omit<GroupChatHistoryEntry, 'id'>
): Promise<GroupChatHistoryEntry> {
  const historyPath = getHistoryPath(groupChatId);

  // Ensure the group chat directory exists
  const chatDir = getGroupChatDir(groupChatId);
  await fs.mkdir(chatDir, { recursive: true });

  // Create the full entry with generated ID
  const fullEntry: GroupChatHistoryEntry = {
    ...entry,
    id: uuidv4(),
  };

  // Append to JSONL file (one JSON object per line)
  const line = JSON.stringify(fullEntry) + '\n';
  await fs.appendFile(historyPath, line, 'utf-8');

  return fullEntry;
}

/**
 * Reads all history entries for a group chat.
 *
 * @param groupChatId - The ID of the group chat
 * @returns Array of history entries, sorted by timestamp (newest first)
 */
export async function getGroupChatHistory(groupChatId: string): Promise<GroupChatHistoryEntry[]> {
  const historyPath = getHistoryPath(groupChatId);

  try {
    const content = await fs.readFile(historyPath, 'utf-8');
    if (!content.trim()) {
      return [];
    }

    const entries: GroupChatHistoryEntry[] = [];
    const lines = content.trim().split('\n');

    for (const line of lines) {
      if (line.trim()) {
        try {
          entries.push(JSON.parse(line));
        } catch {
          // Skip malformed lines
          console.warn(`[GroupChatHistory] Skipping malformed line: ${line.substring(0, 50)}...`);
        }
      }
    }

    // Sort by timestamp, newest first
    return entries.sort((a, b) => b.timestamp - a.timestamp);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * Deletes a specific history entry from a group chat.
 *
 * @param groupChatId - The ID of the group chat
 * @param entryId - The ID of the entry to delete
 * @returns True if the entry was deleted, false if not found
 */
export async function deleteGroupChatHistoryEntry(
  groupChatId: string,
  entryId: string
): Promise<boolean> {
  const historyPath = getHistoryPath(groupChatId);

  try {
    const content = await fs.readFile(historyPath, 'utf-8');
    const lines = content.trim().split('\n');
    let found = false;

    const filteredLines = lines.filter(line => {
      if (!line.trim()) return false;
      try {
        const entry = JSON.parse(line) as GroupChatHistoryEntry;
        if (entry.id === entryId) {
          found = true;
          return false;
        }
        return true;
      } catch {
        return true; // Keep malformed lines
      }
    });

    if (found) {
      await fs.writeFile(historyPath, filteredLines.join('\n') + (filteredLines.length > 0 ? '\n' : ''), 'utf-8');
    }

    return found;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Clears all history entries for a group chat.
 *
 * @param groupChatId - The ID of the group chat
 */
export async function clearGroupChatHistory(groupChatId: string): Promise<void> {
  const historyPath = getHistoryPath(groupChatId);

  try {
    await fs.writeFile(historyPath, '', 'utf-8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    // File doesn't exist, nothing to clear
  }
}

/**
 * Gets the file path to the history file for a group chat.
 * Useful for AI context integration.
 *
 * @param groupChatId - The ID of the group chat
 * @returns The file path, or null if the group chat doesn't exist
 */
export async function getGroupChatHistoryFilePath(groupChatId: string): Promise<string | null> {
  const chat = await loadGroupChat(groupChatId);
  if (!chat) {
    return null;
  }
  return getHistoryPath(groupChatId);
}

/**
 * Extract the first sentence from a message for use as summary.
 * Handles various sentence-ending patterns.
 *
 * @param message - The full message text
 * @returns The first sentence, or truncated text if no sentence found
 */
export function extractFirstSentence(message: string): string {
  // Trim and normalize whitespace
  const trimmed = message.trim().replace(/\s+/g, ' ');

  // Look for sentence-ending punctuation followed by space or end of string
  // Handle common patterns: periods, exclamation, question marks
  // Avoid matching periods in abbreviations like "e.g." or "Dr."
  const sentenceMatch = trimmed.match(/^(.+?(?<![A-Z])[.!?])(?:\s|$)/);

  if (sentenceMatch) {
    return sentenceMatch[1].trim();
  }

  // If no sentence ending found, take first 150 chars
  if (trimmed.length > 150) {
    return trimmed.substring(0, 147) + '...';
  }

  return trimmed;
}
