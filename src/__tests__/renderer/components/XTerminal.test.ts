/**
 * Tests for XTerminal.tsx — mapThemeToXterm and evaluateCustomKeyEvent pure functions.
 *
 * mapThemeToXterm converts a Maestro Theme into an xterm.js ITheme,
 * falling back to mode-appropriate ANSI palettes when the theme lacks
 * individual ANSI color fields.
 *
 * evaluateCustomKeyEvent determines whether xterm should handle a key
 * or pass it through to Maestro's shortcut handler.
 */

import { describe, it, expect } from 'vitest';
import { mapThemeToXterm, evaluateCustomKeyEvent } from '../../../renderer/components/XTerminal';
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
			'black',
			'red',
			'green',
			'yellow',
			'blue',
			'magenta',
			'cyan',
			'white',
			'brightBlack',
			'brightRed',
			'brightGreen',
			'brightYellow',
			'brightBlue',
			'brightMagenta',
			'brightCyan',
			'brightWhite',
		];
		for (const field of fields) {
			expect(result).toHaveProperty(field);
			expect(typeof (result as Record<string, unknown>)[field]).toBe('string');
		}
	});
});

// ============================================================================
// evaluateCustomKeyEvent tests
// ============================================================================

function makeKeyEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
	return {
		key: '',
		code: '',
		type: 'keydown',
		ctrlKey: false,
		shiftKey: false,
		metaKey: false,
		altKey: false,
		...overrides,
	} as KeyboardEvent;
}

describe('evaluateCustomKeyEvent', () => {
	it('returns "handle" for Escape keydown (xterm sends \\x1b via onData)', () => {
		const e = makeKeyEvent({ key: 'Escape', type: 'keydown' });
		expect(evaluateCustomKeyEvent(e)).toBe('handle');
	});

	it('returns "handle" for Escape keyup', () => {
		const e = makeKeyEvent({ key: 'Escape', type: 'keyup' });
		expect(evaluateCustomKeyEvent(e)).toBe('handle');
	});

	it('returns "passthrough" for Meta (Cmd) combos', () => {
		const e = makeKeyEvent({ key: 'k', metaKey: true });
		expect(evaluateCustomKeyEvent(e)).toBe('passthrough');
	});

	it('returns "passthrough" for Ctrl+Shift combos', () => {
		const e = makeKeyEvent({ key: 'A', ctrlKey: true, shiftKey: true });
		expect(evaluateCustomKeyEvent(e)).toBe('passthrough');
	});

	it('returns "passthrough" for Ctrl+Shift+` (new terminal tab)', () => {
		const e = makeKeyEvent({ ctrlKey: true, shiftKey: true, code: 'Backquote' });
		expect(evaluateCustomKeyEvent(e)).toBe('passthrough');
	});

	it('returns "passthrough" for Alt combos (non-navigation)', () => {
		const e = makeKeyEvent({ key: 'q', altKey: true });
		expect(evaluateCustomKeyEvent(e)).toBe('passthrough');
	});

	// Terminal navigation: Option+Arrow → word jump
	it('returns write action with ESC b for Option+Left (word back)', () => {
		const e = makeKeyEvent({ key: 'ArrowLeft', altKey: true, type: 'keydown' });
		expect(evaluateCustomKeyEvent(e)).toEqual({ action: 'write', data: '\x1bb' });
	});

	it('returns write action with ESC f for Option+Right (word forward)', () => {
		const e = makeKeyEvent({ key: 'ArrowRight', altKey: true, type: 'keydown' });
		expect(evaluateCustomKeyEvent(e)).toEqual({ action: 'write', data: '\x1bf' });
	});

	it('returns write action with ESC DEL for Option+Backspace (kill word)', () => {
		const e = makeKeyEvent({ key: 'Backspace', altKey: true, type: 'keydown' });
		expect(evaluateCustomKeyEvent(e)).toEqual({ action: 'write', data: '\x1b\x7f' });
	});

	// Terminal navigation: Cmd+Arrow → line jump
	it('returns write action with Ctrl-A for Cmd+Left (beginning of line)', () => {
		const e = makeKeyEvent({ key: 'ArrowLeft', metaKey: true, type: 'keydown' });
		expect(evaluateCustomKeyEvent(e)).toEqual({ action: 'write', data: '\x01' });
	});

	it('returns write action with Ctrl-E for Cmd+Right (end of line)', () => {
		const e = makeKeyEvent({ key: 'ArrowRight', metaKey: true, type: 'keydown' });
		expect(evaluateCustomKeyEvent(e)).toEqual({ action: 'write', data: '\x05' });
	});

	// Navigation keys on keyup should not fire (only keydown)
	it('returns passthrough for Option+Arrow on keyup', () => {
		const e = makeKeyEvent({ key: 'ArrowLeft', altKey: true, type: 'keyup' });
		expect(evaluateCustomKeyEvent(e)).toBe('passthrough');
	});

	it('returns passthrough for Cmd+Arrow on keyup', () => {
		const e = makeKeyEvent({ key: 'ArrowLeft', metaKey: true, type: 'keyup' });
		expect(evaluateCustomKeyEvent(e)).toBe('passthrough');
	});

	it('returns "handle" for regular character keys', () => {
		const e = makeKeyEvent({ key: 'a' });
		expect(evaluateCustomKeyEvent(e)).toBe('handle');
	});

	it('returns "handle" for Enter', () => {
		const e = makeKeyEvent({ key: 'Enter' });
		expect(evaluateCustomKeyEvent(e)).toBe('handle');
	});

	it('returns "handle" for Ctrl+C (terminal interrupt)', () => {
		const e = makeKeyEvent({ key: 'c', ctrlKey: true });
		expect(evaluateCustomKeyEvent(e)).toBe('handle');
	});
});
