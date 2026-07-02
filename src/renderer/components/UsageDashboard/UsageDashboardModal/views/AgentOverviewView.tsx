import { AgentEfficiencyChart } from '../../AgentEfficiencyChart';
import { AgentUsageChart } from '../../AgentUsageChart';
import { ChartErrorBoundary } from '../../ChartErrorBoundary';
import { SessionStats } from '../../SessionStats';
import { WorktreeAnalytics } from '../../WorktreeAnalytics';
import { DashboardSection } from '../components';
import { DashboardTabPanel } from './DashboardTabPanel';
import type { AgentOverviewViewProps } from './types';

export function AgentOverviewView({
	data,
	timeRange,
	theme,
	colorBlindMode,
	sessions,
	focusedSection,
	setSectionRef,
	handleSectionKeyDown,
}: AgentOverviewViewProps) {
	return (
		<DashboardTabPanel viewMode="agent-overview">
			<DashboardSection
				sectionId="session-stats"
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
				style={{ animationDelay: '0ms' }}
			>
				<ChartErrorBoundary theme={theme} chartName="Agent Statistics">
					<SessionStats sessions={sessions} theme={theme} colorBlindMode={colorBlindMode} />
				</ChartErrorBoundary>
			</DashboardSection>

			{sessions.some((session) => !!session.parentSessionId) && (
				<DashboardSection
					sectionId="worktree-analytics"
					focusedSection={focusedSection}
					setSectionRef={setSectionRef}
					handleSectionKeyDown={handleSectionKeyDown}
					theme={theme}
					style={{ animationDelay: '25ms' }}
				>
					<ChartErrorBoundary theme={theme} chartName="Worktree Analytics">
						<WorktreeAnalytics sessions={sessions} data={data} theme={theme} />
					</ChartErrorBoundary>
				</DashboardSection>
			)}

			<DashboardSection
				sectionId="agent-efficiency"
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
				style={{ minHeight: '180px', animationDelay: '50ms' }}
			>
				<ChartErrorBoundary theme={theme} chartName="Agent Efficiency">
					<AgentEfficiencyChart
						data={data}
						theme={theme}
						colorBlindMode={colorBlindMode}
						sessions={sessions}
					/>
				</ChartErrorBoundary>
			</DashboardSection>

			<DashboardSection
				sectionId="agent-usage"
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
				style={{ minHeight: '280px', animationDelay: '200ms' }}
			>
				<ChartErrorBoundary theme={theme} chartName="Agent Usage">
					<AgentUsageChart
						data={data}
						timeRange={timeRange}
						theme={theme}
						colorBlindMode={colorBlindMode}
						sessions={sessions}
					/>
				</ChartErrorBoundary>
			</DashboardSection>
		</DashboardTabPanel>
	);
}
