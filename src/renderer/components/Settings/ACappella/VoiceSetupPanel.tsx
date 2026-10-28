/** Microphone input and the link to voice model files. */

import { Mic } from 'lucide-react';

import type { Theme } from '../../../types';
import { SettingsSectionHeading } from '../SettingsSectionHeading';
import { SectionCard } from '../tabs/DisplayTab/components/SectionCard';
import { VoiceInputPicker, useVoiceInputDevices } from '../../ACappella';
import {
	modelsSettingsLocation,
	modelsSettingsSubTab,
} from '../../../../shared/local-models/settings-location';
import { getModalActions } from '../../../stores/modalStore';

export interface VoiceSetupPanelProps {
	theme: Theme;
	/** Mirror of the A Cappella Encore flag. */
	enabled: boolean;
}

export function VoiceSetupPanel({ theme, enabled }: VoiceSetupPanelProps) {
	// The same hook and the same persisted setting the HUD's quick picker writes,
	// so the two can never disagree about which microphone is chosen.
	const inputDevices = useVoiceInputDevices(enabled);

	return (
		<div data-setting-id="encore-a-cappella-voice-setup" className="select-none space-y-5">
			<div>
				<SettingsSectionHeading icon={Mic}>Microphone</SettingsSectionHeading>
				<SectionCard theme={theme}>
					<p className="text-xs opacity-70">
						Download, verify, and remove voice models in{' '}
						{modelsSettingsLocation('library', 'speech')}.
					</p>

					{/* The microphone picker shares its setting with the HUD. */}
					<VoiceInputPicker theme={theme} devices={inputDevices} />

					<button
						type="button"
						data-setting-id="encore-a-cappella-models"
						onClick={() =>
							getModalActions().openSettings(
								'models',
								undefined,
								modelsSettingsSubTab('library', 'speech')
							)
						}
						className="px-3 py-2 rounded border text-sm font-medium"
						style={{ borderColor: theme.colors.accent, color: theme.colors.textMain }}
					>
						Manage voice models
					</button>
				</SectionCard>
			</div>
		</div>
	);
}
