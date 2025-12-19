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
  GroupChat,
  GroupChatParticipant,
} from '../../group-chat/group-chat-storage';

// Group chat log imports
import {
  appendToLog,
  readLog,
  saveImage,
  GroupChatMessage,
} from '../../group-chat/group-chat-log';

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

const LOG_CONTEXT = '[GroupChat]';

/**
 * Module-level object to store emitter functions after initialization.
 * These can be used by other modules to emit messages and state changes.
 */
export const groupChatEmitters: {
  emitMessage?: (groupChatId: string, message: GroupChatMessage) => void;
  emitStateChange?: (groupChatId: string, state: GroupChatState) => void;
  emitParticipantsChanged?: (groupChatId: string, participants: GroupChatParticipant[]) => void;
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
  }): { pid: number; success: boolean };
  write(sessionId: string, data: string): boolean;
  kill(sessionId: string): boolean;
}

/**
 * Dependencies required for group chat handler registration
 */
export interface GroupChatHandlerDependencies {
  getMainWindow: () => BrowserWindow | null;
  getProcessManager: () => GenericProcessManager | null;
  getAgentDetector: () => AgentDetector | null;
  getCustomEnvVars?: (agentId: string) => Record<string, string> | undefined;
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
  const { getMainWindow, getProcessManager, getAgentDetector, getCustomEnvVars } = deps;

  // ========== Storage Handlers ==========

  // Create a new group chat
  ipcMain.handle(
    'groupChat:create',
    withIpcErrorLogging(handlerOpts('create'), async (
      name: string,
      moderatorAgentId: string,
      moderatorConfig?: { customPath?: string; customArgs?: string; customEnvVars?: Record<string, string> }
    ): Promise<GroupChat> => {
      logger.info(`Creating group chat: ${name}`, LOG_CONTEXT, { moderatorAgentId, hasConfig: !!moderatorConfig });
      const chat = await createGroupChat(name, moderatorAgentId, moderatorConfig);
      logger.info(`Created group chat: ${chat.id}`, LOG_CONTEXT);
      return chat;
    })
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
    withIpcErrorLogging(handlerOpts('rename'), async (id: string, name: string): Promise<GroupChat> => {
      logger.info(`Renaming group chat ${id} to: ${name}`, LOG_CONTEXT);
      const updated = await updateGroupChat(id, { name });
      return updated;
    })
  );

  // ========== Chat Log Handlers ==========

  // Append a message to the chat log
  ipcMain.handle(
    'groupChat:appendMessage',
    withIpcErrorLogging(handlerOpts('appendMessage'), async (id: string, from: string, content: string): Promise<void> => {
      const chat = await loadGroupChat(id);
      if (!chat) {
        throw new Error(`Group chat not found: ${id}`);
      }
      await appendToLog(chat.logPath, from, content);
      logger.debug(`Appended message to ${id} from ${from}`, LOG_CONTEXT);
    })
  );

  // Get all messages from the chat log
  ipcMain.handle(
    'groupChat:getMessages',
    withIpcErrorLogging(handlerOpts('getMessages'), async (id: string): Promise<GroupChatMessage[]> => {
      const chat = await loadGroupChat(id);
      if (!chat) {
        throw new Error(`Group chat not found: ${id}`);
      }
      const messages = await readLog(chat.logPath);
      logger.debug(`Read ${messages.length} messages from ${id}`, LOG_CONTEXT);
      return messages;
    })
  );

  // Save an image to the group chat's images directory
  ipcMain.handle(
    'groupChat:saveImage',
    withIpcErrorLogging(handlerOpts('saveImage'), async (id: string, imageData: string, filename: string): Promise<string> => {
      const chat = await loadGroupChat(id);
      if (!chat) {
        throw new Error(`Group chat not found: ${id}`);
      }
      const buffer = Buffer.from(imageData, 'base64');
      const savedFilename = await saveImage(chat.imagesDir, buffer, filename);
      logger.debug(`Saved image to ${id}: ${savedFilename}`, LOG_CONTEXT);
      return savedFilename;
    })
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
    withIpcErrorLogging(handlerOpts('sendToModerator'), async (id: string, message: string, images?: string[], readOnly?: boolean): Promise<void> => {
      const processManager = getProcessManager();
      const agentDetector = getAgentDetector();

      // Route through the user message router which handles logging and forwarding
      await routeUserMessage(id, message, processManager ?? undefined, agentDetector ?? undefined, readOnly);

      logger.debug(`Sent message to moderator in ${id}`, LOG_CONTEXT, {
        messageLength: message.length,
        imageCount: images?.length ?? 0,
        readOnly: readOnly ?? false,
      });
    })
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
    withIpcErrorLogging(handlerOpts('getModeratorSessionId'), async (id: string): Promise<string | null> => {
      return getModeratorSessionId(id) ?? null;
    })
  );

  // ========== Participant Handlers ==========

  // Add a participant to the group chat
  ipcMain.handle(
    'groupChat:addParticipant',
    withIpcErrorLogging(
      handlerOpts('addParticipant'),
      async (id: string, name: string, agentId: string, cwd?: string): Promise<GroupChatParticipant> => {
        const processManager = getProcessManager();
        if (!processManager) {
          throw new Error('Process manager not initialized');
        }

        const agentDetector = getAgentDetector();
        const customEnvVars = getCustomEnvVars?.(agentId);

        logger.info(`Adding participant ${name} (${agentId}) to ${id}`, LOG_CONTEXT);
        const participant = await addParticipant(
          id,
          name,
          agentId,
          processManager,
          cwd || process.env.HOME || '/tmp',
          agentDetector ?? undefined,
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
    withIpcErrorLogging(handlerOpts('removeParticipant'), async (id: string, name: string): Promise<void> => {
      const processManager = getProcessManager();
      await removeParticipant(id, name, processManager ?? undefined);
      logger.info(`Removed participant ${name} from ${id}`, LOG_CONTEXT);
    })
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
  groupChatEmitters.emitParticipantsChanged = (groupChatId: string, participants: GroupChatParticipant[]): void => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('groupChat:participantsChanged', groupChatId, participants);
    }
  };

  logger.info('Registered Group Chat IPC handlers', LOG_CONTEXT);
}
