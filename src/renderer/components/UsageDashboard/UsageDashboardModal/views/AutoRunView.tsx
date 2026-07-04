import { AutoRunStats } from '../../AutoRunStats';
import { ChartErrorBoundary } from '../../ChartErrorBoundary';
import { LongestAutoRunsTable } from '../../LongestAutoRunsTable';
import { PercentilesCard } from '../../PercentilesCard';
import { TasksByHourChart } from '../../TasksByHourChart';
import { DashboardSection } from '../components';
import { DashboardTabPanel } from './DashboardTabPanel';
import type { AutoRunViewProps } from './types';

export function AutoRunView({
	data,
	timeRange,
	theme,
	layout,
	focusedSection,
	setSectionRef,
	handleSectionKeyDown,
}: AutoRunViewProps) {
	return (
		<DashboardTabPanel viewMode="autorun">
			<DashboardSection
				sectionId="autorun-stats"
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
				style={{ animationDelay: '0ms' }}
			>
				<ChartErrorBoundary theme={theme} chartName="Auto Run Stats">
					<AutoRunStats timeRange={timeRange} theme={theme} columns={layout.autoRunStatsCols} />
				</ChartErrorBoundary>
			</DashboardSection>

			<DashboardSection
				sectionId="autorun-task-percentiles"
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
				style={{ animationDelay: '50ms' }}
			>
				<ChartErrorBoundary theme={theme} chartName="Auto Run Task Duration Percentiles">
					<PercentilesCard
						theme={theme}
						title="Task Duration Percentiles"
						unitLabel="tasks"
						distribution={data.autoRunTaskDurationPercentiles}
					/>
				</ChartErrorBoundary>
			</DashboardSection>

			<DashboardSection
				sectionId="tasks-by-hour"
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
				style={{ animationDelay: '100ms' }}
			>
				<ChartErrorBoundary theme={theme} chartName="Tasks by Hour">
					<TasksByHourChart timeRange={timeRange} theme={theme} />
				</ChartErrorBoundary>
			</DashboardSection>

			<DashboardSection
				sectionId="longest-autoruns"
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
				style={{ animationDelay: '200ms' }}
			>
				<ChartErrorBoundary theme={theme} chartName="Longest Auto Runs">
					<LongestAutoRunsTable timeRange={timeRange} theme={theme} />
				</ChartErrorBoundary>
			</DashboardSection>
		</DashboardTabPanel>
	);
}
