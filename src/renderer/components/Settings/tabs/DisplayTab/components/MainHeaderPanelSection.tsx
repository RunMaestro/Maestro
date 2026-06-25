import { PanelTop } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { SectionCard } from './SectionCard';
import { ToggleSettingRow } from './ToggleSettingRow';

interface MainHeaderPanelSectionProps {
	theme: Theme;
	showAgentName: boolean;
	setShowAgentName: (enabled: boolean) => void;
	showSessionIdPill: boolean;
	setShowSessionIdPill: (enabled: boolean) => void;
	showSessionCostPill: boolean;
	setShowSessionCostPill: (enabled: boolean) => void;
}

export function MainHeaderPanelSection({
	theme,
	showAgentName,
	setShowAgentName,
	showSessionIdPill,
	setShowSessionIdPill,
	showSessionCostPill,
	setShowSessionCostPill,
}: MainHeaderPanelSectionProps) {
	return (
		<div data-setting-id="display-main-header-panel">
			<SettingsSectionHeading icon={PanelTop}>Main Header Panel</SettingsSectionHeading>
			<SectionCard theme={theme}>
				<ToggleSettingRow
					theme={theme}
					title="Show agent name"
					description="Display the agent name in the main header."
					checked={showAgentName}
					onChange={setShowAgentName}
					ariaLabel="Show agent name"
				/>
				<ToggleSettingRow
					theme={theme}
					title="Show session ID pill"
					description={
						<>
							Display the provider session ID pill (short hash, e.g. &quot;B778BF42&quot;) in the
							main header. Click the pill to copy the full ID.
						</>
					}
					checked={showSessionIdPill}
					onChange={setShowSessionIdPill}
					ariaLabel="Show session ID pill"
					borderTop
				/>
				<ToggleSettingRow
					theme={theme}
					title="Show session cost pill"
					description={
						<>Display the per-session running cost (e.g. &quot;$21.33&quot;) in the main header.</>
					}
					checked={showSessionCostPill}
					onChange={setShowSessionCostPill}
					ariaLabel="Show session cost pill"
					borderTop
				/>
			</SectionCard>
		</div>
	);
}
