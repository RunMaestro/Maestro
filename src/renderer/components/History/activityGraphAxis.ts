export interface ActivityGraphTimeRange {
	start: number;
	end: number;
}

export interface ActivityGraphAxisLabel {
	label: string;
	index: number;
}

export interface BuildActivityGraphAxisLabelsOptions {
	range: ActivityGraphTimeRange;
	bucketCount: number;
	lookbackHours: number | null;
	timeZone: string;
	formatDate: (date: Date, timeZone: string) => string;
}

/**
 * Builds shared activity graph x-axis labels from an already-resolved range.
 * Callers retain ownership of bucketing and date formatting policy.
 */
export function buildActivityGraphAxisLabels({
	range,
	bucketCount,
	lookbackHours,
	timeZone,
	formatDate,
}: BuildActivityGraphAxisLabelsOptions): ActivityGraphAxisLabel[] {
	if (lookbackHours === null) {
		return [
			{ label: formatDate(new Date(range.start), timeZone), index: 0 },
			{ label: 'Now', index: bucketCount - 1 },
		];
	}

	if (lookbackHours <= 24) {
		return [
			{ label: `${lookbackHours}h`, index: 0 },
			{ label: `${Math.floor((lookbackHours * 2) / 3)}h`, index: Math.floor(bucketCount / 3) },
			{ label: `${Math.floor(lookbackHours / 3)}h`, index: Math.floor((bucketCount * 2) / 3) },
			{ label: '0h', index: bucketCount - 1 },
		];
	}

	if (lookbackHours <= 168) {
		const days = Math.floor(lookbackHours / 24);
		return [
			{ label: `${days}d`, index: 0 },
			{ label: `${Math.floor(days / 2)}d`, index: Math.floor(bucketCount / 2) },
			{ label: 'Now', index: bucketCount - 1 },
		];
	}

	return [
		{ label: formatDate(new Date(range.start), timeZone), index: 0 },
		{ label: 'Now', index: bucketCount - 1 },
	];
}
