import { Puzzle } from 'lucide-react';
import type { PanelContribution } from '../../../shared/plugins/contributions';
import { pluginSettingsId } from '../../../shared/plugins/panel-host';
import type { Theme } from '../../types';
import { useModalStore } from '../../stores/modalStore';
import { PluginPanelFrame } from '../plugins/PluginPanelFrame';
import { SettingsSectionHeading } from './SettingsSectionHeading';
import { SectionCard } from './tabs/DisplayTab/components/SectionCard';

/** Executable content remains in the existing isolated guest; links belong to the host. */
export function PluginSettingsCard({ panel, theme }: { panel: PanelContribution; theme: Theme }) {
	return (
		<div data-setting-id={pluginSettingsId(panel.id)}>
			<SettingsSectionHeading icon={Puzzle} description={`Settings from ${panel.pluginId}`}>
				{panel.title}
			</SettingsSectionHeading>
			<SectionCard theme={theme}>
				<div className="h-[440px]">
					<PluginPanelFrame panel={panel} theme={theme} />
				</div>
				{panel.hostSettings?.includes('media') && (
					<button
						type="button"
						className="w-full px-3 py-2 rounded border text-sm"
						style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
						onClick={() =>
							useModalStore
								.getState()
								.openModal('settings', { tab: 'environment', settingId: 'environment-host-media' })
						}
					>
						Host media tools
					</button>
				)}
			</SectionCard>
		</div>
	);
}
