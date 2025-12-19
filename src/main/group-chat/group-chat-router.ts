/**
 * @file group-chat-router.ts
 * @description Message routing for Group Chat feature.
 *
 * Routes messages between:
 * - User -> Moderator
 * - Moderator -> Participants (via @mentions)
 * - Participants -> Moderator
 */

import { GroupChatParticipant, loadGroupChat, updateParticipant } from './group-chat-storage';
import { appendToLog, readLog } from './group-chat-log';
import type { GroupChatMessage } from '../../shared/group-chat-types';

/**
 * Normalize a name for @mention matching.
 * Converts spaces to hyphens for consistent matching.
 */
function normalizeMentionName(name: string): string {
  return name.replace(/\s+/g, '-');
}

/**
 * Check if a mentioned name matches a session/participant name.
 * Handles both exact match and normalized (hyphenated) match.
 */
function mentionMatchesName(mentionedName: string, actualName: string): boolean {
  return mentionedName.toLowerCase() === actualName.toLowerCase() ||
         mentionedName.toLowerCase() === normalizeMentionName(actualName).toLowerCase();
}
import {
  IProcessManager,
  getModeratorSessionId,
  isModeratorActive,
  MODERATOR_SYSTEM_PROMPT,
} from './group-chat-moderator';
import {
  addParticipant,
  getParticipantSessionId,
  isParticipantActive,
} from './group-chat-agent';
import { AgentDetector } from '../agent-detector';

// Import emitters from IPC handlers (will be populated after handlers are registered)
import { groupChatEmitters } from '../ipc/handlers/groupChat';

/**
 * Session info for matching @mentions to available Maestro sessions.
 */
export interface SessionInfo {
  id: string;
  name: string;
  toolType: string;
  cwd: string;
}

/**
 * Callback type for getting available sessions from the renderer.
 */
export type GetSessionsCallback = () => SessionInfo[];

/**
 * Callback type for getting custom environment variables for an agent.
 */
export type GetCustomEnvVarsCallback = (agentId: string) => Record<string, string> | undefined;

// Module-level callback for session lookup
let getSessionsCallback: GetSessionsCallback | null = null;

// Module-level callback for custom env vars lookup
let getCustomEnvVarsCallback: GetCustomEnvVarsCallback | null = null;

/**
 * Sets the callback for getting available sessions.
 * Called from index.ts during initialization.
 */
export function setGetSessionsCallback(callback: GetSessionsCallback): void {
  getSessionsCallback = callback;
}

/**
 * Sets the callback for getting custom environment variables.
 * Called from index.ts during initialization.
 */
export function setGetCustomEnvVarsCallback(callback: GetCustomEnvVarsCallback): void {
  getCustomEnvVarsCallback = callback;
}

/**
 * Extracts @mentions from text that match known participants.
 * Supports hyphenated names matching participants with spaces.
 *
 * @param text - The text to search for mentions
 * @param participants - List of valid participants
 * @returns Array of participant names that were mentioned (using original names, not hyphenated)
 */
export function extractMentions(
  text: string,
  participants: GroupChatParticipant[]
): string[] {
  const mentions: string[] = [];

  // Match @Name patterns (alphanumeric, underscores, dots, and hyphens)
  // Supports names like @RunMaestro.ai, @my-agent, @Maestro-Playbooks, etc.
  const mentionPattern = /@([\w.-]+)/g;
  let match;

  while ((match = mentionPattern.exec(text)) !== null) {
    const mentionedName = match[1];
    // Find participant that matches (either exact or normalized)
    const matchingParticipant = participants.find(p =>
      mentionMatchesName(mentionedName, p.name)
    );
    if (matchingParticipant && !mentions.includes(matchingParticipant.name)) {
      mentions.push(matchingParticipant.name);
    }
  }

  return mentions;
}

/**
 * Extracts ALL @mentions from text (regardless of whether they're participants).
 *
 * @param text - The text to search for mentions
 * @returns Array of unique names that were mentioned (without @ prefix)
 */
export function extractAllMentions(text: string): string[] {
  const mentions: string[] = [];

  // Match @Name patterns (alphanumeric, underscores, dots, and hyphens)
  // Supports names like @RunMaestro.ai, @my-agent, etc.
  const mentionPattern = /@([\w.-]+)/g;
  let match;

  while ((match = mentionPattern.exec(text)) !== null) {
    const name = match[1];
    if (!mentions.includes(name)) {
      mentions.push(name);
    }
  }

  return mentions;
}

/**
 * Routes a user message to the moderator.
 *
 * Spawns a batch process for the moderator to handle this specific message.
 * The chat history is included in the system prompt for context.
 *
 * @param groupChatId - The ID of the group chat
 * @param message - The message from the user
 * @param processManager - The process manager (optional)
 * @param agentDetector - The agent detector for resolving agent commands (optional)
 * @param readOnly - Optional flag indicating read-only mode
 */
export async function routeUserMessage(
  groupChatId: string,
  message: string,
  processManager?: IProcessManager,
  agentDetector?: AgentDetector,
  readOnly?: boolean
): Promise<void> {
  let chat = await loadGroupChat(groupChatId);
  if (!chat) {
    throw new Error(`Group chat not found: ${groupChatId}`);
  }

  if (!isModeratorActive(groupChatId)) {
    throw new Error(`Moderator is not active for group chat: ${groupChatId}`);
  }

  // Auto-add participants mentioned by the user if they match available sessions
  if (processManager && agentDetector && getSessionsCallback) {
    const userMentions = extractAllMentions(message);
    const sessions = getSessionsCallback();
    const existingParticipantNames = new Set(chat.participants.map(p => p.name));

    for (const mentionedName of userMentions) {
      // Skip if already a participant (check both exact and normalized names)
      const alreadyParticipant = Array.from(existingParticipantNames).some(
        existingName => mentionMatchesName(mentionedName, existingName)
      );
      if (alreadyParticipant) {
        continue;
      }

      // Find matching session by name (supports both exact and hyphenated names)
      const matchingSession = sessions.find(s =>
        mentionMatchesName(mentionedName, s.name) && s.toolType !== 'terminal'
      );

      if (matchingSession) {
        try {
          // Use the original session name as the participant name
          const participantName = matchingSession.name;
          console.log(`[GroupChatRouter] Auto-adding participant @${participantName} from user mention @${mentionedName} (session ${matchingSession.id})`);
          // Get custom env vars for this agent type
          const customEnvVars = getCustomEnvVarsCallback?.(matchingSession.toolType);
          await addParticipant(
            groupChatId,
            participantName,
            matchingSession.toolType,
            processManager,
            matchingSession.cwd,
            agentDetector,
            customEnvVars
          );
          existingParticipantNames.add(participantName);

          // Emit participant changed event so UI updates
          const updatedChatForEmit = await loadGroupChat(groupChatId);
          if (updatedChatForEmit) {
            groupChatEmitters.emitParticipantsChanged?.(groupChatId, updatedChatForEmit.participants);
          }
        } catch (error) {
          console.error(`[GroupChatRouter] Failed to auto-add participant ${mentionedName} from user mention:`, error);
          // Continue with other participants even if one fails
        }
      }
    }

    // Reload chat to get updated participants list
    chat = await loadGroupChat(groupChatId);
    if (!chat) {
      throw new Error(`Group chat not found after participant update: ${groupChatId}`);
    }
  }

  // Log the message as coming from user
  await appendToLog(chat.logPath, 'user', message, readOnly);

  // Emit message event to renderer so it shows immediately
  const userMessage: GroupChatMessage = {
    timestamp: new Date().toISOString(),
    from: 'user',
    content: message,
    readOnly,
  };
  groupChatEmitters.emitMessage?.(groupChatId, userMessage);

  // Spawn a batch process for the moderator to handle this message
  // The response will be captured via the process:data event handler in index.ts
  if (processManager && agentDetector) {
    const sessionIdPrefix = getModeratorSessionId(groupChatId);
    if (sessionIdPrefix) {
      // Create a unique session ID for this message
      const sessionId = `${sessionIdPrefix}-${Date.now()}`;

      // Resolve the agent configuration to get the executable command
      const agent = await agentDetector.getAgent(chat.moderatorAgentId);
      if (!agent || !agent.available) {
        throw new Error(`Agent '${chat.moderatorAgentId}' is not available`);
      }

      // Use custom path from moderator config if set, otherwise use resolved path
      const command = chat.moderatorConfig?.customPath || agent.path || agent.command;
      // Get the base args from the agent configuration
      const args = [...agent.args];
      // Append custom args from moderator config if set
      if (chat.moderatorConfig?.customArgs) {
        // Parse custom args string into array (simple space-split, handles quoted strings)
        const customArgsStr = chat.moderatorConfig.customArgs.trim();
        if (customArgsStr) {
          // Match quoted strings or non-space sequences
          const customArgsArray = customArgsStr.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
          args.push(...customArgsArray.map(arg => arg.replace(/^["']|["']$/g, '')));
        }
      }

      // Build participant context
      const participantContext = chat.participants.length > 0
        ? chat.participants.map(p => `- @${p.name} (${p.agentId} session)`).join('\n')
        : '(No agents currently in this group chat)';

      // Build available sessions context (sessions that could be added)
      let availableSessionsContext = '';
      if (getSessionsCallback) {
        const sessions = getSessionsCallback();
        const participantNames = new Set(chat.participants.map(p => p.name));
        const availableSessions = sessions.filter(s =>
          s.toolType !== 'terminal' && !participantNames.has(s.name)
        );
        if (availableSessions.length > 0) {
          availableSessionsContext = `\n\n## Available Maestro Sessions (can be added via @mention):\n${availableSessions.map(s => `- @${s.name} (${s.toolType})`).join('\n')}`;
        }
      }

      // Build the prompt with context
      const chatHistory = await readLog(chat.logPath);
      const historyContext = chatHistory.slice(-20).map(m =>
        `[${m.from}]: ${m.content}`
      ).join('\n');

      const fullPrompt = `${MODERATOR_SYSTEM_PROMPT}

## Current Participants:
${participantContext}${availableSessionsContext}

## Chat History:
${historyContext}

## User Request${readOnly ? ' (READ-ONLY MODE - do not make changes)' : ''}:
${message}`;

      // Spawn the moderator process in batch mode
      try {
        processManager.spawn({
          sessionId,
          toolType: chat.moderatorAgentId,
          cwd: process.env.HOME || '/tmp',
          command,
          args,
          readOnlyMode: true,
          prompt: fullPrompt,
        });
      } catch (error) {
        console.error(`[GroupChatRouter] Failed to spawn moderator for ${groupChatId}:`, error);
        throw new Error(`Failed to spawn moderator: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else if (processManager && !agentDetector) {
    console.error(`[GroupChatRouter] AgentDetector not available, cannot spawn moderator`);
    throw new Error('AgentDetector not available');
  }
}

/**
 * Routes a moderator response, forwarding to mentioned agents.
 *
 * - Logs the message as coming from 'moderator'
 * - Extracts @mentions and auto-adds new participants from available sessions
 * - Forwards message to mentioned participants
 *
 * @param groupChatId - The ID of the group chat
 * @param message - The message from the moderator
 * @param processManager - The process manager (optional)
 * @param agentDetector - The agent detector for resolving agent commands (optional)
 */
export async function routeModeratorResponse(
  groupChatId: string,
  message: string,
  processManager?: IProcessManager,
  agentDetector?: AgentDetector
): Promise<void> {
  const chat = await loadGroupChat(groupChatId);
  if (!chat) {
    throw new Error(`Group chat not found: ${groupChatId}`);
  }

  // Log the message as coming from moderator
  await appendToLog(chat.logPath, 'moderator', message);

  // Emit message event to renderer so it shows immediately
  const moderatorMessage: GroupChatMessage = {
    timestamp: new Date().toISOString(),
    from: 'moderator',
    content: message,
  };
  groupChatEmitters.emitMessage?.(groupChatId, moderatorMessage);

  // Extract ALL mentions from the message
  const allMentions = extractAllMentions(message);
  const existingParticipantNames = new Set(chat.participants.map(p => p.name));

  // Check for mentions that aren't already participants but match available sessions
  if (processManager && getSessionsCallback) {
    const sessions = getSessionsCallback();

    for (const mentionedName of allMentions) {
      // Skip if already a participant (check both exact and normalized names)
      const alreadyParticipant = Array.from(existingParticipantNames).some(
        existingName => mentionMatchesName(mentionedName, existingName)
      );
      if (alreadyParticipant) {
        continue;
      }

      // Find matching session by name (supports both exact and hyphenated names)
      const matchingSession = sessions.find(s =>
        mentionMatchesName(mentionedName, s.name) && s.toolType !== 'terminal'
      );

      if (matchingSession) {
        try {
          // Use the original session name as the participant name
          const participantName = matchingSession.name;
          console.log(`[GroupChatRouter] Auto-adding participant @${participantName} from moderator mention @${mentionedName} (session ${matchingSession.id})`);
          // Get custom env vars for this agent type
          const customEnvVars = getCustomEnvVarsCallback?.(matchingSession.toolType);
          await addParticipant(
            groupChatId,
            participantName,
            matchingSession.toolType,
            processManager,
            matchingSession.cwd,
            agentDetector,
            customEnvVars
          );
          existingParticipantNames.add(participantName);

          // Emit participant changed event so UI updates
          const updatedChatForEmit = await loadGroupChat(groupChatId);
          if (updatedChatForEmit) {
            groupChatEmitters.emitParticipantsChanged?.(groupChatId, updatedChatForEmit.participants);
          }
        } catch (error) {
          console.error(`[GroupChatRouter] Failed to auto-add participant ${mentionedName}:`, error);
          // Continue with other participants even if one fails
        }
      }
    }
  }

  // Now extract mentions that are actual participants (including newly added ones)
  // Reload chat to get updated participants list
  const updatedChat = await loadGroupChat(groupChatId);
  if (!updatedChat) {
    return;
  }

  const mentions = extractMentions(message, updatedChat.participants);

  if (processManager) {
    for (const participantName of mentions) {
      if (isParticipantActive(groupChatId, participantName)) {
        const sessionId = getParticipantSessionId(groupChatId, participantName);
        if (sessionId) {
          try {
            // Send the full message to the mentioned participant
            processManager.write(sessionId, message + '\n');
          } catch (error) {
            console.error(`[GroupChatRouter] Failed to write to participant ${participantName}:`, error);
            // Continue with other participants even if one fails
          }
        }
      }
    }
  }
}

/**
 * Routes an agent's response back to the moderator.
 *
 * - Logs the message as coming from the participant
 * - Notifies the moderator of the response
 *
 * @param groupChatId - The ID of the group chat
 * @param participantName - The name of the responding participant
 * @param message - The message from the participant
 * @param processManager - The process manager (optional)
 */
export async function routeAgentResponse(
  groupChatId: string,
  participantName: string,
  message: string,
  processManager?: IProcessManager
): Promise<void> {
  const chat = await loadGroupChat(groupChatId);
  if (!chat) {
    throw new Error(`Group chat not found: ${groupChatId}`);
  }

  // Verify participant exists
  const participant = chat.participants.find((p) => p.name === participantName);
  if (!participant) {
    throw new Error(`Participant '${participantName}' not found in group chat`);
  }

  // Log the message as coming from the participant
  await appendToLog(chat.logPath, participantName, message);

  // Emit message event to renderer so it shows immediately
  const agentMessage: GroupChatMessage = {
    timestamp: new Date().toISOString(),
    from: participantName,
    content: message,
  };
  groupChatEmitters.emitMessage?.(groupChatId, agentMessage);

  // Update participant stats
  const currentParticipant = participant;
  const newMessageCount = (currentParticipant.messageCount || 0) + 1;
  // Generate a brief summary from the message (first 50 chars)
  const summary = message.length > 50 ? message.slice(0, 50) + '...' : message;

  try {
    await updateParticipant(groupChatId, participantName, {
      lastActivity: Date.now(),
      lastSummary: summary,
      messageCount: newMessageCount,
    });

    // Emit participants changed so UI updates
    const updatedChat = await loadGroupChat(groupChatId);
    if (updatedChat) {
      groupChatEmitters.emitParticipantsChanged?.(groupChatId, updatedChat.participants);
    }
  } catch (error) {
    console.error(`[GroupChatRouter] Failed to update participant stats for ${participantName}:`, error);
    // Don't throw - stats update failure shouldn't break the message flow
  }

  // Notify moderator
  if (processManager && isModeratorActive(groupChatId)) {
    const sessionId = getModeratorSessionId(groupChatId);
    if (sessionId) {
      try {
        // Format the notification to clearly indicate who responded
        const notification = `[${participantName}]: ${message}`;
        processManager.write(sessionId, notification + '\n');
      } catch (error) {
        console.error(`[GroupChatRouter] Failed to notify moderator from ${participantName}:`, error);
        // Don't throw - the message was already logged
      }
    }
  }
}
