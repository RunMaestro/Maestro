import { Puzzle } from 'lucide-react';
import { taskAssignmentPanel } from '../../../shared/local-models/settings-location';
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
		<div
			className="flex flex-col flex-1 min-h-0 min-w-0"
			data-setting-id={pluginSettingsId(panel.id)}
		>
			<SettingsSectionHeading icon={Puzzle} description={`Settings from ${panel.pluginId}.`}>
				<span className="min-w-0 truncate" title={panel.title}>
					{panel.title}
				</span>
			</SettingsSectionHeading>
			<SectionCard theme={theme} className="flex flex-col flex-1 min-h-0 gap-3 overflow-hidden">
				<div className="flex-1 min-h-0 min-w-0">
					<PluginPanelFrame panel={panel} theme={theme} />
				</div>
				{panel.hostSettings?.includes('dictation') && (
					<button
						type="button"
						className="w-full px-3 py-2 rounded border text-sm"
						style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
						onClick={() =>
							useModalStore.getState().openModal('settings', {
								tab: 'models',
								subTab: taskAssignmentPanel('dictation'),
								settingId: 'local-models-system-one',
							})
						}
					>
						Local Models Dictation
					</button>
				)}
				{panel.hostSettings?.includes('media') && (
					<button
						type="button"
						className="w-full shrink-0 px-3 py-2 rounded border text-sm"
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
