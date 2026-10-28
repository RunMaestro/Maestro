import type { StatsTimeRange } from '../../../../../shared/stats-types';
import type { Theme } from '../../../../types';
import { ModelUsageStats } from '../../ModelUsage';
import { DashboardTabPanel } from './DashboardTabPanel';

interface ModelsViewProps {
	timeRange: StatsTimeRange;
	theme: Theme;
	colorBlindMode?: boolean;
}

/**
 * What every model other than a provider's own did in the range. Reads its own
 * record (`stats:get-model-usage`) rather than the stats aggregation, so, like
 * Tokens and Shortcuts, it renders when no query event was recorded.
 */
export function ModelsView({ timeRange, theme, colorBlindMode }: ModelsViewProps) {
	return (
		<DashboardTabPanel viewMode="models">
			<ModelUsageStats timeRange={timeRange} theme={theme} colorBlindMode={colorBlindMode} />
		</DashboardTabPanel>
	);
}
