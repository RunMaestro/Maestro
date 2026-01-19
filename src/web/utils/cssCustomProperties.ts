/**
 * CSS Custom Properties Generator for Maestro Web Interface
 *
 * Converts theme colors to CSS custom properties (CSS variables) that can be
 * injected into the DOM. This allows dynamic theme switching in the web interface.
 *
 * CSS variable naming convention:
 * - Theme colors are prefixed with `--maestro-`
 * - Color names are converted from camelCase to kebab-case
 *
 * Example: theme.colors.bgMain -> --maestro-bg-main
 */

import type { Theme, ThemeColors } from '../../shared/theme-types';

/**
 * CSS custom property name for a theme color
 */
export type ThemeCSSProperty =
	| '--maestro-bg-main'
	| '--maestro-bg-sidebar'
	| '--maestro-bg-activity'
	| '--maestro-border'
	| '--maestro-text-main'
	| '--maestro-text-dim'
	| '--maestro-accent'
	| '--maestro-accent-dim'
	| '--maestro-accent-text'
	| '--maestro-accent-foreground'
	| '--maestro-success'
	| '--maestro-warning'
	| '--maestro-error'
	| '--maestro-mode';

/**
 * Maps theme color keys to CSS custom property names
 */
const colorToCSSProperty: Record<keyof ThemeColors, ThemeCSSProperty> = {
	bgMain: '--maestro-bg-main',
	bgSidebar: '--maestro-bg-sidebar',
	bgActivity: '--maestro-bg-activity',
	border: '--maestro-border',
	textMain: '--maestro-text-main',
	textDim: '--maestro-text-dim',
	accent: '--maestro-accent',
	accentDim: '--maestro-accent-dim',
	accentText: '--maestro-accent-text',
	accentForeground: '--maestro-accent-foreground',
	success: '--maestro-success',
	warning: '--maestro-warning',
	error: '--maestro-error',
};

/**
 * All CSS custom property names used by the theme system
 */
export const THEME_CSS_PROPERTIES: ThemeCSSProperty[] = [
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

/**
 * Generates a map of CSS custom property names to their values from a theme
 *
 * @param theme - The theme to generate CSS properties from
 * @returns Object mapping CSS property names to values
 *
 * @example
 * ```ts
 * const props = generateCSSProperties(myTheme);
 * // Returns:
 * // {
 * //   '--maestro-bg-main': '#0b0b0d',
 * //   '--maestro-bg-sidebar': '#111113',
 * //   '--maestro-mode': 'dark',
 * //   ...
 * // }
 * ```
 */
export function generateCSSProperties(theme: Theme): Record<ThemeCSSProperty, string> {
	const properties: Partial<Record<ThemeCSSProperty, string>> = {};

	// Add color properties
	for (const [colorKey, cssProperty] of Object.entries(colorToCSSProperty)) {
		const colorValue = theme.colors[colorKey as keyof ThemeColors];
		properties[cssProperty] = colorValue;
	}

	// Add mode property for CSS selectors based on theme mode
	properties['--maestro-mode'] = theme.mode;

	return properties as Record<ThemeCSSProperty, string>;
}

/**
 * Generates a CSS string containing custom property declarations
 *
 * @param theme - The theme to generate CSS from
 * @param selector - CSS selector to scope the variables (default: ':root')
 * @returns CSS string with custom property declarations
 *
 * @example
 * ```ts
 * const css = generateCSSString(myTheme);
 * // Returns:
 * // `:root {
 * //   --maestro-bg-main: #0b0b0d;
 * //   --maestro-bg-sidebar: #111113;
 * //   ...
 * // }`
 * ```
 */
export function generateCSSString(theme: Theme, selector: string = ':root'): string {
	const properties = generateCSSProperties(theme);
	const declarations = Object.entries(properties)
		.map(([prop, value]) => `  ${prop}: ${value};`)
		.join('\n');

	return `${selector} {\n${declarations}\n}`;
}

/**
 * ID of the style element used for theme CSS properties
 */
const STYLE_ELEMENT_ID = 'maestro-theme-css-properties';

/**
 * Injects theme CSS custom properties into the document
 *
 * Creates or updates a <style> element in the document head with CSS custom
 * property declarations. Safe to call multiple times - will update existing
 * properties rather than creating duplicate style elements.
 *
 * @param theme - The theme to inject
 *
 * @example
 * ```ts
 * // In a React component or effect
 * injectCSSProperties(currentTheme);
 * ```
 */
export function injectCSSProperties(theme: Theme): void {
	if (typeof document === 'undefined') {
		// SSR safety - no-op on server
		return;
	}

	let styleElement = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;

	if (!styleElement) {
		styleElement = document.createElement('style');
		styleElement.id = STYLE_ELEMENT_ID;
		styleElement.setAttribute('data-maestro-theme', 'true');
		document.head.appendChild(styleElement);
	}

	styleElement.textContent = generateCSSString(theme);
}

/**
 * Removes theme CSS custom properties from the document
 *
 * @example
 * ```ts
 * // Cleanup when unmounting
 * removeCSSProperties();
 * ```
 */
export function removeCSSProperties(): void {
	if (typeof document === 'undefined') {
		return;
	}

	const styleElement = document.getElementById(STYLE_ELEMENT_ID);
	if (styleElement) {
		styleElement.remove();
	}
}

/**
 * Sets theme CSS custom properties directly on an element's style
 *
 * Useful for scoped theming or when you can't modify the document head.
 *
 * @param element - The element to set properties on
 * @param theme - The theme to apply
 *
 * @example
 * ```tsx
 * function ThemedContainer({ theme, children }) {
 *   const ref = useRef<HTMLDivElement>(null);
 *   useEffect(() => {
 *     if (ref.current) {
 *       setElementCSSProperties(ref.current, theme);
 *     }
 *   }, [theme]);
 *   return <div ref={ref}>{children}</div>;
 * }
 * ```
 */
export function setElementCSSProperties(element: HTMLElement, theme: Theme): void {
	const properties = generateCSSProperties(theme);
	for (const [prop, value] of Object.entries(properties)) {
		element.style.setProperty(prop, value);
	}
}

/**
 * Removes theme CSS custom properties from an element's style
 *
 * @param element - The element to remove properties from
 */
export function removeElementCSSProperties(element: HTMLElement): void {
	for (const prop of THEME_CSS_PROPERTIES) {
		element.style.removeProperty(prop);
	}
}

/**
 * Gets the current value of a theme CSS custom property
 *
 * @param property - The CSS custom property name
 * @param element - Element to get computed style from (default: document.documentElement)
 * @returns The property value or empty string if not set
 *
 * @example
 * ```ts
 * const bgColor = getCSSProperty('--maestro-bg-main');
 * ```
 */
export function getCSSProperty(
	property: ThemeCSSProperty,
	element: Element = document.documentElement
): string {
	if (typeof window === 'undefined') {
		return '';
	}
	return getComputedStyle(element).getPropertyValue(property).trim();
}

/**
 * Helper to use CSS custom properties in inline styles
 *
 * @param property - The CSS custom property name
 * @param fallback - Optional fallback value
 * @returns CSS var() function string
 *
 * @example
 * ```tsx
 * <div style={{ backgroundColor: cssVar('--maestro-bg-main') }}>
 *   Content
 * </div>
 * ```
 */
export function cssVar(property: ThemeCSSProperty, fallback?: string): string {
	return fallback ? `var(${property}, ${fallback})` : `var(${property})`;
}
