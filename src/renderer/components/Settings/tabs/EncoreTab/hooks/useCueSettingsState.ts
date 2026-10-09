import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_CUE_SETTINGS, type CueSettings } from '../../../../../../shared/cue';
import { cueService } from '../../../../../services/cue';
import { captureException } from '../../../../../utils/sentry';
import { useDebouncedCallback } from '../../../../../hooks/utils/useThrottle';
import type { CueSettingsState } from '../types';
import {
	mergeCueSettings,
	parseMaxConcurrentInput,
	parseQueueSizeInput,
	parseTimeoutMinutesInput,
} from '../utils';

interface UseCueSettingsStateOptions {
	isOpen: boolean;
	maestroCueEnabled: boolean;
}

export function useCueSettingsState({
	isOpen,
	maestroCueEnabled,
}: UseCueSettingsStateOptions): CueSettingsState {
	const [cueSettings, setCueSettings] = useState<CueSettings>({ ...DEFAULT_CUE_SETTINGS });
	const [cueSettingsLoaded, setCueSettingsLoaded] = useState(false);
	const [cueSettingsSaveState, setCueSettingsSaveState] =
		useState<CueSettingsState['cueSettingsSaveState']>('idle');
	const [cueQueueSizeStr, setCueQueueSizeStr] = useState(String(DEFAULT_CUE_SETTINGS.queue_size));
	const pendingCueSettingsRef = useRef<CueSettings | null>(null);

	useEffect(() => {
		if (!isOpen || !maestroCueEnabled) return;
		let cancelled = false;
		cueService
			.getSettings()
			.then((settings) => {
				if (cancelled) return;
				const merged = mergeCueSettings(settings);
				setCueSettings(merged);
				setCueQueueSizeStr(String(merged.queue_size));
			})
			.finally(() => {
				if (!cancelled) setCueSettingsLoaded(true);
			});
		return () => {
			cancelled = true;
		};
	}, [isOpen, maestroCueEnabled]);

	const persistCueSettings = useCallback((next: CueSettings) => {
		setCueSettingsSaveState('saving');
		cueService
			.saveSettings(next)
			.then((result) => {
				setCueSettingsSaveState(result.writtenRoots.length === 0 ? 'no-targets' : 'saved');
			})
			.catch((err: unknown) => {
				setCueSettingsSaveState('error');
				captureException(err instanceof Error ? err : new Error(String(err)), {
					extra: { context: 'EncoreTab.saveCueSettings' },
				});
			});
	}, []);
	const persistDebouncedCueSettings = useCallback(
		(next: CueSettings) => {
			if (pendingCueSettingsRef.current === next) {
				pendingCueSettingsRef.current = null;
			}
			persistCueSettings(next);
		},
		[persistCueSettings]
	);
	const {
		debouncedCallback: debouncedPersistCueSettings,
		cancel: cancelDebouncedPersistCueSettings,
	} = useDebouncedCallback(persistDebouncedCueSettings as (...args: unknown[]) => void, 400);
	const flushPendingCueSettings = useCallback(() => {
		const pendingCueSettings = pendingCueSettingsRef.current;
		if (!pendingCueSettings) return;
		pendingCueSettingsRef.current = null;
		cancelDebouncedPersistCueSettings();
		persistCueSettings(pendingCueSettings);
	}, [cancelDebouncedPersistCueSettings, persistCueSettings]);

	useEffect(() => {
		if (isOpen && maestroCueEnabled) return;
		flushPendingCueSettings();
	}, [flushPendingCueSettings, isOpen, maestroCueEnabled]);

	useEffect(() => {
		return () => {
			flushPendingCueSettings();
		};
	}, [flushPendingCueSettings]);

	const updateCueSettings = useCallback(
		(patch: Partial<CueSettings>) => {
			setCueSettings((prev) => {
				const next = { ...prev, ...patch };
				pendingCueSettingsRef.current = next;
				debouncedPersistCueSettings(next);
				return next;
			});
		},
		[debouncedPersistCueSettings]
	);

	const handleTimeoutMinutesChange = (value: string) => {
		updateCueSettings({ timeout_minutes: parseTimeoutMinutesInput(value) });
	};

	const handleTimeoutOnFailChange = (value: CueSettings['timeout_on_fail']) => {
		updateCueSettings({ timeout_on_fail: value });
	};

	const handleMaxConcurrentChange = (value: string) => {
		updateCueSettings({ max_concurrent: parseMaxConcurrentInput(value) });
	};

	const handleQueueSizeChange = (value: string) => {
		setCueQueueSizeStr(value);
		const queueSize = parseQueueSizeInput(value);
		if (queueSize !== null) {
			updateCueSettings({ queue_size: queueSize });
		}
	};

	const handleQueueSizeBlur = () => {
		setCueQueueSizeStr(String(cueSettings.queue_size));
	};

	return {
		cueSettings,
		cueSettingsLoaded,
		cueSettingsSaveState,
		cueQueueSizeStr,
		updateCueSettings,
		handleTimeoutMinutesChange,
		handleTimeoutOnFailChange,
		handleMaxConcurrentChange,
		handleQueueSizeChange,
		handleQueueSizeBlur,
	};
}
