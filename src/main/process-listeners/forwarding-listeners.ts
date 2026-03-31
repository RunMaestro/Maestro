/**
 * Simple IPC forwarding listeners.
 * These listeners just forward events from ProcessManager to the renderer.
 */

import type { ProcessManager } from '../process-manager';
import type { ProcessListenerDependencies, ToolExecution } from './types';

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

	// Handle thinking/streaming content chunks from AI agents
	// Emitted when agents produce partial text events (isPartial: true)
	// Renderer decides whether to display based on tab's showThinking setting
	processManager.on('thinking-chunk', (sessionId: string, content: string) => {
		safeSend('process:thinking-chunk', sessionId, content);
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
