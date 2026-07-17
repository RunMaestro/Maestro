import { describe, it, expect } from 'vitest';
import { pluginThemeToTheme } from '../../../shared/plugins/theme-bridge';
import type { ThemeColors } from '../../../shared/theme-types';
import type { ThemeContribution } from '../../../shared/plugins/contributions';

const baseDark: ThemeColors = {
	bgMain: '#1e1e1e',
	bgSidebar: '#252526',
	bgActivity: '#333333',
	border: '#444444',
	textMain: '#eeeeee',
	textDim: '#999999',
	accent: '#0a84ff',
	accentDim: '#0a84ff55',
	accentText: '#0a84ff',
	accentForeground: '#ffffff',
	success: '#30d158',
	warning: '#ffd60a',
	error: '#ff453a',
};

const baseLight: ThemeColors = {
	...baseDark,
	bgMain: '#ffffff',
	textMain: '#111111',
};

function contribution(overrides: Partial<ThemeContribution> = {}): ThemeContribution {
	return {
		id: 'com.acme/midnight',
		localId: 'midnight',
		pluginId: 'com.acme',
		name: 'Midnight',
		mode: 'dark',
		colors: { accent: '#ff00ff' },
		...overrides,
	};
}

describe('pluginThemeToTheme', () => {
	it('overlays contributed colors onto the base palette', () => {
		const theme = pluginThemeToTheme(contribution(), baseDark);
		expect(theme.id).toBe('com.acme/midnight');
		expect(theme.name).toBe('Midnight');
		expect(theme.mode).toBe('dark');
		// overridden
		expect(theme.colors.accent).toBe('#ff00ff');
		// inherited from base for keys the plugin omitted
		expect(theme.colors.bgMain).toBe('#1e1e1e');
		expect(theme.colors.textMain).toBe('#eeeeee');
	});

	it('ignores unrecognized color keys', () => {
		const theme = pluginThemeToTheme(
			contribution({ colors: { accent: '#abc', notARealKey: '#zzz', __proto__: 'x' } }),
			baseDark
		);
		expect(theme.colors.accent).toBe('#abc');
		expect((theme.colors as unknown as Record<string, string>).notARealKey).toBeUndefined();
		// prototype pollution attempt does not land on the palette
		expect(Object.prototype.hasOwnProperty.call(theme.colors, '__proto__')).toBe(false);
	});

	it('does not mutate the base palette', () => {
		const snapshot = { ...baseDark };
		pluginThemeToTheme(contribution({ colors: { bgMain: '#000000' } }), baseDark);
		expect(baseDark).toEqual(snapshot);
	});

	it('accepts optional ANSI and selection keys', () => {
		const theme = pluginThemeToTheme(
			contribution({ colors: { ansiRed: '#f00', selection: '#0ff' } }),
			baseDark
		);
		expect(theme.colors.ansiRed).toBe('#f00');
		expect(theme.colors.selection).toBe('#0ff');
	});
});

describe('pluginThemeToTheme base selection', () => {
	it('builds dark and light themes from their intended base palettes', () => {
		const darkTheme = pluginThemeToTheme(
			contribution({ id: 'com.a/dark1', localId: 'dark1', mode: 'dark', colors: {} }),
			baseDark
		);
		const lightTheme = pluginThemeToTheme(
			contribution({ id: 'com.a/light1', localId: 'light1', mode: 'light', colors: {} }),
			baseLight
		);

		expect(darkTheme.id).toBe('com.a/dark1');
		expect(darkTheme.colors.bgMain).toBe('#1e1e1e');
		expect(lightTheme.id).toBe('com.a/light1');
		expect(lightTheme.colors.bgMain).toBe('#ffffff');
	});
});
