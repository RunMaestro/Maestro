/** Native local speech source, kept separate from text model endpoints. */
import { useEffect, useState } from 'react';
import { Check, Plug, Volume2 } from 'lucide-react';
import {
	readVoiceStudioConfig,
	voiceStudioConfigProblem,
	normalizeVoiceStudioConfig,
	type VoiceStudioStatus,
} from '../../../../../shared/acappella/voice-studio';
import { resolveEncoreFeatures } from '../../../../../shared/encoreFeatureDefaults';
import {
	patchVoiceSettingsSection,
	readVoiceSettingsBlob,
} from '../../../../services/voiceSettings';
import type { Theme } from '../../../../types';
import { FormInput } from '../../../ui/FormInput';
import { SettingsSectionHeading } from '../../SettingsSectionHeading';
import { SectionCard } from '../DisplayTab/components/SectionCard';
import { CardButton } from './CardButton';
import { CardWarning } from './CardParts';

export function VoiceStudioSourceSection({ theme }: { theme: Theme }) {
	const [config, setConfig] = useState(() => readVoiceStudioConfig(undefined));
	const [seed, setSeed] = useState(String(config.seed));
	const [loaded, setLoaded] = useState(false);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [status, setStatus] = useState<VoiceStudioStatus | null>(null);
	useEffect(() => {
		let alive = true;
		void readVoiceSettingsBlob()
			.then((stored) => {
				if (!alive) return;
				const current = readVoiceStudioConfig(stored.voiceStudio);
				setConfig(current);
				setSeed(String(current.seed));
				setLoaded(true);
			})
			.catch(() => {
				if (alive) setError('Could not read the VoiceStudio source settings.');
			});
		return () => {
			alive = false;
		};
	}, []);
	const draft = { ...config, seed: seed.trim() === '' ? Number.NaN : Number(seed) };
	const problem = voiceStudioConfigProblem(draft);
	const change = (field: 'baseUrl' | 'engine', value: string) => {
		setConfig((current) => ({ ...current, [field]: value }));
		setStatus(null);
		setMessage(null);
		setError(null);
	};
	const run = async (save: boolean) => {
		if (problem) {
			setError(problem);
			return;
		}
		setBusy(true);
		setError(null);
		setMessage(null);
		setStatus(null);
		try {
			const normalized = normalizeVoiceStudioConfig(draft);
			if (save) {
				await patchVoiceSettingsSection('voiceStudio', normalized);
				setConfig(normalized);
				const features = resolveEncoreFeatures(await window.maestro.settings.get('encoreFeatures'));
				if (features.aCappella) {
					const result = await window.maestro.voice.applyProviders();
					setMessage(
						result.status === 'refused'
							? 'Saved. End the current voice session to apply these settings.'
							: 'Saved. Select VoiceStudio in A Cappella > Voice Providers, then choose a profile in Voice Output.'
					);
				} else
					setMessage(
						'Saved. Select VoiceStudio in A Cappella > Voice Providers, then choose a profile in Voice Output.'
					);
			} else setStatus(await window.maestro.voice.voiceStudioStatus(normalized));
		} catch {
			setError(
				save
					? 'Could not apply the VoiceStudio source settings.'
					: 'Could not check VoiceStudio. Start the local service and try again.'
			);
		} finally {
			setBusy(false);
		}
	};
	return (
		<div data-setting-id="local-models-voice-studio">
			<SettingsSectionHeading
				icon={Volume2}
				description="Cloned voices from VoiceStudio running on this computer. Choose VoiceStudio as the A Cappella Text-to-Speech provider to use them."
			>
				VoiceStudio
			</SettingsSectionHeading>
			<SectionCard theme={theme}>
				<FormInput
					theme={theme}
					label="Local service URL"
					value={config.baseUrl}
					onChange={(value) => change('baseUrl', value)}
					disabled={!loaded || busy}
					monospace
					testId="voice-studio-url"
				/>
				<FormInput
					theme={theme}
					label="Speech engine"
					value={config.engine}
					onChange={(value) => change('engine', value)}
					helperText="Use the engine id installed in VoiceStudio, such as voxcpm2 or omnivoice."
					disabled={!loaded || busy}
					testId="voice-studio-engine"
				/>
				<FormInput
					theme={theme}
					label="Sampling seed"
					value={seed}
					onChange={(value) => {
						setSeed(value);
						setStatus(null);
						setMessage(null);
						setError(null);
					}}
					helperText="Keeps the voice repeatable. Use the seed chosen with your voice profile."
					disabled={!loaded || busy}
					testId="voice-studio-seed"
				/>
				<div className="flex flex-wrap gap-2">
					<CardButton
						theme={theme}
						icon={Check}
						label="Save source"
						onClick={() => void run(true)}
						disabled={!loaded || busy}
						primary
						testId="voice-studio-save"
					/>
					<CardButton
						theme={theme}
						icon={Plug}
						label={busy ? 'Working...' : 'Check connection'}
						onClick={() => void run(false)}
						disabled={!loaded || busy}
						testId="voice-studio-check"
					/>
				</div>
				{status?.connected && (
					<p className="text-xs opacity-70 select-text" role="status">
						Connected{status.version ? ` to VoiceStudio ${status.version}` : ''}.{' '}
						{status.profiles.length
							? `Profiles: ${status.profiles.map(({ name }) => name).join(', ')}.`
							: 'No voice profiles available. Create a profile in VoiceStudio.'}
					</p>
				)}
				{status && !status.connected && <CardWarning theme={theme}>{status.message}</CardWarning>}
				{message && (
					<p className="text-xs opacity-70" role="status">
						{message}
					</p>
				)}
				{error && <CardWarning theme={theme}>{error}</CardWarning>}
			</SectionCard>
		</div>
	);
}
