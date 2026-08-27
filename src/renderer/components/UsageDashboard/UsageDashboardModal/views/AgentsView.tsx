import type { Session } from '../../../../types';
import { AgentOverviewCards } from '../../AgentOverviewCards';
import { ChartErrorBoundary } from '../../ChartErrorBoundary';
import { DashboardSection } from '../components';
import { DashboardTabPanel } from './DashboardTabPanel';
import type { AgentsBaseViewProps } from './types';

interface AgentsViewProps extends AgentsBaseViewProps {
	onShowAgentDetails: (session: Session) => void;
	/** Member ids of the group drilled into from the Groups tab, or null. */
	restrictToSessionIds?: string[] | null;
	/** Group name, shown on the chip that says what the grid is filtered to. */
	restrictionLabel?: string;
	/** Drop the restriction and show the whole fleet again. */
	onClearRestriction?: () => void;
}

export function AgentsView({
	data,
	theme,
	sessions,
	focusedSection,
	setSectionRef,
	handleSectionKeyDown,
	onShowAgentDetails,
	restrictToSessionIds = null,
	restrictionLabel,
	onClearRestriction,
}: AgentsViewProps) {
	return (
		<DashboardTabPanel viewMode="agents">
			<DashboardSection
				sectionId="agent-overview-cards"
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
				style={{ animationDelay: '0ms' }}
			>
				{sessions.some((session) => session.toolType !== 'terminal') ? (
					<ChartErrorBoundary theme={theme} chartName="Agent Overview">
						<AgentOverviewCards
							sessions={sessions}
							data={data}
							theme={theme}
							onShowAgentDetails={onShowAgentDetails}
							restrictToSessionIds={restrictToSessionIds}
							restrictionLabel={restrictionLabel}
							onClearRestriction={onClearRestriction}
						/>
					</ChartErrorBoundary>
				) : (
					<div
						className="p-6 rounded-lg text-center text-sm"
						style={{
							backgroundColor: theme.colors.bgMain,
							color: theme.colors.textDim,
						}}
					>
						No active agents
					</div>
				)}
			</DashboardSection>
		</DashboardTabPanel>
	);
}
