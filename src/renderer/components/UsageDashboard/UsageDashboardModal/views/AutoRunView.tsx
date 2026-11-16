import { AutoRunStats } from '../../AutoRunStats';
import { ChartErrorBoundary } from '../../ChartErrorBoundary';
import { LongestAutoRunsTable } from '../../LongestAutoRunsTable';
import { PercentilesCard } from '../../PercentilesCard';
import { TasksByHourChart } from '../../TasksByHourChart';
import { WizardStats } from '../../WizardStats';
import { DashboardSection } from '../components';
import { DashboardTabPanel } from './DashboardTabPanel';
import type { AutoRunViewProps } from './types';

export function AutoRunView({
	data,
	timeRange,
	theme,
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
					<AutoRunStats timeRange={timeRange} theme={theme} />
				</ChartErrorBoundary>
			</DashboardSection>

			{/* Wizard: what the /wizard conversations cost and produced.
			    Sits right under the Auto Run totals because it is the
			    upstream half of the same story - the wizard writes the
			    documents Auto Run then executes. */}
			<DashboardSection
				sectionId="wizard-stats"
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
				style={{ animationDelay: '25ms' }}
			>
				<ChartErrorBoundary theme={theme} chartName="Wizard Stats">
					<WizardStats timeRange={timeRange} theme={theme} />
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
				{/* Per agent TURN (one invocation on a document), not per checkbox:
				    the tiles above count checkboxes, this reads auto_run_tasks. */}
				<ChartErrorBoundary theme={theme} chartName="Auto Run Agent Turn Duration Percentiles">
					<PercentilesCard
						theme={theme}
						title="Agent Turn Duration Percentiles"
						unitLabel="agent turns"
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
				<ChartErrorBoundary theme={theme} chartName="Agent Turns by Time of Day">
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
