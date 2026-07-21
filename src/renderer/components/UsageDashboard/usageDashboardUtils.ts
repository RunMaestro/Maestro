export interface SessionSparklineDay {
	count: number;
}

const SPARKLINE_DAYS = 7;

/**
 * Builds the fixed-width activity series consumed by dashboard sparklines.
 * The oldest values are left-padded so the SVG geometry remains stable.
 */
export function buildSessionSparkline(
	sessionByDay: readonly SessionSparklineDay[] | undefined
): number[] {
	if (!sessionByDay || sessionByDay.length === 0) {
		return new Array(SPARKLINE_DAYS).fill(0);
	}

	const counts = sessionByDay.slice(-SPARKLINE_DAYS).map((day) => day.count);
	if (counts.length >= SPARKLINE_DAYS) return counts;
	return [...new Array(SPARKLINE_DAYS - counts.length).fill(0), ...counts];
}

/** Formats a dashboard YYYY-MM-DD label as a local calendar day. */
export function formatUsageShortDate(dateStr: string): string {
	const parts = dateStr.split('-').map(Number);
	if (parts.length !== 3 || parts.some(Number.isNaN)) return dateStr;

	const [year, month, day] = parts;
	return new Date(year, month - 1, day).toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
	});
}
