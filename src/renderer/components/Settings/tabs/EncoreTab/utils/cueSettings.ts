import { DEFAULT_CUE_SETTINGS, type CueSettings } from '../../../../../../shared/cue';

export function mergeCueSettings(settings: Partial<CueSettings> | null | undefined): CueSettings {
	return {
		...DEFAULT_CUE_SETTINGS,
		...(settings && Object.keys(settings).length > 0 ? settings : {}),
	};
}

export function parseTimeoutMinutesInput(value: string): number {
	return Math.min(1440, Math.max(1, parseInt(value, 10) || 30));
}

export function parseMaxConcurrentInput(value: string): number {
	return Math.min(10, Math.max(1, parseInt(value, 10) || 1));
}

export function parseQueueSizeInput(value: string): number | null {
	const parsed = value === '' ? 0 : parseInt(value, 10);
	if (Number.isNaN(parsed)) return null;
	return Math.min(10000, Math.max(0, parsed));
}
