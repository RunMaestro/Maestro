/**
 * Debug Package IPC Handlers
 *
 * Provides IPC handlers for generating debug/support packages.
 * These packages contain sanitized diagnostic information for bug analysis.
 */

import { ipcMain, dialog, BrowserWindow } from 'electron';
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
import { AgentDetector } from '../../agent-detector';
import { ProcessManager } from '../../process-manager';
import { WebServer } from '../../web-server';

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
				defaultPath: defaultFilename,
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

	logger.debug(`${LOG_CONTEXT} Debug IPC handlers registered`);
}
