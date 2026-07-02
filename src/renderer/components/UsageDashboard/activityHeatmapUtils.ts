import type { StatsTimeRange } from '../../hooks/stats/useStats';
import type { Theme } from '../../types';
import { COLORBLIND_HEATMAP_SCALE } from '../../constants/colorblindPalettes';

export type MetricMode = 'count' | 'duration';

export const TIME_BLOCK_LABELS = ['12a-4a', '4a-8a', '8a-12p', '12p-4p', '4p-8p', '8p-12a'];

export function getDaysForRange(timeRange: StatsTimeRange): number {
	switch (timeRange) {
		case 'day':
			return 1;
		case 'week':
			return 7;
		case 'month':
			return 30;
		case 'quarter':
			return 90;
		case 'year':
			return 365;
		case 'all':
			return 365;
		default:
			return 7;
	}
}

export function shouldUseSingleDayMode(timeRange: StatsTimeRange): boolean {
	return timeRange === 'year' || timeRange === 'all';
}

export function shouldUse4HourBlockMode(timeRange: StatsTimeRange): boolean {
	return timeRange === 'month' || timeRange === 'quarter';
}

export function calculateIntensity(value: number, maxValue: number): number {
	if (value === 0) return 0;
	if (maxValue === 0) return 0;

	const ratio = value / maxValue;
	if (ratio <= 0.25) return 1;
	if (ratio <= 0.5) return 2;
	if (ratio <= 0.75) return 3;
	return 4;
}

export function getIntensityColor(
	intensity: number,
	theme: Theme,
	colorBlindMode?: boolean
): string {
	if (colorBlindMode) {
		const clampedIntensity = Math.max(0, Math.min(4, Math.round(intensity)));
		return COLORBLIND_HEATMAP_SCALE[clampedIntensity];
	}

	const accent = theme.colors.accent;
	const bgSecondary = theme.colors.bgActivity;
	let accentRgb: { r: number; g: number; b: number } | null = null;

	if (accent.startsWith('#')) {
		const hex = accent.slice(1);
		accentRgb = {
			r: parseInt(hex.slice(0, 2), 16),
			g: parseInt(hex.slice(2, 4), 16),
			b: parseInt(hex.slice(4, 6), 16),
		};
	} else if (accent.startsWith('rgb')) {
		const match = accent.match(/\d+/g);
		if (match && match.length >= 3) {
			accentRgb = {
				r: parseInt(match[0]),
				g: parseInt(match[1]),
				b: parseInt(match[2]),
			};
		}
	}

	if (!accentRgb) {
		const opacities = [0.1, 0.3, 0.5, 0.7, 1.0];
		return `${accent}${Math.round(opacities[intensity] * 255)
			.toString(16)
			.padStart(2, '0')}`;
	}

	switch (intensity) {
		case 0:
			return bgSecondary;
		case 1:
			return `rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0.2)`;
		case 2:
			return `rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0.4)`;
		case 3:
			return `rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0.6)`;
		case 4:
			return `rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0.9)`;
		default:
			return bgSecondary;
	}
}
