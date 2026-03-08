/**
 * @file group-chat-router.ts
 * @description Message routing for Group Chat feature.
 *
 * Routes messages between:
 * - User -> Moderator
 * - Moderator -> Participants (via @mentions)
 * - Participants -> Moderator
 */

import * as os from 'os';
import * as path from 'path';
import {
	GroupChatParticipant,
	loadGroupChat,
	updateParticipant,
	addGroupChatHistoryEntry,
	extractFirstSentence,
	getGroupChatDir,
} from './group-chat-storage';
import { appendToLog, readLog, saveImage } from './group-chat-log';
import {
	type GroupChatMessage,
	mentionMatches,
	normalizeMentionName,
} from '../../shared/group-chat-types';
import {
	IProcessManager,
	getModeratorSessionId,
	isModeratorActive,
	getModeratorSystemPrompt,
	getModeratorSynthesisPrompt,
} from './group-chat-moderator';
import { addParticipant } from './group-chat-agent';
import { AgentDetector } from '../agents';
import { powerManager } from '../power-manager';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import {
	buildAgentArgs,
	applyAgentConfigOverrides,
	getContextWindowValue,
} from '../utils/agent-args';
import { groupChatParticipantRequestPrompt } from '../../prompts';
import { wrapSpawnWithSsh } from '../utils/ssh-spawn-wrapper';
import type { SshRemoteSettingsStore } from '../utils/ssh-remote-resolver';
import { setGetCustomShellPathCallback, getWindowsSpawnConfig } from './group-chat-config';

// Import emitters from IPC handlers (will be populated after handlers are registered)
import { groupChatEmitters } from '../ipc/handlers/groupChat';

const LOG_CONTEXT = '[GroupChatRouter]';

// Re-export setGetCustomShellPathCallback for index.ts to use
export { setGetCustomShellPathCallback };

/**
 * Session info for matching @mentions to available Maestro sessions.
 */
export interface SessionInfo {
	id: string;
	name: string;
	toolType: string;
	cwd: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	customModel?: string;
	/** SSH remote name for display in participant card */
	sshRemoteName?: string;
	/** Full SSH remote config for remote execution */
	sshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
}

/**
 * Callback type for getting available sessions from the renderer.
 */
export type GetSessionsCallback = () => SessionInfo[];

/**
 * Callback type for getting custom environment variables for an agent.
 */
export type GetCustomEnvVarsCallback = (agentId: string) => Record<string, string> | undefined;
export type GetAgentConfigCallback = (agentId: string) => Record<string, any> | undefined;

// Module-level callback for session lookup
let getSessionsCallback: GetSessionsCallback | null = null;

// Module-level callback for custom env vars lookup
let getCustomEnvVarsCallback: GetCustomEnvVarsCallback | null = null;
let getAgentConfigCallback: GetAgentConfigCallback | null = null;

// Module-level SSH store for remote execution support
let sshStore: SshRemoteSettingsStore | null = null;

/**
 * Build additional --include-directories args for Gemini CLI in group chat.
 * Gemini CLI has stricter sandbox enforcement than other agents and needs
 * explicit directory approval for each path it accesses. In group chat,
 * this means the project directories, the group chat shared folder, and
 * the home directory all need to be included.
 *
 * For non-Gemini agents, returns an empty array (no-op).
 */
function buildGeminiWorkspaceDirArgs(
	agent: { workingDirArgs?: (dir: string) => string[]; id?: string } | null | undefined,
	agentId: string,
	directories: string[]
): string[] {
	if (agentId !== 'gemini-cli' || !agent?.workingDirArgs) {
		return [];
	}
	const args: string[] = [];
	const seen = new Set<string>();
	for (const dir of directories) {
		if (dir && dir.trim() && !seen.has(dir)) {
			seen.add(dir);
			args.push(...agent.workingDirArgs(dir));
		}
	}
	return args;
}

/**
 * Tracks pending participant responses for each group chat.
 * When all pending participants have responded, we spawn a moderator synthesis round.
 * Maps groupChatId -> Set<participantName>
 */
const pendingParticipantResponses = new Map<string, Set<string>>();

/**
 * Tracks read-only mode state for each group chat.
 * Set when user sends a message with readOnly flag, cleared on next non-readOnly message.
 * Maps groupChatId -> boolean
 */
const groupChatReadOnlyState = new Map<string, boolean>();

/**
 * Gets the current read-only state for a group chat.
 */
export function getGroupChatReadOnlyState(groupChatId: string): boolean {
	return groupChatReadOnlyState.get(groupChatId) ?? false;
}

/**
 * Sets the read-only state for a group chat.
 */
export function setGroupChatReadOnlyState(groupChatId: string, readOnly: boolean): void {
	groupChatReadOnlyState.set(groupChatId, readOnly);
}

/**
 * Gets the pending participants for a group chat.
 */
export function getPendingParticipants(groupChatId: string): Set<string> {
	return pendingParticipantResponses.get(groupChatId) || new Set();
}

/**
 * Clears all pending participants for a group chat.
 */
export function clearPendingParticipants(groupChatId: string): void {
	pendingParticipantResponses.delete(groupChatId);
}

/**
 * Marks a participant as having responded (removes from pending).
 * Returns true if this was the last pending participant.
 */
export function markParticipantResponded(groupChatId: string, participantName: string): boolean {
	const pending = pendingParticipantResponses.get(groupChatId);
	if (!pending) return false;

	pending.delete(participantName);

	if (pending.size === 0) {
		pendingParticipantResponses.delete(groupChatId);
		return true; // Last participant responded
	}
	return false;
}

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

export function setGetAgentConfigCallback(callback: GetAgentConfigCallback): void {
	getAgentConfigCallback = callback;
}

/**
 * Sets the SSH store for remote execution support.
 * Called from index.ts during initialization.
 */
export function setSshStore(store: SshRemoteSettingsStore): void {
	sshStore = store;
}

/**
 * Extracts @mentions from text that match known participants.
 * Supports hyphenated names matching participants with spaces.
 *
 * @param text - The text to search for mentions
 * @param participants - List of valid participants
 * @returns Array of participant names that were mentioned (using original names, not hyphenated)
 */
export function extractMentions(text: string, participants: GroupChatParticipant[]): string[] {
	const mentions: string[] = [];

	// Match @Name patterns - captures characters after @ excluding:
	// - Whitespace and @
	// - Common punctuation that typically follows mentions: :,;!?()[]{}'"<>
	// This supports names with emojis, Unicode characters, dots, hyphens, underscores, etc.
	// Examples: @RunMaestro.ai, @my-agent, @✅-autorun-wizard, @日本語
	const mentionPattern = /@([^\s@:,;!?()\[\]{}'"<>]+)/g;
	let match;

	while ((match = mentionPattern.exec(text)) !== null) {
		const mentionedName = match[1];
		// Find participant that matches (either exact or normalized)
		const matchingParticipant = participants.find((p) => mentionMatches(mentionedName, p.name));
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

	// Match @Name patterns - captures characters after @ excluding:
	// - Whitespace and @
	// - Common punctuation that typically follows mentions: :,;!?()[]{}'"<>
	// This supports names with emojis, Unicode characters, dots, hyphens, underscores, etc.
	// Examples: @RunMaestro.ai, @my-agent, @✅-autorun-wizard, @日本語
	const mentionPattern = /@([^\s@:,;!?()\[\]{}'"<>]+)/g;
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
	readOnly?: boolean,
	images?: string[]
): Promise<void> {
	logger.debug('Route user message', LOG_CONTEXT, {
		groupChatId,
		messageLength: message.length,
		readOnly: readOnly ?? false,
		hasProcessManager: !!processManager,
		hasAgentDetector: !!agentDetector,
	});

	let chat = await loadGroupChat(groupChatId);
	if (!chat) {
		logger.debug('Group chat not found', LOG_CONTEXT, { groupChatId });
		throw new Error(`Group chat not found: ${groupChatId}`);
	}

	logger.debug('Chat loaded', LOG_CONTEXT, {
		chatName: chat.name,
		participantCount: chat.participants.length,
		moderatorAgentId: chat.moderatorAgentId,
	});

	if (!isModeratorActive(groupChatId)) {
		logger.debug('Moderator not active', LOG_CONTEXT, { groupChatId });
		throw new Error(`Moderator is not active for group chat: ${groupChatId}`);
	}

	// Auto-add participants mentioned by the user if they match available sessions
	if (processManager && agentDetector && getSessionsCallback) {
		const userMentions = extractAllMentions(message);
		const sessions = getSessionsCallback();
		const existingParticipantNames = new Set(chat.participants.map((p) => p.name));

		for (const mentionedName of userMentions) {
			// Skip if already a participant (check both exact and normalized names)
			const alreadyParticipant = Array.from(existingParticipantNames).some((existingName) =>
				mentionMatches(mentionedName, existingName)
			);
			if (alreadyParticipant) {
				continue;
			}

			// Find matching session by name (supports both exact and hyphenated names)
			const matchingSession = sessions.find(
				(s) => mentionMatches(mentionedName, s.name) && s.toolType !== 'terminal'
			);

			if (matchingSession) {
				try {
					// Use the original session name as the participant name
					const participantName = matchingSession.name;
					logger.debug('Auto-adding participant from user mention', LOG_CONTEXT, {
						participantName,
						mentionedName,
						sessionId: matchingSession.id,
					});
					// Get custom env vars for this agent type
					const customEnvVars = getCustomEnvVarsCallback?.(matchingSession.toolType);
					const agentConfigValues = getAgentConfigCallback?.(matchingSession.toolType) || {};
					await addParticipant(
						groupChatId,
						participantName,
						matchingSession.toolType,
						processManager,
						matchingSession.cwd,
						agentDetector,
						agentConfigValues,
						customEnvVars,
						// Pass session-specific overrides (customModel, customArgs, customEnvVars, sshRemoteConfig from session)
						{
							customModel: matchingSession.customModel,
							customArgs: matchingSession.customArgs,
							customEnvVars: matchingSession.customEnvVars,
							sshRemoteName: matchingSession.sshRemoteName,
							sshRemoteConfig: matchingSession.sshRemoteConfig,
						},
						// Pass SSH store for remote execution support
						sshStore ?? undefined
					);
					existingParticipantNames.add(participantName);

					// Emit participant changed event so UI updates
					const updatedChatForEmit = await loadGroupChat(groupChatId);
					if (updatedChatForEmit) {
						groupChatEmitters.emitParticipantsChanged?.(
							groupChatId,
							updatedChatForEmit.participants
						);
					}
				} catch (error) {
					logger.error(
						`Failed to auto-add participant ${mentionedName} from user mention`,
						LOG_CONTEXT,
						{ error, groupChatId }
					);
					captureException(error, {
						operation: 'groupChat:autoAddParticipant',
						participantName: mentionedName,
						groupChatId,
					});
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

	// Save images to disk and collect filenames for the log
	let savedImageFilenames: string[] | undefined;
	if (images && images.length > 0) {
		savedImageFilenames = [];
		for (const dataUrl of images) {
			// Extract base64 data and extension from data URL
			const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
			if (match) {
				const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
				const buffer = Buffer.from(match[2], 'base64');
				const filename = await saveImage(chat.imagesDir, buffer, `image.${ext}`);
				savedImageFilenames.push(filename);
			}
		}
	}

	// Log the message as coming from user (with image filenames if any)
	await appendToLog(chat.logPath, 'user', message, readOnly, savedImageFilenames);

	// Store the read-only state for this group chat so it can be propagated to participants
	setGroupChatReadOnlyState(groupChatId, readOnly ?? false);

	// Emit message event to renderer so it shows immediately (with original data URLs for display)
	const userMessage: GroupChatMessage = {
		timestamp: new Date().toISOString(),
		from: 'user',
		content: message,
		readOnly,
		...(images && images.length > 0 && { images }),
	};
	groupChatEmitters.emitMessage?.(groupChatId, userMessage);

	// Spawn a batch process for the moderator to handle this message
	// The response will be captured via the process:data event handler in index.ts
	if (processManager && agentDetector) {
		logger.debug('Preparing to spawn moderator batch process', LOG_CONTEXT, { groupChatId });
		const sessionIdPrefix = getModeratorSessionId(groupChatId);

		if (sessionIdPrefix) {
			// Create a unique session ID for this message
			const sessionId = `${sessionIdPrefix}-${Date.now()}`;
			logger.debug('Generated moderator session ID', LOG_CONTEXT, { sessionId });

			// Resolve the agent configuration to get the executable command
			const agent = await agentDetector.getAgent(chat.moderatorAgentId);
			logger.debug('Agent resolved for moderator', LOG_CONTEXT, {
				agentCommand: agent?.command || null,
				available: agent?.available ?? false,
			});

			if (!agent || !agent.available) {
				logger.debug('Agent not available for moderator', LOG_CONTEXT, {
					agentId: chat.moderatorAgentId,
				});
				throw new Error(`Agent '${chat.moderatorAgentId}' is not available`);
			}

			// Use custom path from moderator config if set, otherwise use resolved path
			const command = chat.moderatorConfig?.customPath || agent.path || agent.command;
			logger.debug('Moderator command resolved', LOG_CONTEXT, { command });

			// Build participant context
			// Use normalized names (spaces → hyphens) so moderator can @mention them properly
			const participantContext =
				chat.participants.length > 0
					? chat.participants
							.map((p) => `- @${normalizeMentionName(p.name)} (${p.agentId} session)`)
							.join('\n')
					: '(No agents currently in this group chat)';

			// Build available sessions context (sessions that could be added)
			let availableSessionsContext = '';
			if (getSessionsCallback) {
				const sessions = getSessionsCallback();
				logger.debug('Available sessions for moderator', LOG_CONTEXT, {
					sessionCount: sessions.length,
				});
				const participantNames = new Set(chat.participants.map((p) => p.name));
				const availableSessions = sessions.filter(
					(s) => s.toolType !== 'terminal' && !participantNames.has(s.name)
				);
				if (availableSessions.length > 0) {
					// Use normalized names (spaces → hyphens) so moderator can @mention them properly
					availableSessionsContext = `\n\n## Available Maestro Sessions (can be added via @mention):\n${availableSessions.map((s) => `- @${normalizeMentionName(s.name)} (${s.toolType})`).join('\n')}`;
				}
			}

			// Build the prompt with context
			const chatHistory = await readLog(chat.logPath);
			logger.debug('Chat history loaded for moderator', LOG_CONTEXT, {
				historyEntries: chatHistory.length,
			});

			const historyContext = chatHistory
				.slice(-20)
				.map((m) => `[${m.from}]: ${m.content}`)
				.join('\n');

			// Build image context if user attached images
			let imageContext = '';
			if (savedImageFilenames && savedImageFilenames.length > 0) {
				const imagePaths = savedImageFilenames.map((f) => path.join(chat.imagesDir, f));
				imageContext = `\n\n## Attached Images (${savedImageFilenames.length}):\nThe user attached ${savedImageFilenames.length} image(s) to this message. The images are saved at:\n${imagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}\nPlease read/view these images to understand the user's request. When delegating to agents, mention the image paths so they can view them too.`;
			}

			const fullPrompt = `${getModeratorSystemPrompt()}

## Current Participants:
${participantContext}${availableSessionsContext}

## Chat History:
${historyContext}

## User Request${readOnly ? ' (READ-ONLY MODE - do not make changes)' : ''}:
${message}${imageContext}`;

			// Get the base args from the agent configuration
			const args = [...agent.args];
			const agentConfigValues = getAgentConfigCallback?.(chat.moderatorAgentId) || {};
			logger.debug('Agent config for moderator', LOG_CONTEXT, {
				agentId: chat.moderatorAgentId,
				configKeyCount: Object.keys(agentConfigValues).length,
			});

			// For Gemini CLI: use the group chat folder as CWD instead of homedir.
			// Gemini's workspace sandbox requires a concrete project directory as CWD;
			// using homedir causes "path not in workspace" errors.
			// Other agents keep homedir as CWD for backward compatibility.
			const groupChatFolder = getGroupChatDir(groupChatId);
			const moderatorCwd = chat.moderatorAgentId === 'gemini-cli' ? groupChatFolder : os.homedir();

			const baseArgs = buildAgentArgs(agent, {
				baseArgs: args,
				prompt: fullPrompt,
				cwd: moderatorCwd,
				readOnlyMode: true,
			});
			const configResolution = applyAgentConfigOverrides(agent, baseArgs, {
				agentConfigValues,
				sessionCustomModel: chat.moderatorConfig?.customModel,
				sessionCustomArgs: chat.moderatorConfig?.customArgs,
				sessionCustomEnvVars: chat.moderatorConfig?.customEnvVars,
			});

			// For Gemini CLI: only disable workspace sandbox when read-only mode is
			// CLI-enforced. Without hard read-only enforcement, removing the sandbox
			// would give the moderator unsandboxed write capability.
			// The CWD is already set to the group chat folder to avoid "path not in workspace" errors.
			const geminiCanBeUnsandboxed =
				chat.moderatorAgentId === 'gemini-cli' && !!agent.readOnlyCliEnforced;
			const geminiNoSandbox = geminiCanBeUnsandboxed ? ['--no-sandbox'] : [];
			const finalArgs = [...configResolution.args, ...geminiNoSandbox];
			logger.debug('Spawning moderator process', LOG_CONTEXT, {
				sessionId,
				agentType: chat.moderatorAgentId,
				cwd: moderatorCwd,
				argCount: finalArgs.length,
				promptLengthChars: fullPrompt.length,
			});

			// Spawn the moderator process in batch mode
			try {
				// Emit state change to show moderator is thinking
				groupChatEmitters.emitStateChange?.(groupChatId, 'moderator-thinking');
				logger.debug('Emitted state change: moderator-thinking', LOG_CONTEXT, { groupChatId });

				// Add power block reason to prevent sleep during group chat activity
				powerManager.addBlockReason(`groupchat:${groupChatId}`);

				// Prepare spawn config with potential SSH wrapping
				let spawnCommand = command;
				let spawnArgs = finalArgs;
				let spawnCwd = moderatorCwd;
				let spawnPrompt: string | undefined = fullPrompt;
				let spawnEnvVars =
					configResolution.effectiveCustomEnvVars ??
					getCustomEnvVarsCallback?.(chat.moderatorAgentId);
				let spawnShell: string | undefined;
				let spawnRunInShell = false;

				// Apply SSH wrapping if configured
				if (sshStore && chat.moderatorConfig?.sshRemoteConfig) {
					logger.debug('Applying SSH wrapping for moderator', LOG_CONTEXT, { groupChatId });
					const sshWrapped = await wrapSpawnWithSsh(
						{
							command,
							args: finalArgs,
							cwd: moderatorCwd,
							prompt: fullPrompt,
							customEnvVars:
								configResolution.effectiveCustomEnvVars ??
								getCustomEnvVarsCallback?.(chat.moderatorAgentId),
							promptArgs: agent.promptArgs,
							noPromptSeparator: agent.noPromptSeparator,
							agentBinaryName: agent.binaryName,
						},
						chat.moderatorConfig.sshRemoteConfig,
						sshStore
					);
					spawnCommand = sshWrapped.command;
					spawnArgs = sshWrapped.args;
					spawnCwd = sshWrapped.cwd;
					spawnPrompt = sshWrapped.prompt;
					spawnEnvVars = sshWrapped.customEnvVars;
					if (sshWrapped.sshRemoteUsed) {
						logger.debug('SSH remote used for moderator', LOG_CONTEXT, {
							remoteName: sshWrapped.sshRemoteUsed.name,
						});
					}
				}

				// Get Windows-specific spawn config (shell, stdin mode) - handles SSH exclusion
				const winConfig = getWindowsSpawnConfig(
					chat.moderatorAgentId,
					chat.moderatorConfig?.sshRemoteConfig
				);
				if (winConfig.shell) {
					spawnShell = winConfig.shell;
					spawnRunInShell = winConfig.runInShell;
					logger.debug('Windows shell config for moderator', LOG_CONTEXT, {
						shell: winConfig.shell,
					});
				}

				processManager.spawn({
					sessionId,
					toolType: chat.moderatorAgentId,
					cwd: spawnCwd,
					command: spawnCommand,
					args: spawnArgs,
					readOnlyMode: true,
					prompt: spawnPrompt,
					contextWindow: getContextWindowValue(agent, agentConfigValues),
					customEnvVars: spawnEnvVars,
					promptArgs: agent.promptArgs,
					noPromptSeparator: agent.noPromptSeparator,
					shell: spawnShell,
					runInShell: spawnRunInShell,
					sendPromptViaStdin: winConfig.sendPromptViaStdin,
					sendPromptViaStdinRaw: winConfig.sendPromptViaStdinRaw,
				});

				logger.debug('Moderator process spawned successfully', LOG_CONTEXT, {
					sessionId,
					hasPromptArgs: !!agent.promptArgs,
					noPromptSeparator: agent.noPromptSeparator ?? false,
				});
			} catch (error) {
				logger.error(`Failed to spawn moderator for ${groupChatId}`, LOG_CONTEXT, { error });
				captureException(error, { operation: 'groupChat:spawnModerator', groupChatId });
				groupChatEmitters.emitStateChange?.(groupChatId, 'idle');
				// Remove power block reason on error since we're going idle
				powerManager.removeBlockReason(`groupchat:${groupChatId}`);
				throw new Error(
					`Failed to spawn moderator: ${error instanceof Error ? error.message : String(error)}`
				);
			}
		} else {
			logger.warn('No session ID prefix found for moderator', LOG_CONTEXT, { groupChatId });
		}
	} else if (processManager && !agentDetector) {
		logger.error('AgentDetector not available, cannot spawn moderator', LOG_CONTEXT, {
			groupChatId,
		});
		throw new Error('AgentDetector not available');
	} else {
		logger.warn('No processManager provided, skipping spawn', LOG_CONTEXT, { groupChatId });
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
 * @param readOnly - Optional flag indicating read-only mode (propagates to participants)
 */
export async function routeModeratorResponse(
	groupChatId: string,
	message: string,
	processManager?: IProcessManager,
	agentDetector?: AgentDetector,
	readOnly?: boolean
): Promise<void> {
	logger.debug('Route moderator response', LOG_CONTEXT, {
		groupChatId,
		messageLength: message.length,
		readOnly: readOnly ?? false,
	});

	const chat = await loadGroupChat(groupChatId);
	if (!chat) {
		logger.debug('Group chat not found', LOG_CONTEXT, { groupChatId });
		throw new Error(`Group chat not found: ${groupChatId}`);
	}

	logger.debug('Chat loaded for moderator response', LOG_CONTEXT, { chatName: chat.name });

	// Log the message as coming from moderator
	await appendToLog(chat.logPath, 'moderator', message);

	// Emit message event to renderer so it shows immediately
	const moderatorMessage: GroupChatMessage = {
		timestamp: new Date().toISOString(),
		from: 'moderator',
		content: message,
	};
	groupChatEmitters.emitMessage?.(groupChatId, moderatorMessage);
	logger.debug('Emitted moderator message to renderer', LOG_CONTEXT, { groupChatId });

	// Add history entry for moderator response
	try {
		const summary = extractFirstSentence(message);
		const historyEntry = await addGroupChatHistoryEntry(groupChatId, {
			timestamp: Date.now(),
			summary,
			participantName: 'Moderator',
			participantColor: '#808080', // Gray for moderator
			type: 'response',
			fullResponse: message,
		});

		// Emit history entry event to renderer
		groupChatEmitters.emitHistoryEntry?.(groupChatId, historyEntry);
		logger.debug('Added history entry for Moderator', LOG_CONTEXT, {
			groupChatId,
			summaryLength: summary.length,
		});
	} catch (error) {
		logger.error('Failed to add history entry for Moderator', LOG_CONTEXT, { error, groupChatId });
		captureException(error, { operation: 'groupChat:addModeratorHistory', groupChatId });
		// Don't throw - history logging failure shouldn't break the message flow
	}

	// Extract ALL mentions from the message
	const allMentions = extractAllMentions(message);
	logger.debug('Extracted mentions from moderator response', LOG_CONTEXT, {
		mentionCount: allMentions.length,
		participantCount: chat.participants.length,
	});

	const existingParticipantNames = new Set(chat.participants.map((p) => p.name));

	// Check for mentions that aren't already participants but match available sessions
	if (processManager && getSessionsCallback) {
		const sessions = getSessionsCallback();
		logger.debug('Available sessions for auto-add', LOG_CONTEXT, { sessionCount: sessions.length });

		for (const mentionedName of allMentions) {
			// Skip if already a participant (check both exact and normalized names)
			const alreadyParticipant = Array.from(existingParticipantNames).some((existingName) =>
				mentionMatches(mentionedName, existingName)
			);
			if (alreadyParticipant) {
				continue;
			}

			// Find matching session by name (supports both exact and hyphenated names)
			const matchingSession = sessions.find(
				(s) => mentionMatches(mentionedName, s.name) && s.toolType !== 'terminal'
			);

			if (matchingSession) {
				try {
					// Use the original session name as the participant name
					const participantName = matchingSession.name;
					logger.debug('Auto-adding participant from moderator mention', LOG_CONTEXT, {
						participantName,
						mentionedName,
						sessionId: matchingSession.id,
					});
					// Get custom env vars for this agent type
					const customEnvVars = getCustomEnvVarsCallback?.(matchingSession.toolType);
					const agentConfigValues = getAgentConfigCallback?.(matchingSession.toolType) || {};
					await addParticipant(
						groupChatId,
						participantName,
						matchingSession.toolType,
						processManager,
						matchingSession.cwd,
						agentDetector,
						agentConfigValues,
						customEnvVars,
						// Pass session-specific overrides (customModel, customArgs, customEnvVars, sshRemoteConfig from session)
						{
							customModel: matchingSession.customModel,
							customArgs: matchingSession.customArgs,
							customEnvVars: matchingSession.customEnvVars,
							sshRemoteName: matchingSession.sshRemoteName,
							sshRemoteConfig: matchingSession.sshRemoteConfig,
						},
						// Pass SSH store for remote execution support
						sshStore ?? undefined
					);
					existingParticipantNames.add(participantName);

					// Emit participant changed event so UI updates
					const updatedChatForEmit = await loadGroupChat(groupChatId);
					if (updatedChatForEmit) {
						groupChatEmitters.emitParticipantsChanged?.(
							groupChatId,
							updatedChatForEmit.participants
						);
					}
				} catch (error) {
					logger.error(`Failed to auto-add participant ${mentionedName}`, LOG_CONTEXT, {
						error,
						groupChatId,
					});
					captureException(error, {
						operation: 'groupChat:autoAddParticipant',
						participantName: mentionedName,
						groupChatId,
					});
					// Continue with other participants even if one fails
				}
			}
		}
	}

	// Now extract mentions that are actual participants (including newly added ones)
	// Reload chat to get updated participants list
	const updatedChat = await loadGroupChat(groupChatId);
	if (!updatedChat) {
		logger.warn('Could not reload chat after participant updates', LOG_CONTEXT, { groupChatId });
		return;
	}

	const mentions = extractMentions(message, updatedChat.participants);
	logger.debug('Valid participant mentions found', LOG_CONTEXT, { mentionCount: mentions.length });

	// Track participants that will need to respond for synthesis round
	const participantsToRespond = new Set<string>();

	// Spawn batch processes for each mentioned participant
	if (processManager && agentDetector && mentions.length > 0) {
		logger.debug('Spawning participant agents', LOG_CONTEXT, {
			groupChatId,
			participantCount: mentions.length,
		});

		// Get available sessions for cwd lookup
		const sessions = getSessionsCallback?.() || [];

		// Get chat history for context
		const chatHistory = await readLog(updatedChat.logPath);
		const historyContext = chatHistory
			.slice(-15)
			.map(
				(m) => `[${m.from}]: ${m.content.substring(0, 500)}${m.content.length > 500 ? '...' : ''}`
			)
			.join('\n');

		for (const participantName of mentions) {
			logger.debug('Spawning participant', LOG_CONTEXT, { participantName });

			// Find the participant info
			const participant = updatedChat.participants.find((p) => p.name === participantName);
			if (!participant) {
				logger.warn('Participant not found in chat - skipping', LOG_CONTEXT, {
					participantName,
					groupChatId,
				});
				continue;
			}

			logger.debug('Participant agent resolved', LOG_CONTEXT, {
				participantName,
				agentId: participant.agentId,
			});

			// Find matching session to get cwd
			const matchingSession = sessions.find(
				(s) => mentionMatches(s.name, participantName) || s.name === participantName
			);
			const cwd = matchingSession?.cwd || os.homedir();
			logger.debug('Participant CWD and agent', LOG_CONTEXT, {
				participantName,
				cwd,
				agentId: participant.agentId,
			});

			// Resolve agent configuration
			const agent = await agentDetector.getAgent(participant.agentId);

			if (!agent || !agent.available) {
				logger.warn('Agent not available for participant', LOG_CONTEXT, {
					agentId: participant.agentId,
					participantName,
				});
				continue;
			}

			// Build the prompt with context for this participant
			// Uses template from src/prompts/group-chat-participant-request.md
			const readOnlyNote = readOnly
				? '\n\n**READ-ONLY MODE:** Do not make any file changes. Only analyze, review, or provide information.'
				: '';
			const readOnlyLabel = readOnly ? ' (READ-ONLY MODE)' : '';
			const readOnlyInstruction = readOnly
				? ' Remember: READ-ONLY mode is active, do not modify any files.'
				: ' If you need to perform any actions, do so and report your findings.';

			// Get the group chat folder path for file access permissions
			const groupChatFolder = getGroupChatDir(groupChatId);

			const participantPrompt = groupChatParticipantRequestPrompt
				.replace(/\{\{PARTICIPANT_NAME\}\}/g, participantName)
				.replace(/\{\{GROUP_CHAT_NAME\}\}/g, updatedChat.name)
				.replace(/\{\{READ_ONLY_NOTE\}\}/g, readOnlyNote)
				.replace(/\{\{GROUP_CHAT_FOLDER\}\}/g, groupChatFolder)
				.replace(/\{\{HISTORY_CONTEXT\}\}/g, historyContext)
				.replace(/\{\{READ_ONLY_LABEL\}\}/g, readOnlyLabel)
				.replace(/\{\{MESSAGE\}\}/g, message)
				.replace(/\{\{READ_ONLY_INSTRUCTION\}\}/g, readOnlyInstruction);

			// Create a unique session ID for this batch process
			const sessionId = `group-chat-${groupChatId}-participant-${participantName}-${Date.now()}`;
			logger.debug('Generated participant session ID', LOG_CONTEXT, { participantName, sessionId });

			const agentConfigValues = getAgentConfigCallback?.(participant.agentId) || {};
			// Note: Don't pass modelId to buildAgentArgs - it will be handled by applyAgentConfigOverrides
			// via sessionCustomModel to avoid duplicate --model args
			const baseArgs = buildAgentArgs(agent, {
				baseArgs: [...agent.args],
				prompt: participantPrompt,
				cwd,
				readOnlyMode: readOnly ?? false,
				agentSessionId: participant.agentSessionId,
			});
			const configResolution = applyAgentConfigOverrides(agent, baseArgs, {
				agentConfigValues,
				sessionCustomModel: matchingSession?.customModel,
				sessionCustomArgs: matchingSession?.customArgs,
				sessionCustomEnvVars: matchingSession?.customEnvVars,
			});

			// For Gemini CLI: add --include-directories for project dir and group chat folder.
			// When SSH is configured, skip local-only paths (groupChatFolder is a local
			// Maestro config path, os.homedir() is the local home) since they won't
			// resolve on the remote host. Only pass cwd which is the remote project path.
			const isParticipantSsh = !!(sshStore && matchingSession?.sshRemoteConfig?.enabled);
			const participantWorkspaceDirs = isParticipantSsh
				? [cwd]
				: [cwd, groupChatFolder, os.homedir()];
			const geminiParticipantDirArgs = buildGeminiWorkspaceDirArgs(
				agent,
				participant.agentId,
				participantWorkspaceDirs
			);
			const participantFinalArgs = [...configResolution.args, ...geminiParticipantDirArgs];

			try {
				// Emit participant state change to show this participant is working
				groupChatEmitters.emitParticipantState?.(groupChatId, participantName, 'working');
				logger.debug('Spawning participant process', LOG_CONTEXT, {
					participantName,
					sessionId,
					agentType: participant.agentId,
					argCount: participantFinalArgs.length,
					promptLengthChars: participantPrompt.length,
					modelSource: configResolution.modelSource || 'unknown',
				});

				// Log spawn details for debugging
				const spawnCommand = agent.path || agent.command;
				const spawnArgs = participantFinalArgs;

				// Prepare spawn config with potential SSH wrapping
				let finalSpawnCommand = spawnCommand;
				let finalSpawnArgs = spawnArgs;
				let finalSpawnCwd = cwd;
				let finalSpawnPrompt: string | undefined = participantPrompt;
				let finalSpawnEnvVars =
					configResolution.effectiveCustomEnvVars ??
					getCustomEnvVarsCallback?.(participant.agentId);
				let finalSpawnShell: string | undefined;
				let finalSpawnRunInShell = false;

				// Apply SSH wrapping if configured for this session
				if (sshStore && matchingSession?.sshRemoteConfig) {
					logger.debug('Applying SSH wrapping for participant', LOG_CONTEXT, { participantName });
					const sshWrapped = await wrapSpawnWithSsh(
						{
							command: spawnCommand,
							args: spawnArgs,
							cwd,
							prompt: participantPrompt,
							customEnvVars:
								configResolution.effectiveCustomEnvVars ??
								getCustomEnvVarsCallback?.(participant.agentId),
							promptArgs: agent.promptArgs,
							noPromptSeparator: agent.noPromptSeparator,
							agentBinaryName: agent.binaryName,
						},
						matchingSession.sshRemoteConfig,
						sshStore
					);
					finalSpawnCommand = sshWrapped.command;
					finalSpawnArgs = sshWrapped.args;
					finalSpawnCwd = sshWrapped.cwd;
					finalSpawnPrompt = sshWrapped.prompt;
					finalSpawnEnvVars = sshWrapped.customEnvVars;
					if (sshWrapped.sshRemoteUsed) {
						logger.debug('SSH remote used for participant', LOG_CONTEXT, {
							participantName,
							remoteName: sshWrapped.sshRemoteUsed.name,
						});
					}
				}

				// Get Windows-specific spawn config (shell, stdin mode) - handles SSH exclusion
				const winConfig = getWindowsSpawnConfig(
					participant.agentId,
					matchingSession?.sshRemoteConfig
				);
				if (winConfig.shell) {
					finalSpawnShell = winConfig.shell;
					finalSpawnRunInShell = winConfig.runInShell;
					logger.debug('Windows shell config for participant', LOG_CONTEXT, {
						participantName,
						shell: winConfig.shell,
					});
				}

				processManager.spawn({
					sessionId,
					toolType: participant.agentId,
					cwd: finalSpawnCwd,
					command: finalSpawnCommand,
					args: finalSpawnArgs,
					readOnlyMode: readOnly ?? false, // Propagate read-only mode from caller
					prompt: finalSpawnPrompt,
					contextWindow: getContextWindowValue(agent, agentConfigValues),
					customEnvVars: finalSpawnEnvVars,
					promptArgs: agent.promptArgs,
					noPromptSeparator: agent.noPromptSeparator,
					shell: finalSpawnShell,
					runInShell: finalSpawnRunInShell,
					sendPromptViaStdin: winConfig.sendPromptViaStdin,
					sendPromptViaStdinRaw: winConfig.sendPromptViaStdinRaw,
				});

				logger.debug('Participant process spawned', LOG_CONTEXT, {
					participantName,
					sessionId,
					hasPromptArgs: !!agent.promptArgs,
					noPromptSeparator: agent.noPromptSeparator ?? false,
				});

				// Track this participant as pending response
				participantsToRespond.add(participantName);
				logger.debug('Batch process spawned for participant', LOG_CONTEXT, {
					participantName,
					sessionId,
					readOnly: readOnly ?? false,
				});
			} catch (error) {
				logger.error(`Failed to spawn participant ${participantName}`, LOG_CONTEXT, {
					error,
					groupChatId,
				});
				captureException(error, {
					operation: 'groupChat:spawnParticipant',
					participantName,
					groupChatId,
				});
				// Continue with other participants even if one fails
			}
		}
	} else if (mentions.length === 0) {
		logger.debug('No participant mentions found - moderator response is final', LOG_CONTEXT, {
			groupChatId,
		});
		// Set state back to idle since no agents are being spawned
		groupChatEmitters.emitStateChange?.(groupChatId, 'idle');
		logger.debug('Emitted state change: idle', LOG_CONTEXT, { groupChatId });
		// Remove power block reason since round is complete
		powerManager.removeBlockReason(`groupchat:${groupChatId}`);
	}

	// Store pending participants for synthesis tracking
	if (participantsToRespond.size > 0) {
		pendingParticipantResponses.set(groupChatId, participantsToRespond);
		logger.debug('Waiting for participants to respond', LOG_CONTEXT, {
			groupChatId,
			pendingCount: participantsToRespond.size,
		});
		// Set state to show agents are working
		groupChatEmitters.emitStateChange?.(groupChatId, 'agent-working');
		logger.debug('Emitted state change: agent-working', LOG_CONTEXT, { groupChatId });
	}
	logger.debug('Route moderator response complete', LOG_CONTEXT, { groupChatId });
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
	_processManager?: IProcessManager
): Promise<void> {
	logger.debug('Route agent response', LOG_CONTEXT, {
		groupChatId,
		participantName,
		messageLength: message.length,
	});

	const chat = await loadGroupChat(groupChatId);
	if (!chat) {
		logger.debug('Group chat not found', LOG_CONTEXT, { groupChatId });
		throw new Error(`Group chat not found: ${groupChatId}`);
	}

	// Verify participant exists
	const participant = chat.participants.find((p) => p.name === participantName);
	if (!participant) {
		logger.debug('Participant not found in chat', LOG_CONTEXT, { groupChatId, participantName });
		throw new Error(`Participant '${participantName}' not found in group chat`);
	}

	logger.debug('Participant verified', LOG_CONTEXT, {
		participantName,
		agentId: participant.agentId,
	});

	// Log the message as coming from the participant
	await appendToLog(chat.logPath, participantName, message);

	// Emit message event to renderer so it shows immediately
	const agentMessage: GroupChatMessage = {
		timestamp: new Date().toISOString(),
		from: participantName,
		content: message,
	};
	groupChatEmitters.emitMessage?.(groupChatId, agentMessage);

	// Extract summary from first sentence (agents are prompted to start with a summary sentence)
	const summary = extractFirstSentence(message);

	// Update participant stats
	const currentParticipant = participant;
	const newMessageCount = (currentParticipant.messageCount || 0) + 1;

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
		logger.error(`Failed to update participant stats for ${participantName}`, LOG_CONTEXT, {
			error,
			groupChatId,
		});
		captureException(error, {
			operation: 'groupChat:updateParticipantStats',
			participantName,
			groupChatId,
		});
		// Don't throw - stats update failure shouldn't break the message flow
	}

	// Add history entry for this response
	try {
		const historyEntry = await addGroupChatHistoryEntry(groupChatId, {
			timestamp: Date.now(),
			summary,
			participantName,
			participantColor: participant.color || '#808080', // Default gray if no color assigned
			type: 'response',
			fullResponse: message,
		});

		// Emit history entry event to renderer
		groupChatEmitters.emitHistoryEntry?.(groupChatId, historyEntry);
		logger.debug('Added history entry for participant', LOG_CONTEXT, {
			participantName,
			summaryLength: summary.length,
		});
	} catch (error) {
		logger.error(`Failed to add history entry for ${participantName}`, LOG_CONTEXT, {
			error,
			groupChatId,
		});
		captureException(error, {
			operation: 'groupChat:addParticipantHistory',
			participantName,
			groupChatId,
		});
		// Don't throw - history logging failure shouldn't break the message flow
	}

	// Note: The moderator runs in batch mode (one-shot per message), so we can't write to it.
	// Instead, we track pending responses and spawn a synthesis round after all participants respond.
	// The synthesis is triggered from index.ts when the last pending participant exits.
}

/**
 * Spawns a moderator synthesis round to summarize participant responses.
 * Called from index.ts when the last pending participant has responded.
 *
 * @param groupChatId - The ID of the group chat
 * @param processManager - The process manager for spawning
 * @param agentDetector - The agent detector for resolving agent commands
 */
export async function spawnModeratorSynthesis(
	groupChatId: string,
	processManager: IProcessManager,
	agentDetector: AgentDetector
): Promise<void> {
	logger.debug('Starting moderator synthesis round', LOG_CONTEXT, { groupChatId });

	const chat = await loadGroupChat(groupChatId);
	if (!chat) {
		logger.error(`Cannot spawn synthesis - chat not found: ${groupChatId}`, LOG_CONTEXT);
		// Reset UI state and remove power block on early return
		groupChatEmitters.emitStateChange?.(groupChatId, 'idle');
		powerManager.removeBlockReason(`groupchat:${groupChatId}`);
		return;
	}

	logger.debug('Chat loaded for synthesis', LOG_CONTEXT, { chatName: chat.name });

	if (!isModeratorActive(groupChatId)) {
		logger.error(`Cannot spawn synthesis - moderator not active for: ${groupChatId}`, LOG_CONTEXT);
		// Reset UI state and remove power block on early return
		groupChatEmitters.emitStateChange?.(groupChatId, 'idle');
		powerManager.removeBlockReason(`groupchat:${groupChatId}`);
		return;
	}

	const sessionIdPrefix = getModeratorSessionId(groupChatId);
	logger.debug('Synthesis session ID prefix', LOG_CONTEXT, { sessionIdPrefix });

	if (!sessionIdPrefix) {
		logger.error(
			`Cannot spawn synthesis - no moderator session ID for: ${groupChatId}`,
			LOG_CONTEXT
		);
		// Reset UI state and remove power block on early return
		groupChatEmitters.emitStateChange?.(groupChatId, 'idle');
		powerManager.removeBlockReason(`groupchat:${groupChatId}`);
		return;
	}

	// Create a unique session ID for this synthesis round
	// Note: We use the regular moderator session ID format (no -synthesis- marker)
	// so the exit handler routes through routeModeratorResponse, which will
	// check for @mentions - if present, route to agents; if not, it's the final response
	const sessionId = `${sessionIdPrefix}-${Date.now()}`;
	logger.debug('Generated synthesis session ID', LOG_CONTEXT, { sessionId });

	// Resolve the agent configuration
	const agent = await agentDetector.getAgent(chat.moderatorAgentId);
	logger.debug('Agent resolved for synthesis', LOG_CONTEXT, {
		agentCommand: agent?.command || null,
		available: agent?.available ?? false,
	});

	if (!agent || !agent.available) {
		logger.error(`Agent '${chat.moderatorAgentId}' is not available for synthesis`, LOG_CONTEXT);
		// Reset UI state and remove power block on early return
		groupChatEmitters.emitStateChange?.(groupChatId, 'idle');
		powerManager.removeBlockReason(`groupchat:${groupChatId}`);
		return;
	}

	// Use custom path from moderator config if set
	const command = chat.moderatorConfig?.customPath || agent.path || agent.command;
	logger.debug('Synthesis command resolved', LOG_CONTEXT, { command });

	const args = [...agent.args];
	// Build the synthesis prompt with recent chat history
	const chatHistory = await readLog(chat.logPath);
	logger.debug('Chat history loaded for synthesis', LOG_CONTEXT, {
		historyEntries: chatHistory.length,
	});

	const historyContext = chatHistory
		.slice(-30)
		.map((m) => `[${m.from}]: ${m.content}`)
		.join('\n');

	// Build participant context for potential follow-up @mentions
	// Use normalized names (spaces → hyphens) so moderator can @mention them properly
	const participantContext =
		chat.participants.length > 0
			? chat.participants
					.map((p) => `- @${normalizeMentionName(p.name)} (${p.agentId} session)`)
					.join('\n')
			: '(No agents currently in this group chat)';

	const synthesisPrompt = `${getModeratorSystemPrompt()}

${getModeratorSynthesisPrompt()}

## Current Participants (you can @mention these for follow-up):
${participantContext}

## Recent Chat History (including participant responses):
${historyContext}

## Your Task:
Review the agent responses above. Either:
1. Synthesize into a final answer for the user (NO @mentions) if the question is fully answered
2. @mention specific agents for follow-up if you need more information`;

	const agentConfigValues = getAgentConfigCallback?.(chat.moderatorAgentId) || {};

	// For Gemini CLI: use the group chat folder as CWD (same as moderator spawn)
	const synthGroupChatFolder = getGroupChatDir(groupChatId);
	const synthCwd = chat.moderatorAgentId === 'gemini-cli' ? synthGroupChatFolder : os.homedir();

	const baseArgs = buildAgentArgs(agent, {
		baseArgs: args,
		prompt: synthesisPrompt,
		cwd: synthCwd,
		readOnlyMode: true,
	});
	const configResolution = applyAgentConfigOverrides(agent, baseArgs, {
		agentConfigValues,
		sessionCustomModel: chat.moderatorConfig?.customModel,
		sessionCustomArgs: chat.moderatorConfig?.customArgs,
		sessionCustomEnvVars: chat.moderatorConfig?.customEnvVars,
	});

	// For Gemini CLI: only disable workspace sandbox when read-only mode is
	// CLI-enforced (same rationale as moderator spawn above)
	const geminiCanBeUnsandboxed =
		chat.moderatorAgentId === 'gemini-cli' && !!agent.readOnlyCliEnforced;
	const geminiSynthNoSandbox = geminiCanBeUnsandboxed ? ['--no-sandbox'] : [];
	const finalArgs = [...configResolution.args, ...geminiSynthNoSandbox];
	logger.debug('Synthesis args built', LOG_CONTEXT, {
		argCount: finalArgs.length,
		promptLengthChars: synthesisPrompt.length,
		agentType: chat.moderatorAgentId,
	});

	// Spawn the synthesis process
	try {
		logger.debug('Spawning synthesis moderator process', LOG_CONTEXT, { groupChatId, sessionId });
		// Emit state change to show moderator is thinking (synthesizing)
		groupChatEmitters.emitStateChange?.(groupChatId, 'moderator-thinking');
		logger.debug('Emitted state change: moderator-thinking (synthesis)', LOG_CONTEXT, {
			groupChatId,
		});

		// Prepare spawn config with SSH wrapping support
		let spawnCommand = command;
		let spawnArgs = finalArgs;
		let spawnCwdResolved = synthCwd;
		let spawnPrompt: string | undefined = synthesisPrompt;
		let spawnEnvVars =
			configResolution.effectiveCustomEnvVars ?? getCustomEnvVarsCallback?.(chat.moderatorAgentId);

		// Apply SSH wrapping if configured (matching moderator spawn in routeUserMessage)
		if (sshStore && chat.moderatorConfig?.sshRemoteConfig) {
			logger.debug('Applying SSH wrapping for synthesis moderator', LOG_CONTEXT, { groupChatId });
			const sshWrapped = await wrapSpawnWithSsh(
				{
					command,
					args: finalArgs,
					cwd: synthCwd,
					prompt: synthesisPrompt,
					customEnvVars:
						configResolution.effectiveCustomEnvVars ??
						getCustomEnvVarsCallback?.(chat.moderatorAgentId),
					promptArgs: agent.promptArgs,
					noPromptSeparator: agent.noPromptSeparator,
					agentBinaryName: agent.binaryName,
				},
				chat.moderatorConfig.sshRemoteConfig,
				sshStore
			);
			spawnCommand = sshWrapped.command;
			spawnArgs = sshWrapped.args;
			spawnCwdResolved = sshWrapped.cwd;
			spawnPrompt = sshWrapped.prompt;
			spawnEnvVars = sshWrapped.customEnvVars;
			if (sshWrapped.sshRemoteUsed) {
				logger.debug('SSH remote used for synthesis', LOG_CONTEXT, {
					remoteName: sshWrapped.sshRemoteUsed.name,
				});
			}
		}

		// Get Windows-specific spawn config (shell, stdin mode) - handles SSH exclusion
		const winConfig = getWindowsSpawnConfig(
			chat.moderatorAgentId,
			chat.moderatorConfig?.sshRemoteConfig
		);
		if (winConfig.shell) {
			logger.debug('Windows shell config for synthesis', LOG_CONTEXT, { shell: winConfig.shell });
		}

		processManager.spawn({
			sessionId,
			toolType: chat.moderatorAgentId,
			cwd: spawnCwdResolved,
			command: spawnCommand,
			args: spawnArgs,
			readOnlyMode: true,
			prompt: spawnPrompt,
			contextWindow: getContextWindowValue(agent, agentConfigValues),
			customEnvVars: spawnEnvVars,
			promptArgs: agent.promptArgs,
			noPromptSeparator: agent.noPromptSeparator,
			shell: winConfig.shell,
			runInShell: winConfig.runInShell,
			sendPromptViaStdin: winConfig.sendPromptViaStdin,
			sendPromptViaStdinRaw: winConfig.sendPromptViaStdinRaw,
		});

		logger.debug('Synthesis moderator process spawned successfully', LOG_CONTEXT, {
			sessionId,
			hasPromptArgs: !!agent.promptArgs,
			noPromptSeparator: agent.noPromptSeparator ?? false,
		});
	} catch (error) {
		logger.error(`Failed to spawn moderator synthesis for ${groupChatId}`, LOG_CONTEXT, { error });
		captureException(error, { operation: 'groupChat:spawnSynthesis', groupChatId });
		groupChatEmitters.emitStateChange?.(groupChatId, 'idle');
		// Remove power block reason on synthesis error since we're going idle
		powerManager.removeBlockReason(`groupchat:${groupChatId}`);
	}
}

/**
 * Re-spawn a participant with session recovery context.
 *
 * This is called when a participant's session was not found (deleted out of band).
 * It builds rich context including the agent's prior statements and re-spawns
 * the participant to continue the conversation.
 *
 * @param groupChatId - The group chat ID
 * @param participantName - The participant who needs recovery
 * @param processManager - The process manager for spawning
 * @param agentDetector - The agent detector for agent configuration
 */
export async function respawnParticipantWithRecovery(
	groupChatId: string,
	participantName: string,
	processManager: IProcessManager,
	agentDetector: AgentDetector
): Promise<void> {
	logger.debug('Respawn participant with recovery', LOG_CONTEXT, { groupChatId, participantName });

	// Import buildRecoveryContext here to avoid circular dependencies
	const { buildRecoveryContext } = await import('./session-recovery');

	// Load the chat and find the participant
	const chat = await loadGroupChat(groupChatId);
	if (!chat) {
		throw new Error(`Group chat not found: ${groupChatId}`);
	}

	const participant = chat.participants.find((p) => p.name === participantName);
	if (!participant) {
		throw new Error(`Participant not found: ${participantName}`);
	}

	// Get the agent configuration
	const agent = await agentDetector.getAgent(participant.agentId);
	if (!agent || !agent.available) {
		throw new Error(`Agent not available: ${participant.agentId}`);
	}

	// Build recovery context with the agent's prior statements
	const recoveryContext = await buildRecoveryContext(groupChatId, participantName, 30);
	logger.debug('Recovery context built', LOG_CONTEXT, {
		recoveryContextLength: recoveryContext.length,
	});

	// Get the read-only state
	const readOnly = getGroupChatReadOnlyState(groupChatId);

	// Get chat history for additional context
	const chatHistory = await readLog(chat.logPath);
	const historyContext = chatHistory
		.slice(-15)
		.map((m) => `[${m.from}]: ${m.content.substring(0, 500)}${m.content.length > 500 ? '...' : ''}`)
		.join('\n');

	// Find matching session for cwd
	const sessions = getSessionsCallback?.() || [];
	const matchingSession = sessions.find(
		(s) => mentionMatches(s.name, participantName) || s.name === participantName
	);
	const cwd = matchingSession?.cwd || os.homedir();

	// Build the prompt with recovery context
	const readOnlyNote = readOnly
		? '\n\n**READ-ONLY MODE:** Do not make any file changes. Only analyze, review, or provide information.'
		: '';
	const readOnlyLabel = readOnly ? ' (READ-ONLY MODE)' : '';
	const readOnlyInstruction = readOnly
		? ' Remember: READ-ONLY mode is active, do not modify any files.'
		: ' If you need to perform any actions, do so and report your findings.';

	const groupChatFolder = getGroupChatDir(groupChatId);

	// Build the recovery prompt - includes standard prompt plus recovery context
	const basePrompt = groupChatParticipantRequestPrompt
		.replace(/\{\{PARTICIPANT_NAME\}\}/g, participantName)
		.replace(/\{\{GROUP_CHAT_NAME\}\}/g, chat.name)
		.replace(/\{\{READ_ONLY_NOTE\}\}/g, readOnlyNote)
		.replace(/\{\{GROUP_CHAT_FOLDER\}\}/g, groupChatFolder)
		.replace(/\{\{HISTORY_CONTEXT\}\}/g, historyContext)
		.replace(/\{\{READ_ONLY_LABEL\}\}/g, readOnlyLabel)
		.replace(
			/\{\{MESSAGE\}\}/g,
			'Please continue from where you left off based on the recovery context below.'
		)
		.replace(/\{\{READ_ONLY_INSTRUCTION\}\}/g, readOnlyInstruction);

	// Prepend recovery context
	const fullPrompt = `${recoveryContext}\n\n${basePrompt}`;
	logger.debug('Recovery prompt built', LOG_CONTEXT, { promptLengthChars: fullPrompt.length });

	// Create a unique session ID for this recovery spawn
	const sessionId = `group-chat-${groupChatId}-participant-${participantName}-recovery-${Date.now()}`;
	logger.debug('Recovery session ID generated', LOG_CONTEXT, { sessionId, participantName });

	// Build args - note: no agentSessionId since we're starting fresh
	const agentConfigValues = getAgentConfigCallback?.(participant.agentId) || {};
	const baseArgs = buildAgentArgs(agent, {
		baseArgs: [...agent.args],
		prompt: fullPrompt,
		cwd,
		readOnlyMode: readOnly ?? false,
		// No agentSessionId - we're starting fresh after session recovery
	});

	const configResolution = applyAgentConfigOverrides(agent, baseArgs, {
		agentConfigValues,
		sessionCustomModel: matchingSession?.customModel,
		sessionCustomArgs: matchingSession?.customArgs,
		sessionCustomEnvVars: matchingSession?.customEnvVars,
	});

	// For Gemini CLI: add --include-directories for group chat folder and home dir.
	// When SSH is configured, skip local-only paths that won't resolve on the remote host.
	const isRecoverySsh = !!(sshStore && matchingSession?.sshRemoteConfig?.enabled);
	const recoveryWorkspaceDirs = isRecoverySsh ? [cwd] : [cwd, groupChatFolder, os.homedir()];
	const geminiRecoveryDirArgs = buildGeminiWorkspaceDirArgs(
		agent,
		participant.agentId,
		recoveryWorkspaceDirs
	);
	const recoveryFinalArgs = [...configResolution.args, ...geminiRecoveryDirArgs];

	// Emit participant state change to show this participant is working
	groupChatEmitters.emitParticipantState?.(groupChatId, participantName, 'working');

	// Spawn the recovery process — with SSH wrapping if configured
	let finalSpawnCommand = agent.path || agent.command;
	let finalSpawnArgs = recoveryFinalArgs;
	let finalSpawnCwd = cwd;
	let finalSpawnPrompt: string | undefined = fullPrompt;
	let finalSpawnEnvVars =
		configResolution.effectiveCustomEnvVars ?? getCustomEnvVarsCallback?.(participant.agentId);
	let finalSpawnShell: string | undefined;
	let finalSpawnRunInShell = false;

	logger.debug('Recovery spawn prepared', LOG_CONTEXT, {
		command: finalSpawnCommand,
		argCount: finalSpawnArgs.length,
	});

	// Apply SSH wrapping if configured for this session
	if (sshStore && matchingSession?.sshRemoteConfig) {
		logger.debug('Applying SSH wrapping for recovery', LOG_CONTEXT, { participantName });
		const sshWrapped = await wrapSpawnWithSsh(
			{
				command: finalSpawnCommand,
				args: finalSpawnArgs,
				cwd,
				prompt: fullPrompt,
				customEnvVars: finalSpawnEnvVars,
				promptArgs: agent.promptArgs,
				noPromptSeparator: agent.noPromptSeparator,
				agentBinaryName: agent.binaryName,
			},
			matchingSession.sshRemoteConfig,
			sshStore
		);
		finalSpawnCommand = sshWrapped.command;
		finalSpawnArgs = sshWrapped.args;
		finalSpawnCwd = sshWrapped.cwd;
		finalSpawnPrompt = sshWrapped.prompt;
		finalSpawnEnvVars = sshWrapped.customEnvVars;
		if (sshWrapped.sshRemoteUsed) {
			logger.debug('SSH remote used for recovery', LOG_CONTEXT, {
				participantName,
				remoteName: sshWrapped.sshRemoteUsed.name,
			});
		}
	}

	// Get Windows-specific spawn config (shell, stdin mode) - handles SSH exclusion
	const winConfig = getWindowsSpawnConfig(participant.agentId, matchingSession?.sshRemoteConfig);
	if (winConfig.shell) {
		finalSpawnShell = winConfig.shell;
		finalSpawnRunInShell = winConfig.runInShell;
		logger.debug('Windows shell config for recovery', LOG_CONTEXT, { shell: winConfig.shell });
	}

	processManager.spawn({
		sessionId,
		toolType: participant.agentId,
		cwd: finalSpawnCwd,
		command: finalSpawnCommand,
		args: finalSpawnArgs,
		readOnlyMode: readOnly ?? false,
		prompt: finalSpawnPrompt,
		contextWindow: getContextWindowValue(agent, agentConfigValues),
		customEnvVars: finalSpawnEnvVars,
		promptArgs: agent.promptArgs,
		noPromptSeparator: agent.noPromptSeparator,
		shell: finalSpawnShell,
		runInShell: finalSpawnRunInShell,
		sendPromptViaStdin: winConfig.sendPromptViaStdin,
		sendPromptViaStdinRaw: winConfig.sendPromptViaStdinRaw,
	});

	logger.debug('Recovery process spawned', LOG_CONTEXT, {
		participantName,
		sessionId,
		hasPromptArgs: !!agent.promptArgs,
	});
}
