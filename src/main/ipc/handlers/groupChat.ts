/**
 * @file groupChat.ts
 * @description IPC handlers for Group Chat feature.
 *
 * Provides handlers for:
 * - Group chat CRUD operations (create, list, load, delete, rename)
 * - Chat log operations (append, get messages, save images)
 * - Moderator management (start, send, stop)
 * - Participant management (add, send, remove)
 */

import { ipcMain, BrowserWindow } from 'electron';
import { withIpcErrorLogging, CreateHandlerOptions } from '../../utils/ipcHandler';
import { logger } from '../../utils/logger';

// Group chat storage imports
import {
	createGroupChat,
	loadGroupChat,
	listGroupChats,
	deleteGroupChat,
	updateGroupChat,
	updateParticipant,
	GroupChat,
	GroupChatParticipant,
	addGroupChatHistoryEntry,
	getGroupChatHistory,
	deleteGroupChatHistoryEntry,
	clearGroupChatHistory,
	getGroupChatHistoryFilePath,
	getGroupChatDir,
} from '../../group-chat/group-chat-storage';

// Group chat history type
import type { GroupChatHistoryEntry } from '../../../shared/group-chat-types';

// Group chat log imports
import { appendToLog, readLog, saveImage, GroupChatMessage } from '../../group-chat/group-chat-log';

// Group chat moderator imports
import {
	spawnModerator,
	sendToModerator as _sendToModerator,
	killModerator,
	getModeratorSessionId,
	type IProcessManager as _IProcessManager,
} from '../../group-chat/group-chat-moderator';

// Re-exports for potential future use
export { _sendToModerator as sendToModerator };
export type { _IProcessManager as IProcessManager };

// Group chat agent imports
import {
	addParticipant,
	sendToParticipant,
	removeParticipant,
	clearAllParticipantSessions,
} from '../../group-chat/group-chat-agent';

// Group chat router imports
import { routeUserMessage } from '../../group-chat/group-chat-router';

// Agent detector import
import { AgentDetector } from '../../agent-detector';
import { groomContext } from '../../utils/context-groomer';
import { v4 as uuidv4 } from 'uuid';

const LOG_CONTEXT = '[GroupChat]';

/**
 * Moderator usage stats for display in the moderator card.
 */
export interface ModeratorUsage {
	contextUsage: number;
	totalCost: number;
	tokenCount: number;
}

/**
 * Participant state for tracking individual agent working status.
 */
export type ParticipantState = 'idle' | 'working';

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
} = {};

// Helper to create handler options with consistent context
const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/**
 * Group chat state type
 */
export type GroupChatState = 'idle' | 'moderator-thinking' | 'agent-working';

/**
 * Generic process manager interface that matches both IProcessManager and ProcessManager
 */
interface GenericProcessManager {
	spawn(config: {
		sessionId: string;
		toolType: string;
		cwd: string;
		command: string;
		args: string[];
		readOnlyMode?: boolean;
		prompt?: string;
		customEnvVars?: Record<string, string>;
		contextWindow?: number;
		noPromptSeparator?: boolean;
	}): { pid: number; success: boolean };
	write(sessionId: string, data: string): boolean;
	kill(sessionId: string): boolean;
	on(event: string, handler: (...args: unknown[]) => void): void;
	off(event: string, handler: (...args: unknown[]) => void): void;
}

/**
 * Dependencies required for group chat handler registration
 */
export interface GroupChatHandlerDependencies {
	getMainWindow: () => BrowserWindow | null;
	getProcessManager: () => GenericProcessManager | null;
	getAgentDetector: () => AgentDetector | null;
	getCustomEnvVars?: (agentId: string) => Record<string, string> | undefined;
	getAgentConfig?: (agentId: string) => Record<string, any> | undefined;
}

/**
 * Register all Group Chat IPC handlers.
 *
 * These handlers provide:
 * - Storage: create, list, load, delete, rename
 * - Chat log: appendMessage, getMessages, saveImage
 * - Moderator: startModerator, sendToModerator, stopModerator
 * - Participants: addParticipant, sendToParticipant, removeParticipant
 */
export function registerGroupChatHandlers(deps: GroupChatHandlerDependencies): void {
	const { getMainWindow, getProcessManager, getAgentDetector, getCustomEnvVars, getAgentConfig } =
		deps;

	// ========== Storage Handlers ==========

	// Create a new group chat (also initializes the moderator so it's ready immediately)
	ipcMain.handle(
		'groupChat:create',
		withIpcErrorLogging(
			handlerOpts('create'),
			async (
				name: string,
				moderatorAgentId: string,
				moderatorConfig?: {
					customPath?: string;
					customArgs?: string;
					customEnvVars?: Record<string, string>;
				}
			): Promise<GroupChat> => {
				logger.info(`Creating group chat: ${name}`, LOG_CONTEXT, {
					moderatorAgentId,
					hasConfig: !!moderatorConfig,
				});
				const chat = await createGroupChat(name, moderatorAgentId, moderatorConfig);

				// Initialize the moderator immediately so it's "hot and ready"
				// This spawns the session ID prefix so the UI doesn't show "pending"
				const processManager = getProcessManager();
				if (processManager) {
					logger.info(`Initializing moderator for group chat: ${chat.id}`, LOG_CONTEXT);
					await spawnModerator(chat, processManager);
					// Reload the chat to get the updated moderatorSessionId
					const updatedChat = await loadGroupChat(chat.id);
					if (updatedChat) {
						logger.info(`Created and initialized group chat: ${chat.id}`, LOG_CONTEXT);
						return updatedChat;
					}
				}

				logger.info(`Created group chat: ${chat.id}`, LOG_CONTEXT);
				return chat;
			}
		)
	);

	// List all group chats
	ipcMain.handle(
		'groupChat:list',
		withIpcErrorLogging(handlerOpts('list'), async (): Promise<GroupChat[]> => {
			logger.debug('Listing group chats', LOG_CONTEXT);
			const chats = await listGroupChats();
			logger.debug(`Found ${chats.length} group chats`, LOG_CONTEXT);
			return chats;
		})
	);

	// Load a specific group chat
	ipcMain.handle(
		'groupChat:load',
		withIpcErrorLogging(handlerOpts('load'), async (id: string): Promise<GroupChat | null> => {
			logger.debug(`Loading group chat: ${id}`, LOG_CONTEXT);
			return loadGroupChat(id);
		})
	);

	// Delete a group chat
	ipcMain.handle(
		'groupChat:delete',
		withIpcErrorLogging(handlerOpts('delete'), async (id: string): Promise<boolean> => {
			logger.info(`Deleting group chat: ${id}`, LOG_CONTEXT);

			// Kill moderator and all participants first
			const processManager = getProcessManager();
			await killModerator(id, processManager ?? undefined);
			await clearAllParticipantSessions(id, processManager ?? undefined);

			// Delete the group chat data
			await deleteGroupChat(id);
			logger.info(`Deleted group chat: ${id}`, LOG_CONTEXT);
			return true;
		})
	);

	// Rename a group chat
	ipcMain.handle(
		'groupChat:rename',
		withIpcErrorLogging(
			handlerOpts('rename'),
			async (id: string, name: string): Promise<GroupChat> => {
				logger.info(`Renaming group chat ${id} to: ${name}`, LOG_CONTEXT);
				const updated = await updateGroupChat(id, { name });
				return updated;
			}
		)
	);

	// Update a group chat (name, moderator agent, moderator config)
	ipcMain.handle(
		'groupChat:update',
		withIpcErrorLogging(
			handlerOpts('update'),
			async (
				id: string,
				updates: {
					name?: string;
					moderatorAgentId?: string;
					moderatorConfig?: {
						customPath?: string;
						customArgs?: string;
						customEnvVars?: Record<string, string>;
					};
				}
			): Promise<GroupChat> => {
				logger.info(`Updating group chat ${id}`, LOG_CONTEXT, updates);

				const chat = await loadGroupChat(id);
				if (!chat) {
					throw new Error(`Group chat not found: ${id}`);
				}

				// Check if moderator agent changed - if so, we need to restart it
				const moderatorChanged =
					updates.moderatorAgentId && updates.moderatorAgentId !== chat.moderatorAgentId;

				// Kill existing moderator if agent is changing
				if (moderatorChanged) {
					const processManager = getProcessManager();
					await killModerator(id, processManager ?? undefined);
				}

				// Update the group chat
				const updated = await updateGroupChat(id, {
					name: updates.name,
					moderatorAgentId: updates.moderatorAgentId,
					moderatorConfig: updates.moderatorConfig,
				});

				// Restart moderator if agent changed
				if (moderatorChanged) {
					const processManager = getProcessManager();
					if (processManager) {
						logger.info(
							`Restarting moderator for group chat: ${id} with new agent: ${updates.moderatorAgentId}`,
							LOG_CONTEXT
						);
						await spawnModerator(updated, processManager);
						// Reload to get updated moderatorSessionId
						const reloaded = await loadGroupChat(id);
						if (reloaded) {
							return reloaded;
						}
					}
				}

				return updated;
			}
		)
	);

	// ========== Chat Log Handlers ==========

	// Append a message to the chat log
	ipcMain.handle(
		'groupChat:appendMessage',
		withIpcErrorLogging(
			handlerOpts('appendMessage'),
			async (id: string, from: string, content: string): Promise<void> => {
				const chat = await loadGroupChat(id);
				if (!chat) {
					throw new Error(`Group chat not found: ${id}`);
				}
				await appendToLog(chat.logPath, from, content);
				logger.debug(`Appended message to ${id} from ${from}`, LOG_CONTEXT);
			}
		)
	);

	// Get all messages from the chat log
	ipcMain.handle(
		'groupChat:getMessages',
		withIpcErrorLogging(
			handlerOpts('getMessages'),
			async (id: string): Promise<GroupChatMessage[]> => {
				const chat = await loadGroupChat(id);
				if (!chat) {
					throw new Error(`Group chat not found: ${id}`);
				}
				const messages = await readLog(chat.logPath);
				logger.debug(`Read ${messages.length} messages from ${id}`, LOG_CONTEXT);
				return messages;
			}
		)
	);

	// Save an image to the group chat's images directory
	ipcMain.handle(
		'groupChat:saveImage',
		withIpcErrorLogging(
			handlerOpts('saveImage'),
			async (id: string, imageData: string, filename: string): Promise<string> => {
				const chat = await loadGroupChat(id);
				if (!chat) {
					throw new Error(`Group chat not found: ${id}`);
				}
				const buffer = Buffer.from(imageData, 'base64');
				const savedFilename = await saveImage(chat.imagesDir, buffer, filename);
				logger.debug(`Saved image to ${id}: ${savedFilename}`, LOG_CONTEXT);
				return savedFilename;
			}
		)
	);

	// ========== Moderator Handlers ==========

	// Start the moderator for a group chat
	ipcMain.handle(
		'groupChat:startModerator',
		withIpcErrorLogging(handlerOpts('startModerator'), async (id: string): Promise<string> => {
			const chat = await loadGroupChat(id);
			if (!chat) {
				throw new Error(`Group chat not found: ${id}`);
			}

			const processManager = getProcessManager();
			if (!processManager) {
				throw new Error('Process manager not initialized');
			}

			logger.info(`Starting moderator for group chat: ${id}`, LOG_CONTEXT);
			const sessionId = await spawnModerator(chat, processManager);
			logger.info(`Moderator started with session: ${sessionId}`, LOG_CONTEXT);
			return sessionId;
		})
	);

	// Send a message to the moderator
	ipcMain.handle(
		'groupChat:sendToModerator',
		withIpcErrorLogging(
			handlerOpts('sendToModerator'),
			async (id: string, message: string, images?: string[], readOnly?: boolean): Promise<void> => {
				console.log(`[GroupChat:Debug] ========== USER MESSAGE RECEIVED ==========`);
				console.log(`[GroupChat:Debug] Group Chat ID: ${id}`);
				console.log(
					`[GroupChat:Debug] Message: "${message.substring(0, 200)}${message.length > 200 ? '...' : ''}"`
				);
				console.log(`[GroupChat:Debug] Read-only: ${readOnly ?? false}`);
				console.log(`[GroupChat:Debug] Images: ${images?.length ?? 0}`);

				const processManager = getProcessManager();
				const agentDetector = getAgentDetector();

				console.log(`[GroupChat:Debug] Process manager available: ${!!processManager}`);
				console.log(`[GroupChat:Debug] Agent detector available: ${!!agentDetector}`);

				// Route through the user message router which handles logging and forwarding
				await routeUserMessage(
					id,
					message,
					processManager ?? undefined,
					agentDetector ?? undefined,
					readOnly
				);

				console.log(`[GroupChat:Debug] User message routed to moderator`);
				console.log(`[GroupChat:Debug] ===========================================`);

				logger.debug(`Sent message to moderator in ${id}`, LOG_CONTEXT, {
					messageLength: message.length,
					imageCount: images?.length ?? 0,
					readOnly: readOnly ?? false,
				});
			}
		)
	);

	// Stop the moderator for a group chat
	ipcMain.handle(
		'groupChat:stopModerator',
		withIpcErrorLogging(handlerOpts('stopModerator'), async (id: string): Promise<void> => {
			const processManager = getProcessManager();
			await killModerator(id, processManager ?? undefined);
			logger.info(`Stopped moderator for group chat: ${id}`, LOG_CONTEXT);
		})
	);

	// Get the moderator session ID (for checking if active)
	ipcMain.handle(
		'groupChat:getModeratorSessionId',
		withIpcErrorLogging(
			handlerOpts('getModeratorSessionId'),
			async (id: string): Promise<string | null> => {
				return getModeratorSessionId(id) ?? null;
			}
		)
	);

	// ========== Participant Handlers ==========

	// Add a participant to the group chat
	ipcMain.handle(
		'groupChat:addParticipant',
		withIpcErrorLogging(
			handlerOpts('addParticipant'),
			async (
				id: string,
				name: string,
				agentId: string,
				cwd?: string
			): Promise<GroupChatParticipant> => {
				const processManager = getProcessManager();
				if (!processManager) {
					throw new Error('Process manager not initialized');
				}

				const agentDetector = getAgentDetector();
				const customEnvVars = getCustomEnvVars?.(agentId);
				const agentConfigValues = getAgentConfig?.(agentId) || {};

				logger.info(`Adding participant ${name} (${agentId}) to ${id}`, LOG_CONTEXT);
				const participant = await addParticipant(
					id,
					name,
					agentId,
					processManager,
					cwd || process.env.HOME || '/tmp',
					agentDetector ?? undefined,
					agentConfigValues,
					customEnvVars
				);
				logger.info(`Added participant: ${name}`, LOG_CONTEXT);
				return participant;
			}
		)
	);

	// Send a message to a specific participant
	ipcMain.handle(
		'groupChat:sendToParticipant',
		withIpcErrorLogging(
			handlerOpts('sendToParticipant'),
			async (id: string, name: string, message: string, images?: string[]): Promise<void> => {
				const processManager = getProcessManager();
				await sendToParticipant(id, name, message, processManager ?? undefined);

				logger.debug(`Sent message to participant ${name} in ${id}`, LOG_CONTEXT, {
					messageLength: message.length,
					imageCount: images?.length ?? 0,
				});
			}
		)
	);

	// Remove a participant from the group chat
	ipcMain.handle(
		'groupChat:removeParticipant',
		withIpcErrorLogging(
			handlerOpts('removeParticipant'),
			async (id: string, name: string): Promise<void> => {
				const processManager = getProcessManager();
				await removeParticipant(id, name, processManager ?? undefined);
				logger.info(`Removed participant ${name} from ${id}`, LOG_CONTEXT);
			}
		)
	);

	// Reset participant context - summarize current session and start fresh
	ipcMain.handle(
		'groupChat:resetParticipantContext',
		withIpcErrorLogging(
			handlerOpts('resetParticipantContext'),
			async (
				groupChatId: string,
				participantName: string,
				cwd?: string
			): Promise<{ newAgentSessionId: string }> => {
				logger.info(
					`Resetting context for participant ${participantName} in ${groupChatId}`,
					LOG_CONTEXT
				);

				const chat = await loadGroupChat(groupChatId);
				if (!chat) {
					throw new Error(`Group chat not found: ${groupChatId}`);
				}

				const participant = chat.participants.find((p) => p.name === participantName);
				if (!participant) {
					throw new Error(`Participant not found: ${participantName}`);
				}

				const processManager = getProcessManager();
				if (!processManager) {
					throw new Error('Process manager not initialized');
				}

				const agentDetector = getAgentDetector();
				if (!agentDetector) {
					throw new Error('Agent detector not initialized');
				}

				// Get the group chat folder for file access
				const groupChatFolder = getGroupChatDir(groupChatId);
				const effectiveCwd = cwd || process.env.HOME || '/tmp';

				// Build a context summary prompt to ask the agent to summarize its current state
				const summaryPrompt = `You are "${participantName}" in the group chat "${chat.name}".
The shared group chat folder is: ${groupChatFolder}

Your context window is getting full. Please provide a concise summary of:
1. What you've been working on in this group chat
2. Key decisions made and their rationale
3. Current state of any ongoing tasks
4. Important context that should be preserved for continuity

This summary will be used to initialize your fresh session so you can continue seamlessly.

Respond with ONLY the summary text, no additional commentary.`;

				// Use the shared groomContext utility to get the summary
				// This spawns a batch process, collects the response, and handles cleanup
				let summaryResponse = '';
				try {
					const result = await groomContext(
						{
							projectRoot: effectiveCwd,
							agentType: participant.agentId,
							prompt: summaryPrompt,
							agentSessionId: participant.agentSessionId, // Resume existing session for context
							readOnlyMode: true, // Summary is read-only
							timeoutMs: 60000, // 60 second timeout for summary
						},
						processManager,
						agentDetector
					);
					summaryResponse = result.response;
					logger.info(`Context summary collected for ${participantName}`, LOG_CONTEXT, {
						responseLength: summaryResponse.length,
						durationMs: result.durationMs,
					});
				} catch (error) {
					logger.warn(`Summary generation failed for ${participantName}: ${error}`, LOG_CONTEXT);
					summaryResponse = 'No summary available - starting fresh session.';
				}

				// Generate a new agent session ID (the actual UUID will be set when the agent responds)
				const newSessionMarker = uuidv4();

				// Update the participant with a cleared agentSessionId
				// The next interaction will establish a new session
				await updateParticipant(groupChatId, participantName, {
					agentSessionId: undefined, // Clear to force new session
					contextUsage: 0, // Reset context usage
				});

				// Emit participants changed event
				const updatedChat = await loadGroupChat(groupChatId);
				if (updatedChat) {
					groupChatEmitters.emitParticipantsChanged?.(groupChatId, updatedChat.participants);
				}

				logger.info(
					`Reset context for ${participantName}, new session marker: ${newSessionMarker}`,
					LOG_CONTEXT
				);

				return { newAgentSessionId: newSessionMarker };
			}
		)
	);

	// ========== History Handlers ==========

	// Get all history entries for a group chat
	ipcMain.handle(
		'groupChat:getHistory',
		withIpcErrorLogging(
			handlerOpts('getHistory'),
			async (id: string): Promise<GroupChatHistoryEntry[]> => {
				logger.debug(`Getting history for group chat: ${id}`, LOG_CONTEXT);
				const entries = await getGroupChatHistory(id);
				logger.debug(`Retrieved ${entries.length} history entries for ${id}`, LOG_CONTEXT);
				return entries;
			}
		)
	);

	// Add a history entry (called internally by the moderator flow)
	ipcMain.handle(
		'groupChat:addHistoryEntry',
		withIpcErrorLogging(
			handlerOpts('addHistoryEntry'),
			async (
				id: string,
				entry: Omit<GroupChatHistoryEntry, 'id'>
			): Promise<GroupChatHistoryEntry> => {
				logger.debug(`Adding history entry to ${id}`, LOG_CONTEXT, {
					type: entry.type,
					participant: entry.participantName,
				});
				const created = await addGroupChatHistoryEntry(id, entry);
				// Emit to renderer
				groupChatEmitters.emitHistoryEntry?.(id, created);
				return created;
			}
		)
	);

	// Delete a history entry
	ipcMain.handle(
		'groupChat:deleteHistoryEntry',
		withIpcErrorLogging(
			handlerOpts('deleteHistoryEntry'),
			async (groupChatId: string, entryId: string): Promise<boolean> => {
				logger.debug(`Deleting history entry ${entryId} from ${groupChatId}`, LOG_CONTEXT);
				return deleteGroupChatHistoryEntry(groupChatId, entryId);
			}
		)
	);

	// Clear all history for a group chat
	ipcMain.handle(
		'groupChat:clearHistory',
		withIpcErrorLogging(handlerOpts('clearHistory'), async (id: string): Promise<void> => {
			logger.info(`Clearing history for group chat: ${id}`, LOG_CONTEXT);
			await clearGroupChatHistory(id);
		})
	);

	// Get the history file path (for AI context integration)
	ipcMain.handle(
		'groupChat:getHistoryFilePath',
		withIpcErrorLogging(
			handlerOpts('getHistoryFilePath'),
			async (id: string): Promise<string | null> => {
				return getGroupChatHistoryFilePath(id);
			}
		)
	);

	// Get all images from a group chat as base64 data URLs
	ipcMain.handle(
		'groupChat:getImages',
		withIpcErrorLogging(
			handlerOpts('getImages'),
			async (id: string): Promise<Record<string, string>> => {
				const chat = await loadGroupChat(id);
				if (!chat) {
					throw new Error(`Group chat not found: ${id}`);
				}

				const images: Record<string, string> = {};
				const fs = await import('fs/promises');
				const path = await import('path');

				try {
					const files = await fs.readdir(chat.imagesDir);
					const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

					for (const file of files) {
						const ext = path.extname(file).toLowerCase();
						if (imageExtensions.includes(ext)) {
							const filePath = path.join(chat.imagesDir, file);
							const buffer = await fs.readFile(filePath);
							const mimeType =
								ext === '.png'
									? 'image/png'
									: ext === '.gif'
										? 'image/gif'
										: ext === '.webp'
											? 'image/webp'
											: 'image/jpeg';
							images[file] = `data:${mimeType};base64,${buffer.toString('base64')}`;
						}
					}
				} catch (error: unknown) {
					// Directory might not exist or be empty, that's fine
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
						logger.warn(`Error reading images directory: ${error}`, LOG_CONTEXT);
					}
				}

				logger.debug(`Retrieved ${Object.keys(images).length} images from ${id}`, LOG_CONTEXT);
				return images;
			}
		)
	);

	// ========== Event Emission Helpers ==========
	// These are stored in module scope for access by the exported emitters

	/**
	 * Emit a new message event to the renderer.
	 * Called when a new message is added to any group chat.
	 */
	groupChatEmitters.emitMessage = (groupChatId: string, message: GroupChatMessage): void => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send('groupChat:message', groupChatId, message);
		}
	};

	/**
	 * Emit a state change event to the renderer.
	 * Called when the group chat state changes (idle, moderator-thinking, agent-working).
	 */
	groupChatEmitters.emitStateChange = (groupChatId: string, state: GroupChatState): void => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send('groupChat:stateChange', groupChatId, state);
		}
	};

	/**
	 * Emit a participants changed event to the renderer.
	 * Called when participants are added or removed from a group chat.
	 */
	groupChatEmitters.emitParticipantsChanged = (
		groupChatId: string,
		participants: GroupChatParticipant[]
	): void => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send('groupChat:participantsChanged', groupChatId, participants);
		}
	};

	/**
	 * Emit moderator usage stats to the renderer.
	 * Called when the moderator process reports usage statistics.
	 */
	groupChatEmitters.emitModeratorUsage = (groupChatId: string, usage: ModeratorUsage): void => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send('groupChat:moderatorUsage', groupChatId, usage);
		}
	};

	/**
	 * Emit a new history entry event to the renderer.
	 * Called when a new history entry is added to any group chat.
	 */
	groupChatEmitters.emitHistoryEntry = (
		groupChatId: string,
		entry: GroupChatHistoryEntry
	): void => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send('groupChat:historyEntry', groupChatId, entry);
		}
	};

	/**
	 * Emit a participant state change event to the renderer.
	 * Called when a participant starts or finishes working.
	 */
	groupChatEmitters.emitParticipantState = (
		groupChatId: string,
		participantName: string,
		state: ParticipantState
	): void => {
		console.log(
			`[GroupChat:IPC] emitParticipantState: chatId=${groupChatId}, participant=${participantName}, state=${state}`
		);
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send(
				'groupChat:participantState',
				groupChatId,
				participantName,
				state
			);
			console.log(`[GroupChat:IPC] Sent 'groupChat:participantState' event`);
		} else {
			console.warn(
				`[GroupChat:IPC] WARNING: mainWindow not available, cannot send participant state`
			);
		}
	};

	/**
	 * Emit a moderator session ID change event to the renderer.
	 * Called when the moderator's real agent session ID is captured.
	 */
	groupChatEmitters.emitModeratorSessionIdChanged = (
		groupChatId: string,
		sessionId: string
	): void => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send('groupChat:moderatorSessionIdChanged', groupChatId, sessionId);
		}
	};

	logger.info('Registered Group Chat IPC handlers', LOG_CONTEXT);
}
