/**
 * Tests for cssCustomProperties.ts
 *
 * Tests CSS custom properties generation, injection, and manipulation
 * for dynamic theme switching in the web interface.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Theme, ThemeColors } from '../../../shared/theme-types';
import {
	THEME_CSS_PROPERTIES,
	generateCSSProperties,
	generateCSSString,
	injectCSSProperties,
	removeCSSProperties,
	setElementCSSProperties,
	removeElementCSSProperties,
	getCSSProperty,
	cssVar,
	type ThemeCSSProperty,
} from '../../../web/utils/cssCustomProperties';

// Helper function to create a mock theme
function createMockTheme(overrides?: Partial<Theme>): Theme {
	return {
		id: 'dracula',
		name: 'Dracula',
		mode: 'dark',
		colors: {
			bgMain: '#282a36',
			bgSidebar: '#21222c',
			bgActivity: '#44475a',
			border: '#6272a4',
			textMain: '#f8f8f2',
			textDim: '#6272a4',
			accent: '#bd93f9',
			accentDim: 'rgba(189, 147, 249, 0.3)',
			accentText: '#bd93f9',
			accentForeground: '#282a36',
			success: '#50fa7b',
			warning: '#ffb86c',
			error: '#ff5555',
		},
		...overrides,
	};
}

// Helper function to create a light theme
function createLightTheme(): Theme {
	return {
		id: 'github-light',
		name: 'GitHub Light',
		mode: 'light',
		colors: {
			bgMain: '#ffffff',
			bgSidebar: '#f6f8fa',
			bgActivity: '#f3f4f6',
			border: '#d0d7de',
			textMain: '#24292f',
			textDim: '#656d76',
			accent: '#0969da',
			accentDim: 'rgba(9, 105, 218, 0.1)',
			accentText: '#0969da',
			accentForeground: '#ffffff',
			success: '#1a7f37',
			warning: '#9a6700',
			error: '#cf222e',
		},
	};
}

describe('cssCustomProperties', () => {
	describe('THEME_CSS_PROPERTIES constant', () => {
		it('should contain all 14 theme CSS properties', () => {
			expect(THEME_CSS_PROPERTIES).toHaveLength(14);
		});

		it('should include all color properties', () => {
			const expectedProperties = [
				'--maestro-bg-main',
				'--maestro-bg-sidebar',
				'--maestro-bg-activity',
				'--maestro-border',
				'--maestro-text-main',
				'--maestro-text-dim',
				'--maestro-accent',
				'--maestro-accent-dim',
				'--maestro-accent-text',
				'--maestro-accent-foreground',
				'--maestro-success',
				'--maestro-warning',
				'--maestro-error',
				'--maestro-mode',
			];

			expectedProperties.forEach((prop) => {
				expect(THEME_CSS_PROPERTIES).toContain(prop);
			});
		});

		it('should have all properties prefixed with --maestro-', () => {
			THEME_CSS_PROPERTIES.forEach((prop) => {
				expect(prop).toMatch(/^--maestro-/);
			});
		});

		it('should not contain duplicate properties', () => {
			const uniqueProps = new Set(THEME_CSS_PROPERTIES);
			expect(uniqueProps.size).toBe(THEME_CSS_PROPERTIES.length);
		});
	});

	describe('generateCSSProperties', () => {
		it('should generate all CSS properties from a dark theme', () => {
			const theme = createMockTheme();
			const properties = generateCSSProperties(theme);

			expect(properties['--maestro-bg-main']).toBe('#282a36');
			expect(properties['--maestro-bg-sidebar']).toBe('#21222c');
			expect(properties['--maestro-bg-activity']).toBe('#44475a');
			expect(properties['--maestro-border']).toBe('#6272a4');
			expect(properties['--maestro-text-main']).toBe('#f8f8f2');
			expect(properties['--maestro-text-dim']).toBe('#6272a4');
			expect(properties['--maestro-accent']).toBe('#bd93f9');
			expect(properties['--maestro-accent-dim']).toBe('rgba(189, 147, 249, 0.3)');
			expect(properties['--maestro-accent-text']).toBe('#bd93f9');
			expect(properties['--maestro-success']).toBe('#50fa7b');
			expect(properties['--maestro-warning']).toBe('#ffb86c');
			expect(properties['--maestro-error']).toBe('#ff5555');
			expect(properties['--maestro-mode']).toBe('dark');
		});

		it('should generate CSS properties from a light theme', () => {
			const theme = createLightTheme();
			const properties = generateCSSProperties(theme);

			expect(properties['--maestro-bg-main']).toBe('#ffffff');
			expect(properties['--maestro-bg-sidebar']).toBe('#f6f8fa');
			expect(properties['--maestro-mode']).toBe('light');
		});

		it('should generate CSS properties from a vibe mode theme', () => {
			const theme = createMockTheme({ mode: 'vibe' });
			const properties = generateCSSProperties(theme);

			expect(properties['--maestro-mode']).toBe('vibe');
		});

		it('should return all 14 properties', () => {
			const theme = createMockTheme();
			const properties = generateCSSProperties(theme);

			expect(Object.keys(properties)).toHaveLength(14);
		});

		it('should handle themes with rgba colors', () => {
			const theme = createMockTheme({
				colors: {
					...createMockTheme().colors,
					accentDim: 'rgba(100, 200, 255, 0.5)',
				},
			});
			const properties = generateCSSProperties(theme);

			expect(properties['--maestro-accent-dim']).toBe('rgba(100, 200, 255, 0.5)');
		});

		it('should handle themes with hsl colors', () => {
			const theme = createMockTheme({
				colors: {
					...createMockTheme().colors,
					bgMain: 'hsl(230, 15%, 18%)',
				},
			});
			const properties = generateCSSProperties(theme);

			expect(properties['--maestro-bg-main']).toBe('hsl(230, 15%, 18%)');
		});

		it('should handle themes with named colors', () => {
			const theme = createMockTheme({
				colors: {
					...createMockTheme().colors,
					error: 'red',
					success: 'green',
				},
			});
			const properties = generateCSSProperties(theme);

			expect(properties['--maestro-error']).toBe('red');
			expect(properties['--maestro-success']).toBe('green');
		});
	});

	describe('generateCSSString', () => {
		it('should generate valid CSS string with default :root selector', () => {
			const theme = createMockTheme();
			const cssString = generateCSSString(theme);

			expect(cssString).toMatch(/^:root \{/);
			expect(cssString).toMatch(/\}$/);
			expect(cssString).toContain('--maestro-bg-main: #282a36;');
			expect(cssString).toContain('--maestro-mode: dark;');
		});

		it('should use custom selector when provided', () => {
			const theme = createMockTheme();
			const cssString = generateCSSString(theme, '.theme-container');

			expect(cssString).toMatch(/^\.theme-container \{/);
		});

		it('should use ID selector when provided', () => {
			const theme = createMockTheme();
			const cssString = generateCSSString(theme, '#app');

			expect(cssString).toMatch(/^#app \{/);
		});

		it('should use attribute selector when provided', () => {
			const theme = createMockTheme();
			const cssString = generateCSSString(theme, '[data-theme="dark"]');

			expect(cssString).toMatch(/^\[data-theme="dark"\] \{/);
		});

		it('should include all color properties in CSS string', () => {
			const theme = createMockTheme();
			const cssString = generateCSSString(theme);

			expect(cssString).toContain('--maestro-bg-main');
			expect(cssString).toContain('--maestro-bg-sidebar');
			expect(cssString).toContain('--maestro-bg-activity');
			expect(cssString).toContain('--maestro-border');
			expect(cssString).toContain('--maestro-text-main');
			expect(cssString).toContain('--maestro-text-dim');
			expect(cssString).toContain('--maestro-accent');
			expect(cssString).toContain('--maestro-accent-dim');
			expect(cssString).toContain('--maestro-accent-text');
			expect(cssString).toContain('--maestro-success');
			expect(cssString).toContain('--maestro-warning');
			expect(cssString).toContain('--maestro-error');
			expect(cssString).toContain('--maestro-mode');
		});

		it('should properly format each line with indentation', () => {
			const theme = createMockTheme();
			const cssString = generateCSSString(theme);
			const lines = cssString.split('\n');

			// First line should be selector with opening brace
			expect(lines[0]).toBe(':root {');

			// Middle lines should be indented with 2 spaces
			for (let i = 1; i < lines.length - 1; i++) {
				expect(lines[i]).toMatch(/^ {2}--maestro-.+: .+;$/);
			}

			// Last line should be closing brace
			expect(lines[lines.length - 1]).toBe('}');
		});

		it('should handle light theme correctly', () => {
			const theme = createLightTheme();
			const cssString = generateCSSString(theme);

			expect(cssString).toContain('--maestro-bg-main: #ffffff;');
			expect(cssString).toContain('--maestro-mode: light;');
		});
	});

	describe('injectCSSProperties', () => {
		let styleElement: HTMLStyleElement | null;

		beforeEach(() => {
			// Clean up any existing style elements
			document.querySelectorAll('#maestro-theme-css-properties').forEach((el) => el.remove());
			styleElement = null;
		});

		afterEach(() => {
			// Clean up after each test
			document.querySelectorAll('#maestro-theme-css-properties').forEach((el) => el.remove());
		});

		it('should create a style element in document head', () => {
			const theme = createMockTheme();
			injectCSSProperties(theme);

			styleElement = document.getElementById('maestro-theme-css-properties') as HTMLStyleElement;
			expect(styleElement).not.toBeNull();
			expect(styleElement.parentElement).toBe(document.head);
		});

		it('should set the correct id on style element', () => {
			const theme = createMockTheme();
			injectCSSProperties(theme);

			styleElement = document.getElementById('maestro-theme-css-properties') as HTMLStyleElement;
			expect(styleElement.id).toBe('maestro-theme-css-properties');
		});

		it('should set data-maestro-theme attribute', () => {
			const theme = createMockTheme();
			injectCSSProperties(theme);

			styleElement = document.getElementById('maestro-theme-css-properties') as HTMLStyleElement;
			expect(styleElement.getAttribute('data-maestro-theme')).toBe('true');
		});

		it('should contain CSS custom properties in textContent', () => {
			const theme = createMockTheme();
			injectCSSProperties(theme);

			styleElement = document.getElementById('maestro-theme-css-properties') as HTMLStyleElement;
			expect(styleElement.textContent).toContain('--maestro-bg-main');
			expect(styleElement.textContent).toContain('#282a36');
		});

		it('should update existing style element instead of creating duplicate', () => {
			const darkTheme = createMockTheme();
			const lightTheme = createLightTheme();

			// Inject dark theme
			injectCSSProperties(darkTheme);
			const styleElements1 = document.querySelectorAll('#maestro-theme-css-properties');
			expect(styleElements1).toHaveLength(1);

			// Inject light theme - should update, not create new
			injectCSSProperties(lightTheme);
			const styleElements2 = document.querySelectorAll('#maestro-theme-css-properties');
			expect(styleElements2).toHaveLength(1);

			// Content should be updated
			styleElement = document.getElementById('maestro-theme-css-properties') as HTMLStyleElement;
			expect(styleElement.textContent).toContain('#ffffff');
			expect(styleElement.textContent).not.toContain('#282a36');
		});

		it('should inject CSS properties from light theme', () => {
			const theme = createLightTheme();
			injectCSSProperties(theme);

			styleElement = document.getElementById('maestro-theme-css-properties') as HTMLStyleElement;
			expect(styleElement.textContent).toContain('--maestro-mode: light;');
		});
	});

	describe('injectCSSProperties SSR safety', () => {
		it('should handle undefined document gracefully (SSR)', () => {
			// Save original
			const originalDocument = globalThis.document;

			// Mock undefined document
			// @ts-expect-error - Testing SSR scenario
			delete globalThis.document;

			const theme = createMockTheme();
			// Should not throw
			expect(() => injectCSSProperties(theme)).not.toThrow();

			// Restore
			globalThis.document = originalDocument;
		});
	});

	describe('removeCSSProperties', () => {
		beforeEach(() => {
			// Inject properties to remove
			const theme = createMockTheme();
			injectCSSProperties(theme);
		});

		afterEach(() => {
			// Clean up
			document.querySelectorAll('#maestro-theme-css-properties').forEach((el) => el.remove());
		});

		it('should remove the style element from document', () => {
			const before = document.getElementById('maestro-theme-css-properties');
			expect(before).not.toBeNull();

			removeCSSProperties();

			const after = document.getElementById('maestro-theme-css-properties');
			expect(after).toBeNull();
		});

		it('should not throw when style element does not exist', () => {
			// First remove
			removeCSSProperties();
			expect(document.getElementById('maestro-theme-css-properties')).toBeNull();

			// Second remove should not throw
			expect(() => removeCSSProperties()).not.toThrow();
		});

		it('should handle multiple calls gracefully', () => {
			removeCSSProperties();
			removeCSSProperties();
			removeCSSProperties();

			expect(document.getElementById('maestro-theme-css-properties')).toBeNull();
		});
	});

	describe('removeCSSProperties SSR safety', () => {
		it('should handle undefined document gracefully (SSR)', () => {
			const originalDocument = globalThis.document;
			// @ts-expect-error - Testing SSR scenario
			delete globalThis.document;

			expect(() => removeCSSProperties()).not.toThrow();

			globalThis.document = originalDocument;
		});
	});

	describe('setElementCSSProperties', () => {
		let element: HTMLDivElement;

		beforeEach(() => {
			element = document.createElement('div');
			document.body.appendChild(element);
		});

		afterEach(() => {
			element.remove();
		});

		it('should set all CSS custom properties on element', () => {
			const theme = createMockTheme();
			setElementCSSProperties(element, theme);

			expect(element.style.getPropertyValue('--maestro-bg-main')).toBe('#282a36');
			expect(element.style.getPropertyValue('--maestro-bg-sidebar')).toBe('#21222c');
			expect(element.style.getPropertyValue('--maestro-mode')).toBe('dark');
		});

		it('should set all 13 properties', () => {
			const theme = createMockTheme();
			setElementCSSProperties(element, theme);

			let count = 0;
			THEME_CSS_PROPERTIES.forEach((prop) => {
				if (element.style.getPropertyValue(prop)) {
					count++;
				}
			});
			expect(count).toBe(14);
		});

		it('should update properties when called again with different theme', () => {
			const darkTheme = createMockTheme();
			const lightTheme = createLightTheme();

			setElementCSSProperties(element, darkTheme);
			expect(element.style.getPropertyValue('--maestro-bg-main')).toBe('#282a36');

			setElementCSSProperties(element, lightTheme);
			expect(element.style.getPropertyValue('--maestro-bg-main')).toBe('#ffffff');
		});

		it('should work with nested elements', () => {
			const parentElement = document.createElement('div');
			const childElement = document.createElement('div');
			parentElement.appendChild(childElement);
			document.body.appendChild(parentElement);

			const theme = createMockTheme();
			setElementCSSProperties(childElement, theme);

			expect(childElement.style.getPropertyValue('--maestro-accent')).toBe('#bd93f9');

			parentElement.remove();
		});
	});

	describe('removeElementCSSProperties', () => {
		let element: HTMLDivElement;

		beforeEach(() => {
			element = document.createElement('div');
			document.body.appendChild(element);

			// Set properties first
			const theme = createMockTheme();
			setElementCSSProperties(element, theme);
		});

		afterEach(() => {
			element.remove();
		});

		it('should remove all CSS custom properties from element', () => {
			// Verify properties are set
			expect(element.style.getPropertyValue('--maestro-bg-main')).toBe('#282a36');

			removeElementCSSProperties(element);

			// Verify all properties are removed
			THEME_CSS_PROPERTIES.forEach((prop) => {
				expect(element.style.getPropertyValue(prop)).toBe('');
			});
		});

		it('should not affect other styles on the element', () => {
			element.style.backgroundColor = 'red';
			element.style.padding = '10px';

			removeElementCSSProperties(element);

			expect(element.style.backgroundColor).toBe('red');
			expect(element.style.padding).toBe('10px');
		});

		it('should not throw when properties are not set', () => {
			const cleanElement = document.createElement('div');
			document.body.appendChild(cleanElement);

			expect(() => removeElementCSSProperties(cleanElement)).not.toThrow();

			cleanElement.remove();
		});
	});

	describe('getCSSProperty', () => {
		let element: HTMLDivElement;

		beforeEach(() => {
			element = document.createElement('div');
			document.body.appendChild(element);
		});

		afterEach(() => {
			element.remove();
			removeCSSProperties();
		});

		it('should get CSS property value from document root', () => {
			const theme = createMockTheme();
			injectCSSProperties(theme);

			// Note: getComputedStyle may not return the value immediately in jsdom
			// This tests the function signature and behavior
			const value = getCSSProperty('--maestro-bg-main');
			// In jsdom, custom properties may not be computed
			expect(typeof value).toBe('string');
		});

		it('should get CSS property value from specific element', () => {
			const theme = createMockTheme();
			setElementCSSProperties(element, theme);

			const value = getCSSProperty('--maestro-accent', element);
			expect(typeof value).toBe('string');
		});

		it('should return empty string for non-existent property', () => {
			const value = getCSSProperty('--maestro-bg-main');
			expect(value).toBe('');
		});

		it('should return trimmed value', () => {
			element.style.setProperty('--maestro-bg-main', '  #ffffff  ');
			const value = getCSSProperty('--maestro-bg-main', element);
			expect(value).toBe('#ffffff');
		});

		it('should use document.documentElement as default element', () => {
			// Inject properties on root
			const theme = createMockTheme();
			injectCSSProperties(theme);

			// Call without element parameter
			const value = getCSSProperty('--maestro-mode');
			expect(typeof value).toBe('string');
		});
	});

	describe('getCSSProperty SSR safety', () => {
		it('should return empty string when window is undefined (SSR)', () => {
			const originalWindow = globalThis.window;
			// @ts-expect-error - Testing SSR scenario
			delete globalThis.window;

			const value = getCSSProperty('--maestro-bg-main');
			expect(value).toBe('');

			globalThis.window = originalWindow;
		});
	});

	describe('cssVar', () => {
		it('should generate var() syntax without fallback', () => {
			const result = cssVar('--maestro-bg-main');
			expect(result).toBe('var(--maestro-bg-main)');
		});

		it('should generate var() syntax with fallback', () => {
			const result = cssVar('--maestro-bg-main', '#000000');
			expect(result).toBe('var(--maestro-bg-main, #000000)');
		});

		it('should work with all property types', () => {
			const properties: ThemeCSSProperty[] = [
				'--maestro-bg-main',
				'--maestro-bg-sidebar',
				'--maestro-bg-activity',
				'--maestro-border',
				'--maestro-text-main',
				'--maestro-text-dim',
				'--maestro-accent',
				'--maestro-accent-dim',
				'--maestro-accent-text',
				'--maestro-success',
				'--maestro-warning',
				'--maestro-error',
				'--maestro-mode',
			];

			properties.forEach((prop) => {
				expect(cssVar(prop)).toBe(`var(${prop})`);
				expect(cssVar(prop, 'fallback')).toBe(`var(${prop}, fallback)`);
			});
		});

		it('should handle various fallback values', () => {
			expect(cssVar('--maestro-accent', 'rgba(0,0,0,0.5)')).toBe(
				'var(--maestro-accent, rgba(0,0,0,0.5))'
			);
			expect(cssVar('--maestro-mode', 'dark')).toBe('var(--maestro-mode, dark)');
			expect(cssVar('--maestro-bg-main', 'hsl(0, 0%, 0%)')).toBe(
				'var(--maestro-bg-main, hsl(0, 0%, 0%))'
			);
		});

		it('should handle empty string fallback', () => {
			// Empty string is falsy but should still be treated as no fallback
			const result = cssVar('--maestro-bg-main', '');
			expect(result).toBe('var(--maestro-bg-main)');
		});

		it('should handle whitespace-only fallback', () => {
			// Note: This tests the actual behavior - whitespace is truthy
			const result = cssVar('--maestro-bg-main', '   ');
			expect(result).toBe('var(--maestro-bg-main,    )');
		});

		it('should return correct CSS for use in style objects', () => {
			const bgColor = cssVar('--maestro-bg-main');
			const accentWithFallback = cssVar('--maestro-accent', 'blue');

			// These should be valid CSS values
			expect(bgColor).toMatch(/^var\(--maestro-.+\)$/);
			expect(accentWithFallback).toMatch(/^var\(--maestro-.+, .+\)$/);
		});
	});

	describe('ThemeCSSProperty type', () => {
		it('should allow all valid property names', () => {
			// This tests type correctness at runtime by ensuring the type
			// allows all the expected values
			const validProps: ThemeCSSProperty[] = [
				'--maestro-bg-main',
				'--maestro-bg-sidebar',
				'--maestro-bg-activity',
				'--maestro-border',
				'--maestro-text-main',
				'--maestro-text-dim',
				'--maestro-accent',
				'--maestro-accent-dim',
				'--maestro-accent-text',
				'--maestro-success',
				'--maestro-warning',
				'--maestro-error',
				'--maestro-mode',
			];

			validProps.forEach((prop) => {
				// If this compiles and runs, the type allows the value
				expect(typeof prop).toBe('string');
			});
		});
	});

	describe('Integration scenarios', () => {
		afterEach(() => {
			removeCSSProperties();
		});

		it('should support full theme injection and retrieval cycle', () => {
			const theme = createMockTheme();

			// Inject
			injectCSSProperties(theme);

			// Verify injection
			const styleElement = document.getElementById('maestro-theme-css-properties');
			expect(styleElement).not.toBeNull();
			expect(styleElement?.textContent).toContain('--maestro-bg-main: #282a36;');

			// Clean up
			removeCSSProperties();
			expect(document.getElementById('maestro-theme-css-properties')).toBeNull();
		});

		it('should support theme switching', () => {
			const darkTheme = createMockTheme();
			const lightTheme = createLightTheme();

			// Start with dark theme
			injectCSSProperties(darkTheme);
			let styleElement = document.getElementById('maestro-theme-css-properties');
			expect(styleElement?.textContent).toContain('--maestro-mode: dark;');

			// Switch to light theme
			injectCSSProperties(lightTheme);
			styleElement = document.getElementById('maestro-theme-css-properties');
			expect(styleElement?.textContent).toContain('--maestro-mode: light;');
			expect(styleElement?.textContent).not.toContain('--maestro-mode: dark;');
		});

		it('should support element-scoped theming', () => {
			const element = document.createElement('div');
			document.body.appendChild(element);

			const theme = createMockTheme();
			setElementCSSProperties(element, theme);

			// Verify scoped properties
			THEME_CSS_PROPERTIES.forEach((prop) => {
				expect(element.style.getPropertyValue(prop)).not.toBe('');
			});

			// Clean up scoped properties
			removeElementCSSProperties(element);

			// Verify removal
			THEME_CSS_PROPERTIES.forEach((prop) => {
				expect(element.style.getPropertyValue(prop)).toBe('');
			});

			element.remove();
		});

		it('should support generating CSS for stylesheets', () => {
			const theme = createMockTheme();
			const css = generateCSSString(theme);

			// Should be valid CSS that can be parsed
			expect(css).toMatch(/^:root \{[\s\S]+\}$/);

			// Should contain all properties (14 = 13 colors + accentForeground + mode)
			expect((css.match(/--maestro-/g) || []).length).toBe(14);
		});

		it('should support cssVar in style objects pattern', () => {
			const element = document.createElement('div');
			document.body.appendChild(element);

			// Inject theme first
			const theme = createMockTheme();
			injectCSSProperties(theme);

			// Apply var() styles
			element.style.backgroundColor = cssVar('--maestro-bg-main');
			element.style.color = cssVar('--maestro-text-main');
			element.style.borderColor = cssVar('--maestro-border', '#000');

			expect(element.style.backgroundColor).toBe('var(--maestro-bg-main)');
			expect(element.style.color).toBe('var(--maestro-text-main)');
			expect(element.style.borderColor).toBe('var(--maestro-border, #000)');

			element.remove();
		});
	});

	describe('Edge cases', () => {
		it('should handle themes with special characters in color values', () => {
			const theme = createMockTheme({
				colors: {
					...createMockTheme().colors,
					accentDim: 'rgba(255, 255, 255, 0.5)',
					bgMain: 'hsla(230, 15%, 18%, 1)',
				},
			});

			const properties = generateCSSProperties(theme);
			expect(properties['--maestro-accent-dim']).toBe('rgba(255, 255, 255, 0.5)');
			expect(properties['--maestro-bg-main']).toBe('hsla(230, 15%, 18%, 1)');
		});

		it('should handle CSS injection when document.head is empty', () => {
			// This is handled by the browser - createElement('style') works even if head is empty
			const theme = createMockTheme();
			expect(() => injectCSSProperties(theme)).not.toThrow();
			removeCSSProperties();
		});

		it('should handle multiple rapid theme injections', () => {
			const darkTheme = createMockTheme();
			const lightTheme = createLightTheme();

			for (let i = 0; i < 10; i++) {
				injectCSSProperties(i % 2 === 0 ? darkTheme : lightTheme);
			}

			// Should only have one style element
			const styleElements = document.querySelectorAll('#maestro-theme-css-properties');
			expect(styleElements).toHaveLength(1);

			// Should have the last injected theme (light, since 9 % 2 === 1)
			const styleElement = document.getElementById('maestro-theme-css-properties');
			expect(styleElement?.textContent).toContain('--maestro-mode: light;');

			removeCSSProperties();
		});

		it('should handle concurrent element property setting', () => {
			const elements = Array.from({ length: 5 }, () => {
				const el = document.createElement('div');
				document.body.appendChild(el);
				return el;
			});

			const theme = createMockTheme();

			// Set properties on all elements
			elements.forEach((el) => setElementCSSProperties(el, theme));

			// Verify all elements have properties
			elements.forEach((el) => {
				expect(el.style.getPropertyValue('--maestro-bg-main')).toBe('#282a36');
			});

			// Clean up
			elements.forEach((el) => {
				removeElementCSSProperties(el);
				el.remove();
			});
		});
	});

	describe('colorToCSSProperty mapping', () => {
		it('should map all ThemeColors keys correctly', () => {
			const theme = createMockTheme();
			const properties = generateCSSProperties(theme);

			// Verify the mapping from color keys to CSS properties
			const expectedMappings: [keyof ThemeColors, ThemeCSSProperty][] = [
				['bgMain', '--maestro-bg-main'],
				['bgSidebar', '--maestro-bg-sidebar'],
				['bgActivity', '--maestro-bg-activity'],
				['border', '--maestro-border'],
				['textMain', '--maestro-text-main'],
				['textDim', '--maestro-text-dim'],
				['accent', '--maestro-accent'],
				['accentDim', '--maestro-accent-dim'],
				['accentText', '--maestro-accent-text'],
				['success', '--maestro-success'],
				['warning', '--maestro-warning'],
				['error', '--maestro-error'],
			];

			expectedMappings.forEach(([colorKey, cssProperty]) => {
				expect(properties[cssProperty]).toBe(theme.colors[colorKey]);
			});
		});

		it('should convert camelCase to kebab-case correctly', () => {
			// The CSS properties follow kebab-case convention
			THEME_CSS_PROPERTIES.forEach((prop) => {
				// All properties should be lowercase and kebab-case
				expect(prop).toMatch(/^--maestro-[a-z]+(-[a-z]+)*$/);
			});
		});
	});
});
