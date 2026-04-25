/**
 * useCueSettings — Global Cue engine settings loader and UI toggle.
 *
 * Fetches cue settings from the engine on mount. Exposes a `settingsLoaded`
 * flag that flips to true after the mount fetch resolves (success OR failure)
 * so consumers can gate write operations (e.g. handleSave) until settings are
 * known — prevents saving pipelines with stale default settings in the brief
 * window between modal open and settings arrival.
 */

import { useEffect, useState } from 'react';
import { cueService } from '../../services/cue';
import { DEFAULT_CUE_SETTINGS, type CueSettings } from '../../../shared/cue';
import { captureException } from '../../utils/sentry';

export interface UseCueSettingsReturn {
	cueSettings: CueSettings;
	setCueSettings: React.Dispatch<React.SetStateAction<CueSettings>>;
	/** True once the mount fetch has resolved (regardless of outcome). */
	settingsLoaded: boolean;
	showSettings: boolean;
	setShowSettings: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useCueSettings(): UseCueSettingsReturn {
	const [cueSettings, setCueSettings] = useState<CueSettings>({ ...DEFAULT_CUE_SETTINGS });
	const [settingsLoaded, setSettingsLoaded] = useState(false);
	const [showSettings, setShowSettings] = useState(false);

	useEffect(() => {
		let cancelled = false;
		cueService
			.getSettings()
			.then((settings) => {
				if (cancelled) return;
				setCueSettings(settings);
			})
			.catch((err: unknown) => {
				captureException(err, { extra: { operation: 'cue.getSettings' } });
			})
			.finally(() => {
				if (cancelled) return;
				setSettingsLoaded(true);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	return { cueSettings, setCueSettings, settingsLoaded, showSettings, setShowSettings };
}
