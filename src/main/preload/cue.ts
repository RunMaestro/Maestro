/**
 * Preload API for Cue operations
 *
 * Provides the window.maestro.cue namespace for:
 * - Engine status and activity log queries
 * - Runtime engine controls (enable/disable)
 * - Run management (stop individual or all)
 * - YAML configuration management (read, write, validate)
 * - Real-time activity updates via event listener
 */

import { ipcRenderer } from 'electron';

/** Event types that can trigger a Cue subscription */
export type CueEventType = 'time.interval' | 'file.changed' | 'agent.completed';

/** Status of a Cue run */
export type CueRunStatus = 'running' | 'completed' | 'failed' | 'timeout' | 'stopped';

/** An event instance produced by a trigger */
export interface CueEvent {
	id: string;
	type: CueEventType;
	timestamp: string;
	triggerName: string;
	payload: Record<string, unknown>;
}

/** Result of a completed (or failed/timed-out) Cue run */
export interface CueRunResult {
	runId: string;
	sessionId: string;
	sessionName: string;
	subscriptionName: string;
	event: CueEvent;
	status: CueRunStatus;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	durationMs: number;
	startedAt: string;
	endedAt: string;
}

/** Status summary for a Cue-enabled session */
export interface CueSessionStatus {
	sessionId: string;
	sessionName: string;
	toolType: string;
	enabled: boolean;
	subscriptionCount: number;
	activeRuns: number;
	lastTriggered?: string;
	nextTrigger?: string;
}

/**
 * Creates the Cue API object for preload exposure
 */
export function createCueApi() {
	return {
		// Get status of all Cue-enabled sessions
		getStatus: (): Promise<CueSessionStatus[]> => ipcRenderer.invoke('cue:getStatus'),

		// Get currently active Cue runs
		getActiveRuns: (): Promise<CueRunResult[]> => ipcRenderer.invoke('cue:getActiveRuns'),

		// Get activity log (recent completed/failed runs)
		getActivityLog: (limit?: number): Promise<CueRunResult[]> =>
			ipcRenderer.invoke('cue:getActivityLog', { limit }),

		// Enable the Cue engine (runtime control)
		enable: (): Promise<void> => ipcRenderer.invoke('cue:enable'),

		// Disable the Cue engine (runtime control)
		disable: (): Promise<void> => ipcRenderer.invoke('cue:disable'),

		// Stop a specific running Cue execution
		stopRun: (runId: string): Promise<boolean> => ipcRenderer.invoke('cue:stopRun', { runId }),

		// Stop all running Cue executions
		stopAll: (): Promise<void> => ipcRenderer.invoke('cue:stopAll'),

		// Get queue status per session
		getQueueStatus: (): Promise<Record<string, number>> => ipcRenderer.invoke('cue:getQueueStatus'),

		// Refresh a session's Cue configuration
		refreshSession: (sessionId: string, projectRoot: string): Promise<void> =>
			ipcRenderer.invoke('cue:refreshSession', { sessionId, projectRoot }),

		// Read raw YAML content from a session's maestro-cue.yaml
		readYaml: (projectRoot: string): Promise<string | null> =>
			ipcRenderer.invoke('cue:readYaml', { projectRoot }),

		// Write YAML content to a session's maestro-cue.yaml
		writeYaml: (projectRoot: string, content: string): Promise<void> =>
			ipcRenderer.invoke('cue:writeYaml', { projectRoot, content }),

		// Validate YAML content as a Cue configuration
		validateYaml: (content: string): Promise<{ valid: boolean; errors: string[] }> =>
			ipcRenderer.invoke('cue:validateYaml', { content }),

		// Listen for real-time activity updates from the main process
		onActivityUpdate: (callback: (data: CueRunResult) => void): (() => void) => {
			const handler = (_e: unknown, data: CueRunResult) => callback(data);
			ipcRenderer.on('cue:activityUpdate', handler);
			return () => {
				ipcRenderer.removeListener('cue:activityUpdate', handler);
			};
		},
	};
}

export type CueApi = ReturnType<typeof createCueApi>;
