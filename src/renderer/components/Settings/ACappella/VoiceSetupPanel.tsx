/** Microphone input and the link to voice model files. */

import { Mic } from 'lucide-react';

import type { Theme } from '../../../types';
import { SettingsSectionHeading } from '../SettingsSectionHeading';
import { SectionCard } from '../tabs/DisplayTab/components/SectionCard';
import { VoiceInputPicker, useVoiceInputDevices } from '../../ACappella';
import { useState } from 'react';
import { VoiceSetupModal } from './VoiceSetupModal';

export interface VoiceSetupPanelProps {
	theme: Theme;
	/** Mirror of the A Cappella Encore flag. */
	enabled: boolean;
}

export function VoiceSetupPanel({ theme, enabled }: VoiceSetupPanelProps) {
	// The same hook and the same persisted setting the HUD's quick picker writes,
	// so the two can never disagree about which microphone is chosen.
	const inputDevices = useVoiceInputDevices(enabled);
	const [setupOpen, setSetupOpen] = useState(false);

	return (
		<div data-setting-id="encore-a-cappella-voice-setup" className="select-none space-y-5">
			<div>
				<SettingsSectionHeading icon={Mic}>Microphone</SettingsSectionHeading>
				<SectionCard theme={theme}>
					{/* The microphone picker shares its setting with the HUD. */}
					<VoiceInputPicker theme={theme} devices={inputDevices} />

					<button
						type="button"
						data-setting-id="encore-a-cappella-models"
						onClick={() => setSetupOpen(true)}
						className="px-3 py-2 rounded border text-sm font-medium"
						style={{ borderColor: theme.colors.accent, color: theme.colors.textMain }}
					>
						Set up local voice
					</button>
				</SectionCard>
			</div>
			{setupOpen && (
				<VoiceSetupModal theme={theme} enabled={enabled} onClose={() => setSetupOpen(false)} />
			)}
		</div>
	);
}
