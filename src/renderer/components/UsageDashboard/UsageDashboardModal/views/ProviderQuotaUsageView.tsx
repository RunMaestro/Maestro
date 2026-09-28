import { useMemo, type ComponentType } from 'react';
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
	/**
	 * Open the Agents grid narrowed to one account. Curried with this view's own
	 * provider id, since a quota row only ever names an account within it.
	 */
	onShowAccountAgents?: (toolType: string, accountKey: string) => void;
}

interface ProviderUsageComponentProps {
	theme: Theme;
	showAllAccounts?: boolean;
	autoRefresh?: boolean;
	refreshHotkey?: boolean;
	onShowAccountAgents?: (accountKey: string) => void;
}

const PROVIDER_CONFIG: Record<
	ProviderQuotaUsageViewProps['provider'],
	{
		viewMode: 'anthropic-usage' | 'codex-usage';
		sectionId: SectionId;
		chartName: string;
		/** Agent `toolType` these quota rows describe, for the account filter. */
		toolType: string;
		Component: ComponentType<ProviderUsageComponentProps>;
	}
> = {
	anthropic: {
		viewMode: 'anthropic-usage',
		sectionId: 'anthropic-usage',
		chartName: 'Anthropic Usage',
		toolType: 'claude-code',
		Component: ClaudePlanUsage,
	},
	codex: {
		viewMode: 'codex-usage',
		sectionId: 'codex-usage',
		chartName: 'OpenAI Usage',
		toolType: 'codex',
		Component: CodexPlanUsage,
	},
};

export function ProviderQuotaUsageView({
	provider,
	theme,
	focusedSection,
	setSectionRef,
	handleSectionKeyDown,
	onShowAccountAgents,
}: ProviderQuotaUsageViewProps) {
	const { viewMode, sectionId, chartName, toolType, Component } = PROVIDER_CONFIG[provider];
	const showAccountAgents = useMemo(
		() =>
			onShowAccountAgents
				? (accountKey: string) => onShowAccountAgents(toolType, accountKey)
				: undefined,
		[onShowAccountAgents, toolType]
	);

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
					{/*
					 * `refreshHotkey` claims Cmd/Ctrl+R for this panel's Refresh. It is
					 * opt-in rather than automatic because only the panel the user is
					 * LOOKING at may answer the chord, and this view renders exactly one
					 * provider at a time - which is what makes the claim unambiguous here.
					 */}
					<Component
						theme={theme}
						showAllAccounts
						autoRefresh={false}
						refreshHotkey
						onShowAccountAgents={showAccountAgents}
					/>
				</ChartErrorBoundary>
			</DashboardSection>
		</DashboardTabPanel>
	);
}
