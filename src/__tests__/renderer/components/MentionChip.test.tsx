import { describe, it, expect } from 'vitest';
import { getMentionChipColors } from '../../../renderer/components/MentionChip';
import type { Theme } from '../../../renderer/types';

function makeTheme(overrides: Partial<Theme['colors']> = {}): Theme {
	return {
		id: 'dracula',
		name: 'Test',
		mode: 'dark',
		colors: {
			bgMain: '#111111',
			bgSidebar: '#0a0a0a',
			bgActivity: '#161616',
			border: '#333333',
			textMain: '#eeeeee',
			textDim: '#888888',
			accent: '#7c3aed',
			accentDim: '#5b21b6',
			accentText: '#c4b5fd',
			accentForeground: '#ffffff',
			success: '#22c55e',
			warning: '#eab308',
			error: '#ef4444',
			...overrides,
		},
	} as Theme;
}

describe('getMentionChipColors', () => {
	it('derives subtle tints from accent/border/text when tokens are unset', () => {
		const colors = getMentionChipColors(makeTheme());
		expect(colors.bg).toContain('color-mix');
		expect(colors.bg).toContain('#7c3aed'); // accent
		expect(colors.border).toContain('color-mix');
		expect(colors.text).toBe('#eeeeee'); // falls back to textMain
	});

	it('prefers explicit theme tokens when a theme sets them', () => {
		const colors = getMentionChipColors(
			makeTheme({
				mentionChipBg: '#202020',
				mentionChipBorder: '#404040',
				mentionChipText: '#dddddd',
			})
		);
		expect(colors).toEqual({ bg: '#202020', border: '#404040', text: '#dddddd' });
	});
});
