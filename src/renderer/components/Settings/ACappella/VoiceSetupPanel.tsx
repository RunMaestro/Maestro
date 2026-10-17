/** Voice input and provider choices. Model files are managed in Settings > Models. */

import { Mic } from 'lucide-react';

import type { VoiceProviderRole } from '../../../../shared/acappella/providers';
import type { Theme } from '../../../types';
import { SettingsSectionHeading } from '../SettingsSectionHeading';
import { SectionCard } from '../tabs/DisplayTab/components/SectionCard';
import { ToggleButtonGroup } from '../../ToggleButtonGroup';
import { useVoiceModels } from './useVoiceModels';
import { VoiceInputPicker, useVoiceInputDevices } from '../../ACappella';
import {
	SLOT_DEFINITIONS,
	localModelIdForSlot,
	useVoiceProviderSelection,
	type VoiceSlotMode,
} from './useVoiceProviderSelection';
import {
	modelsSettingsLocation,
	modelsSettingsSubTab,
	taskAssignmentLocation,
} from '../../../../shared/local-models/settings-location';
import { getModalActions } from '../../../stores/modalStore';

export interface VoiceSetupPanelProps {
	theme: Theme;
	/** Mirror of the A Cappella Encore flag. */
	enabled: boolean;
}

const MODE_OPTIONS: Array<{ value: VoiceSlotMode; label: string }> = [
	{ value: 'local', label: 'Local' },
	{ value: 'cloud', label: 'Cloud' },
];

export function VoiceSetupPanel({ theme, enabled }: VoiceSetupPanelProps) {
	const models = useVoiceModels(enabled);
	// The same hook and the same persisted setting the HUD's quick picker writes,
	// so the two can never disagree about which microphone is chosen.
	const inputDevices = useVoiceInputDevices(enabled);
	const { modes, setMode, loaded, providerIds, brainSource } = useVoiceProviderSelection(enabled);
	/** One provider slot: the Local/Cloud choice and its selected model. */
	const renderSlot = (role: VoiceProviderRole) => {
		const slot = SLOT_DEFINITIONS.find((candidate) => candidate.slot === role)!;
		// A Brain on the `voice-routing` assignment uses that model's label.
		const assigned = role === 'brain' ? brainSource : null;
		const modelId = assigned
			? assigned.assignment.type === 'local'
				? assigned.assignment.modelId
				: undefined
			: localModelIdForSlot(slot, providerIds[role]);
		const listing = modelId
			? models.listings.find((candidate) => candidate.entry.id === modelId)
			: undefined;
		const Icon = slot.icon;
		return (
			<>
				<SettingsSectionHeading icon={Icon}>{slot.label}</SettingsSectionHeading>
				<SectionCard theme={theme}>
					<div>
						<div className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
							{slot.title}
						</div>
						<p className="text-xs opacity-70 mt-0.5 mb-2">{slot.description}</p>
						<ToggleButtonGroup
							options={MODE_OPTIONS}
							value={modes[role]}
							onChange={(next) => void setMode(role, next)}
							theme={theme}
						/>
						{modes[role] === 'cloud' && (
							<p className="text-xs-plus opacity-55 mt-2">
								A cloud provider needs its own API key and sends audio or text off this machine.
								Voice mode will refuse to start until the key is set; it never falls back to a
								provider you did not pick.
							</p>
						)}
					</div>

					{modes[role] === 'local' && listing && (
						<p className="text-xs opacity-70">{listing.entry.displayName}</p>
					)}
					{modes[role] === 'local' && assigned && (
						<p className="text-xs-plus opacity-55 select-text">
							Routes with {assigned.label}, the model assigned to Voice routing in{' '}
							{taskAssignmentLocation('voice-routing')}. Choose a different Conductor Brain in Voice
							Providers below.
						</p>
					)}
					{modes[role] === 'local' && !assigned && !modelId && slot.localNote && (
						<p className="text-xs-plus opacity-55">{slot.localNote}</p>
					)}
				</SectionCard>
			</>
		);
	};

	return (
		<div data-setting-id="encore-a-cappella-voice-setup" className="select-none space-y-5">
			<div>
				<SettingsSectionHeading icon={Mic}>Voice Setup</SettingsSectionHeading>
				<SectionCard theme={theme}>
					<p className="text-xs opacity-70">
						Download, verify, and remove voice models in{' '}
						{modelsSettingsLocation('library', 'speech')}.
					</p>

					{/* The microphone picker shares its setting with the HUD. */}
					<VoiceInputPicker theme={theme} devices={inputDevices} />

					{!loaded && <p className="text-xs opacity-55">Loading your selection...</p>}

					{models.error && (
						<p className="text-xs" style={{ color: theme.colors.error }}>
							{models.error}
						</p>
					)}

					{models.readiness && !models.readiness.canStartSession && (
						<div className="space-y-1" style={{ color: theme.colors.warning }}>
							{models.readiness.blocking.map((slot) => (
								<div key={slot.slot} className="text-xs">
									{slot.detail} {slot.suggestedAction}
								</div>
							))}
						</div>
					)}

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

			{/*
			 * The three wrappers are written out rather than mapped so each
			 * `data-setting-id` is a literal. `searchableSettings.test.ts` proves
			 * registry/DOM parity by scanning source text for the attribute, and an
			 * id computed from a variable is invisible to it - which would mean these
			 * sections silently stopped being findable in Settings search.
			 */}
			<div data-setting-id="encore-a-cappella-stt">{renderSlot('stt')}</div>
			<div data-setting-id="encore-a-cappella-tts">{renderSlot('tts')}</div>
			<div data-setting-id="encore-a-cappella-brain">{renderSlot('brain')}</div>
		</div>
	);
}
