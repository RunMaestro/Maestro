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

export interface DashboardViewBaseProps extends SectionNavigationProps {
	theme: Theme;
}

export interface StatsViewProps extends DashboardViewBaseProps {
	data: StatsAggregation;
	timeRange: StatsTimeRange;
	colorBlindMode: boolean;
}

export interface OverviewViewProps extends StatsViewProps {
	sessions: Session[];
	layout: UsageDashboardLayout;
	cueSourceTotals: CueSourceTotals | null;
}

export interface AgentOverviewViewProps extends StatsViewProps {
	sessions: Session[];
}

export interface AgentsBaseViewProps extends DashboardViewBaseProps {
	data: StatsAggregation;
	sessions: Session[];
}

export interface ActivityViewProps extends StatsViewProps {}

export interface AutoRunViewProps extends DashboardViewBaseProps {
	data: StatsAggregation;
	timeRange: StatsTimeRange;
	layout: UsageDashboardLayout;
}
