import { describe, expect, it, vi } from 'vitest';
import { THEMES } from '../../../renderer/constants/themes';
import {
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
