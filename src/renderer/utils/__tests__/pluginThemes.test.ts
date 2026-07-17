import { describe, expect, it } from 'vitest';
import type { ThemeContribution } from '../../../shared/plugins/contributions';
import { THEMES } from '../../constants/themes';
import { mergePluginThemes, resolvePluginTheme } from '../pluginThemes';

function contribution(overrides: Partial<ThemeContribution> = {}): ThemeContribution {
	return {
		id: 'com.acme/midnight',
		localId: 'midnight',
		pluginId: 'com.acme',
		name: 'Midnight',
		mode: 'dark',
		colors: {},
		...overrides,
	};
}

describe('resolvePluginTheme', () => {
	it('uses the mode-matched built-in palette for omitted colors', () => {
		const darkTheme = resolvePluginTheme(contribution());
		const lightTheme = resolvePluginTheme(
			contribution({ id: 'com.acme/daylight', localId: 'daylight', mode: 'light' })
		);

		expect(darkTheme.colors.bgMain).toBe(THEMES.dracula.colors.bgMain);
		expect(lightTheme.colors.bgMain).toBe(THEMES['github-light'].colors.bgMain);
	});
});

describe('mergePluginThemes', () => {
	it('returns no themes when both built-ins and contributions are empty', () => {
		expect(mergePluginThemes({}, [])).toEqual({});
	});

	it('keys contributed themes by namespaced id', () => {
		const themes = mergePluginThemes({}, [
			contribution({ id: 'com.a/dark1', localId: 'dark1' }),
			contribution({ id: 'com.a/light1', localId: 'light1', mode: 'light' }),
		]);

		expect(Object.keys(themes).sort()).toEqual(['com.a/dark1', 'com.a/light1']);
		expect(themes['com.a/dark1'].colors.bgMain).toBe(THEMES.dracula.colors.bgMain);
		expect(themes['com.a/light1'].colors.bgMain).toBe(THEMES['github-light'].colors.bgMain);
	});
});
