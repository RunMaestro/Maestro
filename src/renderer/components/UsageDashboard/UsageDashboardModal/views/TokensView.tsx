import type { StatsTimeRange } from '../../../../../shared/stats-types';
import type { Theme } from '../../../../types';
import { TokenStats } from '../../TokenStats';
import { ResilienceStats } from '../../ResilienceStats';
import { ChartErrorBoundary } from '../../ChartErrorBoundary';
import { DashboardTabPanel } from './DashboardTabPanel';

interface TokensViewProps {
	timeRange: StatsTimeRange;
	theme: Theme;
	colorBlindMode?: boolean;
}

/**
 * Token & cost consumption. Reads each agent's on-disk transcripts rather than
 * the stats DB, so (like Shortcuts) it renders even when there are no recorded
 * query events.
 */
export function TokensView({ timeRange, theme, colorBlindMode }: TokensViewProps) {
	return (
		<DashboardTabPanel viewMode="tokens">
			<TokenStats timeRange={timeRange} theme={theme} colorBlindMode={colorBlindMode} />

			{/* Agent Resilience: outages hit vs. carried through. This sits with the
			    token readouts because an outage is what a token budget running out
			    looks like from the agent's side, and both are read per time range. */}
			<div className="dashboard-section-enter" style={{ animationDelay: '150ms' }}>
				<ChartErrorBoundary theme={theme} chartName="Resilience">
					<ResilienceStats timeRange={timeRange} theme={theme} />
				</ChartErrorBoundary>
			</div>
		</DashboardTabPanel>
	);
}
