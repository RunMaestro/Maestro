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
export type CueEventType =
	| 'time.heartbeat'
	| 'time.scheduled'
	| 'file.changed'
	| 'agent.completed'
	| 'github.pull_request'
	| 'github.issue'
	| 'task.pending';

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
		// Get global Cue settings (timeout, concurrency, queue)
		getSettings: (): Promise<{
			timeout_minutes: number;
			timeout_on_fail: 'break' | 'continue';
			max_concurrent: number;
			queue_size: number;
		}> => ipcRenderer.invoke('cue:getSettings'),

		// Get status of all Cue-enabled sessions
		getStatus: (): Promise<CueSessionStatus[]> => ipcRenderer.invoke('cue:getStatus'),

		// Get all sessions with their subscriptions (for graph visualization)
		getGraphData: (): Promise<
			Array<{
				sessionId: string;
				sessionName: string;
				toolType: string;
				subscriptions: Array<{
					name: string;
					event: CueEventType;
					enabled: boolean;
					prompt: string;
					interval_minutes?: number;
					watch?: string;
					source_session?: string | string[];
					fan_out?: string[];
					filter?: Record<string, string | number | boolean>;
					repo?: string;
					poll_minutes?: number;
				}>;
			}>
		> => ipcRenderer.invoke('cue:getGraphData'),

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

		// Manually trigger a subscription by name (Run Now)
		triggerSubscription: (subscriptionName: string): Promise<boolean> =>
			ipcRenderer.invoke('cue:triggerSubscription', { subscriptionName }),

		// Get queue status per session
		getQueueStatus: (): Promise<Record<string, number>> => ipcRenderer.invoke('cue:getQueueStatus'),

		// Refresh a session's Cue configuration
		refreshSession: (sessionId: string, projectRoot: string): Promise<void> =>
			ipcRenderer.invoke('cue:refreshSession', { sessionId, projectRoot }),

		// Read raw YAML content from a session's maestro-cue.yaml
		readYaml: (projectRoot: string): Promise<string | null> =>
			ipcRenderer.invoke('cue:readYaml', { projectRoot }),

		// Write YAML content to a session's maestro-cue.yaml (with optional external prompt files)
		writeYaml: (
			projectRoot: string,
			content: string,
			promptFiles?: Record<string, string>
		): Promise<void> => ipcRenderer.invoke('cue:writeYaml', { projectRoot, content, promptFiles }),

		// Delete a session's cue.yaml config file
		deleteYaml: (projectRoot: string): Promise<boolean> =>
			ipcRenderer.invoke('cue:deleteYaml', { projectRoot }),

		// Validate YAML content as a Cue configuration
		validateYaml: (content: string): Promise<{ valid: boolean; errors: string[] }> =>
			ipcRenderer.invoke('cue:validateYaml', { content }),

		// Save pipeline layout (node positions, viewport, pipeline selection)
		savePipelineLayout: (layout: Record<string, unknown>): Promise<void> =>
			ipcRenderer.invoke('cue:savePipelineLayout', { layout }),

		// Load saved pipeline layout
		loadPipelineLayout: (): Promise<Record<string, unknown> | null> =>
			ipcRenderer.invoke('cue:loadPipelineLayout'),

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
