/**
 * Shared formatting utilities for displaying numbers, sizes, times, and tokens.
 * These pure functions are used by both renderer (desktop) and web (mobile) code.
 *
 * Functions:
 * - formatSize: File sizes (B, KB, MB, GB, TB)
 * - formatNumber: Large numbers with k/M/B suffixes
 * - formatTokens: Token counts with K/M/B suffixes (~prefix)
 * - formatTokensCompact: Token counts without ~prefix
 * - formatRelativeTime: Relative timestamps ("5m ago", "2h ago")
 * - formatActiveTime: Duration display (1D, 2H 30M, <1M)
 * - formatElapsedTime: Precise elapsed time (1h 10m, 30s, 500ms)
 * - formatElapsedTimeColon: Timer-style elapsed time (mm:ss or hh:mm:ss)
 * - formatDurationHuman: Human-readable duration without ms precision (1h 5m, 30s, 0s)
 * - formatDurationCompact: Compact duration without seconds in minute range (5m, 2h 30m)
 * - formatDurationVerbose: Verbose duration with full words (5 minutes 30 seconds)
 * - formatDurationParts: Multi-part duration with days support (2d 5h 30m)
 * - formatDurationDecimal: Decimal duration for CLI output (5.2m, 1.3h)
 * - formatCost: USD currency display ($1.23, <$0.01)
 * - estimateTokenCount: Estimate token count from text (~4 chars/token)
 * - estimateTokensFromLogs: Estimate token count from log entry arrays
 * - formatTimestamp: Format timestamps in various styles (time, datetime, smart, full)
 * - truncatePath: Truncate file paths for display (.../<parent>/<current>)
 * - truncateCommand: Truncate command text for display with ellipsis
 */

/**
 * Format a file size in bytes to a human-readable string.
 * Automatically scales to appropriate unit (B, KB, MB, GB, TB).
 *
 * @param bytes - The size in bytes
 * @returns Formatted string (e.g., "1.5 MB", "256 KB")
 */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes < 1024 * 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
	return `${(bytes / (1024 * 1024 * 1024 * 1024)).toFixed(1)} TB`;
}

/**
 * Format a large number with k/M/B suffixes for compact display.
 *
 * @param num - The number to format
 * @returns Formatted string (e.g., "1.5k", "2.3M", "1.0B")
 */
export function formatNumber(num: number): string {
	if (num < 1000) return num.toString();
	if (num < 1000000) return `${(num / 1000).toFixed(1)}K`;
	if (num < 1000000000) return `${(num / 1000000).toFixed(1)}M`;
	return `${(num / 1000000000).toFixed(1)}B`;
}

/**
 * Format a token count with K/M/B suffix for compact display.
 * Uses approximate (~) prefix for larger numbers.
 *
 * @param tokens - The token count
 * @returns Formatted string (e.g., "500", "~1K", "~2M", "~1B")
 */
export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000_000) return `~${Math.round(tokens / 1_000_000_000)}B`;
	if (tokens >= 1_000_000) return `~${Math.round(tokens / 1_000_000)}M`;
	if (tokens >= 1_000) return `~${Math.round(tokens / 1_000)}K`;
	return tokens.toString();
}

/**
 * Format a token count compactly without the approximate prefix.
 * Useful for precise token displays.
 *
 * @param tokens - The token count
 * @returns Formatted string (e.g., "500", "1.5K", "2.3M", "5.8B")
 */
export function formatTokensCompact(tokens: number): string {
	if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1)}B`;
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
	return tokens.toString();
}

/**
 * Format a date/timestamp as relative time (e.g., "just now", "5m ago", "2h ago").
 * Accepts either a timestamp (number of milliseconds) or a date string.
 *
 * @param dateOrTimestamp - Either a Date object, timestamp in milliseconds, or ISO date string
 * @returns Relative time string (e.g., "just now", "5m ago", "3d ago", or localized date)
 */
export function formatRelativeTime(dateOrTimestamp: Date | number | string): string {
	let timestamp: number;

	if (typeof dateOrTimestamp === 'number') {
		timestamp = dateOrTimestamp;
	} else if (typeof dateOrTimestamp === 'string') {
		timestamp = new Date(dateOrTimestamp).getTime();
	} else {
		timestamp = dateOrTimestamp.getTime();
	}

	const now = Date.now();
	const diffMs = now - timestamp;
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMins / 60);
	const diffDays = Math.floor(diffHours / 24);

	if (diffMins < 1) return 'just now';
	if (diffMins < 60) return `${diffMins}m ago`;
	if (diffHours < 24) return `${diffHours}h ago`;
	if (diffDays < 7) return `${diffDays}d ago`;
	// Show compact date format (e.g., "Dec 3") for older dates
	return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Format duration in milliseconds as compact display string.
 * Uses uppercase units (D, H, M) for consistency.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted string (e.g., "1D", "2H 30M", "15M", "<1M")
 */
export function formatActiveTime(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const totalMinutes = Math.floor(totalSeconds / 60);
	const totalHours = Math.floor(totalMinutes / 60);
	const totalDays = Math.floor(totalHours / 24);

	if (totalDays > 0) {
		return `${totalDays}D`;
	} else if (totalHours > 0) {
		const remainingMinutes = totalMinutes % 60;
		if (remainingMinutes > 0) {
			return `${totalHours}H ${remainingMinutes}M`;
		}
		return `${totalHours}H`;
	} else if (totalMinutes > 0) {
		return `${totalMinutes}M`;
	} else {
		return '<1M';
	}
}

/**
 * Format elapsed time in milliseconds as precise human-readable format.
 * Shows milliseconds for sub-second, seconds for <1m, minutes+seconds for <1h,
 * and hours+minutes for longer durations.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted string (e.g., "500ms", "30s", "5m 12s", "1h 10m")
 */
export function formatElapsedTime(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return `${hours}h ${remainingMinutes}m`;
}

/**
 * Format cost as USD with appropriate precision.
 * Shows "<$0.01" for very small amounts.
 *
 * @param cost - The cost in USD
 * @returns Formatted string (e.g., "$1.23", "<$0.01", "$0.00")
 */
export function formatCost(cost: number): string {
	if (cost === 0) return '$0.00';
	if (cost < 0.01) return '<$0.01';
	return '$' + cost.toFixed(2);
}

/**
 * Estimate token count from text using rough approximation.
 * Uses ~4 characters per token for English text, which is a common heuristic.
 *
 * @param text - The text to estimate tokens for
 * @returns Estimated token count
 */
export function estimateTokenCount(text: string): number {
	if (!text) return 0;
	return Math.ceil(text.length / 4);
}

/**
 * Format elapsed time in seconds as timer-style display (mm:ss or hh:mm:ss).
 * Useful for live countdown/timer displays.
 *
 * @param seconds - Duration in seconds
 * @returns Formatted string (e.g., "5:12", "1:30:45")
 */
export function formatElapsedTimeColon(seconds: number): string {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = seconds % 60;

	if (hours > 0) {
		return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
	}
	return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Truncate a file path for display, preserving the most relevant parts.
 * Shows ".../<parent>/<current>" format for long paths.
 *
 * @param path - The file path to truncate
 * @param maxLength - Maximum length of the returned string (default: 35)
 * @returns Truncated path string (e.g., ".../parent/current")
 */
export function truncatePath(path: string, maxLength: number = 35): string {
	if (!path) return '';
	if (path.length <= maxLength) return path;

	// Detect path separator (Windows vs Unix)
	const separator = path.includes('\\') ? '\\' : '/';
	const parts = path.split(/[/\\]/).filter(Boolean);

	if (parts.length === 0) return path;

	// Show the last two parts with ellipsis
	if (parts.length === 1) {
		return `...${path.slice(-maxLength + 3)}`;
	}

	const lastTwo = parts.slice(-2).join(separator);
	if (lastTwo.length > maxLength - 4) {
		return `...${separator}${parts[parts.length - 1].slice(-(maxLength - 5))}`;
	}

	return `...${separator}${lastTwo}`;
}

/**
 * Get the parent directory of a path (cross-platform, works with / and \ separators).
 * Returns the original path if already at root.
 */
export function getParentDir(path: string): string {
	const parent = path.replace(/[/\\][^/\\]+$/, '');
	return parent || path;
}

/**
 * Truncate command text for display.
 * Replaces newlines with spaces, trims whitespace, and adds ellipsis if truncated.
 *
 * @param command - The command text to truncate
 * @param maxLength - Maximum length of the returned string (default: 40)
 * @returns Truncated command string (e.g., "npm run build --...")
 */
export function truncateCommand(command: string, maxLength: number = 40): string {
	// Replace newlines with spaces for single-line display
	const singleLine = command.replace(/\n/g, ' ').trim();
	if (singleLine.length <= maxLength) return singleLine;
	return singleLine.slice(0, maxLength - 1) + '…';
}

/**
 * Format duration in milliseconds as human-readable string without millisecond precision.
 * Suitable for dashboard displays where sub-second precision is unnecessary.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted string (e.g., "0s", "45s", "5m 30s", "2h 15m")
 */
export function formatDurationHuman(ms: number): string {
	if (ms === 0) return '0s';

	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	}
	return `${seconds}s`;
}

/**
 * Format duration in milliseconds compactly, omitting seconds in the minute range.
 * Useful for summary displays where second-level precision is noise.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted string (e.g., "0s", "45s", "5m", "2h 15m")
 */
export function formatDurationCompact(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);

	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	if (minutes > 0) {
		return `${minutes}m`;
	}
	return `${totalSeconds}s`;
}

/**
 * Format duration in milliseconds with full English words.
 * Suitable for celebratory or detailed displays.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted string (e.g., "5 minutes 30 seconds", "1 hour 15 minutes")
 */
export function formatDurationVerbose(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);

	if (hours > 0) {
		const remainingMinutes = minutes % 60;
		if (remainingMinutes > 0) {
			return `${hours} hour${hours > 1 ? 's' : ''} ${remainingMinutes} minute${remainingMinutes > 1 ? 's' : ''}`;
		}
		return `${hours} hour${hours > 1 ? 's' : ''}`;
	}

	if (minutes > 0) {
		const remainingSeconds = seconds % 60;
		if (remainingSeconds > 0) {
			return `${minutes} minute${minutes > 1 ? 's' : ''} ${remainingSeconds} second${remainingSeconds > 1 ? 's' : ''}`;
		}
		return `${minutes} minute${minutes > 1 ? 's' : ''}`;
	}

	return `${seconds} second${seconds > 1 ? 's' : ''}`;
}

/**
 * Format duration in milliseconds as multi-part string with days support.
 * Useful for toast notifications and long-running processes.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted string (e.g., "5s", "2m 30s", "1h 15m", "3d 2h 15m")
 */
export function formatDurationParts(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;

	const days = Math.floor(totalSeconds / 86400);
	const hours = Math.floor((totalSeconds % 86400) / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	const parts: string[] = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	if (seconds > 0 && days === 0) parts.push(`${seconds}s`);

	return parts.join(' ') || '0s';
}

/**
 * Format duration in milliseconds as decimal string for compact CLI output.
 * Uses single-decimal precision with appropriate unit suffix.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted string (e.g., "500ms", "5.2s", "3.1m", "1.5h")
 */
export function formatDurationDecimal(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	if (ms < 3600_000) return `${(ms / 60_000).toFixed(1)}m`;
	return `${(ms / 3600_000).toFixed(1)}h`;
}

/**
 * Estimate token count from an array of log entries.
 * Uses the same ~4 characters per token heuristic as estimateTokenCount.
 *
 * @param logs - Array of objects with text property
 * @returns Estimated total token count
 */
export function estimateTokensFromLogs(logs: { text: string }[]): number {
	const totalChars = logs.reduce((sum, log) => sum + (log.text?.length || 0), 0);
	return Math.ceil(totalChars / 4);
}

/**
 * Format a timestamp for display in various styles.
 *
 * Styles:
 * - 'time': Time only (e.g., "2:30 PM")
 * - 'datetime': Date and time (e.g., "Jan 5, 2:30 PM")
 * - 'smart': Time if today, date+time otherwise (default)
 * - 'full': Full locale string (e.g., "1/5/2025, 2:30:00 PM")
 *
 * @param timestamp - Unix timestamp in milliseconds, or ISO date string
 * @param style - Output format style (default: 'smart')
 * @returns Formatted timestamp string
 */
export function formatTimestamp(
	timestamp: number | string,
	style: 'time' | 'datetime' | 'smart' | 'full' = 'smart'
): string {
	const date = new Date(timestamp);

	switch (style) {
		case 'time':
			return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

		case 'datetime':
			return date.toLocaleString([], {
				month: 'short',
				day: 'numeric',
				hour: 'numeric',
				minute: '2-digit',
			});

		case 'full':
			return date.toLocaleString();

		case 'smart':
		default: {
			const now = new Date();
			const isToday = date.toDateString() === now.toDateString();

			if (isToday) {
				return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
			}
			return (
				date.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
				' ' +
				date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
			);
		}
	}
}
