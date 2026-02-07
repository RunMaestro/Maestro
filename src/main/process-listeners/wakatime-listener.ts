/**
 * WakaTime heartbeat listener.
 * Sends WakaTime heartbeats on AI activity (data, thinking-chunk events) and batch
 * query completions. Cleans up debounce tracking on process exit.
 *
 * The `data` event fires on every stdout chunk for both interactive and batch sessions.
 * The `thinking-chunk` event fires while the AI is actively reasoning (extended thinking).
 * Together these ensure heartbeats cover the full duration of AI activity.
 * The `query-complete` event fires only for batch/auto-run processes.
 */

import type { ProcessManager } from '../process-manager';
import type { QueryCompleteData } from '../process-manager/types';
import type { WakaTimeManager } from '../wakatime-manager';

/** Helper to send a heartbeat for a managed process */
function heartbeatForSession(
	processManager: ProcessManager,
	wakaTimeManager: WakaTimeManager,
	sessionId: string
): void {
	const managedProcess = processManager.get(sessionId);
	if (!managedProcess || managedProcess.isTerminal) return;
	const projectName = managedProcess.projectPath || managedProcess.cwd || sessionId;
	void wakaTimeManager.sendHeartbeat(
		sessionId, projectName, managedProcess.cwd, managedProcess.toolType
	);
}

/**
 * Sets up the WakaTime heartbeat listener on data, thinking-chunk,
 * query-complete, and exit events.
 * Heartbeat calls are fire-and-forget (no await needed in the listener).
 */
export function setupWakaTimeListener(
	processManager: ProcessManager,
	wakaTimeManager: WakaTimeManager
): void {
	// Send heartbeat on any AI output (covers interactive sessions)
	// The 2-minute debounce in WakaTimeManager prevents flooding
	processManager.on('data', (sessionId: string) => {
		heartbeatForSession(processManager, wakaTimeManager, sessionId);
	});

	// Send heartbeat during AI thinking (extended thinking / reasoning)
	// This ensures time spent on long reasoning is captured
	processManager.on('thinking-chunk', (sessionId: string) => {
		heartbeatForSession(processManager, wakaTimeManager, sessionId);
	});

	// Also send heartbeat on query-complete for batch/auto-run processes
	processManager.on('query-complete', (_sessionId: string, queryData: QueryCompleteData) => {
		const projectName = queryData.projectPath || queryData.sessionId;
		void wakaTimeManager.sendHeartbeat(
			queryData.sessionId, projectName, queryData.projectPath, queryData.agentType
		);
	});

	// Clean up debounce tracking when a process exits
	processManager.on('exit', (sessionId: string) => {
		wakaTimeManager.removeSession(sessionId);
	});
}
