/**
 * Stored and URL-safe lookback values for history graphs.
 * Labels live with the rendering components so persistence never depends on copy.
 */
export const LOOKBACK_PERIODS = [
	{ hours: 24, bucketCount: 24 },
	{ hours: 72, bucketCount: 24 },
	{ hours: 168, bucketCount: 28 },
	{ hours: 336, bucketCount: 28 },
	{ hours: 720, bucketCount: 30 },
	{ hours: 4320, bucketCount: 24 },
	{ hours: 8760, bucketCount: 24 },
	{ hours: null, bucketCount: 24 },
] as const;

export type LookbackHours = (typeof LOOKBACK_PERIODS)[number]['hours'];

/** The persisted sentinel for an unbounded history window. */
export const ALL_TIME_LOOKBACK_HOURS: LookbackHours = null;

/** The default selected window for controls that start with a bounded range. */
export const DEFAULT_LOOKBACK_HOURS: LookbackHours = LOOKBACK_PERIODS[0].hours;
