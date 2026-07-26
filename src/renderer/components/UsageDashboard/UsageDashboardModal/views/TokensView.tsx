import type { StatsTimeRange } from '../../../../../shared/stats-types';
import type { Theme } from '../../../../types';
import { TokenStats } from '../../TokenStats';
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
		</DashboardTabPanel>
	);
}
