/**
 * Format a millisecond duration for compact decimal CLI output.
 *
 * This intentionally preserves the CLI's decimal-unit contract: milliseconds
 * below one second, then one decimal place in seconds, minutes, or hours.
 */
export function formatDurationDecimal(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	if (ms < 3600_000) return `${(ms / 60_000).toFixed(1)}m`;
	return `${(ms / 3600_000).toFixed(1)}h`;
}
