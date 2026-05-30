/**
 * Debug Package IPC Handlers
 *
 * Provides IPC handlers for generating debug/support packages.
 * These packages contain sanitized diagnostic information for bug analysis.
 */

import { ipcMain, dialog, BrowserWindow, app } from 'electron';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import Store from 'electron-store';
import { logger } from '../../utils/logger';
import { createIpcHandler, CreateHandlerOptions } from '../../utils/ipcHandler';
import {
	generateDebugPackage,
	previewDebugPackage,
	DebugPackageOptions,
	DebugPackageDependencies,
} from '../../debug-package';
import { AgentDetector } from '../../agents';
import { ProcessManager } from '../../process-manager';
import { WebServer } from '../../web-server';

const execFileAsync = promisify(execFile);

const LOG_CONTEXT = '[DebugPackage]';

// Helper to create handler options with consistent context
const handlerOpts = (operation: string, logSuccess = true): CreateHandlerOptions => ({
	context: LOG_CONTEXT,
	operation,
	logSuccess,
});

/**
 * Dependencies required for debug handler registration
 */
export interface DebugHandlerDependencies {
	getMainWindow: () => BrowserWindow | null;
	getAgentDetector: () => AgentDetector | null;
	getProcessManager: () => ProcessManager | null;
	getWebServer: () => WebServer | null;
	settingsStore: Store<any>;
	sessionsStore: Store<any>;
	groupsStore: Store<any>;
	bootstrapStore?: Store<any>;
}

/**
 * Register all Debug Package-related IPC handlers.
 *
 * These handlers provide:
 * - Generate debug package with user-selected save location
 * - Preview what will be included in the package
 */
export function registerDebugHandlers(deps: DebugHandlerDependencies): void {
	const {
		getMainWindow,
		getAgentDetector,
		getProcessManager,
		getWebServer,
		settingsStore,
		sessionsStore,
		groupsStore,
		bootstrapStore,
	} = deps;

	// Generate debug package with user-selected save location
	ipcMain.handle(
		'debug:createPackage',
		createIpcHandler(handlerOpts('createPackage'), async (options?: DebugPackageOptions) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				throw new Error('No main window available');
			}

			// Generate a default filename with timestamp
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
			const defaultFilename = `maestro-debug-${timestamp}.zip`;

			// Show save dialog
			const result = await dialog.showSaveDialog(mainWindow, {
				title: 'Save Debug Package',
				defaultPath: path.join(app.getPath('desktop'), defaultFilename),
				filters: [{ name: 'Zip Files', extensions: ['zip'] }],
			});

			if (result.canceled || !result.filePath) {
				return {
					path: null,
					filesIncluded: [],
					totalSizeBytes: 0,
					cancelled: true,
				};
			}

			const outputDir = path.dirname(result.filePath);

			// Create dependencies object for the debug package generator
			const debugDeps: DebugPackageDependencies = {
				getAgentDetector,
				getProcessManager,
				getWebServer,
				settingsStore,
				sessionsStore,
				groupsStore,
				bootstrapStore,
			};

			const packageResult = await generateDebugPackage(outputDir, debugDeps, options);

			if (!packageResult.success) {
				throw new Error(packageResult.error || 'Failed to generate debug package');
			}

			logger.info(`Debug package created: ${packageResult.path}`, LOG_CONTEXT);

			return {
				path: packageResult.path,
				filesIncluded: packageResult.filesIncluded,
				totalSizeBytes: packageResult.totalSizeBytes,
				cancelled: false,
			};
		})
	);

	// Preview what will be included (for UI)
	ipcMain.handle(
		'debug:previewPackage',
		createIpcHandler(handlerOpts('previewPackage', false), async () => {
			const preview = previewDebugPackage();
			return preview;
		})
	);

	// Snapshot of runtime memory / process info for the Debug: View Application Stats modal
	ipcMain.handle(
		'debug:getAppStats',
		createIpcHandler(handlerOpts('getAppStats', false), async () => {
			const mainMemory = process.memoryUsage();
			const electronProcesses = app.getAppMetrics().map((m) => ({
				pid: m.pid,
				type: m.type,
				name: m.name,
				serviceName: m.serviceName,
				cpuPercent: m.cpu?.percentCPUUsage,
				// memory.workingSetSize is in KB on Electron
				workingSetBytes:
					typeof m.memory?.workingSetSize === 'number' ? m.memory.workingSetSize * 1024 : undefined,
				peakWorkingSetBytes:
					typeof m.memory?.peakWorkingSetSize === 'number'
						? m.memory.peakWorkingSetSize * 1024
						: undefined,
			}));

			// Collect spawned agent/PTY PIDs so we can attribute memory to them
			const processManager = getProcessManager();
			const managedProcesses = processManager
				? processManager.getAll().map((p) => ({
						sessionId: p.sessionId,
						toolType: p.toolType,
						pid: p.pid,
						isTerminal: p.isTerminal,
						isBatchMode: p.isBatchMode || false,
						startTime: p.startTime,
					}))
				: [];

			// Try to attach RSS for each managed PID using `ps` on macOS/Linux.
			// Windows: leave rssBytes undefined (would require wmic/tasklist — not worth the dependency).
			const memoryByPid = new Map<number, number>();
			if (process.platform !== 'win32' && managedProcesses.length > 0) {
				const pids = managedProcesses.map((p) => p.pid).filter((pid): pid is number => !!pid);
				if (pids.length > 0) {
					try {
						const { stdout } = await execFileAsync('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')]);
						for (const line of stdout.split('\n')) {
							const trimmed = line.trim();
							if (!trimmed) continue;
							const [pidStr, rssStr] = trimmed.split(/\s+/);
							const pid = Number(pidStr);
							const rssKb = Number(rssStr);
							if (Number.isFinite(pid) && Number.isFinite(rssKb)) {
								memoryByPid.set(pid, rssKb * 1024);
							}
						}
					} catch (err) {
						logger.debug(`${LOG_CONTEXT} ps lookup failed`, undefined, err);
					}
				}
			}

			const managedWithMemory = managedProcesses.map((p) => ({
				...p,
				rssBytes: p.pid ? memoryByPid.get(p.pid) : undefined,
			}));

			return {
				timestamp: Date.now(),
				platform: process.platform,
				main: {
					rss: mainMemory.rss,
					heapTotal: mainMemory.heapTotal,
					heapUsed: mainMemory.heapUsed,
					external: mainMemory.external,
					arrayBuffers: mainMemory.arrayBuffers,
				},
				electronProcesses,
				managedProcesses: managedWithMemory,
			};
		})
	);

	logger.debug(`${LOG_CONTEXT} Debug IPC handlers registered`);
}
