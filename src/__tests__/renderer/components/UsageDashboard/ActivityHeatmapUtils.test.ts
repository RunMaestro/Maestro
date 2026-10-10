import { describe, expect, it } from 'vitest';
import { COLORBLIND_HEATMAP_SCALE } from '../../../../renderer/constants/colorblindPalettes';
import {
	calculateIntensity,
	getDaysForRange,
	getIntensityColor,
	shouldUse4HourBlockMode,
	shouldUseSingleDayMode,
	TIME_BLOCK_LABELS,
} from '../../../../renderer/components/UsageDashboard/activityHeatmapUtils';
import { THEMES } from '../../../../shared/themes';

const theme = THEMES.dracula;

describe('activityHeatmapUtils', () => {
	it('selects days and layout modes by range', () => {
		expect(getDaysForRange('day')).toBe(1);
		expect(getDaysForRange('week')).toBe(7);
		expect(getDaysForRange('month')).toBe(30);
		expect(getDaysForRange('quarter')).toBe(90);
		expect(getDaysForRange('year')).toBe(365);
		expect(getDaysForRange('all')).toBe(365);
		expect(shouldUseSingleDayMode('year')).toBe(true);
		expect(shouldUseSingleDayMode('all')).toBe(true);
		expect(shouldUseSingleDayMode('month')).toBe(false);
		expect(shouldUse4HourBlockMode('month')).toBe(true);
		expect(shouldUse4HourBlockMode('quarter')).toBe(true);
		expect(shouldUse4HourBlockMode('week')).toBe(false);
		expect(TIME_BLOCK_LABELS).toEqual(['12a-4a', '4a-8a', '8a-12p', '12p-4p', '4p-8p', '8p-12a']);
	});

	it('calculates heatmap intensity thresholds', () => {
		expect(calculateIntensity(0, 100)).toBe(0);
		expect(calculateIntensity(10, 100)).toBe(1);
		expect(calculateIntensity(50, 100)).toBe(2);
		expect(calculateIntensity(75, 100)).toBe(3);
		expect(calculateIntensity(76, 100)).toBe(4);
		expect(calculateIntensity(5, 0)).toBe(0);
	});

	it('returns theme, rgb, fallback, and colorblind colors', () => {
		expect(getIntensityColor(0, theme)).toBe(theme.colors.bgActivity);
		expect(getIntensityColor(2, theme)).toBe('rgba(189, 147, 249, 0.4)');
		expect(
			getIntensityColor(3, { ...theme, colors: { ...theme.colors, accent: 'rgb(1, 2, 3)' } })
		).toBe('rgba(1, 2, 3, 0.6)');
		expect(
			getIntensityColor(1, { ...theme, colors: { ...theme.colors, accent: 'var(--accent)' } })
		).toBe('var(--accent)4d');
		expect(getIntensityColor(99, theme, true)).toBe(COLORBLIND_HEATMAP_SCALE[4]);
	});
});
