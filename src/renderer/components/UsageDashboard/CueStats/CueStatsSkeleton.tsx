import { memo } from 'react';
import type { Theme } from '../../../types';
import {
	AgentComparisonChartSkeleton,
	DurationTrendsChartSkeleton,
	SummaryCardsSkeleton,
} from '../ChartSkeletons';

export const CueStatsSkeleton = memo(function CueStatsSkeleton({ theme }: { theme: Theme }) {
	return (
		<div className="space-y-6" data-testid="cue-stats-skeleton">
			<SummaryCardsSkeleton theme={theme} columns={4} />
			<DurationTrendsChartSkeleton theme={theme} />
			<AgentComparisonChartSkeleton theme={theme} />
		</div>
	);
});
