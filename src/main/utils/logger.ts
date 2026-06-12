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
import { isWindows, isMacOS } from '../../shared/platformDetection';

// Re-export types for backwards compatibility
export type { MainLogLevel as LogLevel, SystemLogEntry as LogEntry };

/**
 * Get the platform-specific logs directory path.
 * On Windows: %APPDATA%/Maestro/logs
 * On macOS: ~/Library/Application Support/Maestro/logs
 * On Linux: ~/.config/Maestro/logs (or XDG_CONFIG_HOME)
 */
function getLogsDir(): string {
	let appDataDir: string;

	if (isWindows()) {
		appDataDir = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
	} else if (isMacOS()) {
		appDataDir = path.join(os.homedir(), 'Library', 'Application Support');
	} else {
		appDataDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
	}

	return path.join(appDataDir, 'Maestro', 'logs');
}

/**
 * Get today's local date as a YYYY-MM-DD string.
 */
function getTodayDateString(): string {
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const day = String(now.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

/**
 * Get the path to the debug log file with today's date.
 * Returns a dated filename: maestro-debug-YYYY-MM-DD.log using local date.
 */
function getLogFilePath(): string {
	return path.join(getLogsDir(), `maestro-debug-${getTodayDateString()}.log`);
}

class Logger extends EventEmitter {
	private logs: SystemLogEntry[] = [];
	private maxLogs = DEFAULT_MAX_LOGS;
	private minLevel: MainLogLevel = 'info'; // Default log level
	private fileLogEnabled = false;
	private logFilePath: string;
	private logFileStream: fs.WriteStream | null = null;
	private currentLogDate: string = '';

	private levelPriority = LOG_LEVEL_PRIORITY;

	constructor() {
		super();
		this.logFilePath = getLogFilePath();
		this.currentLogDate = getTodayDateString();

		// Enable file logging on Windows by default for debugging
		// Users can also enable it on other platforms via enableFileLogging()
		if (isWindows()) {
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
			const logsDir = getLogsDir();
			if (!fs.existsSync(logsDir)) {
				fs.mkdirSync(logsDir, { recursive: true });
			}

			// Set current date and log file path to today's values
			this.currentLogDate = getTodayDateString();
			this.logFilePath = getLogFilePath();

			// Migrate legacy maestro-debug.log if it exists
			try {
				const legacyPath = path.join(logsDir, 'maestro-debug.log');
				if (fs.existsSync(legacyPath)) {
					const stat = fs.statSync(legacyPath);
					const mtime = stat.mtime;
					const year = mtime.getFullYear();
					const month = String(mtime.getMonth() + 1).padStart(2, '0');
					const day = String(mtime.getDate()).padStart(2, '0');
					const mtimeDate = `${year}-${month}-${day}`;
					const targetPath = path.join(logsDir, `maestro-debug-${mtimeDate}.log`);

					if (!fs.existsSync(targetPath)) {
						fs.renameSync(legacyPath, targetPath);
						console.log(`[Logger] Migrated legacy log file to maestro-debug-${mtimeDate}.log`);
					} else {
						// Target dated file already exists; remove the legacy file to prevent orphans
						fs.unlinkSync(legacyPath);
						console.log(`[Logger] Removed legacy log file (dated file already exists)`);
					}
				}
			} catch (migrationError) {
				console.error('[Logger] Failed to migrate legacy log file:', migrationError);
			}

			// Open log file in append mode
			this.logFileStream = fs.createWriteStream(this.logFilePath, { flags: 'a' });
			this.fileLogEnabled = true;

			// Write a startup marker
			const startupMsg = `\n${'='.repeat(80)}\n[${new Date().toISOString()}] Maestro started - File logging enabled\nPlatform: ${process.platform}, Node: ${process.version}\nLog file: ${this.logFilePath}\n${'='.repeat(80)}\n`;
			this.logFileStream.write(startupMsg);

			// Clean up old log files
			this.cleanOldLogs();

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
	 * Check if the date has changed and rotate to a new log file if needed.
	 * Closes the old stream, opens a new one for today's date, and triggers cleanup.
	 */
	private rotateIfNeeded(): void {
		try {
			const todayDate = getTodayDateString();
			if (todayDate === this.currentLogDate) return;

			// Close old stream if it exists
			if (this.logFileStream) {
				this.logFileStream.end();
				this.logFileStream = null;
			}

			// Stage today's log file, but don't advance state until the new stream exists
			const nextLogFilePath = getLogFilePath();

			// Ensure the logs directory exists
			const logsDir = getLogsDir();
			if (!fs.existsSync(logsDir)) {
				fs.mkdirSync(logsDir, { recursive: true });
			}

			// Open new log file in append mode
			this.logFileStream = fs.createWriteStream(nextLogFilePath, { flags: 'a' });
			this.logFilePath = nextLogFilePath;
			this.currentLogDate = todayDate;

			// Write rotation marker
			const startupMsg = `\n${'='.repeat(80)}\n[${new Date().toISOString()}] Maestro log rotated - new log file\nPlatform: ${process.platform}, Node: ${process.version}\nLog file: ${this.logFilePath}\n${'='.repeat(80)}\n`;
			this.logFileStream.write(startupMsg);

			// Clean up old log files
			this.cleanOldLogs();
		} catch (error) {
			console.error('[Logger] Failed to rotate log file:', error);
			// Disable file logging so callers know logs are no longer being written to disk
			this.fileLogEnabled = false;
			this.logFileStream = null;
		}
	}

	/**
	 * Remove log files older than 7 days.
	 * Uses console.log for cleanup messages to avoid circular issues during startup.
	 */
	private cleanOldLogs(): void {
		try {
			const logsDir = getLogsDir();
			const files = fs.readdirSync(logsDir);
			const logFilePattern = /^maestro-debug-(\d{4}-\d{2}-\d{2})\.log$/;
			const now = new Date();
			// Use UTC calendar-day arithmetic to avoid DST edge cases
			const todayDay = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000;

			for (const file of files) {
				const match = file.match(logFilePattern);
				if (!match) continue;

				const [yearStr, monthStr, dayStr] = match[1].split('-');
				const fileDay =
					Date.UTC(parseInt(yearStr, 10), parseInt(monthStr, 10) - 1, parseInt(dayStr, 10)) /
					86_400_000;
				const ageInDays = todayDay - fileDay;

				if (ageInDays > 7) {
					try {
						fs.unlinkSync(path.join(logsDir, file));
						console.log(`[Logger] Cleaned up old log file: ${file}`);
					} catch (deleteError) {
						console.error(`[Logger] Failed to delete old log file ${file}:`, deleteError);
					}
				}
			}
		} catch (error) {
			console.error('[Logger] Failed to clean old log files:', error);
		}
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

		// Check if we need to rotate to a new day's log file
		if (this.fileLogEnabled) {
			this.rotateIfNeeded();
		}

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
		// Wrapped in try-catch to handle EPIPE errors when stdout/stderr is disconnected
		// (e.g., when a parent process consuming output dies unexpectedly)
		// Fixes MAESTRO-5C
		try {
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
				case 'cue':
					// Cue event-driven automation logs (teal in LogViewer)
					console.info(message, entry.data || '');
					break;
			}
		} catch {
			// Silently ignore EPIPE errors - console is disconnected
			// Other errors are also ignored to prevent infinite loops
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

	cue(message: string, context?: string, data?: unknown): void {
		// Cue logs are always logged (event-driven automation tracking)
		this.addLog({
			timestamp: Date.now(),
			level: 'cue',
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
