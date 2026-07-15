/**
 * Data output listener.
 * Handles process output data, including group chat buffering and web broadcasting.
 */

import type { ProcessManager } from '../process-manager';
import { GROUP_CHAT_PREFIX, type ProcessListenerDependencies } from './types';
import { groupChatEmitters } from '../ipc/handlers/groupChat';

/**
 * Maximum buffer size per session (10MB).
 * Prevents unbounded memory growth from long-running or misbehaving processes.
 */
const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

/**
 * Coalesce process:data chunks for this long before flushing to the renderer.
 * PTY output (terminal echo, `cat bigfile`, npm logs) can arrive as thousands of
 * tiny chunks; each used to be its own webContents.send, which showed up in perf
 * traces as a flood of "Receive mojo message" tasks on the main thread. One frame
 * (~16ms) of coalescing collapses a burst into a single send. The renderer already
 * appends each chunk to a running buffer, so concatenating adjacent chunks is
 * byte-for-byte equivalent - purely fewer, larger messages.
 */
const DATA_FLUSH_INTERVAL_MS = 16;

/**
 * Hard cap on buffered process:data size - flush early if a burst exceeds this so
 * a firehose (e.g. `cat` of a large file) never sits in memory waiting on the timer.
 */
const DATA_FLUSH_SIZE = 64 * 1024;

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

	// Per-session process:data coalescing buffers. Only the desktop
	// safeSend('process:data', ...) path is batched; the web-broadcast path below
	// still fires per chunk (separate transport/consumer).
	const dataBuffers = new Map<
		string,
		{ content: string; timer: ReturnType<typeof setTimeout> | null }
	>();

	const flushData = (sessionId: string) => {
		const entry = dataBuffers.get(sessionId);
		if (!entry) return;
		if (entry.timer) {
			clearTimeout(entry.timer);
			entry.timer = null;
		}
		const content = entry.content;
		dataBuffers.delete(sessionId);
		if (content) {
			safeSend('process:data', sessionId, content);
		}
	};

	const queueData = (sessionId: string, data: string) => {
		let entry = dataBuffers.get(sessionId);
		if (!entry) {
			entry = { content: '', timer: null };
			dataBuffers.set(sessionId, entry);
		}
		entry.content += data;

		// Flush early on a large burst so a firehose never waits on the timer.
		if (entry.content.length >= DATA_FLUSH_SIZE) {
			flushData(sessionId);
			return;
		}
		if (!entry.timer) {
			entry.timer = setTimeout(() => flushData(sessionId), DATA_FLUSH_INTERVAL_MS);
		}
	};

	// Release buffered output promptly at turn/process boundaries. setupDataListener
	// runs before setupExitListener (see process-listeners/index.ts), so this exit
	// flush's process:data send is emitted BEFORE the exit listener's process:exit,
	// preserving the renderer's data-then-exit ordering.
	processManager.on('query-complete', (sessionId: string) => {
		flushData(sessionId);
	});
	processManager.on('exit', (sessionId: string) => {
		flushData(sessionId);
	});

	// Listen to raw stdout for live output streaming to group chat participant peek panels.
	// The 'data' event for stream-json sessions only fires at turn completion (result ready),
	// so we need raw-stdout to stream chunks in real time during agent work.
	processManager.on('raw-stdout', (sessionId: string, chunk: string) => {
		if (!sessionId.startsWith(GROUP_CHAT_PREFIX)) return;
		const participantInfo = outputParser.parseParticipantSessionId(sessionId);
		if (participantInfo) {
			groupChatEmitters.emitParticipantLiveOutput?.(
				participantInfo.groupChatId,
				participantInfo.participantName,
				chunk
			);
		}
	});

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
			// Note: live output is streamed via raw-stdout listener above (fires per chunk during work).
			return; // Don't send to regular process:data handler
		}

		// CRITICAL: group-chat domain containment. If we got here with a sessionId
		// that starts with GROUP_CHAT_PREFIX but neither the moderator regex nor
		// parseParticipantSessionId matched, it means something produced a
		// group-chat-shaped sessionId we don't recognize. We MUST NOT fall through
		// to safeSend('process:data', ...) or the web broadcast path below, or the
		// group-chat output bytes will leak into the regular renderer channel
		// (and, transitively, into anything that subscribes to process:data -
		// including the session's stdout history that the UI displays). Drop the
		// data and log loudly so the unknown shape can be investigated.
		if (isGroupChatSession) {
			debugLog(
				'GroupChat:Debug',
				`WARNING: unrecognized group-chat sessionId shape - dropping ${data.length} bytes to prevent cross-domain leak: ${sessionId}`
			);
			return;
		}

		// Desktop channel: coalesce into ~16ms windows to cut IPC message volume.
		queueData(sessionId, data);

		// Broadcast to web clients - extract base session ID (remove -ai or -terminal suffix)
		// IMPORTANT: Skip PTY terminal output (-terminal suffix) as it contains raw ANSI codes.
		// Web interface terminal commands use runCommand() which emits with plain session IDs.
		const webServer = getWebServer();
		if (webServer) {
			// Broadcast raw PTY terminal output as terminal_data (for xterm.js in web client)
			if (sessionId.endsWith('-terminal')) {
				const baseSessionId = sessionId.replace(/-terminal$/, '');
				debugLog(
					'WebBroadcast',
					`Broadcasting terminal_data: session=${baseSessionId}, dataLen=${data.length}`
				);
				webServer.broadcastToSessionClients(baseSessionId, {
					type: 'terminal_data',
					sessionId: baseSessionId,
					data,
					timestamp: Date.now(),
				});
				return;
			}

			// Don't broadcast background batch/synopsis output to web clients
			// These are internal Auto Run operations that should only appear in history, not as chat messages
			// Use proper regex patterns to avoid false positives from UUIDs containing "batch" or "synopsis"
			if (REGEX_BATCH_SESSION.test(sessionId) || REGEX_SYNOPSIS_SESSION.test(sessionId)) {
				debugLog('WebBroadcast', `SKIPPING batch/synopsis output for web: session=${sessionId}`);
				return;
			}

			// Extract base session ID and tab ID from format: {id}-ai-{tabId}
			const baseSessionId = sessionId.replace(REGEX_AI_SUFFIX, '');
			const isAiOutput = sessionId.includes('-ai-');

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
