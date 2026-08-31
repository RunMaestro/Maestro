import type { GroupLike, GroupStatRollup } from '../../../../../shared/statsGroupRollup';
import { GroupOverviewCards } from '../../GroupOverviewCards';
import { ChartErrorBoundary } from '../../ChartErrorBoundary';
import { DashboardSection } from '../components';
import { DashboardTabPanel } from './DashboardTabPanel';
import type { AgentsBaseViewProps } from './types';

interface GroupsViewProps extends AgentsBaseViewProps {
	/** Left Bar groups, in their stored order. */
	groups: GroupLike[];
	/** Group whose detail modal is open, so its tile renders selected. */
	activeGroupId: string | null;
	/** Open a group's per-agent breakdown modal. */
	onSelectGroup: (rollup: GroupStatRollup) => void;
}

export function GroupsView({
	data,
	theme,
	sessions,
	groups,
	activeGroupId,
	onSelectGroup,
	focusedSection,
	setSectionRef,
	handleSectionKeyDown,
}: GroupsViewProps) {
	return (
		<DashboardTabPanel viewMode="groups">
			<DashboardSection
				sectionId="group-overview-cards"
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
				style={{ animationDelay: '0ms' }}
			>
				<ChartErrorBoundary theme={theme} chartName="Group Overview">
					<GroupOverviewCards
						groups={groups}
						sessions={sessions}
						data={data}
						theme={theme}
						activeGroupId={activeGroupId}
						onSelectGroup={onSelectGroup}
					/>
				</ChartErrorBoundary>
			</DashboardSection>
		</DashboardTabPanel>
	);
}
