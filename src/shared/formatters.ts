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
 * - formatCost: USD currency display ($1.23, <$0.01)
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
  if (num < 1000) return num.toFixed(1);
  if (num < 1000000) return `${(num / 1000).toFixed(1)}k`;
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
 * @returns Formatted string (e.g., "500", "1.5K", "2.3M")
 */
export function formatTokensCompact(tokens: number): string {
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
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
