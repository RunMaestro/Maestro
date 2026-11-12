import { DISPLAY_SECTIONS } from './sections';
import type { DisplayTabProps } from './types';
import { PluginPanelSlot } from '../../../plugins/PluginPanelSlot';
import { PluginUiItemsSlot } from '../../../plugins/PluginUiItemsSlot';

export type { DisplayTabProps } from './types';

export function DisplayTab({ theme, isOpen }: DisplayTabProps) {
	return (
		<div className="space-y-5">
			{DISPLAY_SECTIONS.map(({ key, Component }) => (
				<Component key={key} theme={theme} isOpen={isOpen} />
			))}

			{/* This neutral display-settings slot is deliberately outside plugin
			    management, consent, uninstall, and grant/revoke flows. */}
			<PluginUiItemsSlot surface="settingsSection" className="rounded-lg border p-3" />
			<PluginPanelSlot
				theme={theme}
				placement="settings"
				className="flex flex-col overflow-hidden rounded-lg border h-[440px]"
			/>
		</div>
	);
}
