import type { ComponentType } from 'react';
import type { Theme } from '../../../../types';
import { ChartErrorBoundary } from '../../ChartErrorBoundary';
import { ClaudePlanUsage } from '../../ClaudePlanUsage';
import { CodexPlanUsage } from '../../CodexPlanUsage';
import { DashboardSection } from '../components';
import type { SectionId } from '../sections';
import type { SectionNavigationProps } from './types';
import { DashboardTabPanel } from './DashboardTabPanel';

interface ProviderQuotaUsageViewProps extends SectionNavigationProps {
	provider: 'anthropic' | 'codex';
	theme: Theme;
}

interface ProviderUsageComponentProps {
	theme: Theme;
	showAllAccounts?: boolean;
	autoRefresh?: boolean;
}

const PROVIDER_CONFIG: Record<
	ProviderQuotaUsageViewProps['provider'],
	{
		viewMode: 'anthropic-usage' | 'codex-usage';
		sectionId: SectionId;
		chartName: string;
		Component: ComponentType<ProviderUsageComponentProps>;
	}
> = {
	anthropic: {
		viewMode: 'anthropic-usage',
		sectionId: 'anthropic-usage',
		chartName: 'Anthropic Usage',
		Component: ClaudePlanUsage,
	},
	codex: {
		viewMode: 'codex-usage',
		sectionId: 'codex-usage',
		chartName: 'OpenAI Usage',
		Component: CodexPlanUsage,
	},
};

export function ProviderQuotaUsageView({
	provider,
	theme,
	focusedSection,
	setSectionRef,
	handleSectionKeyDown,
}: ProviderQuotaUsageViewProps) {
	const { viewMode, sectionId, chartName, Component } = PROVIDER_CONFIG[provider];

	return (
		<DashboardTabPanel viewMode={viewMode}>
			<DashboardSection
				sectionId={sectionId}
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
			>
				<ChartErrorBoundary theme={theme} chartName={chartName}>
					<Component theme={theme} showAllAccounts autoRefresh={false} />
				</ChartErrorBoundary>
			</DashboardSection>
		</DashboardTabPanel>
	);
}
