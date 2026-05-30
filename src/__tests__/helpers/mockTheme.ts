/**
 * Shared theme test factories.
 *
 * Use these in place of hand-rolling a local `mockTheme` / `createMockTheme`
 * in test files. The defaults match the Dracula theme and satisfy every
 * required field of the canonical `Theme` / `ThemeColors` interfaces in
 * `src/shared/theme-types.ts`.
 *
 * Usage:
 *
 *   import { mockTheme, createMockTheme, mockThemeColors } from '<relative>/helpers/mockTheme';
 *
 *   // Static default (identity-stable):
 *   render(<Component theme={mockTheme} />);
 *
 *   // Custom overrides:
 *   const theme = createMockTheme({ mode: 'vibe' });
 *   const theme2 = createMockTheme({ colors: { accent: '#ff0000' } });
 */

import type { Theme, ThemeColors } from '../../shared/theme-types';

/**
 * Override shape for `createMockTheme`. Permits partial `colors` so callers
 * can supply only the color keys they want to change (e.g. `{ accent: ... }`)
 * without having to spell out the full `ThemeColors` object.
 */
type ThemeOverrides = Omit<Partial<Theme>, 'colors'> & {
	colors?: Partial<ThemeColors>;
};

/**
 * Default color palette used by `mockTheme` and `createMockTheme`.
 * Exported so tests (like CustomThemeBuilder) that need a standalone
 * `ThemeColors` value can reference it directly.
 */
export const mockThemeColors: ThemeColors = {
	bgMain: '#282a36',
	bgSidebar: '#21222c',
	bgActivity: '#343746',
	border: '#44475a',
	textMain: '#f8f8f2',
	textDim: '#6272a4',
	accent: '#bd93f9',
	accentDim: 'rgba(189, 147, 249, 0.2)',
	accentText: '#ff79c6',
	accentForeground: '#282a36',
	success: '#50fa7b',
	warning: '#ffb86c',
	error: '#ff5555',
};

/**
 * Default mock theme (Dracula). Safe to share by reference across tests
 * because it is frozen. Any test that needs to mutate should call
 * `createMockTheme(...)` instead.
 */
export const mockTheme: Theme = Object.freeze({
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: Object.freeze({ ...mockThemeColors }) as ThemeColors,
}) as Theme;

/**
 * Build a `Theme` by deep-merging `overrides` onto the default `mockTheme`.
 * The `colors` override is spread into the defaults so callers only need to
 * specify the fields they want to change.
 */
export function createMockTheme(overrides: ThemeOverrides = {}): Theme {
	const { colors: colorOverrides, ...rest } = overrides;
	return {
		id: mockTheme.id,
		name: mockTheme.name,
		mode: mockTheme.mode,
		...rest,
		colors: {
			...mockThemeColors,
			...(colorOverrides ?? {}),
		},
	};
}
