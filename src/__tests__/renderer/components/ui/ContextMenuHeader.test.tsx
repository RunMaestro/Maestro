/**
 * Tests for ContextMenuHeader - the accent title band shared by right-click menus.
 */

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { File } from 'lucide-react';
import {
	ContextMenuHeader,
	contextMenuHeaderForeground,
	contextMenuIconStyle,
} from '../../../../renderer/components/ui/ContextMenuHeader';
import { contrastRatio } from '../../../../shared/colorContrast';
import { mockTheme } from '../../../helpers/mockTheme';

function renderHeader(props: Partial<React.ComponentProps<typeof ContextMenuHeader>> = {}) {
	// Read from this render's own container: several tests render twice, and a
	// screen-wide query would then match both bands.
	const { container } = render(
		<ContextMenuHeader theme={mockTheme} label=".editorconfig" {...props} />
	);
	return container.firstElementChild as HTMLElement;
}

describe('ContextMenuHeader', () => {
	it('renders the label verbatim, without forcing a case', () => {
		// File names are case-sensitive, so the band must not uppercase them.
		const header = renderHeader({ label: 'README.md' });
		expect(header.textContent).toBe('README.md');
		expect(header.className).not.toContain('uppercase');
	});

	it('fills with the theme accent', () => {
		const header = renderHeader({
			theme: { ...mockTheme, colors: { ...mockTheme.colors, accent: '#9146ff' } },
		});
		expect(header.style.backgroundColor).toBe('rgb(145, 70, 255)');
	});

	it('defaults the tooltip to the label and accepts an override', () => {
		expect(renderHeader().getAttribute('title')).toBe('.editorconfig');
		expect(renderHeader({ title: '/repo/.editorconfig' }).getAttribute('title')).toBe(
			'/repo/.editorconfig'
		);
	});

	it('draws an icon, or an emoji when no icon is given', () => {
		expect(renderHeader({ icon: File }).querySelector('svg')).not.toBeNull();
		const withEmoji = renderHeader({ emoji: '🎹', label: 'Maestro' });
		expect(withEmoji.querySelector('svg')).toBeNull();
		expect(withEmoji.textContent).toBe('🎹Maestro');
	});

	it('keeps text readable on a light accent', () => {
		// White on yellow is the failure this guards against.
		const theme = {
			...mockTheme,
			colors: { ...mockTheme.colors, accent: '#ffd700', accentForeground: '#ffffff' },
		};
		const fg = contextMenuHeaderForeground(theme);
		expect(contrastRatio(fg, '#ffd700')).toBeGreaterThanOrEqual(4.5);
	});

	it('keeps a theme foreground that already reads well', () => {
		const theme = {
			...mockTheme,
			colors: { ...mockTheme.colors, accent: '#9146ff', accentForeground: '#ffffff' },
		};
		expect(contextMenuHeaderForeground(theme)).toBe('#ffffff');
	});

	it('colors menu row icons with the theme accent', () => {
		const theme = { ...mockTheme, colors: { ...mockTheme.colors, accent: '#9146ff' } };
		expect(contextMenuIconStyle(theme)).toEqual({ color: '#9146ff' });
	});
});
