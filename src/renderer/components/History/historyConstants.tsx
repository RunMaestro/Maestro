import React from 'react';
import { Bot, User, Zap } from 'lucide-react';
import type { Theme, HistoryEntryType } from '../../types';
import { CUE_COLOR } from '../../../shared/cue-pipeline-types';

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

// CUE_COLOR is imported above from shared/cue-pipeline-types and re-exported for History consumers
export { CUE_COLOR };

/** Get pill color scheme based on entry type */
export const getPillColor = (type: HistoryEntryType, theme: Theme) => {
	switch (type) {
		case 'AUTO':
			return {
				bg: theme.colors.warning + '20',
				text: theme.colors.warning,
				border: theme.colors.warning + '40',
			};
		case 'USER':
			return {
				bg: theme.colors.accent + '20',
				text: theme.colors.accent,
				border: theme.colors.accent + '40',
			};
		case 'CUE':
			return {
				bg: CUE_COLOR + '20',
				text: CUE_COLOR,
				border: CUE_COLOR + '40',
			};
		default:
			return {
				bg: theme.colors.bgActivity,
				text: theme.colors.textDim,
				border: theme.colors.border,
			};
	}
};

/** Get icon component for entry type */
export const getEntryIcon = (type: HistoryEntryType) => {
	switch (type) {
		case 'AUTO':
			return Bot;
		case 'USER':
			return User;
		case 'CUE':
			return Zap;
		default:
			return Bot;
	}
};

// Estimated row heights for virtualization. Used by the row virtualizer
// before measureElement reports the actual rendered size. If these
// underestimate, adjacent rows briefly overlap in the moment between the
// initial render and the ResizeObserver callback - pick values that match
// the worst-case rendered height for each variant so that any correction
// from measureElement only ever shrinks the row.
//
// Breakdown (Tailwind defaults): p-3 (12px × 2) + 1px border × 2
//   + header row (~20px) + mb-2 (8px)
//   + 3-line text-xs leading-relaxed summary (~60px, the line-clamp ceiling)
//   = ~116px base
// Footer adds: mt-2 (8) + pt-2 (8) + 1px border-t + content (~16px) = ~33px
// CUE "Triggered by:" subtitle adds: mt-1 (4) + ~14px = ~18px
export const ESTIMATED_ROW_HEIGHT_BASE = 116;
export const ESTIMATED_ROW_HEIGHT_FOOTER = 33;
export const ESTIMATED_ROW_HEIGHT_CUE_SUBTITLE = 18;
export const ESTIMATED_ROW_HEIGHT = ESTIMATED_ROW_HEIGHT_BASE + ESTIMATED_ROW_HEIGHT_FOOTER; // 149
export const ESTIMATED_ROW_HEIGHT_SIMPLE = ESTIMATED_ROW_HEIGHT_BASE; // 116

/** Estimate a row's rendered height from the entry's content variant. */
export const estimateHistoryRowHeight = (entry: {
	type?: string;
	elapsedTimeMs?: number;
	usageStats?: { totalCostUsd?: number };
	achievementAction?: string;
	hostname?: string;
	cueEventType?: string;
}): number => {
	let height = ESTIMATED_ROW_HEIGHT_BASE;
	const hasFooter =
		entry.elapsedTimeMs !== undefined ||
		(entry.usageStats && (entry.usageStats.totalCostUsd ?? 0) > 0) ||
		!!entry.achievementAction ||
		!!entry.hostname;
	if (hasFooter) height += ESTIMATED_ROW_HEIGHT_FOOTER;
	if (entry.type === 'CUE' && entry.cueEventType) height += ESTIMATED_ROW_HEIGHT_CUE_SUBTITLE;
	return height;
};
