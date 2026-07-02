import { getAgentDisplayName } from '../../../../../shared/agentMetadata';
import { AgentComparisonChart } from '../../AgentComparisonChart';
import { ChartErrorBoundary } from '../../ChartErrorBoundary';
import { LocationDistributionChart } from '../../LocationDistributionChart';
import { PercentilesCard } from '../../PercentilesCard';
import { ProviderTrendsChart } from '../../ProviderTrendsChart';
import { RadialActivityChart } from '../../RadialActivityChart';
import { SourceDistributionChart } from '../../SourceDistributionChart';
import { SummaryCards } from '../../SummaryCards';
import { YearInPixelsStrip } from '../../YearInPixelsStrip';
import { DashboardSection } from '../components';
import { DashboardTabPanel } from './DashboardTabPanel';
import type { OverviewViewProps } from './types';

export function OverviewView({
	data,
	timeRange,
	theme,
	colorBlindMode,
	sessions,
	layout,
	cueSourceTotals,
	focusedSection,
	setSectionRef,
	handleSectionKeyDown,
}: OverviewViewProps) {
	return (
		<DashboardTabPanel viewMode="overview">
			<DashboardSection
				sectionId="year-in-pixels"
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
				style={{ animationDelay: '0ms' }}
			>
				<ChartErrorBoundary theme={theme} chartName="Year In Pixels">
					<YearInPixelsStrip
						data={data}
						theme={theme}
						colorBlindMode={colorBlindMode}
						timeRange={timeRange}
					/>
				</ChartErrorBoundary>
			</DashboardSection>

			<DashboardSection
				sectionId="summary-cards"
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
				style={{ animationDelay: '0ms' }}
			>
				<ChartErrorBoundary theme={theme} chartName="Summary Cards">
					<SummaryCards
						data={data}
						theme={theme}
						columns={layout.summaryCardsCols}
						sessions={sessions}
					/>
				</ChartErrorBoundary>
			</DashboardSection>

			<DashboardSection
				sectionId="query-percentiles"
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
				style={{ animationDelay: '50ms' }}
			>
				<ChartErrorBoundary theme={theme} chartName="Query Duration Percentiles">
					<PercentilesCard
						theme={theme}
						title="Query Duration Percentiles"
						unitLabel="queries"
						distribution={data.queryDurationPercentiles}
						breakdown={Object.entries(data.queryDurationPercentilesByAgent).map(
							([agentType, distribution]) => ({
								label: getAgentDisplayName(agentType),
								distribution,
							})
						)}
					/>
				</ChartErrorBoundary>
			</DashboardSection>

			<DashboardSection
				sectionId="agent-comparison"
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
				style={{ minHeight: '180px', animationDelay: '100ms' }}
			>
				<ChartErrorBoundary theme={theme} chartName="Provider Comparison">
					<AgentComparisonChart
						data={data}
						theme={theme}
						colorBlindMode={colorBlindMode}
						sessions={sessions}
					/>
				</ChartErrorBoundary>
			</DashboardSection>

			<DashboardSection
				sectionId="provider-trends"
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
				style={{ minHeight: '260px', animationDelay: '125ms' }}
			>
				<ChartErrorBoundary theme={theme} chartName="Provider Trends">
					<ProviderTrendsChart
						data={data}
						timeRange={timeRange}
						theme={theme}
						colorBlindMode={colorBlindMode}
						sessions={sessions}
					/>
				</ChartErrorBoundary>
			</DashboardSection>

			<div
				className="grid gap-6 dashboard-section-enter"
				style={{
					gridTemplateColumns: `repeat(${layout.chartGridCols}, minmax(0, 1fr))`,
					animationDelay: '150ms',
				}}
			>
				<DashboardSection
					sectionId="source-distribution"
					focusedSection={focusedSection}
					setSectionRef={setSectionRef}
					handleSectionKeyDown={handleSectionKeyDown}
					theme={theme}
					className="outline-none rounded-lg transition-shadow"
					style={{ minHeight: '240px' }}
				>
					<ChartErrorBoundary theme={theme} chartName="Source Distribution">
						<SourceDistributionChart
							data={data}
							theme={theme}
							colorBlindMode={colorBlindMode}
							cueTotals={cueSourceTotals}
						/>
					</ChartErrorBoundary>
				</DashboardSection>

				<DashboardSection
					sectionId="location-distribution"
					focusedSection={focusedSection}
					setSectionRef={setSectionRef}
					handleSectionKeyDown={handleSectionKeyDown}
					theme={theme}
					className="outline-none rounded-lg transition-shadow"
					style={{ minHeight: '240px' }}
				>
					<ChartErrorBoundary theme={theme} chartName="Location Distribution">
						<LocationDistributionChart data={data} theme={theme} colorBlindMode={colorBlindMode} />
					</ChartErrorBoundary>
				</DashboardSection>
			</div>

			<DashboardSection
				sectionId="radial-activity"
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
				style={{ minHeight: '320px', animationDelay: '175ms' }}
			>
				<div
					className="grid gap-6"
					style={{
						gridTemplateColumns: `repeat(${layout.chartGridCols}, minmax(0, 1fr))`,
					}}
				>
					<ChartErrorBoundary theme={theme} chartName="Activity by Hour">
						<RadialActivityChart
							mode="hours"
							data={data}
							theme={theme}
							colorBlindMode={colorBlindMode}
						/>
					</ChartErrorBoundary>
					<ChartErrorBoundary theme={theme} chartName="Activity by Day of Week">
						<RadialActivityChart
							mode="weekday"
							data={data}
							theme={theme}
							colorBlindMode={colorBlindMode}
						/>
					</ChartErrorBoundary>
				</div>
			</DashboardSection>
		</DashboardTabPanel>
	);
}
