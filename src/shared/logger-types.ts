/**
 * Shared logger types used across main, renderer, and web processes
 */

/**
 * Base log levels supported by all loggers
 */
export type BaseLogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Extended log levels available in the main process logger.
 * - 'toast': User-facing toast notifications (always logged)
 * - 'autorun': Auto Run workflow tracking logs (always logged)
 */
export type MainLogLevel = BaseLogLevel | 'toast' | 'autorun';

/**
 * Log level type alias for backwards compatibility.
 * Use MainLogLevel for main process, BaseLogLevel for renderer/web.
 */
export type LogLevel = MainLogLevel;

/**
 * Priority mapping for log levels used in filtering.
 * Lower numbers = more verbose, higher numbers = more severe.
 */
export const LOG_LEVEL_PRIORITY: Record<MainLogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  toast: 1, // Toast notifications always logged at info priority (always visible)
  autorun: 1, // Auto Run logs always logged at info priority (always visible)
};

/**
 * Default maximum log buffer size (number of entries to keep)
 */
export const DEFAULT_MAX_LOGS = 1000;

/**
 * System log entry interface for main process logging.
 * Note: This is different from session LogEntry used in renderer types.
 */
export interface SystemLogEntry {
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Log level */
  level: MainLogLevel;
  /** Log message */
  message: string;
  /** Optional context identifier (e.g., component name) */
  context?: string;
  /** Optional additional data */
  data?: unknown;
}

/**
 * Check if a log level should be logged given the minimum level.
 */
export function shouldLogLevel(level: MainLogLevel, minLevel: MainLogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[minLevel];
}
