/**
 * Data output listener.
 * Handles process output data, including group chat buffering and web broadcasting.
 */

import type { ProcessManager } from '../process-manager';
import { GROUP_CHAT_PREFIX, type ProcessListenerDependencies } from './types';

/**
 * Maximum buffer size per session (10MB).
 * Prevents unbounded memory growth from long-running or misbehaving processes.
 */
const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

/**
 * Length of random suffix in message IDs (9 characters of base36).
 * Combined with timestamp provides uniqueness for web broadcast deduplication.
 */
const MSG_ID_RANDOM_LENGTH = 9;

/**
 * Sets up the data listener for process output.
 * Handles:
 * - Group chat moderator/participant output buffering
 * - Regular process data forwarding to renderer
 * - Web broadcast to connected clients
 */
export function setupDataListener(
	processManager: ProcessManager,
	deps: Pick<
		ProcessListenerDependencies,
		'safeSend' | 'getWebServer' | 'outputBuffer' | 'outputParser' | 'debugLog' | 'patterns'
	>
): void {
	const { safeSend, getWebServer, outputBuffer, outputParser, debugLog, patterns } = deps;
	const {
		REGEX_MODERATOR_SESSION,
		REGEX_AI_SUFFIX,
		REGEX_AI_TAB_ID,
		REGEX_BATCH_SESSION,
		REGEX_SYNOPSIS_SESSION,
	} = patterns;

	processManager.on('data', (sessionId: string, data: string) => {
		// Fast path: skip regex for non-group-chat sessions (performance optimization)
		// Most sessions don't start with 'group-chat-', so this avoids expensive regex matching
		const isGroupChatSession = sessionId.startsWith(GROUP_CHAT_PREFIX);

		// Handle group chat moderator output - buffer it
		// Session ID format: group-chat-{groupChatId}-moderator-{uuid} or group-chat-{groupChatId}-moderator-synthesis-{uuid}
		const moderatorMatch = isGroupChatSession ? sessionId.match(REGEX_MODERATOR_SESSION) : null;
		if (moderatorMatch) {
			const groupChatId = moderatorMatch[1];
			debugLog('GroupChat:Debug', `MODERATOR DATA received for chat ${groupChatId}`);
			debugLog('GroupChat:Debug', `Session ID: ${sessionId}`);
			debugLog('GroupChat:Debug', `Data length: ${data.length}`);
			// Buffer the output - will be routed on process exit
			const totalLength = outputBuffer.appendToGroupChatBuffer(sessionId, data);
			debugLog('GroupChat:Debug', `Buffered total: ${totalLength} chars`);
			// Warn if buffer is growing too large (potential memory leak)
			if (totalLength > MAX_BUFFER_SIZE) {
				debugLog(
					'GroupChat:Debug',
					`WARNING: Buffer size ${totalLength} exceeds ${MAX_BUFFER_SIZE} bytes for moderator session ${sessionId}`
				);
			}
			return; // Don't send to regular process:data handler
		}

		// Handle group chat participant output - buffer it
		// Session ID format: group-chat-{groupChatId}-participant-{name}-{uuid|timestamp}
		// Only parse if it's a group chat session (performance optimization)
		const participantInfo = isGroupChatSession
			? outputParser.parseParticipantSessionId(sessionId)
			: null;
		if (participantInfo) {
			debugLog('GroupChat:Debug', 'PARTICIPANT DATA received');
			debugLog(
				'GroupChat:Debug',
				`Chat: ${participantInfo.groupChatId}, Participant: ${participantInfo.participantName}`
			);
			debugLog('GroupChat:Debug', `Session ID: ${sessionId}`);
			debugLog('GroupChat:Debug', `Data length: ${data.length}`);
			// Buffer the output - will be routed on process exit
			const totalLength = outputBuffer.appendToGroupChatBuffer(sessionId, data);
			debugLog('GroupChat:Debug', `Buffered total: ${totalLength} chars`);
			// Warn if buffer is growing too large (potential memory leak)
			if (totalLength > MAX_BUFFER_SIZE) {
				debugLog(
					'GroupChat:Debug',
					`WARNING: Buffer size ${totalLength} exceeds ${MAX_BUFFER_SIZE} bytes for participant ${participantInfo.participantName}`
				);
			}
			return; // Don't send to regular process:data handler
		}

		// Preserve full session ID for per-tab routing (e.g., {sessionId}-terminal-{tabId}).
		safeSend('process:data', sessionId, data);

		// Broadcast to web clients - extract base session ID (remove -ai or -terminal suffix)
		// IMPORTANT: Skip PTY terminal output (-terminal suffix) as it contains raw ANSI codes.
		// Web interface terminal commands use runCommand() which emits with plain session IDs.
		const webServer = getWebServer();
		if (webServer) {
			// Don't broadcast raw PTY terminal output to web clients
			if (sessionId.endsWith('-terminal')) {
				debugLog('WebBroadcast', `SKIPPING PTY terminal output for web: session=${sessionId}`);
				return;
			}

			// Don't broadcast background batch/synopsis output to web clients
			// These are internal Auto Run operations that should only appear in history, not as chat messages
			// Use proper regex patterns to avoid false positives from UUIDs containing "batch" or "synopsis"
			if (REGEX_BATCH_SESSION.test(sessionId) || REGEX_SYNOPSIS_SESSION.test(sessionId)) {
				debugLog('WebBroadcast', `SKIPPING batch/synopsis output for web: session=${sessionId}`);
				return;
			}

			// AI session IDs use format: {id}-ai-{tabId}; terminal tab IDs remain full
			// format: {id}-terminal-{tabId} and should not be stripped.
			const isAiOutput = sessionId.includes('-ai-');
			const baseSessionId = isAiOutput ? sessionId.replace(REGEX_AI_SUFFIX, '') : sessionId;

			// Extract tab ID from session ID format: {id}-ai-{tabId}
			const tabIdMatch = sessionId.match(REGEX_AI_TAB_ID);
			const tabId = tabIdMatch ? tabIdMatch[1] : undefined;

			// Generate unique message ID: timestamp + random suffix for deduplication
			const msgId = `${Date.now()}-${Math.random()
				.toString(36)
				.substring(2, 2 + MSG_ID_RANDOM_LENGTH)}`;
			debugLog(
				'WebBroadcast',
				`Broadcasting session_output: msgId=${msgId}, session=${baseSessionId}, tabId=${tabId || 'none'}, source=${isAiOutput ? 'ai' : 'terminal'}, dataLen=${data.length}`
			);
			webServer.broadcastToSessionClients(baseSessionId, {
				type: 'session_output',
				sessionId: baseSessionId,
				tabId,
				data,
				source: isAiOutput ? 'ai' : 'terminal',
				timestamp: Date.now(),
				msgId,
			});
		}
	});
}
