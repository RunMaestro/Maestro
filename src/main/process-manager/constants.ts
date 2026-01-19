/**
 * Maximum buffer size for stdout/stderr error detection buffers.
 * Prevents memory exhaustion during extended process execution.
 */
export const MAX_BUFFER_SIZE = 100 * 1024; // 100KB

/**
 * Data buffer flush interval in milliseconds
 */
export const DATA_BUFFER_FLUSH_INTERVAL = 50;

/**
 * Data buffer size threshold for immediate flush
 */
export const DATA_BUFFER_SIZE_THRESHOLD = 8192; // 8KB

/**
 * Standard Unix paths for PATH environment variable
 */
export const STANDARD_UNIX_PATHS = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

/**
 * Common shell binary locations for path resolution
 */
export const COMMON_SHELL_PATHS = ['/bin/', '/usr/bin/', '/usr/local/bin/', '/opt/homebrew/bin/'];
