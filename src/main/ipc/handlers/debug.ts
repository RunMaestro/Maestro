/**
 * Debug Package IPC Handlers
 *
 * Provides IPC handlers for generating debug/support packages.
 * These packages contain sanitized diagnostic information for bug analysis.
 */

import { ipcMain, dialog, BrowserWindow, app } from 'electron';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import Store from 'electron-store';
import { logger } from '../../utils/logger';
import { createIpcHandler, CreateHandlerOptions } from '../../utils/ipcHandler';
import { createSafeSend } from '../../utils/safe-send';
import {
	generateDebugPackage,
	previewDebugPackage,
	DebugPackageOptions,
	DebugPackageDependencies,
} from '../../debug-package';
import {
	startProfiling,
	stopProfiling,
	getProfilingStatus,
	finalizeCapture,
} from '../../profiling';
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
	const safeSend = createSafeSend(getMainWindow);

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

	// --- Performance profiling (Chromium contentTracing) ---------------------
	// Off by default with zero steady-state cost: Chromium's trace points are
	// dormant until a recording enables their category.

	// Whether a recording is currently in flight (drives the palette toggle).
	ipcMain.handle(
		'debug:getProfilingStatus',
		createIpcHandler(handlerOpts('getProfilingStatus', false), async () => {
			const s = getProfilingStatus();
			return {
				active: s.active,
				startedAt: s.startedAt,
				elapsedMs: s.elapsedMs,
				categories: s.categories,
			};
		})
	);

	// Begin capturing a trace across all Electron processes.
	ipcMain.handle(
		'debug:startProfiling',
		createIpcHandler(handlerOpts('startProfiling'), async () => {
			const s = await startProfiling();
			return {
				active: s.active,
				startedAt: s.startedAt,
				elapsedMs: s.elapsedMs,
				categories: s.categories,
			};
		})
	);

	// Stop the recording, then prompt for a save location and write the bundle
	// (raw trace + capture metadata) as a compressed .zip. Analysis is a
	// development-time activity - see scripts/analyze-perf-trace.mjs.
	//
	// Flushing the trace and (especially) zip compression can take tens of
	// seconds for a large capture. We emit `debug:profilingProgress` phase events
	// throughout so the renderer can show a live progress modal instead of the UI
	// looking frozen after the user hits "End Performance Profiling".
	ipcMain.handle(
		'debug:stopProfiling',
		createIpcHandler(handlerOpts('stopProfiling'), async () => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				throw new Error('No main window available');
			}

			// Best-effort progress ping; safeSend swallows closed/destroyed
			// windows and also fans out to web-desktop bridge clients.
			const sendProgress = (payload: Record<string, unknown>) => {
				safeSend('debug:profilingProgress', payload);
			};

			const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
			// Flush the trace to a temp file first so recording (and its overhead)
			// ends immediately, before the user fiddles with the save dialog.
			const tracePath = path.join(app.getPath('temp'), `maestro-trace-${timestamp}.json`);
			sendProgress({ phase: 'stopping' });
			const { durationMs, categories } = await stopProfiling(tracePath);

			sendProgress({ phase: 'awaiting-save' });
			const result = await dialog.showSaveDialog(mainWindow, {
				title: 'Save Performance Profile',
				defaultPath: path.join(app.getPath('desktop'), `maestro-profile-${timestamp}.zip`),
				filters: [{ name: 'Zip Files', extensions: ['zip'] }],
			});

			if (result.canceled || !result.filePath) {
				await fs.promises.unlink(tracePath).catch(() => {});
				sendProgress({ phase: 'cancelled' });
				return {
					path: null,
					cancelled: true,
					bundleSizeBytes: 0,
					traceSizeBytes: 0,
					durationMs,
				};
			}

			try {
				sendProgress({ phase: 'compressing', percent: 0 });
				const finalized = await finalizeCapture(
					tracePath,
					result.filePath,
					durationMs,
					categories,
					(percent, bytesProcessed, totalBytes) =>
						sendProgress({ phase: 'compressing', percent, bytesProcessed, totalBytes })
				);
				logger.info(`${LOG_CONTEXT} Performance profile saved: ${finalized.path}`);
				sendProgress({
					phase: 'done',
					percent: 100,
					path: finalized.path,
					bundleSizeBytes: finalized.bundleSizeBytes,
				});
				return {
					path: finalized.path,
					cancelled: false,
					bundleSizeBytes: finalized.bundleSizeBytes,
					traceSizeBytes: finalized.traceSizeBytes,
					durationMs,
				};
			} catch (err) {
				sendProgress({
					phase: 'error',
					error: err instanceof Error ? err.message : 'Failed to save profile',
				});
				throw err;
			} finally {
				await fs.promises.unlink(tracePath).catch(() => {});
			}
		})
	);

	// Stop the recording and write the bundle to a temp file WITHOUT prompting
	// for a save location, returning the path. Used by the Feedback modal to
	// attach a performance trace directly to a report. The caller either hands
	// the path to feedback submission (which consumes and deletes it) or drops it
	// via debug:discardTrace so the (potentially large) zip never lingers.
	ipcMain.handle(
		'debug:stopProfilingToFile',
		createIpcHandler(handlerOpts('stopProfilingToFile'), async () => {
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
			const tracePath = path.join(app.getPath('temp'), `maestro-trace-${timestamp}.json`);
			const { durationMs, categories } = await stopProfiling(tracePath);
			const bundlePath = path.join(app.getPath('temp'), `maestro-profile-${timestamp}.zip`);
			try {
				const finalized = await finalizeCapture(tracePath, bundlePath, durationMs, categories);
				logger.info(`${LOG_CONTEXT} Performance profile captured for feedback: ${finalized.path}`);
				return {
					path: finalized.path,
					bundleSizeBytes: finalized.bundleSizeBytes,
					traceSizeBytes: finalized.traceSizeBytes,
					durationMs,
				};
			} finally {
				await fs.promises.unlink(tracePath).catch(() => {});
			}
		})
	);

	// Delete a temp trace bundle produced by debug:stopProfilingToFile that the
	// user abandoned (removed the attachment or discarded the report). Guarded to
	// our own temp-dir naming so it can only unlink a maestro trace zip.
	ipcMain.handle(
		'debug:discardTrace',
		createIpcHandler(handlerOpts('discardTrace', false), async (filePath?: string) => {
			const tempDir = app.getPath('temp');
			if (
				typeof filePath === 'string' &&
				filePath.startsWith(tempDir) &&
				/[/\\]maestro-profile-[^/\\]+\.zip$/.test(filePath)
			) {
				await fs.promises.unlink(filePath).catch(() => {});
				return { success: true };
			}
			return { success: false };
		})
	);

	logger.debug(`${LOG_CONTEXT} Debug IPC handlers registered`);
}
