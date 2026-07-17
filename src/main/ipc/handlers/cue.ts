/**
 * Cue IPC Handlers
 *
 * Provides IPC handlers for the Maestro Cue event-driven automation system:
 * - Engine runtime controls (enable/disable, stop runs)
 * - Status and activity log queries
 * - YAML configuration management (read, write, validate)
 *
 * This module is a thin transport layer: business logic and filesystem I/O
 * live in domain modules (cue-engine, cue-config-repository,
 * pipeline-layout-store). Each handler should be a 1-line delegation.
 */

import { ipcMain } from 'electron';
import * as yaml from 'js-yaml';
import { withIpcErrorLogging, type CreateHandlerOptions } from '../../utils/ipcHandler';
import { validateCueConfig } from '../../cue/cue-yaml-loader';
import { cueDebugLog } from '../../../shared/cueDebug';
import { readCueConfigFile } from '../../cue/config/cue-config-repository';
import { createCueConfigMutationService } from '../../cue/config/cue-config-mutation-service';
import { setCueActive } from '../../cue/cue-active-state';
import { loadPipelineLayout, savePipelineLayout } from '../../cue/pipeline-layout-store';
import type { CueEngine } from '../../cue/cue-engine';
import type {
	CueGraphSession,
	CueRunResult,
	CueSessionStatus,
	CueSettings,
} from '../../cue/cue-types';
import type { PipelineLayoutState } from '../../../shared/cue-pipeline-types';

const LOG_CONTEXT = '[Cue]';
const cueConfigMutations = createCueConfigMutationService();

// Helper to create handler options with consistent context
const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/**
 * Dependencies required for Cue handler registration
 */
export interface CueHandlerDependencies {
	getCueEngine: () => CueEngine | null;
}

/**
 * Register all Cue IPC handlers.
 *
 * These handlers provide:
 * - Engine status and activity log queries
 * - Runtime engine controls (enable/disable)
 * - Run management (stop individual or all)
 * - YAML configuration management
 */
export function registerCueHandlers(deps: CueHandlerDependencies): void {
	const { getCueEngine } = deps;

	const requireEngine = (): CueEngine => {
		const engine = getCueEngine();
		if (!engine) {
			throw new Error('Cue engine not initialized');
		}
		return engine;
	};

	// Get global Cue settings (merged from engine state)
	ipcMain.handle(
		'cue:getSettings',
		withIpcErrorLogging(handlerOpts('getSettings'), async (): Promise<CueSettings> => {
			return requireEngine().getSettings();
		})
	);

	// Persist global Cue settings to every known cue.yaml on disk + refresh
	// engine in-memory state. Used by Settings → Encore Features → Maestro Cue.
	ipcMain.handle(
		'cue:saveSettings',
		withIpcErrorLogging(
			handlerOpts('saveSettings'),
			async (options: { settings: CueSettings }): Promise<{ writtenRoots: string[] }> => {
				return requireEngine().saveSettings(options.settings);
			}
		)
	);

	// Get status of all Cue-enabled sessions
	ipcMain.handle(
		'cue:getStatus',
		withIpcErrorLogging(handlerOpts('getStatus'), async (): Promise<CueSessionStatus[]> => {
			return requireEngine().getStatus();
		})
	);

	// Get currently active Cue runs
	ipcMain.handle(
		'cue:getActiveRuns',
		withIpcErrorLogging(handlerOpts('getActiveRuns'), async (): Promise<CueRunResult[]> => {
			return requireEngine().getActiveRuns();
		})
	);

	// Snapshot the in-flight stdout/stderr for an active Cue run. Returns null
	// when the runId isn't currently active. Powers the dashboard's
	// expand-active-run-row "live logs" UX (renderer polls this while expanded).
	ipcMain.handle(
		'cue:getRunLiveOutput',
		withIpcErrorLogging(
			handlerOpts('getRunLiveOutput'),
			async (options: { runId: string }): Promise<{ stdout: string; stderr: string } | null> => {
				return requireEngine().getRunLiveOutput(options.runId);
			}
		)
	);

	// Get activity log (recent completed/failed runs)
	ipcMain.handle(
		'cue:getActivityLog',
		withIpcErrorLogging(
			handlerOpts('getActivityLog'),
			async (options: { limit?: number }): Promise<CueRunResult[]> => {
				return requireEngine().getActivityLog(options?.limit);
			}
		)
	);

	// Get lifetime count of Cue events (dashboard stats card)
	ipcMain.handle(
		'cue:getEventCount',
		withIpcErrorLogging(handlerOpts('getEventCount'), async (): Promise<number> => {
			return requireEngine().getEventCount();
		})
	);

	// Enable the Cue engine (runtime control)
	ipcMain.handle(
		'cue:enable',
		withIpcErrorLogging(handlerOpts('enable'), async (): Promise<void> => {
			requireEngine().start('system-boot');
		})
	);

	// Disable the Cue engine (runtime control)
	ipcMain.handle(
		'cue:disable',
		withIpcErrorLogging(handlerOpts('disable'), async (): Promise<void> => {
			requireEngine().stop();
		})
	);

	// Visibility-aware pause: the renderer flips this on visibilitychange so
	// scanners (file-watcher / task-scanner / github-poller) stop doing
	// expensive background work while the app is hidden. Different from
	// enable/disable, which fully starts/stops the engine — setActive only
	// gates the per-tick work and does not tear down state.
	ipcMain.handle(
		'cue:setActive',
		withIpcErrorLogging(handlerOpts('setActive'), async (active: boolean): Promise<void> => {
			// Strict type check rather than Boolean(active) coercion. Coercion
			// would silently accept truthy strings / numbers / objects from a
			// misbehaving caller, hiding the bug. withIpcErrorLogging surfaces
			// thrown TypeErrors to Sentry so we get a real signal.
			if (typeof active !== 'boolean') {
				throw new TypeError(
					`cue:setActive expected boolean, got ${typeof active} (${String(active)})`
				);
			}
			setCueActive(active);
		})
	);

	// Stop a specific running Cue execution
	ipcMain.handle(
		'cue:stopRun',
		withIpcErrorLogging(
			handlerOpts('stopRun'),
			async (options: { runId: string }): Promise<boolean> => {
				return requireEngine().stopRun(options.runId);
			}
		)
	);

	// Stop all running Cue executions
	ipcMain.handle(
		'cue:stopAll',
		withIpcErrorLogging(handlerOpts('stopAll'), async (): Promise<void> => {
			requireEngine().stopAll();
		})
	);

	// Manually trigger a subscription by name (Run Now)
	ipcMain.handle(
		'cue:triggerSubscription',
		withIpcErrorLogging(
			handlerOpts('triggerSubscription'),
			async (options: {
				subscriptionName: string;
				prompt?: string;
				sourceAgentId?: string;
			}): Promise<boolean> => {
				return requireEngine().triggerSubscription(
					options.subscriptionName,
					options.prompt,
					options.sourceAgentId
				);
			}
		)
	);

	// Get queue status per session
	ipcMain.handle(
		'cue:getQueueStatus',
		withIpcErrorLogging(
			handlerOpts('getQueueStatus'),
			async (): Promise<Record<string, number>> => {
				const queueMap = requireEngine().getQueueStatus();
				const result: Record<string, number> = {};
				for (const [sessionId, count] of queueMap) {
					result[sessionId] = count;
				}
				return result;
			}
		)
	);

	// Get engine metrics snapshot (runsStarted, eventsDropped, etc.)
	ipcMain.handle(
		'cue:getMetrics',
		withIpcErrorLogging(handlerOpts('getMetrics'), async () => {
			return requireEngine().getMetrics();
		})
	);

	// Get fan-in health — stalled trackers > 50% timeout (empty = healthy).
	ipcMain.handle(
		'cue:getFanInHealth',
		withIpcErrorLogging(handlerOpts('getFanInHealth'), async () => {
			return requireEngine().getFanInHealth();
		})
	);

	// Refresh a session's Cue configuration
	ipcMain.handle(
		'cue:refreshSession',
		withIpcErrorLogging(
			handlerOpts('refreshSession'),
			async (options: { sessionId: string; projectRoot: string }): Promise<void> => {
				requireEngine().refreshSession(options.sessionId, options.projectRoot);
			}
		)
	);

	// Remove a session from Cue tracking
	ipcMain.handle(
		'cue:removeSession',
		withIpcErrorLogging(
			handlerOpts('removeSession'),
			async (options: { sessionId: string }): Promise<void> => {
				requireEngine().removeSession(options.sessionId);
			}
		)
	);

	// Get all sessions with their subscriptions (for graph visualization)
	ipcMain.handle(
		'cue:getGraphData',
		withIpcErrorLogging(handlerOpts('getGraphData'), async (): Promise<CueGraphSession[]> => {
			return requireEngine().getGraphData();
		})
	);

	// Read raw YAML content from a session's cue config (checks .maestro/cue.yaml then legacy)
	ipcMain.handle(
		'cue:readYaml',
		withIpcErrorLogging(
			handlerOpts('readYaml'),
			async (options: { projectRoot: string }): Promise<string | null> => {
				const file = readCueConfigFile(options.projectRoot);
				return file ? file.raw : null;
			}
		)
	);

	// Write YAML content to .maestro/cue.yaml (canonical path, creates .maestro/ if needed)
	// Optionally writes external prompt files alongside the YAML.
	ipcMain.handle(
		'cue:writeYaml',
		withIpcErrorLogging(
			handlerOpts('writeYaml'),
			async (options: {
				projectRoot: string;
				content: string;
				promptFiles?: Record<string, string>;
			}): Promise<{ changed: boolean }> => {
				cueDebugLog('main:writeYaml:received', {
					projectRoot: options.projectRoot,
					yamlBytes: options.content.length,
					promptFileCount: Object.keys(options.promptFiles ?? {}).length,
				});
				const result = await cueConfigMutations.replaceWithPromptFiles(
					options.projectRoot,
					options.content,
					options.promptFiles
				);
				return { changed: result.changed };
			}
		)
	);

	// Delete a session's cue.yaml config file. Also prunes every `.md` file
	// under `.maestro/prompts/` (keep-set is empty since there are no
	// subscriptions left to reference any prompt) and removes the prompts
	// directory if it ends up empty. Without this, "Remove Cue configuration"
	// left orphaned prompt files behind and the `.maestro` footprint never
	// shrank.
	ipcMain.handle(
		'cue:deleteYaml',
		withIpcErrorLogging(
			handlerOpts('deleteYaml'),
			async (options: { projectRoot: string }): Promise<boolean> => {
				return cueConfigMutations.deleteAndPrunePrompts(options.projectRoot);
			}
		)
	);

	// Validate YAML content as a Cue configuration
	ipcMain.handle(
		'cue:validateYaml',
		withIpcErrorLogging(
			handlerOpts('validateYaml'),
			async (options: { content: string }): Promise<{ valid: boolean; errors: string[] }> => {
				try {
					const parsed = yaml.load(options.content);
					return validateCueConfig(parsed);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return { valid: false, errors: [`YAML parse error: ${message}`] };
				}
			}
		)
	);

	// Save pipeline layout (node positions, viewport, selected pipeline)
	ipcMain.handle(
		'cue:savePipelineLayout',
		withIpcErrorLogging(
			handlerOpts('savePipelineLayout'),
			async (options: { layout: PipelineLayoutState }): Promise<void> => {
				savePipelineLayout(options.layout);
			}
		)
	);

	// Load saved pipeline layout
	ipcMain.handle(
		'cue:loadPipelineLayout',
		withIpcErrorLogging(
			handlerOpts('loadPipelineLayout'),
			async (): Promise<PipelineLayoutState | null> => {
				return loadPipelineLayout();
			}
		)
	);
}
