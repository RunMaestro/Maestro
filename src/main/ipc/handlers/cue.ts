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
import { ipcMain } from 'electron';
import * as yaml from 'js-yaml';
import { withIpcErrorLogging, type CreateHandlerOptions } from '../../utils/ipcHandler';
import { validateCueConfig } from '../../cue/cue-yaml-loader';
import { CUE_YAML_FILENAME } from '../../cue/cue-types';
import type { CueEngine } from '../../cue/cue-engine';
import type { CueRunResult, CueSessionStatus } from '../../cue/cue-types';

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

	// Read raw YAML content from a session's maestro-cue.yaml
	ipcMain.handle(
		'cue:readYaml',
		withIpcErrorLogging(
			handlerOpts('readYaml'),
			async (options: { projectRoot: string }): Promise<string | null> => {
				const filePath = path.join(options.projectRoot, CUE_YAML_FILENAME);
				if (!fs.existsSync(filePath)) {
					return null;
				}
				return fs.readFileSync(filePath, 'utf-8');
			}
		)
	);

	// Write YAML content to a session's maestro-cue.yaml
	ipcMain.handle(
		'cue:writeYaml',
		withIpcErrorLogging(
			handlerOpts('writeYaml'),
			async (options: { projectRoot: string; content: string }): Promise<void> => {
				const filePath = path.join(options.projectRoot, CUE_YAML_FILENAME);
				fs.writeFileSync(filePath, options.content, 'utf-8');
				// The file watcher in CueEngine will automatically detect the change and refresh
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
}
