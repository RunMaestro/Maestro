import { useEffect, useState } from 'react';
import { AudioLines } from 'lucide-react';
import type { MediaToolStatus } from '../../../shared/plugins/media-tools';
import { useSettingsStore } from '../../stores/settingsStore';
import type { Theme } from '../../types';
import { FormInput } from '../ui/FormInput';
import { SettingsSectionHeading } from './SettingsSectionHeading';
import { SectionCard } from './tabs/DisplayTab/components/SectionCard';

export function HostMediaSection({ theme }: { theme: Theme }) {
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
		<div data-setting-id="environment-host-media">
			<SettingsSectionHeading
				icon={AudioLines}
				description="Local speech recognition tools used by plugins such as Relay. Changes apply without restarting Maestro."
			>
				Host media tools
			</SettingsSectionHeading>
			<SectionCard theme={theme}>
				<div>
					<label htmlFor="host-media-directory" className="font-medium">
						Whisper model directory
					</label>
					<p className="text-xs opacity-70 mt-0.5 mb-2">
						Choose the local folder containing multilingual ggml-&lt;model&gt;.bin files, such as
						ggml-base.bin. This host setting takes precedence over MAESTRO_MEDIA_MODEL_DIR. Leave it
						empty to use that environment fallback.
					</p>
					<FormInput
						id="host-media-directory"
						theme={theme}
						value={draft}
						onChange={setDraft}
						onSubmit={() => void save()}
						submitEnabled={!saving && supported}
						disabled={saving || !supported}
						error={error}
						placeholder="Absolute path to local Whisper models"
					/>
				</div>
				<button
					type="button"
					disabled={saving || !supported}
					onClick={() => void save()}
					className="w-full px-3 py-2 rounded border text-sm disabled:opacity-55"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
				>
					{saving ? 'Saving...' : 'Save directory'}
				</button>
				<div role="status" aria-live="polite" className="text-xs space-y-1">
					{!supported ? (
						<p>Host media status is available in the desktop app.</p>
					) : statusError ? (
						<p style={{ color: theme.colors.error }}>{statusError}</p>
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
					model file was found. Tools and models are not downloaded by this setting.
				</p>
				<button
					type="button"
					disabled={!supported || saving}
					onClick={() => setRefresh((n) => n + 1)}
					className="w-full px-3 py-2 rounded border text-sm disabled:opacity-55"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
				>
					Check status
				</button>
			</SectionCard>
		</div>
	);
}
