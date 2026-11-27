/**
 * HostMediaSourceSection - the Whisper model folder that plugins using the
 * legacy `media.run` interface (Relay) transcribe with, drawn under Models >
 * Sources. It is a model source the Library does not manage: Maestro neither
 * downloads these files nor runs them through the Local Models pool, it only
 * points `whisper-cli` at the folder and reports what it finds there.
 */
import { useEffect, useState } from 'react';
import { AudioLines, Check, RefreshCw } from 'lucide-react';
import type { MediaToolStatus } from '../../../../../shared/plugins/media-tools';
import { useSettingsStore } from '../../../../stores/settingsStore';
import type { Theme } from '../../../../types';
import { FormInput } from '../../../ui/FormInput';
import { SettingsSectionHeading } from '../../SettingsSectionHeading';
import { SectionCard } from '../DisplayTab/components/SectionCard';
import { CardButton } from './CardButton';
import { CardWarning } from './CardParts';

export function HostMediaSourceSection({ theme }: { theme: Theme }) {
	const directory = useSettingsStore((s) => s.mediaModelDirectory);
	const setDirectory = useSettingsStore((s) => s.setMediaModelDirectory);
	const [draft, setDraft] = useState(directory);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState('');
	const [status, setStatus] = useState<MediaToolStatus | null>(null);
	const [statusError, setStatusError] = useState('');
	const [refresh, setRefresh] = useState(0);
	const supported = !!window.maestro?.settings?.getMediaStatus;

	useEffect(() => setDraft(directory), [directory]);
	useEffect(() => {
		if (!supported) return;
		let active = true;
		setStatus(null);
		setStatusError('');
		window.maestro.settings.getMediaStatus!().then(
			(value) => {
				if (active) setStatus(value);
			},
			() => {
				if (active) setStatusError('Could not read host media status. Try checking again.');
			}
		);
		return () => {
			active = false;
		};
	}, [directory, refresh, supported]);

	const save = async () => {
		if (saving) return;
		setSaving(true);
		setError('');
		try {
			if (!(await setDirectory(draft))) {
				setError(
					'Could not save. Use an absolute path to an existing local directory and check that Maestro can access it.'
				);
				return;
			}
			setDraft(useSettingsStore.getState().mediaModelDirectory);
			setRefresh((n) => n + 1);
		} catch {
			setError('Could not save the model directory. Please try again.');
		} finally {
			setSaving(false);
		}
	};

	return (
		<div data-setting-id="local-models-host-media">
			<SettingsSectionHeading
				icon={AudioLines}
				description="A folder of whisper.cpp models that plugins such as Relay transcribe audio with. Maestro does not download these files. Changes apply without restarting Maestro."
			>
				Whisper models
			</SettingsSectionHeading>
			<SectionCard theme={theme}>
				<FormInput
					id="host-media-directory"
					theme={theme}
					label="Whisper model directory"
					helperText="The local folder that holds multilingual ggml-<model>.bin files, such as ggml-base.bin. This setting takes precedence over MAESTRO_MEDIA_MODEL_DIR. Leave it empty to use that variable."
					value={draft}
					onChange={setDraft}
					onSubmit={() => void save()}
					submitEnabled={!saving && supported}
					disabled={saving || !supported}
					error={error}
					monospace
					placeholder="Absolute path to local Whisper models"
					testId="host-media-directory"
				/>
				<div className="flex flex-wrap gap-2">
					<CardButton
						theme={theme}
						icon={Check}
						label={saving ? 'Saving...' : 'Save directory'}
						onClick={() => void save()}
						disabled={saving || !supported}
						primary
						testId="host-media-save"
					/>
					<CardButton
						theme={theme}
						icon={RefreshCw}
						label="Check status"
						onClick={() => setRefresh((n) => n + 1)}
						disabled={saving || !supported}
						testId="host-media-check"
					/>
				</div>
				<div role="status" aria-live="polite" className="text-xs space-y-1 select-text">
					{!supported ? (
						<p>Host media status is available in the desktop app.</p>
					) : statusError ? (
						<CardWarning theme={theme}>{statusError}</CardWarning>
					) : status ? (
						<>
							<p className="font-medium">
								Host media status: {status.profiles.length ? 'Ready' : 'Unavailable'}
							</p>
							<p>Available profiles: {status.profiles.join(', ') || 'None'}</p>
							<p>Available models: {status.models.join(', ') || 'None'}</p>
							<p>Missing prerequisites: {status.missing.join(', ') || 'None'}</p>
						</>
					) : (
						<p>Checking host media status...</p>
					)}
				</div>
				<p className="text-xs opacity-70">
					The plugin must select an available model. If only base is listed, select base in Relay;
					small requires ggml-small.bin in this folder. Model-directory means no allowed, readable
					model file was found.
				</p>
			</SectionCard>
		</div>
	);
}
