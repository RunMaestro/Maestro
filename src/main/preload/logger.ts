/**
 * Preload API for logging operations
 *
 * Provides the window.maestro.logger namespace for:
 * - Application logging
 * - Log level management
 * - Real-time log subscriptions
 */

import { ipcRenderer } from 'electron';
import type { MainLogLevel, SystemLogEntry } from '../../shared/logger-types';

/**
 * Creates the logger API object for preload exposure
 */
export function createLoggerApi() {
	return {
		log: (level: MainLogLevel, message: string, context?: string, data?: unknown) =>
			ipcRenderer.invoke('logger:log', level, message, context, data),

		getLogs: (filter?: { level?: MainLogLevel; context?: string; limit?: number }) =>
			ipcRenderer.invoke('logger:getLogs', filter),

		clearLogs: () => ipcRenderer.invoke('logger:clearLogs'),

		setLogLevel: (level: MainLogLevel) => ipcRenderer.invoke('logger:setLogLevel', level),

		getLogLevel: () => ipcRenderer.invoke('logger:getLogLevel'),

		setMaxLogBuffer: (max: number) => ipcRenderer.invoke('logger:setMaxLogBuffer', max),

		getMaxLogBuffer: () => ipcRenderer.invoke('logger:getMaxLogBuffer'),

		// Convenience method for logging toast notifications
		toast: (title: string, data?: unknown) =>
			ipcRenderer.invoke('logger:log', 'toast', title, 'Toast', data),

		// Convenience method for Auto Run workflow logging (cannot be turned off)
		autorun: (message: string, context?: string, data?: unknown) =>
			ipcRenderer.invoke('logger:log', 'autorun', message, context || 'AutoRun', data),

		// Subscribe to new log entries in real-time.
		// Main forwards entries in batches via `logger:newLogBatch` to amortize
		// IPC overhead — we fan them out here so consumers keep a per-entry API.
		onNewLog: (callback: (log: SystemLogEntry) => void) => {
			const batchHandler = (_: Electron.IpcRendererEvent, batch: SystemLogEntry[]) => {
				for (const log of batch) callback(log);
			};
			ipcRenderer.on('logger:newLogBatch', batchHandler);
			return () => ipcRenderer.removeListener('logger:newLogBatch', batchHandler);
		},

		// File logging (enabled by default on Windows for debugging)
		getLogFilePath: (): Promise<string> => ipcRenderer.invoke('logger:getLogFilePath'),

		isFileLoggingEnabled: (): Promise<boolean> => ipcRenderer.invoke('logger:isFileLoggingEnabled'),

		enableFileLogging: (): Promise<void> => ipcRenderer.invoke('logger:enableFileLogging'),
	};
}

export type LoggerApi = ReturnType<typeof createLoggerApi>;
