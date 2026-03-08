/**
 * Cue IPC Handlers
 *
 * Provides IPC handlers for the Maestro Cue event-driven automation system:
 * - Engine runtime controls (enable/disable, stop runs)
 * - Status and activity log queries
 * - YAML configuration management (read, write, validate)
 */

import * as fs from 'fs';
import * as path from 'path';
import { app, ipcMain } from 'electron';
import * as yaml from 'js-yaml';
import { withIpcErrorLogging, type CreateHandlerOptions } from '../../utils/ipcHandler';
import { validateCueConfig, resolveCueConfigPath } from '../../cue/cue-yaml-loader';
import { CUE_CONFIG_PATH, MAESTRO_DIR, CUE_PROMPTS_DIR } from '../../../shared/maestro-paths';
import type { CueEngine } from '../../cue/cue-engine';
import type {
	CueGraphSession,
	CueRunResult,
	CueSessionStatus,
	CueSettings,
} from '../../cue/cue-types';
import type { PipelineLayoutState } from '../../../shared/cue-pipeline-types';

const LOG_CONTEXT = '[Cue]';

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

	// Enable the Cue engine (runtime control)
	ipcMain.handle(
		'cue:enable',
		withIpcErrorLogging(handlerOpts('enable'), async (): Promise<void> => {
			requireEngine().start();
		})
	);

	// Disable the Cue engine (runtime control)
	ipcMain.handle(
		'cue:disable',
		withIpcErrorLogging(handlerOpts('disable'), async (): Promise<void> => {
			requireEngine().stop();
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
			async (options: { subscriptionName: string }): Promise<boolean> => {
				return requireEngine().triggerSubscription(options.subscriptionName);
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
				const filePath = resolveCueConfigPath(options.projectRoot);
				if (!filePath) {
					return null;
				}
				return fs.readFileSync(filePath, 'utf-8');
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
			}): Promise<void> => {
				const maestroDir = path.join(options.projectRoot, MAESTRO_DIR);
				if (!fs.existsSync(maestroDir)) {
					fs.mkdirSync(maestroDir, { recursive: true });
				}
				const filePath = path.join(options.projectRoot, CUE_CONFIG_PATH);
				fs.writeFileSync(filePath, options.content, 'utf-8');

				// Write external prompt files
				if (options.promptFiles) {
					const promptsDir = path.join(options.projectRoot, CUE_PROMPTS_DIR);
					if (!fs.existsSync(promptsDir)) {
						fs.mkdirSync(promptsDir, { recursive: true });
					}
					for (const [relativePath, content] of Object.entries(options.promptFiles)) {
						const absPath = path.join(options.projectRoot, relativePath);
						const dir = path.dirname(absPath);
						if (!fs.existsSync(dir)) {
							fs.mkdirSync(dir, { recursive: true });
						}
						fs.writeFileSync(absPath, content, 'utf-8');
					}
				}
			}
		)
	);

	// Delete a session's cue.yaml config file
	ipcMain.handle(
		'cue:deleteYaml',
		withIpcErrorLogging(
			handlerOpts('deleteYaml'),
			async (options: { projectRoot: string }): Promise<boolean> => {
				const filePath = resolveCueConfigPath(options.projectRoot);
				if (!filePath) {
					return false;
				}
				fs.unlinkSync(filePath);
				return true;
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

	const layoutFilePath = path.join(app.getPath('userData'), 'cue-pipeline-layout.json');

	// Save pipeline layout (node positions, viewport, selected pipeline)
	ipcMain.handle(
		'cue:savePipelineLayout',
		withIpcErrorLogging(
			handlerOpts('savePipelineLayout'),
			async (options: { layout: PipelineLayoutState }): Promise<void> => {
				fs.writeFileSync(layoutFilePath, JSON.stringify(options.layout, null, 2), 'utf-8');
			}
		)
	);

	// Load saved pipeline layout
	ipcMain.handle(
		'cue:loadPipelineLayout',
		withIpcErrorLogging(
			handlerOpts('loadPipelineLayout'),
			async (): Promise<PipelineLayoutState | null> => {
				if (!fs.existsSync(layoutFilePath)) {
					return null;
				}
				const content = fs.readFileSync(layoutFilePath, 'utf-8');
				return JSON.parse(content) as PipelineLayoutState;
			}
		)
	);
}
