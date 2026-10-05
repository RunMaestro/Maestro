/**
 * @file groupchat/storage.ts
 * @description Storage for the Group Chat feature, without Electron.
 *
 * Group chats live under a `group-chats/` directory inside the Maestro data
 * directory. Each group chat has its own directory containing:
 * - metadata.json: GroupChat metadata
 * - chat.log: Pipe-delimited message log
 * - images/: Directory for image attachments
 * - history.jsonl: per-chat History entries
 *
 * The directory is an INPUT (`options.groupChatsDir`), not something this module
 * resolves: the desktop answers with `customSyncPath` or Electron's userData
 * (re-read on every call, as before) and the headless runtime answers with
 * `paths.groupChatsDir`. The layout, the atomic metadata writes and the per-chat
 * write queue are the same on both, so a chat one wrote reads on the other.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { GroupChatHistoryEntry, ModeratorConfig } from '../../group-chat-types';
import { createKeyedWriteQueue } from '../../keyedWriteQueue';
import { logger } from '../host';
import { hasCapability } from '../providers/capabilities';
import { atomicWriteJson } from '../store/atomic-write';
import type {
	GroupChat,
	GroupChatParticipant,
	GroupChatUpdate,
	ParticipantRemovalResult,
	ParticipantUpdate,
} from './types';

export type {
	GroupChat,
	GroupChatParticipant,
	GroupChatUpdate,
	ParticipantRemovalResult,
	ParticipantUpdate,
} from './types';

export interface GroupChatStoreOptions {
	/**
	 * The directory that holds one sub-directory per chat. Called on every use,
	 * so a host whose root can change (the desktop's custom sync path) is read
	 * fresh rather than captured once.
	 */
	groupChatsDir: () => string;
	/** Id for a new chat or History entry. Defaults to a random UUID. */
	generateId?: () => string;
	/**
	 * Called before every write. Throw to refuse it: the headless runtime passes
	 * its fence here, so a runtime that lost the data directory stops writing.
	 */
	beforeWrite?: () => void;
}

/**
 * Normalizes a chat display name. The on-disk directory is keyed by UUID, not
 * the name (see getGroupChatDir), so filesystem-invalid characters like `/` are
 * allowed here - the same as regular agent names. We only strip control
 * characters, trim, cap the length, and fall back when empty.
 *
 * @param name - Raw chat name
 * @returns Normalized chat name
 */
function sanitizeChatName(name: string): string {
	return (
		name
			.replace(/[\x00-\x1f]/g, '') // Strip control chars only; keep printable special chars
			.trim()
			.slice(0, 255) || 'Untitled Chat'
	); // Limit length, fallback if empty
}

/**
 * Create the group chat store over a root resolver. Every function keeps the
 * behavior it had as a module function in `src/main/group-chat/group-chat-storage.ts`.
 */
export function createGroupChatStore(options: GroupChatStoreOptions) {
	const generateId = options.generateId ?? randomUUID;
	const beforeWrite = (): void => options.beforeWrite?.();

	/**
	 * Per-chat write queue. Serializes all metadata writes for a given group chat
	 * ID so concurrent callers (usage-listener, session-id-listener, router) don't
	 * race on the same metadata.json file. Backed by the shared keyed-write-queue
	 * utility; `atomicWriteJson` provides the partial-read-safe file write.
	 */
	const groupChatWriteQueue = createKeyedWriteQueue();
	const enqueueWrite = <T>(chatId: string, fn: () => Promise<T>): Promise<T> =>
		groupChatWriteQueue.enqueue(chatId, fn);

	/**
	 * Get the directory path for a specific group chat
	 */
	function getGroupChatDir(id: string): string {
		return path.join(options.groupChatsDir(), id);
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
	 * Creates a new group chat with the specified name and moderator agent.
	 *
	 * @param name - Display name for the group chat
	 * @param moderatorAgentId - ID of the agent to use as moderator (e.g., 'claude-code')
	 * @param moderatorConfig - Optional custom configuration for the moderator agent
	 * @returns The created GroupChat object
	 * @throws Error if moderatorAgentId is not a valid agent ID
	 */
	async function createGroupChat(
		name: string,
		moderatorAgentId: string,
		moderatorConfig?: ModeratorConfig,
		requireIdleParticipants?: boolean
	): Promise<GroupChat> {
		beforeWrite();

		// Validate agent ID supports group chat moderation
		if (!hasCapability(moderatorAgentId, 'supportsGroupChatModeration')) {
			throw new Error(
				`Invalid moderator agent ID: ${moderatorAgentId}. Agent does not support group chat moderation.`
			);
		}

		// Sanitize the chat name
		const sanitizedName = sanitizeChatName(name);

		const id = generateId();
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
			moderatorSessionId: '', // Will be set when moderator is spawned
			moderatorConfig,
			participants: [],
			logPath,
			imagesDir,
			// Persisted explicitly (rather than left undefined) so the chat's own record
			// states the choice the user made at creation time.
			requireIdleParticipants: requireIdleParticipants !== false,
		};

		// Write metadata (atomic: write tmp then rename)
		const metadataPath = getMetadataPath(id);
		await atomicWriteJson(metadataPath, groupChat);

		return groupChat;
	}

	/**
	 * Loads an existing group chat by ID.
	 *
	 * @param id - The group chat ID
	 * @returns The GroupChat object, or null if not found
	 */
	async function loadGroupChat(id: string): Promise<GroupChat | null> {
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
	async function listGroupChats(): Promise<GroupChat[]> {
		const groupChatsDir = options.groupChatsDir();

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
	 * Serialized through the write queue to prevent delete-during-write races.
	 * Retries on EPERM/EBUSY errors (common on Windows with OneDrive/antivirus file locks).
	 *
	 * @param id - The group chat ID to delete
	 */
	function deleteGroupChat(id: string): Promise<void> {
		return enqueueWrite(id, async () => {
			beforeWrite();
			const chatDir = getGroupChatDir(id);
			const maxRetries = 5;
			for (let attempt = 0; attempt <= maxRetries; attempt++) {
				try {
					await fs.rm(chatDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
					return;
				} catch (err) {
					const code = (err as NodeJS.ErrnoException).code;
					if (
						(code === 'EPERM' || code === 'EBUSY' || code === 'ENOTEMPTY') &&
						attempt < maxRetries
					) {
						// Exponential backoff - file locks from OneDrive/antivirus may need time to release
						await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
						continue;
					}
					throw err;
				}
			}
		});
	}

	/**
	 * Updates a group chat's metadata.
	 *
	 * @param id - The group chat ID
	 * @param updates - Partial update object
	 * @returns The updated GroupChat object
	 * @throws Error if the group chat doesn't exist
	 */
	function updateGroupChat(id: string, updates: GroupChatUpdate): Promise<GroupChat> {
		return enqueueWrite(id, async () => {
			beforeWrite();
			const chat = await loadGroupChat(id);
			if (!chat) {
				throw new Error(`Group chat not found: ${id}`);
			}

			const updated: GroupChat = {
				...chat,
				...updates,
				// Keep renames consistent with creation: normalize the display name.
				...(updates.name !== undefined ? { name: sanitizeChatName(updates.name) } : {}),
				updatedAt: Date.now(),
			};

			const metadataPath = getMetadataPath(id);
			await atomicWriteJson(metadataPath, updated);

			return updated;
		});
	}

	/**
	 * Add a participant to a group chat.
	 *
	 * @param id - The group chat ID
	 * @param participant - The participant to add
	 * @returns The updated GroupChat object
	 */
	function addParticipantToChat(id: string, participant: GroupChatParticipant): Promise<GroupChat> {
		return enqueueWrite(id, async () => {
			beforeWrite();
			const chat = await loadGroupChat(id);
			if (!chat) {
				throw new Error(`Group chat not found: ${id}`);
			}

			// Idempotent: if participant already exists, return current state
			if (chat.participants.some((p) => p.name === participant.name)) {
				return chat;
			}

			const updated: GroupChat = {
				...chat,
				participants: [...chat.participants, participant],
				updatedAt: Date.now(),
			};

			const metadataPath = getMetadataPath(id);
			await atomicWriteJson(metadataPath, updated);

			return updated;
		});
	}

	/**
	 * Remove a participant from a group chat by name.
	 *
	 * @param id - The group chat ID
	 * @param participantName - The name of the participant to remove
	 * @returns The updated GroupChat object
	 */
	function removeParticipantFromChat(id: string, participantName: string): Promise<GroupChat> {
		return removeParticipantFromChatWithResult(id, participantName).then((result) => result.chat);
	}

	/**
	 * Remove a participant from a group chat by name and report whether storage changed.
	 *
	 * @param id - The group chat ID
	 * @param participantName - The name of the participant to remove
	 * @returns The updated group chat and whether a participant was removed
	 */
	function removeParticipantFromChatWithResult(
		id: string,
		participantName: string
	): Promise<ParticipantRemovalResult> {
		return enqueueWrite(id, async () => {
			beforeWrite();
			const chat = await loadGroupChat(id);
			if (!chat) {
				throw new Error(`Group chat not found: ${id}`);
			}

			const participants = chat.participants.filter((p) => p.name !== participantName);
			const removed = participants.length !== chat.participants.length;
			if (!removed) {
				return { chat, removed };
			}

			const updated: GroupChat = {
				...chat,
				participants,
				updatedAt: Date.now(),
			};

			const metadataPath = getMetadataPath(id);
			await atomicWriteJson(metadataPath, updated);

			return { chat: updated, removed };
		});
	}

	/**
	 * Get a participant by name from a group chat.
	 *
	 * @param id - The group chat ID
	 * @param participantName - The name of the participant
	 * @returns The participant, or undefined if not found
	 */
	async function getParticipant(
		id: string,
		participantName: string
	): Promise<GroupChatParticipant | undefined> {
		const chat = await loadGroupChat(id);
		if (!chat) {
			return undefined;
		}

		return chat.participants.find((p) => p.name === participantName);
	}

	/**
	 * Update a participant's stats in a group chat.
	 *
	 * @param id - The group chat ID
	 * @param participantName - The name of the participant to update
	 * @param updates - Partial update object for stats
	 * @returns The updated GroupChat object
	 */
	function updateParticipant(
		id: string,
		participantName: string,
		updates: ParticipantUpdate
	): Promise<GroupChat> {
		return enqueueWrite(id, async () => {
			beforeWrite();
			const chat = await loadGroupChat(id);
			if (!chat) {
				throw new Error(`Group chat not found: ${id}`);
			}

			const participantIndex = chat.participants.findIndex((p) => p.name === participantName);
			if (participantIndex === -1) {
				throw new Error(`Participant '${participantName}' not found in group chat`);
			}

			// Update the participant with new stats
			const updatedParticipants = [...chat.participants];
			updatedParticipants[participantIndex] = {
				...updatedParticipants[participantIndex],
				...updates,
			};

			const updated: GroupChat = {
				...chat,
				participants: updatedParticipants,
				updatedAt: Date.now(),
			};

			const metadataPath = getMetadataPath(id);
			await atomicWriteJson(metadataPath, updated);

			return updated;
		});
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
	async function addGroupChatHistoryEntry(
		groupChatId: string,
		entry: Omit<GroupChatHistoryEntry, 'id'>
	): Promise<GroupChatHistoryEntry> {
		beforeWrite();
		const historyPath = getHistoryPath(groupChatId);

		// Ensure the group chat directory exists
		const chatDir = getGroupChatDir(groupChatId);
		await fs.mkdir(chatDir, { recursive: true });

		// Create the full entry with generated ID
		const fullEntry: GroupChatHistoryEntry = {
			...entry,
			id: generateId(),
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
	async function getGroupChatHistory(groupChatId: string): Promise<GroupChatHistoryEntry[]> {
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
						logger.warn(`[GroupChatHistory] Skipping malformed line: ${line.substring(0, 50)}...`);
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
	async function deleteGroupChatHistoryEntry(
		groupChatId: string,
		entryId: string
	): Promise<boolean> {
		beforeWrite();
		const historyPath = getHistoryPath(groupChatId);

		try {
			const content = await fs.readFile(historyPath, 'utf-8');
			const lines = content.trim().split('\n');
			let found = false;

			const filteredLines = lines.filter((line) => {
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
				await fs.writeFile(
					historyPath,
					filteredLines.join('\n') + (filteredLines.length > 0 ? '\n' : ''),
					'utf-8'
				);
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
	async function clearGroupChatHistory(groupChatId: string): Promise<void> {
		beforeWrite();
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
	async function getGroupChatHistoryFilePath(groupChatId: string): Promise<string | null> {
		const chat = await loadGroupChat(groupChatId);
		if (!chat) {
			return null;
		}
		return getHistoryPath(groupChatId);
	}

	return {
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
	};
}

/** The functions a store offers. */
export type GroupChatStore = ReturnType<typeof createGroupChatStore>;

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
