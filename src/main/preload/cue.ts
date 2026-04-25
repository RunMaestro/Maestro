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
import type {
	CueGraphSession,
	CueRunResult,
	CueSessionStatus,
	CueSettings,
} from '../../shared/cue';
import type { CueLogPayload } from '../../shared/cue-log-types';
import type { CueMetrics } from '../cue/cue-metrics';
import type { FanInHealthEntry } from '../cue/cue-fan-in-tracker';
export type {
	CueEvent,
	CueEventType,
	CueGraphSession,
	CueRunResult,
	CueRunStatus,
	CueSessionStatus,
	CueSettings,
} from '../../shared/cue';
export type { CueLogPayload } from '../../shared/cue-log-types';

/**
 * Payload shape received by `onActivityUpdate` listeners. The main process
 * forwards the `data` argument of every `onLog(level, message, data)` call
 * verbatim on `cue:activityUpdate`, and every data-bearing call passes a
 * typed `CueLogPayload` (queueOverflow, runFinished, rateLimitBackoff, …).
 * Renderer code narrows via `payload.type`.
 */
export type CueActivityPayload = CueLogPayload;

/**
 * Creates the Cue API object for preload exposure
 */
export function createCueApi() {
	return {
		// Get global Cue settings (timeout, concurrency, queue)
		getSettings: (): Promise<CueSettings> => ipcRenderer.invoke('cue:getSettings'),

		// Get status of all Cue-enabled sessions
		getStatus: (): Promise<CueSessionStatus[]> => ipcRenderer.invoke('cue:getStatus'),

		// Get all sessions with their subscriptions (for graph visualization)
		getGraphData: (): Promise<CueGraphSession[]> => ipcRenderer.invoke('cue:getGraphData'),

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

		// Manually trigger a subscription by name (Run Now), with optional prompt override
		triggerSubscription: (
			subscriptionName: string,
			prompt?: string,
			sourceAgentId?: string
		): Promise<boolean> =>
			ipcRenderer.invoke('cue:triggerSubscription', { subscriptionName, prompt, sourceAgentId }),

		// Get queue status per session
		getQueueStatus: (): Promise<Record<string, number>> => ipcRenderer.invoke('cue:getQueueStatus'),

		// Get engine metrics snapshot (runsStarted, eventsDropped, etc.)
		getMetrics: (): Promise<CueMetrics | null> => ipcRenderer.invoke('cue:getMetrics'),

		// Get stalled fan-in subscriptions (> 50% timeout). Empty = healthy.
		getFanInHealth: (): Promise<FanInHealthEntry[]> => ipcRenderer.invoke('cue:getFanInHealth'),

		// Refresh a session's Cue configuration
		refreshSession: (sessionId: string, projectRoot: string): Promise<void> =>
			ipcRenderer.invoke('cue:refreshSession', { sessionId, projectRoot }),

		// Remove a session from Cue tracking
		removeSession: (sessionId: string): Promise<void> =>
			ipcRenderer.invoke('cue:removeSession', { sessionId }),

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

		// Listen for real-time activity updates from the main process. Payload
		// is a typed CueLogPayload discriminated union — narrow on `data.type`
		// to handle specific events (queueOverflow, runFinished, ...).
		onActivityUpdate: (callback: (data: CueActivityPayload) => void): (() => void) => {
			const handler = (_e: unknown, data: CueActivityPayload) => callback(data);
			ipcRenderer.on('cue:activityUpdate', handler);
			return () => {
				ipcRenderer.removeListener('cue:activityUpdate', handler);
			};
		},
	};
}

export type CueApi = ReturnType<typeof createCueApi>;
