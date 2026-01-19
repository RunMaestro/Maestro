/**
 * Tests for ThemeProvider component
 *
 * Tests core behavior: context provision, device preference, CSS injection.
 * Implementation details (exact color hex values) are not exhaustively tested.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, renderHook } from '@testing-library/react';
import React from 'react';
import {
	ThemeProvider,
	useTheme,
	useThemeColors,
	ThemeContext,
	type ThemeContextValue,
} from '../../../web/components/ThemeProvider';
import type { Theme } from '../../../shared/theme-types';
import * as cssCustomProperties from '../../../web/utils/cssCustomProperties';
import * as useDeviceColorSchemeModule from '../../../web/hooks/useDeviceColorScheme';

// Mock CSS custom properties module
vi.mock('../../../web/utils/cssCustomProperties', () => ({
	injectCSSProperties: vi.fn(),
	removeCSSProperties: vi.fn(),
}));

// Mock useDeviceColorScheme hook
vi.mock('../../../web/hooks/useDeviceColorScheme', () => ({
	useDeviceColorScheme: vi.fn(() => ({
		colorScheme: 'dark',
		prefersDark: true,
		prefersLight: false,
	})),
}));

const mockedCssCustomProperties = vi.mocked(cssCustomProperties);
const mockedUseDeviceColorScheme = vi.mocked(useDeviceColorSchemeModule.useDeviceColorScheme);
let consoleErrorSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
	consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	consoleErrorSpy?.mockRestore();
	consoleErrorSpy = undefined;
});

// Test themes
const customDarkTheme: Theme = {
	id: 'custom-dark',
	name: 'Custom Dark',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgSidebar: '#2a2a2a',
		bgActivity: '#3a3a3a',
		border: '#4a4a4a',
		textMain: '#ffffff',
		textDim: '#cccccc',
		accent: '#ff5500',
		accentDim: 'rgba(255, 85, 0, 0.2)',
		accentText: '#ffaa77',
		success: '#00ff00',
		warning: '#ffff00',
		error: '#ff0000',
	},
};

const customLightTheme: Theme = {
	id: 'custom-light',
	name: 'Custom Light',
	mode: 'light',
	colors: {
		bgMain: '#ffffff',
		bgSidebar: '#f0f0f0',
		bgActivity: '#e0e0e0',
		border: '#cccccc',
		textMain: '#000000',
		textDim: '#666666',
		accent: '#0066cc',
		accentDim: 'rgba(0, 102, 204, 0.1)',
		accentText: '#0066cc',
		success: '#008800',
		warning: '#886600',
		error: '#cc0000',
	},
};

const customVibeTheme: Theme = {
	id: 'custom-vibe',
	name: 'Custom Vibe',
	mode: 'vibe',
	colors: {
		bgMain: '#1a0a2e',
		bgSidebar: '#2a1a4e',
		bgActivity: '#3a2a6e',
		border: '#5a4a8e',
		textMain: '#e0d0ff',
		textDim: '#a090cc',
		accent: '#ff00ff',
		accentDim: 'rgba(255, 0, 255, 0.2)',
		accentText: '#ff88ff',
		success: '#00ff88',
		warning: '#ffaa00',
		error: '#ff0088',
	},
};

describe('ThemeProvider', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedUseDeviceColorScheme.mockReturnValue({
			colorScheme: 'dark',
			prefersDark: true,
			prefersLight: false,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('rendering', () => {
		it('renders children correctly', () => {
			render(
				<ThemeProvider>
					<div data-testid="child">Child content</div>
				</ThemeProvider>
			);
			expect(screen.getByTestId('child')).toBeInTheDocument();
		});

		it('renders multiple and nested children', () => {
			render(
				<ThemeProvider theme={customDarkTheme}>
					<ThemeProvider theme={customLightTheme}>
						<div data-testid="nested">Nested</div>
					</ThemeProvider>
				</ThemeProvider>
			);
			expect(screen.getByTestId('nested')).toBeInTheDocument();
		});
	});

	describe('theme prop', () => {
		it('uses provided theme', () => {
			let capturedTheme: Theme | null = null;
			function ThemeCapture() {
				const { theme } = useTheme();
				capturedTheme = theme;
				return null;
			}

			render(
				<ThemeProvider theme={customDarkTheme}>
					<ThemeCapture />
				</ThemeProvider>
			);

			expect(capturedTheme).toEqual(customDarkTheme);
		});

		it('sets isDevicePreference to false when theme prop is provided', () => {
			let capturedValue: ThemeContextValue | null = null;
			function ThemeCapture() {
				capturedValue = useTheme();
				return null;
			}

			render(
				<ThemeProvider theme={customDarkTheme}>
					<ThemeCapture />
				</ThemeProvider>
			);

			expect(capturedValue?.isDevicePreference).toBe(false);
		});

		it('theme prop overrides device preference', () => {
			mockedUseDeviceColorScheme.mockReturnValue({
				colorScheme: 'light',
				prefersDark: false,
				prefersLight: true,
			});

			let capturedTheme: Theme | null = null;
			function ThemeCapture() {
				const { theme } = useTheme();
				capturedTheme = theme;
				return null;
			}

			render(
				<ThemeProvider theme={customDarkTheme} useDevicePreference>
					<ThemeCapture />
				</ThemeProvider>
			);

			expect(capturedTheme?.id).toBe('custom-dark');
		});
	});

	describe('useDevicePreference prop', () => {
		it('uses dark theme when device prefers dark', () => {
			let capturedTheme: Theme | null = null;
			let isDevicePref = false;
			function ThemeCapture() {
				const { theme, isDevicePreference } = useTheme();
				capturedTheme = theme;
				isDevicePref = isDevicePreference;
				return null;
			}

			render(
				<ThemeProvider useDevicePreference>
					<ThemeCapture />
				</ThemeProvider>
			);

			expect(capturedTheme?.mode).toBe('dark');
			expect(isDevicePref).toBe(true);
		});

		it('uses light theme when device prefers light', () => {
			mockedUseDeviceColorScheme.mockReturnValue({
				colorScheme: 'light',
				prefersDark: false,
				prefersLight: true,
			});

			let capturedTheme: Theme | null = null;
			function ThemeCapture() {
				const { theme } = useTheme();
				capturedTheme = theme;
				return null;
			}

			render(
				<ThemeProvider useDevicePreference>
					<ThemeCapture />
				</ThemeProvider>
			);

			expect(capturedTheme?.mode).toBe('light');
		});

		it('defaults to dark theme when useDevicePreference is false', () => {
			mockedUseDeviceColorScheme.mockReturnValue({
				colorScheme: 'light',
				prefersDark: false,
				prefersLight: true,
			});

			let capturedTheme: Theme | null = null;
			function ThemeCapture() {
				const { theme } = useTheme();
				capturedTheme = theme;
				return null;
			}

			render(
				<ThemeProvider useDevicePreference={false}>
					<ThemeCapture />
				</ThemeProvider>
			);

			expect(capturedTheme?.mode).toBe('dark');
		});
	});

	describe('context value calculation', () => {
		it('sets mode flags correctly for each theme mode', () => {
			const modes = [
				{ theme: customDarkTheme, isDark: true, isLight: false, isVibe: false },
				{ theme: customLightTheme, isDark: false, isLight: true, isVibe: false },
				{ theme: customVibeTheme, isDark: false, isLight: false, isVibe: true },
			];

			modes.forEach(({ theme, isDark, isLight, isVibe }) => {
				let capturedValue: ThemeContextValue | null = null;
				function ThemeCapture() {
					capturedValue = useTheme();
					return null;
				}

				const { unmount } = render(
					<ThemeProvider theme={theme}>
						<ThemeCapture />
					</ThemeProvider>
				);

				expect(capturedValue?.isDark).toBe(isDark);
				expect(capturedValue?.isLight).toBe(isLight);
				expect(capturedValue?.isVibe).toBe(isVibe);
				unmount();
			});
		});
	});

	describe('CSS injection', () => {
		it('injects CSS properties on mount', () => {
			render(
				<ThemeProvider theme={customDarkTheme}>
					<div>Content</div>
				</ThemeProvider>
			);

			expect(mockedCssCustomProperties.injectCSSProperties).toHaveBeenCalledWith(customDarkTheme);
		});

		it('removes CSS properties on unmount', () => {
			const { unmount } = render(
				<ThemeProvider theme={customDarkTheme}>
					<div>Content</div>
				</ThemeProvider>
			);

			unmount();
			expect(mockedCssCustomProperties.removeCSSProperties).toHaveBeenCalled();
		});

		it('updates CSS properties when theme changes', () => {
			const { rerender } = render(
				<ThemeProvider theme={customDarkTheme}>
					<div>Content</div>
				</ThemeProvider>
			);

			rerender(
				<ThemeProvider theme={customLightTheme}>
					<div>Content</div>
				</ThemeProvider>
			);

			expect(mockedCssCustomProperties.injectCSSProperties).toHaveBeenCalledTimes(2);
			expect(mockedCssCustomProperties.injectCSSProperties).toHaveBeenLastCalledWith(
				customLightTheme
			);
		});
	});

	describe('theme switching', () => {
		it('switches between themes correctly', () => {
			let capturedTheme: Theme | null = null;
			function ThemeCapture() {
				const { theme } = useTheme();
				capturedTheme = theme;
				return null;
			}

			const { rerender } = render(
				<ThemeProvider theme={customDarkTheme}>
					<ThemeCapture />
				</ThemeProvider>
			);

			expect(capturedTheme?.mode).toBe('dark');

			rerender(
				<ThemeProvider theme={customLightTheme}>
					<ThemeCapture />
				</ThemeProvider>
			);

			expect(capturedTheme?.mode).toBe('light');
		});

		it('responds to device color scheme changes', () => {
			let capturedTheme: Theme | null = null;
			function ThemeCapture() {
				const { theme } = useTheme();
				capturedTheme = theme;
				return null;
			}

			const { rerender } = render(
				<ThemeProvider useDevicePreference>
					<ThemeCapture />
				</ThemeProvider>
			);

			expect(capturedTheme?.mode).toBe('dark');

			mockedUseDeviceColorScheme.mockReturnValue({
				colorScheme: 'light',
				prefersDark: false,
				prefersLight: true,
			});

			rerender(
				<ThemeProvider useDevicePreference>
					<ThemeCapture />
				</ThemeProvider>
			);

			expect(capturedTheme?.mode).toBe('light');
		});
	});
});

describe('useTheme hook', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns theme context value within provider', () => {
		const { result } = renderHook(() => useTheme(), {
			wrapper: ({ children }) => <ThemeProvider theme={customDarkTheme}>{children}</ThemeProvider>,
		});

		expect(result.current.theme).toEqual(customDarkTheme);
		expect(result.current.isDark).toBe(true);
	});

	it('throws error when used outside provider', () => {
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		expect(() => {
			renderHook(() => useTheme());
		}).toThrow('useTheme must be used within a ThemeProvider');

		consoleSpy.mockRestore();
	});
});

describe('useThemeColors hook', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns theme colors within provider', () => {
		const { result } = renderHook(() => useThemeColors(), {
			wrapper: ({ children }) => <ThemeProvider theme={customDarkTheme}>{children}</ThemeProvider>,
		});

		expect(result.current).toEqual(customDarkTheme.colors);
	});

	it('throws error when used outside provider', () => {
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		expect(() => {
			renderHook(() => useThemeColors());
		}).toThrow('useTheme must be used within a ThemeProvider');

		consoleSpy.mockRestore();
	});
});

describe('ThemeContext export', () => {
	it('is a valid React context', () => {
		expect(ThemeContext).toBeDefined();
		expect(ThemeContext.Provider).toBeDefined();
		expect(ThemeContext.Consumer).toBeDefined();
	});

	it('can be used with useContext directly', () => {
		function DirectContextConsumer() {
			const context = React.useContext(ThemeContext);
			return <div data-testid="context-value">{context?.theme.id || 'null'}</div>;
		}

		render(
			<ThemeProvider theme={customDarkTheme}>
				<DirectContextConsumer />
			</ThemeProvider>
		);

		expect(screen.getByTestId('context-value')).toHaveTextContent('custom-dark');
	});
});
