import { Database } from 'lucide-react';
import type { StatsAggregation, StatsTimeRange } from '../../../../../shared/stats-types';
import { TIME_RANGE_OPTIONS } from '../constants';
import { formatDatabaseSize } from '../formatters';
import type { UsageDashboardModalProps } from '../types';

interface UsageDashboardFooterProps {
	theme: UsageDashboardModalProps['theme'];
	data: StatsAggregation | null;
	timeRange: StatsTimeRange;
	databaseSize: number | null;
}

export function UsageDashboardFooter({
	theme,
	data,
	timeRange,
	databaseSize,
}: UsageDashboardFooterProps) {
	return (
		<div
			className="px-6 py-3 border-t flex items-center justify-between text-xs flex-shrink-0"
			style={{
				borderColor: theme.colors.border,
				color: theme.colors.textDim,
			}}
		>
			<div className="flex items-center gap-4">
				<span>
					{data && data.totalQueries > 0
						? `Showing ${TIME_RANGE_OPTIONS.find((option) => option.value === timeRange)?.label.toLowerCase()} data`
						: 'No data for selected time range'}
				</span>
				{databaseSize !== null && (
					<span
						className="flex items-center gap-1"
						style={{ opacity: 0.7 }}
						title="Stats database size"
						data-testid="database-size-indicator"
					>
						<Database className="w-3 h-3" />
						{formatDatabaseSize(databaseSize)}
					</span>
				)}
			</div>
			<span style={{ opacity: 0.7 }}>Press Esc to close</span>
		</div>
	);
}
