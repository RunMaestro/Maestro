import type { KeyboardEvent } from 'react';
import type { StatsAggregation, StatsTimeRange } from '../../../../../shared/stats-types';
import type { Session, Theme } from '../../../../types';
import type { CueSourceTotals } from '../../SourceDistributionChart';
import type { SectionId } from '../sections';
import type { UsageDashboardLayout } from '../types';

export interface SectionNavigationProps {
	focusedSection: SectionId | null;
	setSectionRef: (sectionId: SectionId) => (el: HTMLDivElement | null) => void;
	handleSectionKeyDown: (event: KeyboardEvent<HTMLDivElement>, sectionId: SectionId) => void;
}

export interface DashboardViewProps extends SectionNavigationProps {
	data: StatsAggregation;
	timeRange: StatsTimeRange;
	theme: Theme;
	colorBlindMode: boolean;
	sessions: Session[];
	layout: UsageDashboardLayout;
}

export interface OverviewViewProps extends DashboardViewProps {
	cueSourceTotals: CueSourceTotals | null;
}
