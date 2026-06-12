const MIN_TIME = 1000;
const MAX_TIME = 315360000000;
const LOG_MIN = Math.log(MIN_TIME);
const LOG_MAX = Math.log(MAX_TIME);

export function formatPlaygroundDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (days > 0) return `${days}d ${hours % 24}h`;
	if (hours > 0) return `${hours}h ${minutes % 60}m`;
	if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
	return `${seconds}s`;
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
