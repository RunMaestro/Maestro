import React from 'react';

// Double checkmark SVG component for validated entries
export const DoubleCheck = ({
	className,
	style,
}: {
	className?: string;
	style?: React.CSSProperties;
}) => (
	<svg
		className={className}
		style={style}
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2.5"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<polyline points="15 6 6 17 1 12" />
		<polyline points="23 6 14 17 11 14" />
	</svg>
);

// Lookback period options for the activity graph
export type LookbackPeriod = {
	label: string;
	hours: number | null; // null = all time
	bucketCount: number;
};

export const LOOKBACK_OPTIONS: LookbackPeriod[] = [
	{ label: '24 hours', hours: 24, bucketCount: 24 },
	{ label: '72 hours', hours: 72, bucketCount: 24 },
	{ label: '1 week', hours: 168, bucketCount: 28 },
	{ label: '2 weeks', hours: 336, bucketCount: 28 },
	{ label: '1 month', hours: 720, bucketCount: 30 },
	{ label: '6 months', hours: 4320, bucketCount: 24 },
	{ label: '1 year', hours: 8760, bucketCount: 24 },
	{ label: 'All time', hours: null, bucketCount: 24 },
];

// Constants for history pagination
export const MAX_HISTORY_IN_MEMORY = 500; // Maximum entries to keep in memory

// Estimated row heights for virtualization
// Entry breakdown: p-3 (24px padding) + header (~24px) + mb-2 (8px) + summary (~48px for 3 lines)
// Footer adds: mt-2 pt-2 border-t (~20px)
export const ESTIMATED_ROW_HEIGHT = 124; // Height for entry with footer
export const ESTIMATED_ROW_HEIGHT_SIMPLE = 104; // Height for entry without footer
