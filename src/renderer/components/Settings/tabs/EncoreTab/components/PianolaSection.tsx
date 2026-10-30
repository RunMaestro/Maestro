import { useState } from 'react';
import { Wrench } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { useSettingsStore } from '../../../../../stores/settingsStore';
import { notifyToast } from '../../../../../stores/notificationStore';
import { ipcErrorMessage } from '../../../../../utils/ipcErrorMessage';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { SectionCard } from '../../DisplayTab/components/SectionCard';
import { ToggleSettingRow } from '../../DisplayTab/components/ToggleSettingRow';

export function PianolaSection({ theme }: { theme: Theme }) {
	const [saving, setSaving] = useState(false);
	const enabled = useSettingsStore((s) => s.encoreFeatures.pianola);
	const autoFixEnabled = useSettingsStore((s) => s.pianolaAutoFixEnabled);
	const setAutoFixEnabled = useSettingsStore((s) => s.setPianolaAutoFixEnabled);
	const mode = !enabled ? 'Disabled' : autoFixEnabled ? 'Automatic repairs' : 'Supervision';

	return (
		<div data-setting-id="encore-pianola-auto-fix" className="space-y-3">
			<SettingsSectionHeading icon={Wrench} description={`Current mode: ${mode}.`}>
				Automatic repairs
			</SettingsSectionHeading>
			<SectionCard theme={theme}>
				<ToggleSettingRow
					theme={theme}
					title="Allow automatic repairs"
					description="Allow up to three repair attempts for orchestrated tasks that need review. Repair workers can change files within their existing access."
					checked={autoFixEnabled}
					disabled={saving || !enabled}
					onChange={(value) => {
						setSaving(true);
						void setAutoFixEnabled(value)
							.catch((error: unknown) =>
								notifyToast({
									color: 'red',
									title: 'Pianola',
									message: `Could not save repair permission: ${ipcErrorMessage(error)}`,
								})
							)
							.finally(() => setSaving(false));
					}}
					clickableRow
				/>
				<p className="text-xs opacity-70">
					Enabling Pianola, including its autopilot CLI alias, does not change this permission.
					Merging requires separate approval. Automatic merge is unavailable.
				</p>
			</SectionCard>
		</div>
	);
}
