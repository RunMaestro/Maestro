/**
 * Structured logging utility for the main process
 * Logs are stored in memory and can be retrieved via IPC
 */

import { EventEmitter } from 'events';
import {
  type MainLogLevel,
  type SystemLogEntry,
  LOG_LEVEL_PRIORITY,
  DEFAULT_MAX_LOGS,
} from '../../shared/logger-types';

// Re-export types for backwards compatibility
export type { MainLogLevel as LogLevel, SystemLogEntry as LogEntry };

class Logger extends EventEmitter {
  private logs: SystemLogEntry[] = [];
  private maxLogs = DEFAULT_MAX_LOGS;
  private minLevel: MainLogLevel = 'info'; // Default log level

  private levelPriority = LOG_LEVEL_PRIORITY;

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

    // Also output to console for development
    const timestamp = new Date(entry.timestamp).toISOString();
    const prefix = `[${timestamp}] [${entry.level.toUpperCase()}]${entry.context ? ` [${entry.context}]` : ''}`;
    const message = `${prefix} ${entry.message}`;

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
      filtered = filtered.filter(log => this.levelPriority[log.level] >= minPriority);
    }

    if (filter?.context) {
      filtered = filtered.filter(log => log.context === filter.context);
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
