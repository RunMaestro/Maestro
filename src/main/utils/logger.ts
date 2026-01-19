/**
 * Structured logging utility for the main process
 * Logs are stored in memory and can be retrieved via IPC
 *
 * On Windows, logs are also written to a file for easier debugging:
 * %APPDATA%/Maestro/logs/maestro-debug.log
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
	type MainLogLevel,
	type SystemLogEntry,
	LOG_LEVEL_PRIORITY,
	DEFAULT_MAX_LOGS,
} from '../../shared/logger-types';

// Re-export types for backwards compatibility
export type { MainLogLevel as LogLevel, SystemLogEntry as LogEntry };

/**
 * Get the path to the debug log file.
 * On Windows: %APPDATA%/Maestro/logs/maestro-debug.log
 * On macOS/Linux: ~/Library/Application Support/Maestro/logs/maestro-debug.log (or ~/.config/Maestro/logs)
 */
function getLogFilePath(): string {
	const isWindows = process.platform === 'win32';
	let appDataDir: string;

	if (isWindows) {
		appDataDir = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
	} else if (process.platform === 'darwin') {
		appDataDir = path.join(os.homedir(), 'Library', 'Application Support');
	} else {
		appDataDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
	}

	return path.join(appDataDir, 'Maestro', 'logs', 'maestro-debug.log');
}

class Logger extends EventEmitter {
	private logs: SystemLogEntry[] = [];
	private maxLogs = DEFAULT_MAX_LOGS;
	private minLevel: MainLogLevel = 'info'; // Default log level
	private fileLogEnabled = false;
	private logFilePath: string;
	private logFileStream: fs.WriteStream | null = null;

	private levelPriority = LOG_LEVEL_PRIORITY;

	constructor() {
		super();
		this.logFilePath = getLogFilePath();

		// Enable file logging on Windows by default for debugging
		// Users can also enable it on other platforms via enableFileLogging()
		if (process.platform === 'win32') {
			this.enableFileLogging();
		}
	}

	/**
	 * Enable logging to a file. Useful for debugging on Windows where
	 * console output may not be easily accessible.
	 */
	enableFileLogging(): void {
		if (this.fileLogEnabled) return;

		try {
			// Ensure the logs directory exists
			const logsDir = path.dirname(this.logFilePath);
			if (!fs.existsSync(logsDir)) {
				fs.mkdirSync(logsDir, { recursive: true });
			}

			// Open log file in append mode
			this.logFileStream = fs.createWriteStream(this.logFilePath, { flags: 'a' });
			this.fileLogEnabled = true;

			// Write a startup marker
			const startupMsg = `\n${'='.repeat(80)}\n[${new Date().toISOString()}] Maestro started - File logging enabled\nPlatform: ${process.platform}, Node: ${process.version}\nLog file: ${this.logFilePath}\n${'='.repeat(80)}\n`;
			this.logFileStream.write(startupMsg);

			console.log(`[Logger] File logging enabled: ${this.logFilePath}`);
		} catch (error) {
			console.error(`[Logger] Failed to enable file logging:`, error);
		}
	}

	/**
	 * Disable file logging
	 */
	disableFileLogging(): void {
		if (!this.fileLogEnabled) return;

		if (this.logFileStream) {
			this.logFileStream.end();
			this.logFileStream = null;
		}
		this.fileLogEnabled = false;
	}

	/**
	 * Get the path to the log file
	 */
	getLogFilePath(): string {
		return this.logFilePath;
	}

	/**
	 * Check if file logging is enabled
	 */
	isFileLoggingEnabled(): boolean {
		return this.fileLogEnabled;
	}

	setLogLevel(level: MainLogLevel): void {
		this.minLevel = level;
	}

	getLogLevel(): MainLogLevel {
		return this.minLevel;
	}

	setMaxLogBuffer(max: number): void {
		this.maxLogs = max;
		// Trim logs if current size exceeds new max
		if (this.logs.length > this.maxLogs) {
			this.logs = this.logs.slice(-this.maxLogs);
		}
	}

	getMaxLogBuffer(): number {
		return this.maxLogs;
	}

	private shouldLog(level: MainLogLevel): boolean {
		return this.levelPriority[level] >= this.levelPriority[this.minLevel];
	}

	private addLog(entry: SystemLogEntry): void {
		this.logs.push(entry);

		// Keep only the last maxLogs entries
		if (this.logs.length > this.maxLogs) {
			this.logs = this.logs.slice(-this.maxLogs);
		}

		// Emit event for real-time log streaming
		this.emit('newLog', entry);

		// Format the log message
		const timestamp = new Date(entry.timestamp).toISOString();
		const prefix = `[${timestamp}] [${entry.level.toUpperCase()}]${entry.context ? ` [${entry.context}]` : ''}`;
		const message = `${prefix} ${entry.message}`;

		// Write to file if enabled (on Windows by default)
		if (this.fileLogEnabled && this.logFileStream) {
			try {
				const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
				this.logFileStream.write(`${message}${dataStr}\n`);
			} catch {
				// Silently ignore file write errors to avoid infinite loops
			}
		}

		// Also output to console for development
		switch (entry.level) {
			case 'error':
				console.error(message, entry.data || '');
				break;
			case 'warn':
				console.warn(message, entry.data || '');
				break;
			case 'info':
				console.info(message, entry.data || '');
				break;
			case 'debug':
				console.log(message, entry.data || '');
				break;
			case 'toast':
				// Toast notifications logged with info styling (purple in LogViewer)
				console.info(message, entry.data || '');
				break;
			case 'autorun':
				// Auto Run logs for workflow tracking (orange in LogViewer)
				console.info(message, entry.data || '');
				break;
		}
	}

	debug(message: string, context?: string, data?: unknown): void {
		if (!this.shouldLog('debug')) return;
		this.addLog({
			timestamp: Date.now(),
			level: 'debug',
			message,
			context,
			data,
		});
	}

	info(message: string, context?: string, data?: unknown): void {
		if (!this.shouldLog('info')) return;
		this.addLog({
			timestamp: Date.now(),
			level: 'info',
			message,
			context,
			data,
		});
	}

	warn(message: string, context?: string, data?: unknown): void {
		if (!this.shouldLog('warn')) return;
		this.addLog({
			timestamp: Date.now(),
			level: 'warn',
			message,
			context,
			data,
		});
	}

	error(message: string, context?: string, data?: unknown): void {
		if (!this.shouldLog('error')) return;
		this.addLog({
			timestamp: Date.now(),
			level: 'error',
			message,
			context,
			data,
		});
	}

	toast(message: string, context?: string, data?: unknown): void {
		// Toast notifications are always logged (they're user-facing notifications)
		this.addLog({
			timestamp: Date.now(),
			level: 'toast',
			message,
			context,
			data,
		});
	}

	autorun(message: string, context?: string, data?: unknown): void {
		// Auto Run logs are always logged (workflow tracking cannot be turned off)
		this.addLog({
			timestamp: Date.now(),
			level: 'autorun',
			message,
			context,
			data,
		});
	}

	getLogs(filter?: { level?: MainLogLevel; context?: string; limit?: number }): SystemLogEntry[] {
		let filtered = [...this.logs];

		if (filter?.level) {
			const minPriority = this.levelPriority[filter.level];
			filtered = filtered.filter((log) => this.levelPriority[log.level] >= minPriority);
		}

		if (filter?.context) {
			filtered = filtered.filter((log) => log.context === filter.context);
		}

		if (filter?.limit) {
			filtered = filtered.slice(-filter.limit);
		}

		return filtered;
	}

	clearLogs(): void {
		this.logs = [];
	}
}

// Export singleton instance
export const logger = new Logger();
