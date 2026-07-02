import type { Theme } from '../../../../types';
import { ChartErrorBoundary } from '../../ChartErrorBoundary';
import { ClaudePlanUsage } from '../../ClaudePlanUsage';
import { CodexPlanUsage } from '../../CodexPlanUsage';
import { DashboardSection } from '../components';
import type { SectionNavigationProps } from './types';
import { DashboardTabPanel } from './DashboardTabPanel';

interface ProviderQuotaUsageViewProps extends SectionNavigationProps {
	provider: 'anthropic' | 'codex';
	theme: Theme;
}

export function ProviderQuotaUsageView({
	provider,
	theme,
	focusedSection,
	setSectionRef,
	handleSectionKeyDown,
}: ProviderQuotaUsageViewProps) {
	if (provider === 'anthropic') {
		return (
			<DashboardTabPanel viewMode="anthropic-usage">
				<DashboardSection
					sectionId="anthropic-usage"
					focusedSection={focusedSection}
					setSectionRef={setSectionRef}
					handleSectionKeyDown={handleSectionKeyDown}
					theme={theme}
				>
					<ChartErrorBoundary theme={theme} chartName="Anthropic Usage">
						<ClaudePlanUsage theme={theme} showAllAccounts autoRefresh={false} />
					</ChartErrorBoundary>
				</DashboardSection>
			</DashboardTabPanel>
		);
	}

	return (
		<DashboardTabPanel viewMode="codex-usage">
			<DashboardSection
				sectionId="codex-usage"
				focusedSection={focusedSection}
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
			>
				<ChartErrorBoundary theme={theme} chartName="OpenAI Usage">
					<CodexPlanUsage theme={theme} showAllAccounts autoRefresh={false} />
				</ChartErrorBoundary>
			</DashboardSection>
		</DashboardTabPanel>
	);
}
