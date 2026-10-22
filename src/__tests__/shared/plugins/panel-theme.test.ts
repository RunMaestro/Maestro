import { describe, expect, it, vi } from 'vitest';
import { THEMES } from '../../../renderer/constants/themes';
import {
	applyPanelThemePayload,
	buildPanelThemePayload,
	PANEL_THEME_COLOR_TOKENS,
} from '../../../shared/plugins/panel-theme';
import type { Theme } from '../../../shared/theme-types';

describe('panel theme snapshot', () => {
	it('maps the exact public token list from light, dark, and custom palettes', () => {
		for (const theme of [THEMES['one-light'], THEMES.dracula]) {
			const payload = buildPanelThemePayload(theme);
			expect(Object.keys(payload.colors)).toEqual(Object.keys(PANEL_THEME_COLOR_TOKENS));
			for (const [token, key] of Object.entries(PANEL_THEME_COLOR_TOKENS)) {
				expect(payload.colors[token]).toBe(theme.colors[key as keyof typeof theme.colors]);
			}
			expect(payload.colorScheme).toBe(theme.mode);
		}
		const custom: Theme = {
			...THEMES.dracula,
			id: 'custom',
			mode: 'light',
			colors: { ...THEMES.dracula.colors, bgMain: 'rebeccapurple', accent: 'rgba(1, 2, 3, .5)' },
		};
		const payload = buildPanelThemePayload(custom);
		expect(payload.colors['--maestro-bg-main']).toBe('rebeccapurple');
		expect(payload.colors['--maestro-accent']).toBe('rgba(1, 2, 3, .5)');
		expect(payload.colorScheme).toBe('light');
	});

	it('drops malformed custom colors and uses dark controls for vibe themes', () => {
		const theme: Theme = {
			...THEMES.dracula,
			mode: 'vibe',
			colors: { ...THEMES.dracula.colors, accent: 'red; color: blue' },
		};
		const payload = buildPanelThemePayload(theme);
		expect(payload.colors['--maestro-accent']).toBeUndefined();
		expect(payload.colorScheme).toBe('dark');
	});

	it('accepts modern colors only when Chromium accepts them and refuses guest CSS references', () => {
		vi.stubGlobal('CSS', {
			supports: (_property: string, value: string) => value === 'oklch(60% 0.1 240)',
		});
		try {
			const theme: Theme = {
				...THEMES.dracula,
				colors: {
					...THEMES.dracula.colors,
					accent: 'oklch(60% 0.1 240)',
					border: 'rgb(1)',
					textDim: 'var(--guest-color)',
					success: 'color-mix(in srgb, currentColor, green)',
				},
			};
			const payload = buildPanelThemePayload(theme);
			expect(payload.colors['--maestro-accent']).toBe('oklch(60% 0.1 240)');
			expect(payload.colors['--maestro-border']).toBeUndefined();
			expect(payload.colors['--maestro-text-dim']).toBeUndefined();
			expect(payload.colors['--maestro-success']).toBeUndefined();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe('applyPanelThemePayload', () => {
	function styleTarget() {
		const values = new Map<string, string>();
		return {
			values,
			setProperty: (name: string, value: string) => values.set(name, value),
			removeProperty: (name: string) => values.delete(name),
		};
	}

	it('writes every checked token, the root background, and the color scheme', () => {
		const style = styleTarget();
		applyPanelThemePayload(style, {
			colorScheme: 'dark',
			colors: { '--maestro-bg-main': '#101010', '--maestro-accent': '#ff00ff' },
		});
		expect(style.values.get('--maestro-bg-main')).toBe('#101010');
		expect(style.values.get('--maestro-accent')).toBe('#ff00ff');
		expect(style.values.get('background-color')).toBe('#101010');
		expect(style.values.get('color-scheme')).toBe('dark');
	});

	it('clears a token a later payload leaves out or spells badly, and ignores unknown tokens', () => {
		const style = styleTarget();
		applyPanelThemePayload(style, {
			colorScheme: 'dark',
			colors: { '--maestro-bg-main': '#101010', '--maestro-accent': '#ff00ff' },
		});
		applyPanelThemePayload(style, {
			colorScheme: 'light',
			colors: { '--maestro-accent': 'red; background: url(x)', '--maestro-evil': 'red' },
		});
		expect(style.values.has('--maestro-bg-main')).toBe(false);
		expect(style.values.has('--maestro-accent')).toBe(false);
		expect(style.values.has('background-color')).toBe(false);
		expect(style.values.has('--maestro-evil')).toBe(false);
		expect(style.values.get('color-scheme')).toBe('light');
	});

	it('changes nothing for a payload that is not a theme payload', () => {
		const style = styleTarget();
		for (const payload of [
			null,
			'dark',
			{ colorScheme: 'vibe', colors: {} },
			{ colorScheme: 'dark', colors: null },
		]) {
			applyPanelThemePayload(style, payload);
		}
		expect(style.values.size).toBe(0);
	});
});
