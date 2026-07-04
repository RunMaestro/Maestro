import { ActivityHeatmap } from '../../ActivityHeatmap';
import { ChartErrorBoundary } from '../../ChartErrorBoundary';
import { DurationTrendsChart } from '../../DurationTrendsChart';
import { WeekdayComparisonChart } from '../../WeekdayComparisonChart';
import { DashboardSection } from '../components';
import { DashboardTabPanel } from './DashboardTabPanel';
import type { ActivityViewProps } from './types';

export function ActivityView({
	data,
	timeRange,
	theme,
	colorBlindMode,
	focusedSection,
	setSectionRef,
	handleSectionKeyDown,
}: ActivityViewProps) {
	return (
		<DashboardTabPanel viewMode="activity">
			<DashboardSection
				sectionId="activity-heatmap"
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
				style={{ minHeight: '300px', animationDelay: '0ms' }}
			>
				<ChartErrorBoundary theme={theme} chartName="Activity Heatmap">
					<ActivityHeatmap
						data={data}
						timeRange={timeRange}
						theme={theme}
						colorBlindMode={colorBlindMode}
					/>
				</ChartErrorBoundary>
			</DashboardSection>

			<DashboardSection
				sectionId="weekday-comparison"
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
				style={{ animationDelay: '50ms' }}
			>
				<ChartErrorBoundary theme={theme} chartName="Weekday Comparison">
					<WeekdayComparisonChart data={data} theme={theme} colorBlindMode={colorBlindMode} />
				</ChartErrorBoundary>
			</DashboardSection>

			<DashboardSection
				sectionId="duration-trends"
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
				style={{ minHeight: '280px', animationDelay: '100ms' }}
			>
				<ChartErrorBoundary theme={theme} chartName="Duration Trends">
					<DurationTrendsChart
						data={data}
						timeRange={timeRange}
						theme={theme}
						colorBlindMode={colorBlindMode}
					/>
				</ChartErrorBoundary>
			</DashboardSection>
		</DashboardTabPanel>
	);
}
