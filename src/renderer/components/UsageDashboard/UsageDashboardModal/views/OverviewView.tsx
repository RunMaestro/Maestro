import { getAgentDisplayName } from '../../../../../shared/agentMetadata';
import { resolveCueHistoryRetentionDays } from '../../../../../shared/cue/retention';
import { AgentComparisonChart } from '../../AgentComparisonChart';
import { ChartErrorBoundary } from '../../ChartErrorBoundary';
import { DelegationScoreCard } from '../../DelegationScoreCard';
import { LocationDistributionChart } from '../../LocationDistributionChart';
import { PercentilesCard } from '../../PercentilesCard';
import { ProviderTrendsChart } from '../../ProviderTrendsChart';
import { RadialActivityChart } from '../../RadialActivityChart';
import { SourceDistributionChart } from '../../SourceDistributionChart';
import { SummaryCards } from '../../SummaryCards';
import { OverviewTokenSpeed } from '../../TokenSpeedCards';
import { YearInPixelsStrip } from '../../YearInPixelsStrip';
import { DashboardSection } from '../components';
import { DashboardTabPanel } from './DashboardTabPanel';
import { useMemo } from 'react';
import { useSettingsStore } from '../../../../stores/settingsStore';
import { withLifetimeCueTime } from '../../../../../shared/delegation';
import type { OverviewViewProps } from './types';

export function OverviewView({
	data,
	timeRange,
	theme,
	colorBlindMode,
	sessions,
	layout,
	cueSourceTotals,
	delegationTotals,
	lifetimeDelegation,
	focusedSection,
	setSectionRef,
	handleSectionKeyDown,
}: OverviewViewProps) {
	// The milestone high-water mark is read here rather than threaded down from
	// the modal: the score card is the only consumer, and the store is already
	// the source of truth for it.
	const delegationMilestone = useSettingsStore((s) => s.delegationMilestone);
	const unlockDelegationMilestone = useSettingsStore((s) => s.unlockDelegationMilestone);
	// `cue_events` is pruned to the Cue retention window, `query_events` never
	// is, so the merged lifetime totals would weigh a few days of Cue against the
	// whole install. This is the same Cue time the About card shows, accumulated
	// in settings and never pruned - see `withLifetimeCueTime`.
	const lifetimeCueMs = useSettingsStore((s) => s.autoRunStats.cueTimeMs);
	const lifetimeTotals = useMemo(
		() => (lifetimeDelegation ? withLifetimeCueTime(lifetimeDelegation, lifetimeCueMs) : null),
		[lifetimeDelegation, lifetimeCueMs]
	);

	// Cue is an Encore Feature: with it off, the Query Source donut draws no Cue
	// slice at all. With it on, a range longer than Cue's run-history retention
	// can only count the retained days, and the surfaces that put Cue into a
	// ratio say so. `byDay` is gap-filled, so its length is the range in days.
	const cueEnabled = useSettingsStore((s) => s.encoreFeatures.maestroCue);
	const cueRetentionSetting = useSettingsStore((s) => s.cueHistoryRetentionDays);
	const retentionDays = resolveCueHistoryRetentionDays(cueRetentionSetting);
	const cueRetentionDays = cueEnabled && data.byDay.length > retentionDays ? retentionDays : null;

	const percentileBreakdown = useMemo(
		() =>
			Object.entries(data.queryDurationPercentilesByAgent).map(([agentType, distribution]) => ({
				label: getAgentDisplayName(agentType),
				distribution,
			})),
		[data.queryDurationPercentilesByAgent]
	);

	// The location donut only exists for someone who ran a query over SSH: for
	// everyone else it would be a permanent 100% Local ring. `sections.ts` drops
	// its id from keyboard navigation under the same condition.
	const showLocation = (data.byLocation?.remote ?? 0) > 0;

	const sourceChart = (
		<ChartErrorBoundary theme={theme} chartName="Query Source">
			<SourceDistributionChart
				data={data}
				theme={theme}
				colorBlindMode={colorBlindMode}
				delegation={delegationTotals}
				includeCue={cueEnabled}
				cueTokens={cueSourceTotals?.tokens ?? null}
				cueRetentionDays={cueRetentionDays}
			/>
		</ChartErrorBoundary>
	);

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
						delegation={delegationTotals}
						cueRetentionDays={cueRetentionDays}
						colorBlindMode={colorBlindMode}
					/>
				</ChartErrorBoundary>
			</DashboardSection>

			<DashboardSection
				sectionId="token-speed"
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
				style={{ animationDelay: '0ms' }}
			>
				<ChartErrorBoundary theme={theme} chartName="Tokens per Second">
					<OverviewTokenSpeed timeRange={timeRange} theme={theme} />
				</ChartErrorBoundary>
			</DashboardSection>

			<DashboardSection
				sectionId="delegation-score"
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
				style={{ animationDelay: '25ms' }}
			>
				<ChartErrorBoundary theme={theme} chartName="Delegation Score">
					<DelegationScoreCard
						totals={lifetimeTotals}
						theme={theme}
						colorBlindMode={colorBlindMode}
						unlockedMilestone={delegationMilestone}
						onUnlockMilestone={unlockDelegationMilestone}
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
						breakdownLabel="By Provider"
						distribution={data.queryDurationPercentiles}
						breakdown={percentileBreakdown}
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
					<AgentComparisonChart data={data} theme={theme} colorBlindMode={colorBlindMode} />
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
					/>
				</ChartErrorBoundary>
			</DashboardSection>

			{showLocation ? (
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
						{sourceChart}
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
						<ChartErrorBoundary theme={theme} chartName="Query Location">
							<LocationDistributionChart
								data={data}
								theme={theme}
								colorBlindMode={colorBlindMode}
							/>
						</ChartErrorBoundary>
					</DashboardSection>
				</div>
			) : (
				<DashboardSection
					sectionId="source-distribution"
					focusedSection={focusedSection}
					setSectionRef={setSectionRef}
					handleSectionKeyDown={handleSectionKeyDown}
					theme={theme}
					style={{ minHeight: '240px', animationDelay: '150ms' }}
				>
					{sourceChart}
				</DashboardSection>
			)}

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
