/**
 * Tests for XTerminal.tsx — mapThemeToXterm pure function.
 *
 * mapThemeToXterm converts a Maestro Theme into an xterm.js ITheme,
 * falling back to mode-appropriate ANSI palettes when the theme lacks
 * individual ANSI color fields.
 */

import { describe, it, expect } from 'vitest';
import { mapThemeToXterm } from '../../../renderer/components/XTerminal';
import type { Theme } from '../../../shared/theme-types';

function makeTheme(overrides: Partial<Theme['colors']> = {}, mode: Theme['mode'] = 'dark'): Theme {
	return {
		id: 'test',
		name: 'Test',
		mode,
		colors: {
			bgMain: '#1e1e1e',
			bgPanel: '#252526',
			bgInput: '#3c3c3c',
			textMain: '#d4d4d4',
			textMuted: '#858585',
			accent: '#569cd6',
			accentDim: '#264f78',
			border: '#3e3e42',
			...overrides,
		},
	} as unknown as Theme;
}

describe('mapThemeToXterm', () => {
	it('maps background, foreground, and cursor from theme colors', () => {
		const theme = makeTheme({ bgMain: '#1e1e1e', textMain: '#d4d4d4', accent: '#569cd6' });
		const result = mapThemeToXterm(theme);
		expect(result.background).toBe('#1e1e1e');
		expect(result.foreground).toBe('#d4d4d4');
		expect(result.cursor).toBe('#569cd6');
		expect(result.cursorAccent).toBe('#1e1e1e');
	});

	it('uses theme selectionBackground when selection color is provided', () => {
		const theme = makeTheme({ selection: '#3a3d41', accentDim: '#264f78' });
		const result = mapThemeToXterm(theme);
		expect(result.selectionBackground).toBe('#3a3d41');
	});

	it('falls back to accentDim for selectionBackground when selection is not set', () => {
		const theme = makeTheme({ accentDim: '#264f78' });
		// selection field not set
		const result = mapThemeToXterm(theme);
		expect(result.selectionBackground).toBe('#264f78');
	});

	it('uses provided ANSI colors when available on the theme', () => {
		const theme = makeTheme({
			ansiRed: '#ff0000',
			ansiGreen: '#00ff00',
			ansiBlue: '#0000ff',
		});
		const result = mapThemeToXterm(theme);
		expect(result.red).toBe('#ff0000');
		expect(result.green).toBe('#00ff00');
		expect(result.blue).toBe('#0000ff');
	});

	it('falls back to dark ANSI defaults when mode is dark and ANSI fields are absent', () => {
		const theme = makeTheme({}, 'dark');
		const result = mapThemeToXterm(theme);
		// One Dark-inspired dark defaults
		expect(result.red).toBe('#ff5555');
		expect(result.green).toBe('#50fa7b');
		expect(result.cyan).toBe('#8be9fd');
	});

	it('falls back to light ANSI defaults when mode is light and ANSI fields are absent', () => {
		const theme = makeTheme({}, 'light');
		const result = mapThemeToXterm(theme);
		// GitHub-inspired light defaults
		expect(result.red).toBe('#d73a49');
		expect(result.green).toBe('#22863a');
		expect(result.cyan).toBe('#0077aa');
	});

	it('mixes provided and default ANSI colors (provided takes precedence)', () => {
		const theme = makeTheme({ ansiRed: '#cc0000' }, 'dark');
		const result = mapThemeToXterm(theme);
		expect(result.red).toBe('#cc0000');
		// Other colors fall back to dark defaults
		expect(result.green).toBe('#50fa7b');
	});

	it('includes all 16 ANSI color fields in the output', () => {
		const theme = makeTheme();
		const result = mapThemeToXterm(theme);
		const fields = [
			'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
			'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
			'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
		];
		for (const field of fields) {
			expect(result).toHaveProperty(field);
			expect(typeof (result as Record<string, unknown>)[field]).toBe('string');
		}
	});
});
