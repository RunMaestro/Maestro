import { humanizeDuration, DURATION_LADDER_DAYS } from '../../../../shared/duration';

const MIN_TIME = 1000;
const MAX_TIME = 315360000000;
const LOG_MIN = Math.log(MIN_TIME);
const LOG_MAX = Math.log(MAX_TIME);

/**
 * Format a badge-preview duration, e.g. "45s", "5m 30s", "2h 15m", "3d 2h".
 * Day-capped and zero-padded so the preview label holds a steady width as the
 * playground slider sweeps across the whole range.
 */
export function formatPlaygroundDuration(ms: number): string {
	return humanizeDuration(ms, { units: DURATION_LADDER_DAYS, keepZeroUnits: true });
}

export function sliderToTime(sliderValue: number): number {
	if (sliderValue === 0) return 0;
	const logValue = LOG_MIN + (sliderValue / 100) * (LOG_MAX - LOG_MIN);
	return Math.round(Math.exp(logValue));
}

export function timeToSlider(timeMs: number): number {
	if (timeMs <= 0) return 0;
	if (timeMs < MIN_TIME) return 0;
	const logValue = Math.log(timeMs);
	return Math.round(((logValue - LOG_MIN) / (LOG_MAX - LOG_MIN)) * 100);
}
