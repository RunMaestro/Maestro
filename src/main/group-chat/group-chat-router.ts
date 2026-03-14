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
import {
	GroupChatParticipant,
	loadGroupChat,
	updateParticipant,
	addGroupChatHistoryEntry,
	extractFirstSentence,
	getGroupChatDir,
} from './group-chat-storage';
import { appendToLog, readLog } from './group-chat-log';
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
	/** Auto Run folder path for this session */
	autoRunFolderPath?: string;
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
export type GetModeratorSettingsCallback = () => {
	standingInstructions: string;
	conductorProfile: string;
};

// Module-level callback for session lookup
let getSessionsCallback: GetSessionsCallback | null = null;

// Module-level callback for custom env vars lookup
let getCustomEnvVarsCallback: GetCustomEnvVarsCallback | null = null;
let getAgentConfigCallback: GetAgentConfigCallback | null = null;

// Module-level callback for moderator settings (standing instructions + conductor profile)
let getModeratorSettingsCallback: GetModeratorSettingsCallback | null = null;

// Module-level SSH store for remote execution support
let sshStore: SshRemoteSettingsStore | null = null;

/**
 * Tracks pending participant responses for each group chat.
 * When all pending participants have responded, we spawn a moderator synthesis round.
 * Maps groupChatId -> Set<participantName>
 */
const pendingParticipantResponses = new Map<string, Set<string>>();

/**
 * Tracks which participants in each group chat were triggered via !autorun directives.
 * Used to gate emitAutoRunBatchComplete so it only fires for autorun participants,
 * not for normal @mention participants sharing the same timeout path.
 * Maps groupChatId -> Set<participantName>
 */
const autoRunParticipantTracker = new Map<string, Set<string>>();

/**
 * Tracks per-participant response timeout handles.
 * Maps `${groupChatId}:${participantName}` -> NodeJS.Timeout
 * Timeouts fire if a participant never responds (hung process, lost IPC, etc.)
 */
const participantTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

/** How long to wait for a participant before treating them as timed-out (10 minutes). */
const PARTICIPANT_RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;

function getParticipantTimeoutKey(groupChatId: string, participantName: string): string {
	return `${groupChatId}:${participantName}`;
}

/**
 * Registers a response timeout for a participant.
 * If the participant doesn't respond in PARTICIPANT_RESPONSE_TIMEOUT_MS, they are
 * force-marked as responded so synthesis can proceed and the chat doesn't hang forever.
 */
function setParticipantResponseTimeout(
	groupChatId: string,
	participantName: string,
	processManager: IProcessManager | undefined,
	agentDetector: AgentDetector | undefined
): void {
	const key = getParticipantTimeoutKey(groupChatId, participantName);
	// Clear any existing timeout for this participant
	const existing = participantTimeouts.get(key);
	if (existing) clearTimeout(existing);

	const handle = setTimeout(async () => {
		participantTimeouts.delete(key);
		const pending = pendingParticipantResponses.get(groupChatId);
		if (!pending?.has(participantName)) return; // Already responded

		console.warn(
			`[GroupChat:Debug] Participant ${participantName} timed out after ${PARTICIPANT_RESPONSE_TIMEOUT_MS / 1000}s — force-completing`
		);
		groupChatEmitters.emitMessage?.(groupChatId, {
			timestamp: new Date().toISOString(),
			from: 'system',
			content: `⚠️ @${participantName} did not respond within ${PARTICIPANT_RESPONSE_TIMEOUT_MS / 60000} minutes and has been marked as timed out.`,
		});

		// Log a timeout response so the moderator knows what happened
		try {
			const { loadGroupChat } = await import('./group-chat-storage');
			const { appendToLog } = await import('./group-chat-log');
			const chat = await loadGroupChat(groupChatId);
			if (chat) {
				await appendToLog(
					chat.logPath,
					participantName,
					`[Timed out — no response after ${PARTICIPANT_RESPONSE_TIMEOUT_MS / 60000} minutes]`
				);
			}
		} catch (err) {
			// Non-critical — synthesize anyway, but log and report so we can diagnose
			logger.error('Failed to log timeout response', LOG_CONTEXT, {
				groupChatId,
				participantName,
				error: err,
			});
			captureException(err, {
				operation: 'groupChat:logTimeoutResponse',
				groupChatId,
				participantName,
			});
		}

		// Reset participant state and force-complete the batch so the AUTO badge
		// and progress bar clear immediately — the batch loop may still be awaiting
		// a process exit that will never come.
		groupChatEmitters.emitParticipantState?.(groupChatId, participantName, 'idle');
		// Only emit batch-complete for participants triggered via !autorun, not normal @mentions
		const autoRunSet = autoRunParticipantTracker.get(groupChatId);
		if (autoRunSet?.has(participantName)) {
			groupChatEmitters.emitAutoRunBatchComplete?.(groupChatId, participantName);
			autoRunSet.delete(participantName);
			if (autoRunSet.size === 0) autoRunParticipantTracker.delete(groupChatId);
		}

		const isLast = markParticipantResponded(groupChatId, participantName);
		if (isLast && processManager && agentDetector) {
			spawnModeratorSynthesis(groupChatId, processManager, agentDetector).catch((err) => {
				logger.error('Failed to spawn moderator synthesis after participant timeout', LOG_CONTEXT, {
					error: err,
					groupChatId,
					participantName,
				});
				captureException(err, {
					operation: 'groupChat:spawnSynthesisAfterTimeout',
					groupChatId,
					participantName,
				});
				groupChatEmitters.emitStateChange?.(groupChatId, 'idle');
				powerManager.removeBlockReason(`groupchat:${groupChatId}`);
			});
		}
	}, PARTICIPANT_RESPONSE_TIMEOUT_MS);

	participantTimeouts.set(key, handle);
}

/**
 * Cancels the response timeout for a participant (called when they do respond).
 */
function clearParticipantResponseTimeout(groupChatId: string, participantName: string): void {
	const key = getParticipantTimeoutKey(groupChatId, participantName);
	const handle = participantTimeouts.get(key);
	if (handle) {
		clearTimeout(handle);
		participantTimeouts.delete(key);
	}
}

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
 * Clears all pending participants for a group chat (and their timeouts).
 */
export function clearPendingParticipants(groupChatId: string): void {
	// Cancel all timeouts for this chat before clearing
	const pending = pendingParticipantResponses.get(groupChatId);
	if (pending) {
		for (const name of pending) {
			clearParticipantResponseTimeout(groupChatId, name);
		}
	}
	pendingParticipantResponses.delete(groupChatId);
	autoRunParticipantTracker.delete(groupChatId);
}

/**
 * Marks a participant as having responded (removes from pending, cancels timeout).
 * Returns true if this was the last pending participant.
 */
export function markParticipantResponded(groupChatId: string, participantName: string): boolean {
	clearParticipantResponseTimeout(groupChatId, participantName);

	// Clean up autorun tracking for this participant
	const autoRunSet = autoRunParticipantTracker.get(groupChatId);
	if (autoRunSet?.delete(participantName) && autoRunSet.size === 0) {
		autoRunParticipantTracker.delete(groupChatId);
	}

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
 * Sets the callback for getting moderator settings (standing instructions + conductor profile).
 * Called from index.ts during initialization.
 */
export function setGetModeratorSettingsCallback(callback: GetModeratorSettingsCallback): void {
	getModeratorSettingsCallback = callback;
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
 * Extracts !autorun directives from moderator output.
 * Matches `!autorun @AgentName` patterns.
 *
 * @param text - The moderator's message text
 * @returns Object with autorun participant names and cleaned message text
 */
export interface AutoRunDirective {
	participantName: string;
	/** Specific filename to run, if specified (e.g. `!autorun @Agent:plan.md`). When present,
	 *  only that document is executed instead of all docs in the folder. */
	filename?: string;
}

export function extractAutoRunDirectives(text: string): {
	autoRunDirectives: AutoRunDirective[];
	/** @deprecated use autoRunDirectives */
	autoRunParticipants: string[];
	cleanedText: string;
} {
	const autoRunDirectives: AutoRunDirective[] = [];
	// Matches: !autorun @AgentName  OR  !autorun @AgentName:filename.md
	const autoRunPattern = /!autorun\s+@([^\s@:,;!?()\[\]{}'"<>]+)(?::([^\s,;!?()\[\]{}'"<>]+))?/g;
	let match;

	while ((match = autoRunPattern.exec(text)) !== null) {
		const participantName = match[1];
		const filename = match[2]; // undefined when no :filename suffix
		if (!autoRunDirectives.some((d) => d.participantName === participantName)) {
			autoRunDirectives.push({ participantName, filename });
		}
	}

	// Remove !autorun lines from the message for display
	const cleanedText = text
		.replace(/^.*!autorun\s+@[^\s@:,;!?()\[\]{}'"<>]+.*$/gm, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();

	return {
		autoRunDirectives,
		autoRunParticipants: autoRunDirectives.map((d) => d.participantName),
		cleanedText,
	};
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
	console.log(`[GroupChat:Debug] ========== ROUTE USER MESSAGE ==========`);
	console.log(`[GroupChat:Debug] Group Chat ID: ${groupChatId}`);
	console.log(`[GroupChat:Debug] Message length: ${message.length}`);
	console.log(`[GroupChat:Debug] Read-only: ${readOnly ?? false}`);
	console.log(`[GroupChat:Debug] Has processManager: ${!!processManager}`);
	console.log(`[GroupChat:Debug] Has agentDetector: ${!!agentDetector}`);

	let chat = await loadGroupChat(groupChatId);
	if (!chat) {
		console.log(`[GroupChat:Debug] ERROR: Group chat not found!`);
		throw new Error(`Group chat not found: ${groupChatId}`);
	}

	console.log(`[GroupChat:Debug] Chat loaded: "${chat.name}"`);
	console.log(
		`[GroupChat:Debug] Current participants: ${chat.participants.map((p) => p.name).join(', ') || '(none)'}`
	);
	console.log(`[GroupChat:Debug] Moderator Agent ID: ${chat.moderatorAgentId}`);

	if (!isModeratorActive(groupChatId)) {
		console.log(`[GroupChat:Debug] ERROR: Moderator is not active!`);
		throw new Error(`Moderator is not active for group chat: ${groupChatId}`);
	}

	console.log(`[GroupChat:Debug] Moderator is active: true`);

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
					console.log(
						`[GroupChatRouter] Auto-adding participant @${participantName} from user mention @${mentionedName} (session ${matchingSession.id})`
					);
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

	// Log the message as coming from user
	await appendToLog(chat.logPath, 'user', message, readOnly);

	// Store the read-only state for this group chat so it can be propagated to participants
	setGroupChatReadOnlyState(groupChatId, readOnly ?? false);

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
		console.log(`[GroupChat:Debug] Preparing to spawn moderator batch process...`);
		const sessionIdPrefix = getModeratorSessionId(groupChatId);
		console.log(`[GroupChat:Debug] Session ID prefix: ${sessionIdPrefix}`);

		if (sessionIdPrefix) {
			// Create a unique session ID for this message
			const sessionId = `${sessionIdPrefix}-${Date.now()}`;
			console.log(`[GroupChat:Debug] Generated full session ID: ${sessionId}`);

			// Resolve the agent configuration to get the executable command
			const agent = await agentDetector.getAgent(chat.moderatorAgentId);
			console.log(`[GroupChat:Debug] Agent resolved: ${agent?.command || 'null'}`);
			console.log(`[GroupChat:Debug] Agent available: ${agent?.available ?? false}`);

			if (!agent || !agent.available) {
				console.log(`[GroupChat:Debug] ERROR: Agent not available!`);
				throw new Error(`Agent '${chat.moderatorAgentId}' is not available`);
			}

			// Use custom path from moderator config if set, otherwise use resolved path
			const command = chat.moderatorConfig?.customPath || agent.path || agent.command;
			console.log(`[GroupChat:Debug] Command to execute: ${command}`);

			// Build participant context
			// Use normalized names (spaces → hyphens) so moderator can @mention them properly
			const participantContext =
				chat.participants.length > 0
					? chat.participants
							.map((p) => {
								return `- @${normalizeMentionName(p.name)} (${p.agentId} session)`;
							})
							.join('\n')
					: '(No agents currently in this group chat)';

			// Build available sessions context (sessions that could be added)
			let availableSessionsContext = '';
			if (getSessionsCallback) {
				const sessions = getSessionsCallback();
				console.log(
					`[GroupChat:Debug] Available sessions from callback: ${sessions.map((s) => s.name).join(', ')}`
				);
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
			console.log(`[GroupChat:Debug] Chat history entries: ${chatHistory.length}`);

			const historyContext = chatHistory
				.slice(-20)
				.map((m) => `[${m.from}]: ${m.content}`)
				.join('\n');

			// Get moderator settings for prompt customization
			const moderatorSettings = getModeratorSettingsCallback?.() ?? {
				standingInstructions: '',
				conductorProfile: '',
			};

			// Substitute {{CONDUCTOR_PROFILE}} template variable
			const baseSystemPrompt = getModeratorSystemPrompt().replace(
				'{{CONDUCTOR_PROFILE}}',
				moderatorSettings.conductorProfile || '(No conductor profile set)'
			);

			// Build standing instructions section if configured
			const standingInstructionsSection = moderatorSettings.standingInstructions
				? `\n\n## Standing Instructions\n\nThe following instructions apply to ALL group chat sessions. Follow them consistently:\n\n${moderatorSettings.standingInstructions}`
				: '';

			const fullPrompt = `${baseSystemPrompt}${standingInstructionsSection}

## Current Participants:
${participantContext}${availableSessionsContext}

## Chat History:
${historyContext}

## User Request${readOnly ? ' (READ-ONLY MODE - do not make changes)' : ''}:
${message}`;

			// Get the base args from the agent configuration
			const args = [...agent.args];
			const agentConfigValues = getAgentConfigCallback?.(chat.moderatorAgentId) || {};
			console.log(
				`[GroupChat:Debug] agentConfigValues for ${chat.moderatorAgentId}: ${JSON.stringify(agentConfigValues)}`
			);
			const baseArgs = buildAgentArgs(agent, {
				baseArgs: args,
				prompt: fullPrompt,
				cwd: os.homedir(),
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
			console.log(`[GroupChat:Debug] Args: ${JSON.stringify(finalArgs)}`);

			console.log(`[GroupChat:Debug] Full prompt length: ${fullPrompt.length} chars`);
			console.log(`[GroupChat:Debug] ========== SPAWNING MODERATOR PROCESS ==========`);
			console.log(`[GroupChat:Debug] Session ID: ${sessionId}`);
			console.log(`[GroupChat:Debug] Tool Type: ${chat.moderatorAgentId}`);
			console.log(`[GroupChat:Debug] CWD: ${os.homedir()}`);
			console.log(`[GroupChat:Debug] Command: ${command}`);
			console.log(`[GroupChat:Debug] ReadOnly: true`);

			// Spawn the moderator process in batch mode
			try {
				// Emit state change to show moderator is thinking
				groupChatEmitters.emitStateChange?.(groupChatId, 'moderator-thinking');
				console.log(`[GroupChat:Debug] Emitted state change: moderator-thinking`);

				// Add power block reason to prevent sleep during group chat activity
				powerManager.addBlockReason(`groupchat:${groupChatId}`);

				// Prepare spawn config with potential SSH wrapping
				let spawnCommand = command;
				let spawnArgs = finalArgs;
				let spawnCwd = os.homedir();
				let spawnPrompt: string | undefined = fullPrompt;
				let spawnEnvVars =
					configResolution.effectiveCustomEnvVars ??
					getCustomEnvVarsCallback?.(chat.moderatorAgentId);
				let spawnShell: string | undefined;
				let spawnRunInShell = false;

				// Apply SSH wrapping if configured
				if (sshStore && chat.moderatorConfig?.sshRemoteConfig) {
					console.log(`[GroupChat:Debug] Applying SSH wrapping for moderator...`);
					const sshWrapped = await wrapSpawnWithSsh(
						{
							command,
							args: finalArgs,
							cwd: os.homedir(),
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
						console.log(`[GroupChat:Debug] SSH remote used: ${sshWrapped.sshRemoteUsed.name}`);
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
					console.log(`[GroupChat:Debug] Windows shell config: ${winConfig.shell}`);
				}

				const spawnResult = processManager.spawn({
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

				console.log(`[GroupChat:Debug] Spawn result: ${JSON.stringify(spawnResult)}`);
				console.log(`[GroupChat:Debug] Moderator process spawned successfully`);
				console.log(`[GroupChat:Debug] promptArgs: ${agent.promptArgs ? 'defined' : 'undefined'}`);
				console.log(`[GroupChat:Debug] noPromptSeparator: ${agent.noPromptSeparator ?? false}`);
				console.log(`[GroupChat:Debug] =================================================`);
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
			console.log(`[GroupChat:Debug] WARNING: No session ID prefix found for moderator`);
		}
	} else if (processManager && !agentDetector) {
		console.error(`[GroupChat:Debug] ERROR: AgentDetector not available!`);
		console.error(`[GroupChatRouter] AgentDetector not available, cannot spawn moderator`);
		throw new Error('AgentDetector not available');
	} else {
		console.log(`[GroupChat:Debug] WARNING: No processManager provided, skipping spawn`);
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
	console.log(`[GroupChat:Debug] ========== ROUTE MODERATOR RESPONSE ==========`);
	console.log(`[GroupChat:Debug] Group Chat ID: ${groupChatId}`);
	console.log(`[GroupChat:Debug] Message length: ${message.length}`);
	console.log(
		`[GroupChat:Debug] Message preview: "${message.substring(0, 300)}${message.length > 300 ? '...' : ''}"`
	);
	console.log(`[GroupChat:Debug] Read-only: ${readOnly ?? false}`);

	const chat = await loadGroupChat(groupChatId);
	if (!chat) {
		console.log(`[GroupChat:Debug] ERROR: Group chat not found!`);
		throw new Error(`Group chat not found: ${groupChatId}`);
	}

	console.log(`[GroupChat:Debug] Chat loaded: "${chat.name}"`);

	// Strip internal !autorun directives from the message before logging/display.
	// These are machine-to-machine commands; storing them in the chat log causes
	// the synthesis moderator to see them in history and potentially re-trigger them.
	const {
		autoRunDirectives,
		autoRunParticipants,
		cleanedText: displayMessage,
	} = extractAutoRunDirectives(message);

	// Only persist/emit the moderator message if it has visible content after stripping directives
	const shouldPersistModeratorMessage = displayMessage.trim().length > 0;

	if (shouldPersistModeratorMessage) {
		// Log the message as coming from moderator (cleaned of !autorun directives)
		await appendToLog(chat.logPath, 'moderator', displayMessage);
		console.log(`[GroupChat:Debug] Message appended to log`);

		// Emit message event to renderer so it shows immediately
		const moderatorMessage: GroupChatMessage = {
			timestamp: new Date().toISOString(),
			from: 'moderator',
			content: displayMessage,
		};
		groupChatEmitters.emitMessage?.(groupChatId, moderatorMessage);
		console.log(`[GroupChat:Debug] Emitted moderator message to renderer`);
	}

	// Add history entry for moderator response
	if (shouldPersistModeratorMessage) {
		try {
			const summary = extractFirstSentence(displayMessage);
			const historyEntry = await addGroupChatHistoryEntry(groupChatId, {
				timestamp: Date.now(),
				summary,
				participantName: 'Moderator',
				participantColor: '#808080', // Gray for moderator
				type: 'response',
				fullResponse: displayMessage,
			});

			// Emit history entry event to renderer
			groupChatEmitters.emitHistoryEntry?.(groupChatId, historyEntry);
			console.log(
				`[GroupChatRouter] Added history entry for Moderator: ${summary.substring(0, 50)}...`
			);
		} catch (error) {
			logger.error('Failed to add history entry for Moderator', LOG_CONTEXT, {
				error,
				groupChatId,
			});
			captureException(error, { operation: 'groupChat:addModeratorHistory', groupChatId });
			// Don't throw - history logging failure shouldn't break the message flow
		}
	}

	// Extract ALL mentions from the message
	const allMentions = extractAllMentions(message);
	console.log(`[GroupChat:Debug] Extracted @mentions: ${allMentions.join(', ') || '(none)'}`);

	const existingParticipantNames = new Set(chat.participants.map((p) => p.name));
	console.log(
		`[GroupChat:Debug] Existing participants: ${Array.from(existingParticipantNames).join(', ') || '(none)'}`
	);

	// Check for mentions that aren't already participants but match available sessions
	if (processManager && getSessionsCallback) {
		const sessions = getSessionsCallback();
		console.log(
			`[GroupChat:Debug] Available sessions for auto-add: ${sessions.map((s) => s.name).join(', ')}`
		);

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
					console.log(
						`[GroupChatRouter] Auto-adding participant @${participantName} from moderator mention @${mentionedName} (session ${matchingSession.id})`
					);
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
		console.log(`[GroupChat:Debug] WARNING: Could not reload chat after participant updates`);
		return;
	}

	const mentions = extractMentions(message, updatedChat.participants);
	console.log(
		`[GroupChat:Debug] Valid participant mentions found: ${mentions.join(', ') || '(none)'}`
	);

	// Track participants that will need to respond for synthesis round
	const participantsToRespond = new Set<string>();

	// Use the !autorun directives already extracted above (same `message` input)
	if (autoRunDirectives.length > 0) {
		console.log(
			`[GroupChat:Debug] Found !autorun directives for: ${autoRunDirectives.map((d) => (d.filename ? `${d.participantName}:${d.filename}` : d.participantName)).join(', ')}`
		);
	}

	// Trigger Auto Run for participants via the renderer's batch processor
	// This delegates to the renderer so the full useBatchProcessor pipeline runs:
	// progress indicators, multi-document sequencing, task checking, achievements, etc.
	if (autoRunDirectives.length > 0) {
		console.log(`[GroupChat:Debug] ========== TRIGGERING AUTORUN VIA RENDERER ==========`);
		const sessions = getSessionsCallback?.() || [];

		for (const directive of autoRunDirectives) {
			const { participantName: autoRunName, filename: targetFilename } = directive;
			const participant = updatedChat.participants.find((p) => mentionMatches(autoRunName, p.name));
			if (!participant) {
				console.warn(
					`[GroupChat:Debug] Autorun participant ${autoRunName} not found in chat - skipping`
				);
				groupChatEmitters.emitMessage?.(groupChatId, {
					timestamp: new Date().toISOString(),
					from: 'system',
					content: `⚠️ Could not find participant @${autoRunName} for !autorun. Make sure the agent is added to the group chat.`,
				});
				continue;
			}

			const matchingSession = sessions.find(
				(s) => mentionMatches(s.name, participant.name) || s.name === participant.name
			);

			if (!matchingSession?.autoRunFolderPath) {
				console.warn(
					`[GroupChat:Debug] No autoRunFolderPath configured for ${participant.name} - skipping`
				);
				groupChatEmitters.emitMessage?.(groupChatId, {
					timestamp: new Date().toISOString(),
					from: 'system',
					content: `⚠️ No Auto Run folder configured for @${participant.name}. Open the agent in Maestro, go to the Auto Run tab, and configure a folder first.`,
				});
				continue;
			}

			// Emit event to renderer — the renderer will call startBatchRun via useBatchProcessor.
			// When the batch completes, the renderer calls groupChat:reportAutoRunComplete which
			// invokes routeAgentResponse to trigger the synthesis round.
			groupChatEmitters.emitParticipantState?.(groupChatId, participant.name, 'working');
			groupChatEmitters.emitAutoRunTriggered?.(groupChatId, participant.name, targetFilename);
			participantsToRespond.add(participant.name);
			// Track as autorun so timeout path only emits batch-complete for autorun participants
			if (!autoRunParticipantTracker.has(groupChatId)) {
				autoRunParticipantTracker.set(groupChatId, new Set());
			}
			autoRunParticipantTracker.get(groupChatId)!.add(participant.name);
			console.log(
				`[GroupChat:Debug] Emitted autoRunTriggered for @${participant.name}${targetFilename ? `:${targetFilename}` : ''} in chat ${groupChatId}`
			);
		}
		console.log(`[GroupChat:Debug] =================================================`);
	}

	// Spawn batch processes for each mentioned participant (exclude autorun participants)
	const mentionsToSpawn = mentions.filter(
		(name) => !autoRunParticipants.some((arName) => mentionMatches(arName, name))
	);
	if (processManager && agentDetector && mentionsToSpawn.length > 0) {
		console.log(`[GroupChat:Debug] ========== SPAWNING PARTICIPANT AGENTS ==========`);
		console.log(`[GroupChat:Debug] Will spawn ${mentionsToSpawn.length} participant agent(s)`);

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

		for (const participantName of mentionsToSpawn) {
			console.log(`[GroupChat:Debug] --- Spawning participant: @${participantName} ---`);

			// Find the participant info
			const participant = updatedChat.participants.find((p) => p.name === participantName);
			if (!participant) {
				console.warn(
					`[GroupChat:Debug] Participant ${participantName} not found in chat - skipping`
				);
				continue;
			}

			console.log(`[GroupChat:Debug] Participant agent ID: ${participant.agentId}`);

			// Find matching session to get cwd
			const matchingSession = sessions.find(
				(s) => mentionMatches(s.name, participantName) || s.name === participantName
			);
			const cwd = matchingSession?.cwd || os.homedir();
			console.log(`[GroupChat:Debug] CWD for participant: ${cwd}`);

			// Resolve agent configuration
			const agent = await agentDetector.getAgent(participant.agentId);
			console.log(
				`[GroupChat:Debug] Agent resolved: ${agent?.command || 'null'}, available: ${agent?.available ?? false}`
			);

			if (!agent || !agent.available) {
				console.error(
					`[GroupChat:Debug] ERROR: Agent '${participant.agentId}' not available for ${participantName}`
				);
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
			console.log(`[GroupChat:Debug] Generated session ID: ${sessionId}`);

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

			try {
				// Emit participant state change to show this participant is working
				groupChatEmitters.emitParticipantState?.(groupChatId, participantName, 'working');
				console.log(`[GroupChat:Debug] Emitted participant state: working`);

				// Log spawn details for debugging
				const spawnCommand = agent.path || agent.command;
				const spawnArgs = configResolution.args;
				console.log(`[GroupChat:Debug] Spawn command: ${spawnCommand}`);
				console.log(`[GroupChat:Debug] Spawn args: ${JSON.stringify(spawnArgs)}`);
				console.log(
					`[GroupChat:Debug] Session customModel: ${matchingSession?.customModel || '(none)'}`
				);
				console.log(
					`[GroupChat:Debug] Config model source: ${configResolution.modelSource || 'unknown'}`
				);
				console.log(`[GroupChat:Debug] Prompt length: ${participantPrompt.length}`);
				console.log(
					`[GroupChat:Debug] CustomEnvVars: ${JSON.stringify(configResolution.effectiveCustomEnvVars || {})}`
				);

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
					console.log(
						`[GroupChat:Debug] Applying SSH wrapping for participant ${participantName}...`
					);
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
						console.log(`[GroupChat:Debug] SSH remote used: ${sshWrapped.sshRemoteUsed.name}`);
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
					console.log(
						`[GroupChat:Debug] Windows shell config for ${participantName}: ${winConfig.shell}`
					);
				}

				const spawnResult = processManager.spawn({
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

				console.log(
					`[GroupChat:Debug] Spawn result for ${participantName}: ${JSON.stringify(spawnResult)}`
				);
				console.log(`[GroupChat:Debug] promptArgs: ${agent.promptArgs ? 'defined' : 'undefined'}`);
				console.log(`[GroupChat:Debug] noPromptSeparator: ${agent.noPromptSeparator ?? false}`);

				// Track this participant as pending response
				participantsToRespond.add(participantName);
				console.log(
					`[GroupChat:Debug] Spawned batch process for participant @${participantName} (session ${sessionId}, readOnly=${readOnly ?? false})`
				);
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
		console.log(`[GroupChat:Debug] =================================================`);
	}

	// If no actionable participant work was started (all directives invalid/skipped, no mentions),
	// clean up lifecycle state so power blocks don't leak.
	if (participantsToRespond.size === 0) {
		console.log(
			`[GroupChat:Debug] No actionable participant work started - moderator response is final`
		);
		groupChatEmitters.emitStateChange?.(groupChatId, 'idle');
		console.log(`[GroupChat:Debug] Emitted state change: idle`);
		powerManager.removeBlockReason(`groupchat:${groupChatId}`);
	}

	// Store pending participants for synthesis tracking and install response timeouts
	if (participantsToRespond.size > 0) {
		pendingParticipantResponses.set(groupChatId, participantsToRespond);
		console.log(
			`[GroupChat:Debug] Waiting for ${participantsToRespond.size} participant(s) to respond: ${[...participantsToRespond].join(', ')}`
		);
		// Install a per-participant timeout so a hung/unresponsive participant can't block
		// synthesis indefinitely. The timeout fires after PARTICIPANT_RESPONSE_TIMEOUT_MS.
		for (const participantName of participantsToRespond) {
			setParticipantResponseTimeout(
				groupChatId,
				participantName,
				processManager ?? undefined,
				agentDetector ?? undefined
			);
		}
		// Set state to show agents are working
		groupChatEmitters.emitStateChange?.(groupChatId, 'agent-working');
		console.log(`[GroupChat:Debug] Emitted state change: agent-working`);
	}
	console.log(`[GroupChat:Debug] ===================================================`);
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
	console.log(`[GroupChat:Debug] ========== ROUTE AGENT RESPONSE ==========`);
	console.log(`[GroupChat:Debug] Group Chat ID: ${groupChatId}`);
	console.log(`[GroupChat:Debug] Participant: ${participantName}`);
	console.log(`[GroupChat:Debug] Message length: ${message.length}`);
	console.log(
		`[GroupChat:Debug] Message preview: "${message.substring(0, 200)}${message.length > 200 ? '...' : ''}"`
	);

	const chat = await loadGroupChat(groupChatId);
	if (!chat) {
		console.log(`[GroupChat:Debug] ERROR: Group chat not found!`);
		throw new Error(`Group chat not found: ${groupChatId}`);
	}

	// Verify participant exists
	const participant = chat.participants.find((p) => p.name === participantName);
	if (!participant) {
		console.log(`[GroupChat:Debug] ERROR: Participant '${participantName}' not found!`);
		throw new Error(`Participant '${participantName}' not found in group chat`);
	}

	console.log(
		`[GroupChat:Debug] Participant verified: ${participantName} (agent: ${participant.agentId})`
	);

	// Log the message as coming from the participant
	await appendToLog(chat.logPath, participantName, message);
	console.log(`[GroupChat:Debug] Message appended to log`);

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
		console.log(
			`[GroupChatRouter] Added history entry for ${participantName}: ${summary.substring(0, 50)}...`
		);
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
	console.log(`[GroupChat:Debug] ========== SPAWN MODERATOR SYNTHESIS ==========`);
	console.log(`[GroupChat:Debug] Group Chat ID: ${groupChatId}`);
	console.log(`[GroupChat:Debug] All participants have responded, starting synthesis round...`);

	const chat = await loadGroupChat(groupChatId);
	if (!chat) {
		logger.error(`Cannot spawn synthesis - chat not found: ${groupChatId}`, LOG_CONTEXT);
		// Reset UI state and remove power block on early return
		groupChatEmitters.emitStateChange?.(groupChatId, 'idle');
		powerManager.removeBlockReason(`groupchat:${groupChatId}`);
		return;
	}

	console.log(`[GroupChat:Debug] Chat loaded: "${chat.name}"`);

	if (!isModeratorActive(groupChatId)) {
		logger.error(`Cannot spawn synthesis - moderator not active for: ${groupChatId}`, LOG_CONTEXT);
		// Reset UI state and remove power block on early return
		groupChatEmitters.emitStateChange?.(groupChatId, 'idle');
		powerManager.removeBlockReason(`groupchat:${groupChatId}`);
		return;
	}

	const sessionIdPrefix = getModeratorSessionId(groupChatId);
	console.log(`[GroupChat:Debug] Session ID prefix: ${sessionIdPrefix}`);

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
	console.log(`[GroupChat:Debug] Generated synthesis session ID: ${sessionId}`);

	// Resolve the agent configuration
	const agent = await agentDetector.getAgent(chat.moderatorAgentId);
	console.log(
		`[GroupChat:Debug] Agent resolved: ${agent?.command || 'null'}, available: ${agent?.available ?? false}`
	);

	if (!agent || !agent.available) {
		logger.error(`Agent '${chat.moderatorAgentId}' is not available for synthesis`, LOG_CONTEXT);
		// Reset UI state and remove power block on early return
		groupChatEmitters.emitStateChange?.(groupChatId, 'idle');
		powerManager.removeBlockReason(`groupchat:${groupChatId}`);
		return;
	}

	// Use custom path from moderator config if set
	const command = chat.moderatorConfig?.customPath || agent.path || agent.command;
	console.log(`[GroupChat:Debug] Command: ${command}`);

	const args = [...agent.args];
	// Build the synthesis prompt with recent chat history
	const chatHistory = await readLog(chat.logPath);
	console.log(`[GroupChat:Debug] Chat history entries for synthesis: ${chatHistory.length}`);

	const historyContext = chatHistory
		.slice(-30)
		.map((m) => `[${m.from}]: ${m.content}`)
		.join('\n');

	// Build participant context for potential follow-up @mentions
	// Use normalized names (spaces → hyphens) so moderator can @mention them properly
	const participantContext =
		chat.participants.length > 0
			? chat.participants
					.map((p) => {
						return `- @${normalizeMentionName(p.name)} (${p.agentId} session)`;
					})
					.join('\n')
			: '(No agents currently in this group chat)';

	// Get moderator settings for prompt customization
	const synthModeratorSettings = getModeratorSettingsCallback?.() ?? {
		standingInstructions: '',
		conductorProfile: '',
	};
	const synthBasePrompt = getModeratorSystemPrompt().replace(
		'{{CONDUCTOR_PROFILE}}',
		synthModeratorSettings.conductorProfile || '(No conductor profile set)'
	);
	const synthStandingInstructions = synthModeratorSettings.standingInstructions
		? `\n\n## Standing Instructions\n\nThe following instructions apply to ALL group chat sessions. Follow them consistently:\n\n${synthModeratorSettings.standingInstructions}`
		: '';

	const synthesisPrompt = `${synthBasePrompt}${synthStandingInstructions}

${getModeratorSynthesisPrompt()}

## Current Participants (you can @mention these for follow-up):
${participantContext}

## Recent Chat History (including participant responses):
${historyContext}

## Your Task:
Review the agent responses above. Either:
1. Synthesize into a final answer for the user (NO @mentions, NO !autorun) if the question is fully answered
2. @mention specific agents for follow-up if you need more information

**IMPORTANT: Do NOT include any !autorun directives in this synthesis response.**`;

	const agentConfigValues = getAgentConfigCallback?.(chat.moderatorAgentId) || {};
	const baseArgs = buildAgentArgs(agent, {
		baseArgs: args,
		prompt: synthesisPrompt,
		cwd: os.homedir(),
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
	console.log(`[GroupChat:Debug] Args: ${JSON.stringify(finalArgs)}`);

	console.log(`[GroupChat:Debug] Synthesis prompt length: ${synthesisPrompt.length} chars`);

	// Spawn the synthesis process
	try {
		console.log(`[GroupChat:Debug] Spawning synthesis moderator process...`);
		// Emit state change to show moderator is thinking (synthesizing)
		groupChatEmitters.emitStateChange?.(groupChatId, 'moderator-thinking');
		console.log(`[GroupChat:Debug] Emitted state change: moderator-thinking`);

		// Get Windows-specific spawn config (shell, stdin mode) - handles SSH exclusion
		const winConfig = getWindowsSpawnConfig(
			chat.moderatorAgentId,
			chat.moderatorConfig?.sshRemoteConfig
		);
		if (winConfig.shell) {
			console.log(`[GroupChat:Debug] Windows shell config for synthesis: ${winConfig.shell}`);
		}

		const spawnResult = processManager.spawn({
			sessionId,
			toolType: chat.moderatorAgentId,
			cwd: os.homedir(),
			command,
			args: finalArgs,
			readOnlyMode: true,
			prompt: synthesisPrompt,
			contextWindow: getContextWindowValue(agent, agentConfigValues),
			customEnvVars:
				configResolution.effectiveCustomEnvVars ??
				getCustomEnvVarsCallback?.(chat.moderatorAgentId),
			promptArgs: agent.promptArgs,
			noPromptSeparator: agent.noPromptSeparator,
			shell: winConfig.shell,
			runInShell: winConfig.runInShell,
			sendPromptViaStdin: winConfig.sendPromptViaStdin,
			sendPromptViaStdinRaw: winConfig.sendPromptViaStdinRaw,
		});

		console.log(`[GroupChat:Debug] Synthesis spawn result: ${JSON.stringify(spawnResult)}`);
		console.log(`[GroupChat:Debug] Synthesis moderator process spawned successfully`);
		console.log(`[GroupChat:Debug] promptArgs: ${agent.promptArgs ? 'defined' : 'undefined'}`);
		console.log(`[GroupChat:Debug] noPromptSeparator: ${agent.noPromptSeparator ?? false}`);
		console.log(`[GroupChat:Debug] ================================================`);
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
	console.log(`[GroupChat:Debug] ========== RESPAWN WITH RECOVERY ==========`);
	console.log(`[GroupChat:Debug] Group Chat: ${groupChatId}`);
	console.log(`[GroupChat:Debug] Participant: ${participantName}`);

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
	console.log(`[GroupChat:Debug] Recovery context length: ${recoveryContext.length}`);

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
	console.log(`[GroupChat:Debug] Full recovery prompt length: ${fullPrompt.length}`);

	// Create a unique session ID for this recovery spawn
	const sessionId = `group-chat-${groupChatId}-participant-${participantName}-recovery-${Date.now()}`;
	console.log(`[GroupChat:Debug] Recovery session ID: ${sessionId}`);

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

	// Emit participant state change to show this participant is working
	groupChatEmitters.emitParticipantState?.(groupChatId, participantName, 'working');

	// Spawn the recovery process — with SSH wrapping if configured
	let finalSpawnCommand = agent.path || agent.command;
	let finalSpawnArgs = configResolution.args;
	let finalSpawnCwd = cwd;
	let finalSpawnPrompt: string | undefined = fullPrompt;
	let finalSpawnEnvVars =
		configResolution.effectiveCustomEnvVars ?? getCustomEnvVarsCallback?.(participant.agentId);
	let finalSpawnShell: string | undefined;
	let finalSpawnRunInShell = false;

	console.log(`[GroupChat:Debug] Recovery spawn command: ${finalSpawnCommand}`);
	console.log(`[GroupChat:Debug] Recovery spawn args count: ${finalSpawnArgs.length}`);

	// Apply SSH wrapping if configured for this session
	if (sshStore && matchingSession?.sshRemoteConfig) {
		console.log(`[GroupChat:Debug] Applying SSH wrapping for recovery of ${participantName}...`);
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
			console.log(
				`[GroupChat:Debug] SSH remote used for recovery: ${sshWrapped.sshRemoteUsed.name}`
			);
		}
	}

	// Get Windows-specific spawn config (shell, stdin mode) - handles SSH exclusion
	const winConfig = getWindowsSpawnConfig(participant.agentId, matchingSession?.sshRemoteConfig);
	if (winConfig.shell) {
		finalSpawnShell = winConfig.shell;
		finalSpawnRunInShell = winConfig.runInShell;
		console.log(`[GroupChat:Debug] Windows shell config for recovery: ${winConfig.shell}`);
	}

	const spawnResult = processManager.spawn({
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

	console.log(`[GroupChat:Debug] Recovery spawn result: ${JSON.stringify(spawnResult)}`);
	console.log(`[GroupChat:Debug] promptArgs: ${agent.promptArgs ? 'defined' : 'undefined'}`);
	console.log(`[GroupChat:Debug] =============================================`);
}
