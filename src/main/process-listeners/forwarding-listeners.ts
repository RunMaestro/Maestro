/**
 * Simple IPC forwarding listeners.
 * These listeners just forward events from ProcessManager to the renderer.
 */

import type { ProcessManager } from '../process-manager';
import type { ProcessListenerDependencies, ToolExecution } from './types';

/** Coalesce thinking chunks for this long before flushing to the renderer. */
const THINKING_CHUNK_FLUSH_INTERVAL_MS = 50;
/** Hard cap on buffered thinking chunk size — flush early if exceeded. */
const THINKING_CHUNK_FLUSH_SIZE = 8 * 1024;

/**
 * Sets up simple forwarding listeners that pass events directly to renderer.
 * These are lightweight handlers that don't require any processing logic.
 * Also broadcasts tool-execution events to web clients for UX parity.
 */
export function setupForwardingListeners(
	processManager: ProcessManager,
	deps: Pick<ProcessListenerDependencies, 'safeSend' | 'getWebServer' | 'patterns'>
): void {
	const { safeSend, getWebServer, patterns } = deps;
	const { REGEX_AI_SUFFIX, REGEX_AI_TAB_ID } = patterns;

	// Handle slash commands from Claude Code init message
	processManager.on('slash-commands', (sessionId: string, slashCommands: string[]) => {
		safeSend('process:slash-commands', sessionId, slashCommands);
	});

	// Per-session thinking-chunk buffers. Streaming reasoning can arrive at
	// per-character granularity; coalescing them into ~50ms windows cuts IPC
	// volume dramatically without changing observable behavior — the renderer
	// already appends each chunk to a running buffer.
	const thinkingBuffers = new Map<
		string,
		{ content: string; timer: ReturnType<typeof setTimeout> | null }
	>();

	const flushThinking = (sessionId: string) => {
		const entry = thinkingBuffers.get(sessionId);
		if (!entry) return;
		if (entry.timer) {
			clearTimeout(entry.timer);
			entry.timer = null;
		}
		const content = entry.content;
		thinkingBuffers.delete(sessionId);
		if (content) {
			safeSend('process:thinking-chunk', sessionId, content);
		}
	};

	// Handle thinking/streaming content chunks from AI agents
	// Emitted when agents produce partial text events (isPartial: true)
	// Renderer decides whether to display based on tab's showThinking setting
	processManager.on('thinking-chunk', (sessionId: string, content: string) => {
		if (!content) return;
		let entry = thinkingBuffers.get(sessionId);
		if (!entry) {
			entry = { content: '', timer: null };
			thinkingBuffers.set(sessionId, entry);
		}
		entry.content += content;

		if (entry.content.length >= THINKING_CHUNK_FLUSH_SIZE) {
			flushThinking(sessionId);
			return;
		}

		if (!entry.timer) {
			entry.timer = setTimeout(() => flushThinking(sessionId), THINKING_CHUNK_FLUSH_INTERVAL_MS);
		}
	});

	// Flush pending thinking content the moment the agent finishes a turn so
	// the final tail isn't held back by the 50ms timer.
	processManager.on('query-complete', (sessionId: string) => {
		flushThinking(sessionId);
	});
	processManager.on('exit', (sessionId: string) => {
		flushThinking(sessionId);
	});

	// Handle tool execution events (OpenCode, Codex)
	processManager.on('tool-execution', (sessionId: string, toolEvent: ToolExecution) => {
		safeSend('process:tool-execution', sessionId, toolEvent);

		// Broadcast to web clients for UX parity with desktop thinking stream
		const webServer = getWebServer();
		if (webServer) {
			const baseSessionId = sessionId.replace(REGEX_AI_SUFFIX, '');
			const tabIdMatch = sessionId.match(REGEX_AI_TAB_ID);
			const tabId = tabIdMatch ? tabIdMatch[1] : '';

			const toolState = toolEvent.state as Record<string, unknown> | undefined;
			webServer.broadcastToolEvent(baseSessionId, tabId, {
				id: `tool-${toolEvent.timestamp}-${toolEvent.toolName}`,
				timestamp: toolEvent.timestamp,
				source: 'tool',
				text: toolEvent.toolName,
				metadata: {
					toolState: {
						name: toolEvent.toolName,
						status: (toolState?.status as 'running' | 'completed' | 'error') ?? 'running',
						input: toolState?.input as Record<string, unknown> | undefined,
					},
				},
			});
		}
	});

	// Handle stderr separately from runCommand (for clean command execution)
	processManager.on('stderr', (sessionId: string, data: string) => {
		safeSend('process:stderr', sessionId, data);
	});

	// Handle command exit (from runCommand - separate from PTY exit)
	processManager.on('command-exit', (sessionId: string, code: number) => {
		safeSend('process:command-exit', sessionId, code);
	});
}
