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
 * - formatCacheAge: Cache age labels ("just now", "5m ago", "2h ago")
 * - formatAgeShort: Compact age badge ("new", "5m", "3h", "5d", "3w", "6mo", "3.5y")
 * - formatActiveTime: Duration display (1D, 2H 30M, <1M)
 * - formatElapsedTime: Precise elapsed time (1h 10m, 30s, 500ms)
 * - formatElapsedTimeColon: Timer-style elapsed time (mm:ss or hh:mm:ss)
 * - formatDurationHuman: Human-readable duration without ms precision (1h 5m, 30s, 0s)
 * - formatDurationCompact: Compact duration without seconds in minute range (5m, 2h 30m)
 * - formatDurationVerbose: Verbose duration with full words (5 minutes 30 seconds)
 * - formatDurationParts: Multi-part duration with days support (2d 5h 30m)
 * - formatDurationLong: Two-unit duration laddering seconds -> years (6d 7h, 3w 2d, 1y 7w)
 * - formatDurationDecimal: Decimal duration for CLI output (5.2m, 1.3h)
 * - formatCost: USD currency display ($1.23, <$0.01)
 * - estimateTokenCount: Estimate token count from text (~4 chars/token)
 * - estimateTokensFromLogs: Estimate token count from log entry arrays
 * - formatTimestamp: Format timestamps in various styles (time, datetime, smart, full)
 * - truncatePath: Truncate file paths for display (.../<parent>/<current>)
 * - truncateCommand: Truncate command text for display with ellipsis
 * - formatSshTarget: SSH connection target for display (user@host:port)
 * - abbreviateGroupName: Shorten a group name for badge/pill display
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
 * @param options - Optional formatting options
 * @param options.includeSeconds - When true, sub-minute durations render as "Ns ago" instead of "just now"
 * @returns Relative time string (e.g., "just now", "5m ago", "3d ago", or localized date)
 */
export function formatRelativeTime(
	dateOrTimestamp: Date | number | string,
	options?: { includeSeconds?: boolean }
): string {
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
	const diffSecs = Math.floor(diffMs / 1000);
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMins / 60);
	const diffDays = Math.floor(diffHours / 24);

	if (diffMins < 1) {
		if (options?.includeSeconds) {
			return `${Math.max(0, diffSecs)}s ago`;
		}
		return 'just now';
	}
	if (diffMins < 60) return `${diffMins}m ago`;
	if (diffHours < 24) return `${diffHours}h ago`;
	if (diffDays < 7) return `${diffDays}d ago`;
	// Show compact date format (e.g., "Dec 3") for older dates
	return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Format a cache age duration in milliseconds for compact status labels.
 *
 * Unlike `formatRelativeTime`, this receives an elapsed age rather than an
 * absolute timestamp and intentionally never rolls into days.
 */
export function formatCacheAge(cacheAgeMs: number | null): string {
	if (cacheAgeMs === null || cacheAgeMs === 0) return 'just now';

	const seconds = Math.floor(cacheAgeMs / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);

	if (hours > 0) return `${hours}h ago`;
	if (minutes > 0) return `${minutes}m ago`;
	return 'just now';
}

/**
 * Format an age (elapsed time since a creation timestamp) as the most compact
 * human-readable string that still fits a small badge. Used by the dashboard
 * agent cards where space is at a premium.
 *
 * Output ladder:
 *   - < 1 minute     → "new"
 *   - < 1 hour       → "5m"
 *   - < 1 day        → "3h"
 *   - < 7 days       → "5d"
 *   - < 30 days      → "3w"
 *   - < 365 days     → "6mo"
 *   - < 10 years     → "3.5y" (one decimal, .0 suffix dropped → "3y" / "3.5y")
 *   - >= 10 years    → "12y"
 *
 * Month = 30 days, year = 365 days - coarse enough that the badge stays stable
 * across renders without overengineering calendar math.
 */
export function formatAgeShort(dateOrTimestamp: Date | number | string): string {
	let timestamp: number;
	if (typeof dateOrTimestamp === 'number') {
		timestamp = dateOrTimestamp;
	} else if (typeof dateOrTimestamp === 'string') {
		timestamp = new Date(dateOrTimestamp).getTime();
	} else {
		timestamp = dateOrTimestamp.getTime();
	}

	const diffMs = Math.max(0, Date.now() - timestamp);
	const minutes = Math.floor(diffMs / 60_000);
	if (minutes < 1) return 'new';
	if (minutes < 60) return `${minutes}m`;

	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;

	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	if (days < 30) return `${Math.floor(days / 7)}w`;
	if (days < 365) return `${Math.floor(days / 30)}mo`;

	const years = days / 365;
	if (years < 10) {
		const rounded = Math.round(years * 10) / 10;
		return Number.isInteger(rounded) ? `${rounded}y` : `${rounded.toFixed(1)}y`;
	}
	return `${Math.floor(years)}y`;
}

/**
 * Format a future timestamp as a forward-looking relative string.
 *
 * `formatRelativeTime` only models the past - every future timestamp collapses
 * to "just now" because the `diffMins < 1` branch fires on negative diffs. This
 * helper is the symmetric forward variant for things like quota reset times.
 *
 * Output ladder, chosen to mirror Anthropic's `/usage` web panel ("Resets in
 * 43 min" / "Resets Thu 10:00 AM"):
 *   - < 1 minute   → "in <1m"
 *   - < 60 minutes → "in 43m"
 *   - same calendar day in user's locale → "today at 7:00 PM"
 *   - within 7 days → "Thu 10:00 AM"
 *   - beyond a week → "May 22 at 10:00 AM"
 *
 * If `timestamp` is already past `now` (sample is older than the reset),
 * returns "just now" - same calling-site sentinel as `formatRelativeTime`'s
 * floor so consumers don't need to special-case stale snapshots.
 */
export function formatFutureTime(dateOrTimestamp: Date | number | string): string {
	let timestamp: number;
	if (typeof dateOrTimestamp === 'number') {
		timestamp = dateOrTimestamp;
	} else if (typeof dateOrTimestamp === 'string') {
		timestamp = new Date(dateOrTimestamp).getTime();
	} else {
		timestamp = dateOrTimestamp.getTime();
	}

	const now = Date.now();
	const diffMs = timestamp - now;
	if (diffMs <= 0) return 'just now';

	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3_600_000);
	const diffDays = Math.floor(diffMs / 86_400_000);

	if (diffMins < 1) return 'in <1m';
	if (diffMins < 60) return `in ${diffMins}m`;

	const target = new Date(timestamp);
	const nowDate = new Date(now);
	const sameDay =
		target.getFullYear() === nowDate.getFullYear() &&
		target.getMonth() === nowDate.getMonth() &&
		target.getDate() === nowDate.getDate();

	const timeStr = target.toLocaleTimeString('en-US', {
		hour: 'numeric',
		minute: '2-digit',
	});

	if (sameDay) return `today at ${timeStr}`;
	if (diffHours < 24) return `in ${diffHours}h`;
	if (diffDays < 7) {
		const weekday = target.toLocaleDateString('en-US', { weekday: 'short' });
		return `${weekday} ${timeStr}`;
	}
	const dateStr = target.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	return `${dateStr} at ${timeStr}`;
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
 * Returns true if `path` is an absolute filesystem path.
 *
 * Matches Unix absolute paths (`/foo`), Windows drive paths (`C:\foo`,
 * `C:/foo`), and UNC / drive-relative paths starting with a backslash
 * (`\\server\share`, `\foo`).
 */
export function isAbsolutePath(path: string): boolean {
	if (!path) return false;
	return /^(\/|\\|[a-zA-Z]:[/\\])/.test(path);
}

/**
 * Extract the final path segment (file or folder name) from a path.
 * Handles both `/` and `\` separators and ignores a trailing separator.
 * Returns the input unchanged when it contains no separators.
 */
export function getBasename(path: string): string {
	if (!path) return '';
	const trimmed = path.replace(/[/\\]+$/, '');
	const parts = trimmed.split(/[/\\]/);
	return parts[parts.length - 1] || trimmed;
}

/**
 * Join path segments onto a base path, using whichever separator the base
 * already speaks (backslash only when the base is Windows-style).
 *
 * Node's `path.join` is not available in the renderer, and a hardcoded `/`
 * breaks Windows while a hardcoded `\` breaks SSH remotes (always POSIX), so
 * the base path is the source of truth. Segments may use either separator.
 */
export function joinPath(base: string, ...segments: string[]): string {
	const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
	const trimmedBase = base.replace(/[/\\]+$/, '');
	const tail = segments
		.map((s) => s.replace(/^[/\\]+|[/\\]+$/g, '').replace(/[/\\]+/g, sep))
		.filter(Boolean);
	return tail.length > 0 ? `${trimmedBase}${sep}${tail.join(sep)}` : trimmedBase;
}

/**
 * Format an SSH remote's connection target for display, e.g. "pedram@10.0.50.63:2222".
 *
 * The username prefix is omitted when none is set (SSH falls back to ~/.ssh/config or
 * the current user). The port is always shown because an agent connects to the *saved*
 * port: a remote saved with port 22 looks identical to one saved with 2222 unless the
 * port is visible, which is a common source of "it connected to the wrong port"
 * confusion when the display name doesn't match the actual port field.
 *
 * @param remote - SSH remote fields (host required; port/username optional)
 * @returns Display target string (e.g. "pedram@host:2222" or "host:22")
 */
export function formatSshTarget(remote: {
	host: string;
	port?: number;
	username?: string;
}): string {
	const user = remote.username?.trim();
	const prefix = user ? `${user}@` : '';
	return `${prefix}${remote.host}:${remote.port ?? 22}`;
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
 * Truncate arbitrary display text to a maximum length with a trailing ellipsis.
 * Unlike {@link truncateCommand} it does not collapse newlines - use it for
 * short single-token labels (agent names, titles) where the caller surfaces the
 * full value elsewhere (e.g. a tooltip).
 *
 * @param text - The text to truncate
 * @param maxLength - Maximum length of the returned string (default: 24)
 * @returns Truncated string (e.g., "a-very-long-agent-nam…")
 */
export function truncateText(text: string, maxLength: number = 24): string {
	if (text.length <= maxLength) return text;
	return text.slice(0, maxLength - 1) + '…';
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
 * Format a duration in milliseconds as a compact human-readable string that
 * ladders through every unit from seconds up to years, showing the two largest
 * non-zero units. Unlike formatDurationParts (caps at days) and formatDuration
 * (caps at seconds), this keeps long spans readable instead of dumping a giant
 * seconds count: "45s", "5m 30s", "2h 15m", "6d 7h", "3w 2d", "1y 7w".
 *
 * Week = 7 days, year = 365 days - coarse enough for summary/dashboard displays
 * where exact calendar math is unnecessary. Months are intentionally skipped so
 * the ladder stays: seconds, minutes, hours, days, weeks, years.
 *
 * @param ms - Duration in milliseconds
 * @returns Human-readable duration (e.g., "6d 7h")
 */
export function formatDurationLong(ms: number): string {
	if (!Number.isFinite(ms) || ms < 1000) return '0s';
	const totalSeconds = Math.floor(ms / 1000);

	const units: Array<[label: string, size: number]> = [
		['y', 31_536_000],
		['w', 604_800],
		['d', 86_400],
		['h', 3_600],
		['m', 60],
		['s', 1],
	];

	for (let i = 0; i < units.length; i++) {
		const [label, size] = units[i];
		const value = Math.floor(totalSeconds / size);
		if (value <= 0) continue;
		const parts = [`${value}${label}`];
		const next = units[i + 1];
		if (next) {
			const nextValue = Math.floor((totalSeconds % size) / next[1]);
			if (nextValue > 0) parts.push(`${nextValue}${next[0]}`);
		}
		return parts.join(' ');
	}
	return '0s';
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
 * Cleverly shorten a group name so it fits in a small badge/pill.
 *
 * Strategy ladder - first rung that meets `max` wins:
 *   1. Already short enough → return as-is.
 *   2. Contains "&" or " and " conjunction → acronym joined by "&"
 *      ("Amini & Conant" → "A&C", "Foo and Bar and Baz" → "F&B&B").
 *   3. Multi-word (split on whitespace, "_", "-", "/") → initials ("Acme Corp" → "AC").
 *      Each initial is the word's first letter, so leading numbering/bracket
 *      tokens drop out ("[1] Aleyemma/Money-Sessions" → "AMS", not "[AMS").
 *   4. Single long word → strip vowels keeping the first character
 *      ("Engineering" → "Engnrng", "Documentation" → "Dcmnttn").
 *   5. Still too long → hard-truncate the devoweled form.
 *
 * Aim for `target` chars, accept up to `max`. Defaults match the bookmark
 * badge in the Left Bar (target 8, allow 10).
 */
export function abbreviateGroupName(
	name: string,
	options?: { target?: number; max?: number }
): string {
	const max = options?.max ?? 10;
	const trimmed = name.trim();
	if (!trimmed) return trimmed;

	// Bracketed tag prefix wins: "[ARP] Auditoria Relatório Pessoal" → "ARP".
	// Users put their preferred short form in brackets. Without this rule the
	// initials path below would fold the bracketed acronym into the following
	// words ("[ARP] Auditoria Relatório Pessoal" → "AARP"), so honor the tag
	// verbatim (issue #1017). Require a letter so pure-numbering prefixes like
	// "[1]" fall through to the initials path, which drops them ("[1] A/B" → "AB").
	const tagMatch = trimmed.match(/^\[([^\]]+)\]/);
	if (tagMatch) {
		const tag = tagMatch[1].trim();
		if (tag && /[a-z]/i.test(tag) && tag.length <= max) return tag;
	}

	if (trimmed.length <= max) return trimmed;

	// First letter of a word, skipping any leading non-letters so numbering or
	// bracket prefixes drop out entirely ("[1]" → "", "MONEY" → "M").
	const firstLetter = (word: string): string => {
		const match = word.match(/[a-z]/i);
		return match ? match[0].toUpperCase() : '';
	};

	// Acronym joined by "&" - handles "A & B" and "A and B" forms.
	const conjunctionParts = trimmed
		.split(/\s*&\s*|\s+and\s+/i)
		.map((p) => firstLetter(p))
		.filter(Boolean);
	if (conjunctionParts.length >= 2) {
		const acronym = conjunctionParts.join('&');
		if (acronym.length <= max) return acronym;
	}

	// Plain initials for multi-word names.
	const initials = trimmed
		.split(/[\s_\-/]+/)
		.map((w) => firstLetter(w))
		.filter(Boolean)
		.join('');
	if (initials.length >= 2) {
		if (initials.length <= max) return initials;
		return initials.slice(0, max);
	}

	// Single word: drop vowels but preserve the first character so "Amini" → "Amn", not "mn".
	const first = trimmed.charAt(0);
	const devoweled = first + trimmed.slice(1).replace(/[aeiouAEIOU]/g, '');
	if (devoweled.length <= max) return devoweled;
	return devoweled.slice(0, max);
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
