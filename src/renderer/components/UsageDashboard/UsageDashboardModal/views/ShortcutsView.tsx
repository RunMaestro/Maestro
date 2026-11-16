import type { StatsTimeRange } from '../../../../../shared/stats-types';
import type { Theme } from '../../../../types';
import { ChartErrorBoundary } from '../../ChartErrorBoundary';
import { KeyboardStats } from '../../KeyboardStats';
import { DashboardSection } from '../components';
import { DashboardTabPanel } from './DashboardTabPanel';
import type { DashboardViewBaseProps } from './types';

interface ShortcutsViewProps extends Partial<Omit<DashboardViewBaseProps, 'theme'>> {
	timeRange: StatsTimeRange;
	theme: Theme;
}

const NO_SECTION_REF = () => () => {};
const NO_SECTION_KEYS = () => {};

export function ShortcutsView({
	timeRange,
	theme,
	focusedSection = null,
	setSectionRef = NO_SECTION_REF,
	handleSectionKeyDown = NO_SECTION_KEYS,
}: ShortcutsViewProps) {
	return (
		<DashboardTabPanel viewMode="shortcuts">
			<DashboardSection
				sectionId="keyboard-stats"
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
			>
				<ChartErrorBoundary theme={theme} chartName="Keyboard Shortcuts">
					<KeyboardStats timeRange={timeRange} theme={theme} />
				</ChartErrorBoundary>
			</DashboardSection>
		</DashboardTabPanel>
	);
}
