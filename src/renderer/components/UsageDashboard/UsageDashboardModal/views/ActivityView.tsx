import { ActivityHeatmap } from '../../ActivityHeatmap';
import { ChartErrorBoundary } from '../../ChartErrorBoundary';
import { DelegationTrendChart } from '../../DelegationTrendChart';
import { DurationTrendsChart } from '../../DurationTrendsChart';
import { PromptCadenceStats } from '../../PromptCadenceStats';
import { DashboardSection } from '../components';
import { DashboardTabPanel } from './DashboardTabPanel';
import type { ActivityViewProps } from './types';

export function ActivityView({
	data,
	theme,
	colorBlindMode,
	delegationByDay,
	focusedSection,
	setSectionRef,
	handleSectionKeyDown,
}: ActivityViewProps) {
	return (
		<DashboardTabPanel viewMode="activity">
			<DashboardSection
				sectionId="prompt-cadence"
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
				style={{ animationDelay: '0ms' }}
			>
				<ChartErrorBoundary theme={theme} chartName="Prompts">
					<PromptCadenceStats cadence={data.prompts} theme={theme} />
				</ChartErrorBoundary>
			</DashboardSection>

			<DashboardSection
				sectionId="delegation-trend"
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
				style={{ minHeight: '280px', animationDelay: '0ms' }}
			>
				<ChartErrorBoundary theme={theme} chartName="Interactive vs Delegated">
					<DelegationTrendChart
						days={delegationByDay}
						dayWindow={data.window}
						theme={theme}
						colorBlindMode={colorBlindMode}
					/>
				</ChartErrorBoundary>
			</DashboardSection>

			<DashboardSection
				sectionId="activity-heatmap"
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
				style={{ minHeight: '300px', animationDelay: '0ms' }}
			>
				<ChartErrorBoundary theme={theme} chartName="Activity Heatmap">
					<ActivityHeatmap data={data} theme={theme} colorBlindMode={colorBlindMode} />
				</ChartErrorBoundary>
			</DashboardSection>

			<DashboardSection
				sectionId="duration-trends"
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
				style={{ minHeight: '280px', animationDelay: '50ms' }}
			>
				<ChartErrorBoundary theme={theme} chartName="Duration Trends">
					<DurationTrendsChart data={data} theme={theme} colorBlindMode={colorBlindMode} />
				</ChartErrorBoundary>
			</DashboardSection>
		</DashboardTabPanel>
	);
}
