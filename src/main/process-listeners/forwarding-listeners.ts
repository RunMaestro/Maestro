/**
 * Simple IPC forwarding listeners.
 * These listeners just forward events from ProcessManager to the renderer.
 */

import type { ProcessManager } from '../process-manager';
import type { ProcessListenerDependencies, ToolExecution } from './types';

/**
 * Sets up simple forwarding listeners that pass events directly to renderer.
 * These are lightweight handlers that don't require any processing logic.
 */
export function setupForwardingListeners(
	processManager: ProcessManager,
	deps: Pick<ProcessListenerDependencies, 'broadcastToAllWindows'>
): void {
	const { broadcastToAllWindows } = deps;

	// Handle slash commands from Claude Code init message
	processManager.on('slash-commands', (sessionId: string, slashCommands: string[]) => {
			broadcastToAllWindows('process:slash-commands', sessionId, slashCommands);
	});

	// Handle thinking/streaming content chunks from AI agents
	// Emitted when agents produce partial text events (isPartial: true)
	// Renderer decides whether to display based on tab's showThinking setting
	processManager.on('thinking-chunk', (sessionId: string, content: string) => {
			broadcastToAllWindows('process:thinking-chunk', sessionId, content);
	});

	// Handle tool execution events (OpenCode, Codex)
	processManager.on('tool-execution', (sessionId: string, toolEvent: ToolExecution) => {
			broadcastToAllWindows('process:tool-execution', sessionId, toolEvent);
	});

	// Handle stderr separately from runCommand (for clean command execution)
	processManager.on('stderr', (sessionId: string, data: string) => {
			broadcastToAllWindows('process:stderr', sessionId, data);
	});

	// Handle command exit (from runCommand - separate from PTY exit)
	processManager.on('command-exit', (sessionId: string, code: number) => {
			broadcastToAllWindows('process:command-exit', sessionId, code);
	});
}
