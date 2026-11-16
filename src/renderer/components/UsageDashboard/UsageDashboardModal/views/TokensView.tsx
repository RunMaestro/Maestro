import type { StatsTimeRange } from '../../../../../shared/stats-types';
import type { Theme } from '../../../../types';
import { TokenStats } from '../../TokenStats';
import { ResilienceStats } from '../../ResilienceStats';
import { ChartErrorBoundary } from '../../ChartErrorBoundary';
import { DashboardSection } from '../components';
import { DashboardTabPanel } from './DashboardTabPanel';
import type { SectionNavigationProps } from './types';

interface TokensViewProps extends SectionNavigationProps {
	timeRange: StatsTimeRange;
	theme: Theme;
	colorBlindMode?: boolean;
}

/**
 * Token & cost consumption. Reads each agent's on-disk transcripts rather than
 * the stats DB, so (like Shortcuts) it renders even when there are no recorded
 * query events.
 */
export function TokensView({
	timeRange,
	theme,
	colorBlindMode,
	focusedSection,
	setSectionRef,
	handleSectionKeyDown,
}: TokensViewProps) {
	return (
		<DashboardTabPanel viewMode="tokens">
			<DashboardSection
				sectionId="token-stats"
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
				style={{ animationDelay: '0ms' }}
			>
				<TokenStats timeRange={timeRange} theme={theme} colorBlindMode={colorBlindMode} />
			</DashboardSection>

			{/* Agent Resilience: outages hit vs. carried through. This sits with the
			    token readouts because an outage is what a token budget running out
			    looks like from the agent's side, and both are read per time range. */}
			<DashboardSection
				sectionId="resilience"
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
				style={{ animationDelay: '150ms' }}
			>
				<ChartErrorBoundary theme={theme} chartName="Resilience">
					<ResilienceStats timeRange={timeRange} theme={theme} />
				</ChartErrorBoundary>
			</DashboardSection>
		</DashboardTabPanel>
	);
}
