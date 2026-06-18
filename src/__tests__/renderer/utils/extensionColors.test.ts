/**
 * Tests for extensionColors.ts - shared file extension badge color utility
 *
 * Verifies:
 * - Known extensions return category-specific colors (not theme defaults)
 * - Image extensions get visible colors (the original bug)
 * - Unknown extensions derive color from theme accent (never invisible)
 * - Light vs dark theme produces different color values
 * - Colorblind mode delegates to colorblind palette
 * - All categories have both bg and text properties
 */

import { describe, it, expect } from 'vitest';
import { getExtensionColor } from '../../../renderer/utils/extensionColors';
import { THEMES } from '../../../shared/themes';

const darkTheme = THEMES['dracula'];
const lightTheme = THEMES['github-light'];

describe('getExtensionColor', () => {
	describe('known extension categories', () => {
		const cases: [string, string][] = [
			['.ts', 'typescript'],
			['.tsx', 'typescript'],
			['.js', 'typescript'],
			['.md', 'markdown'],
			['.json', 'config'],
			['.yaml', 'config'],
			['.css', 'styles'],
			['.html', 'html'],
			['.py', 'python'],
			['.rs', 'rust'],
			['.go', 'go'],
			['.sh', 'shell'],
			['.png', 'image'],
			['.jpg', 'image'],
			['.jpeg', 'image'],
			['.gif', 'image'],
			['.webp', 'image'],
			['.java', 'java'],
			['.kt', 'java'],
			['.c', 'cpp'],
			['.cpp', 'cpp'],
			['.h', 'cpp'],
			['.rb', 'ruby'],
			['.sql', 'data'],
			['.csv', 'data'],
			['.pdf', 'document'],
			['.docx', 'document'],
		];

		it.each(cases)('%s returns a colored badge (not theme border/dim)', (ext) => {
			const result = getExtensionColor(ext, darkTheme);
			expect(result.bg).not.toBe(darkTheme.colors.border);
			expect(result.text).not.toBe(darkTheme.colors.textDim);
			expect(result.bg).toContain('rgba');
			expect(result.text).toContain('rgba');
		});
	});

	describe('image extensions are visible (original bug)', () => {
		const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff', '.avif'];

		it.each(imageExts)('%s returns a non-default color', (ext) => {
			const dark = getExtensionColor(ext, darkTheme);
			const light = getExtensionColor(ext, lightTheme);
			// Must not be theme border (the old invisible default)
			expect(dark.bg).not.toBe(darkTheme.colors.border);
			expect(light.bg).not.toBe(lightTheme.colors.border);
		});
	});

	describe('unknown extensions use theme accent (never invisible)', () => {
		it('derives color from theme accent for unknown extension', () => {
			const result = getExtensionColor('.xyz', darkTheme);
			// Should contain rgba (derived from hex accent)
			expect(result.bg).toContain('rgba');
			expect(result.text).toContain('rgba');
			// Should NOT be theme border
			expect(result.bg).not.toBe(darkTheme.colors.border);
			expect(result.text).not.toBe(darkTheme.colors.textDim);
		});

		it('different themes produce different accent-derived defaults', () => {
			const dracula = getExtensionColor('.xyz', THEMES['dracula']);
			const nord = getExtensionColor('.xyz', THEMES['nord']);
			// Different theme accents should produce different colors
			expect(dracula.bg).not.toBe(nord.bg);
		});
	});

	describe('light vs dark theme adaptation', () => {
		it('returns different opacity for light and dark themes', () => {
			const dark = getExtensionColor('.ts', darkTheme);
			const light = getExtensionColor('.ts', lightTheme);
			expect(dark.bg).not.toBe(light.bg);
			expect(dark.text).not.toBe(light.text);
		});
	});

	describe('case insensitivity', () => {
		it('handles uppercase extensions', () => {
			const lower = getExtensionColor('.png', darkTheme);
			const upper = getExtensionColor('.PNG', darkTheme);
			expect(upper).toEqual(lower);
		});

		it('handles mixed case', () => {
			const lower = getExtensionColor('.json', darkTheme);
			const mixed = getExtensionColor('.Json', darkTheme);
			expect(mixed).toEqual(lower);
		});
	});

	describe('colorblind mode', () => {
		it('returns colorblind-specific colors for known extensions', () => {
			const normal = getExtensionColor('.ts', darkTheme, false);
			const cb = getExtensionColor('.ts', darkTheme, true);
			// Colorblind palette uses different rgba values
			expect(cb.bg).not.toBe(normal.bg);
		});

		it('returns visible fallback for unknown extensions in colorblind mode', () => {
			const result = getExtensionColor('.xyz', darkTheme, true);
			expect(result.bg).toContain('rgba');
			expect(result.bg).not.toBe(darkTheme.colors.border);
		});
	});

	describe('return value shape', () => {
		it('always returns { bg, text } strings', () => {
			const exts = ['.ts', '.png', '.xyz', '.java', '.sql', '.pdf'];
			for (const ext of exts) {
				const result = getExtensionColor(ext, darkTheme);
				expect(typeof result.bg).toBe('string');
				expect(typeof result.text).toBe('string');
				expect(result.bg.length).toBeGreaterThan(0);
				expect(result.text.length).toBeGreaterThan(0);
			}
		});
	});
});
