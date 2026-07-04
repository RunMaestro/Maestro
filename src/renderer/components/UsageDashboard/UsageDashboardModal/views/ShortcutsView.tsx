import type { StatsTimeRange } from '../../../../../shared/stats-types';
import type { Theme } from '../../../../types';
import { KeyboardStats } from '../../KeyboardStats';
import { DashboardTabPanel } from './DashboardTabPanel';

interface ShortcutsViewProps {
	timeRange: StatsTimeRange;
	theme: Theme;
}

export function ShortcutsView({ timeRange, theme }: ShortcutsViewProps) {
	return (
		<DashboardTabPanel viewMode="shortcuts">
			<KeyboardStats timeRange={timeRange} theme={theme} />
		</DashboardTabPanel>
	);
}
