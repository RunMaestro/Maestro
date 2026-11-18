import { DISPLAY_SECTIONS } from './sections';
import type { DisplayTabProps } from './types';
import { PluginUiItemsSlot } from '../../../plugins/PluginUiItemsSlot';

export type { DisplayTabProps } from './types';

export function DisplayTab({ theme, isOpen }: DisplayTabProps) {
	return (
		<div className="space-y-5">
			{DISPLAY_SECTIONS.map(({ key, Component }) => (
				<Component key={key} theme={theme} isOpen={isOpen} />
			))}

			<PluginUiItemsSlot surface="settingsSection" className="rounded-lg border p-3" />
		</div>
	);
}
