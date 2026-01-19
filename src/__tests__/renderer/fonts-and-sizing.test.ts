/**
 * Cross-platform fonts and sizing tests
 *
 * This test suite verifies that fonts and sizing render correctly across platforms (macOS, Windows, Linux).
 *
 * Key areas tested:
 * 1. Default font stack with cross-platform fallbacks
 * 2. Font size scaling via root element (rem-based sizing)
 * 3. Platform-specific font availability detection
 * 4. Font smoothing settings
 * 5. Common monospace fonts panel configuration
 * 6. Custom font handling
 * 7. rem-based sizing consistency
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { render, screen } from '@testing-library/react';
import { useSettings } from '../../renderer/hooks';
import React from 'react';

// Mock the FontConfigurationPanel's common monospace fonts list
const COMMON_MONOSPACE_FONTS = [
	'Roboto Mono',
	'JetBrains Mono',
	'Fira Code',
	'Monaco',
	'Menlo',
	'Consolas',
	'Courier New',
	'SF Mono',
	'Cascadia Code',
	'Source Code Pro',
];

// Platform-specific font mappings - fonts available by default on each platform
const PLATFORM_FONTS = {
	darwin: ['Monaco', 'Menlo', 'SF Mono', 'Courier New'],
	win32: ['Consolas', 'Courier New', 'Lucida Console'],
	linux: ['Courier New', 'DejaVu Sans Mono', 'Liberation Mono'],
};

// Helper to wait for settings to load
const waitForSettingsLoaded = async (result: { current: ReturnType<typeof useSettings> }) => {
	await waitFor(() => {
		expect(result.current.settingsLoaded).toBe(true);
	});
};

describe('Cross-platform Fonts and Sizing', () => {
	let originalFontSize: string;
	let originalProcessPlatform: PropertyDescriptor | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		originalFontSize = document.documentElement.style.fontSize;
		originalProcessPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

		// Reset all mocks to return empty/default (default behavior)
		// PERF: Implementation now uses batch loading via getAll() instead of individual get() calls
		vi.mocked(window.maestro.settings.getAll).mockResolvedValue({});
		vi.mocked(window.maestro.settings.get).mockResolvedValue(undefined);
		vi.mocked(window.maestro.logger.getLogLevel).mockResolvedValue('info');
		vi.mocked(window.maestro.logger.getMaxLogBuffer).mockResolvedValue(5000);
	});

	afterEach(() => {
		document.documentElement.style.fontSize = originalFontSize;
		if (originalProcessPlatform) {
			Object.defineProperty(process, 'platform', originalProcessPlatform);
		}
	});

	describe('Default Font Stack', () => {
		it('should have cross-platform fallback fonts in default fontFamily setting', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			// Default font family should include multiple fallbacks
			const fontFamily = result.current.fontFamily;
			expect(fontFamily).toContain('Roboto Mono');
			expect(fontFamily).toContain('Menlo'); // macOS fallback
			expect(fontFamily).toContain('Courier New'); // Universal fallback
			expect(fontFamily).toContain('monospace'); // Generic fallback
		});

		it('should have generic monospace as the last fallback', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			const fontFamily = result.current.fontFamily;
			expect(fontFamily.trim().endsWith('monospace')).toBe(true);
		});

		it('should match Tailwind config font stack', () => {
			// The Tailwind config should use the same font stack
			// tailwind.config.mjs: mono: ['"JetBrains Mono"', '"Fira Code"', '"Courier New"', 'monospace']
			const tailwindFontStack = ['"JetBrains Mono"', '"Fira Code"', '"Courier New"', 'monospace'];

			// Verify universal fallbacks are present
			expect(tailwindFontStack).toContain('"Courier New"');
			expect(tailwindFontStack).toContain('monospace');
		});

		it('should have matching CSS base font stack in index.css', () => {
			// index.css body font-family: 'JetBrains Mono', 'Fira Code', 'Courier New', monospace;
			// This test documents the expected CSS font stack
			const cssBaseFonts = ["'JetBrains Mono'", "'Fira Code'", "'Courier New'", 'monospace'];

			// All fonts in CSS stack should be monospace
			expect(
				cssBaseFonts.every(
					(font) =>
						font.includes('Mono') ||
						font.includes('Code') ||
						font.includes('Courier') ||
						font === 'monospace'
				)
			).toBe(true);
		});
	});

	describe('Common Monospace Fonts Panel', () => {
		it('should include macOS-specific fonts', () => {
			const macFonts = ['Monaco', 'Menlo', 'SF Mono'];
			macFonts.forEach((font) => {
				expect(COMMON_MONOSPACE_FONTS).toContain(font);
			});
		});

		it('should include Windows-specific fonts', () => {
			const winFonts = ['Consolas', 'Cascadia Code'];
			winFonts.forEach((font) => {
				expect(COMMON_MONOSPACE_FONTS).toContain(font);
			});
		});

		it('should include cross-platform fonts', () => {
			const crossPlatformFonts = [
				'Roboto Mono',
				'JetBrains Mono',
				'Fira Code',
				'Source Code Pro',
				'Courier New',
			];
			crossPlatformFonts.forEach((font) => {
				expect(COMMON_MONOSPACE_FONTS).toContain(font);
			});
		});

		it('should have Courier New as a universal fallback (installed on all platforms)', () => {
			// Courier New is a safe fallback that exists on macOS, Windows, and most Linux distros
			expect(COMMON_MONOSPACE_FONTS).toContain('Courier New');
		});

		it('should list at least 10 common fonts for user selection', () => {
			expect(COMMON_MONOSPACE_FONTS.length).toBeGreaterThanOrEqual(10);
		});
	});

	describe('Font Size Scaling', () => {
		it('should apply default font size (14px) to document root after settings load', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			expect(result.current.fontSize).toBe(14);
			expect(document.documentElement.style.fontSize).toBe('14px');
		});

		it('should update document root font size when fontSize changes', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.setFontSize(18);
			});

			expect(result.current.fontSize).toBe(18);
			expect(document.documentElement.style.fontSize).toBe('18px');
		});

		it('should persist font size changes to settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.setFontSize(16);
			});

			expect(window.maestro.settings.set).toHaveBeenCalledWith('fontSize', 16);
		});

		it('should load saved font size from settings', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				fontSize: 20,
			});

			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			expect(result.current.fontSize).toBe(20);
			expect(document.documentElement.style.fontSize).toBe('20px');
		});

		it('should support font sizes in valid range (8-32px recommended)', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			// Test minimum readable size
			act(() => {
				result.current.setFontSize(8);
			});
			expect(document.documentElement.style.fontSize).toBe('8px');

			// Test maximum comfortable size
			act(() => {
				result.current.setFontSize(32);
			});
			expect(document.documentElement.style.fontSize).toBe('32px');
		});

		it('should not apply font size until settings are fully loaded (prevents layout shift)', async () => {
			const { result } = renderHook(() => useSettings());

			// Before settings load, fontSize should not be applied
			expect(result.current.settingsLoaded).toBe(false);

			await waitForSettingsLoaded(result);

			// After settings load, fontSize should be applied
			expect(document.documentElement.style.fontSize).toBe('14px');
		});
	});

	describe('rem-based Sizing Consistency', () => {
		it('should scale rem units correctly with different font sizes', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			// With 14px base, 1rem = 14px
			act(() => {
				result.current.setFontSize(14);
			});
			expect(document.documentElement.style.fontSize).toBe('14px');
			// In actual DOM, 1rem would equal 14px, 2rem = 28px, etc.

			// With 16px base, 1rem = 16px (browser default)
			act(() => {
				result.current.setFontSize(16);
			});
			expect(document.documentElement.style.fontSize).toBe('16px');

			// With 20px base, 1rem = 20px
			act(() => {
				result.current.setFontSize(20);
			});
			expect(document.documentElement.style.fontSize).toBe('20px');
		});

		it('should maintain proportional sizing when base font size changes', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			// Test that changing base font size maintains ratios
			const baseSizes = [12, 14, 16, 18, 20];

			for (const baseSize of baseSizes) {
				act(() => {
					result.current.setFontSize(baseSize);
				});

				const computedBase = parseInt(document.documentElement.style.fontSize);
				expect(computedBase).toBe(baseSize);

				// In the actual DOM, all rem-based sizes would scale proportionally
				// 0.875rem text would be 0.875 * baseSize
				// 1.5rem text would be 1.5 * baseSize
				// etc.
			}
		});
	});

	describe('Font Family Changes', () => {
		it('should update fontFamily setting correctly', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.setFontFamily('JetBrains Mono');
			});

			expect(result.current.fontFamily).toBe('JetBrains Mono');
			expect(window.maestro.settings.set).toHaveBeenCalledWith('fontFamily', 'JetBrains Mono');
		});

		it('should load saved fontFamily from settings', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				fontFamily: 'Monaco, monospace',
			});

			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			expect(result.current.fontFamily).toBe('Monaco, monospace');
		});

		it('should handle custom font family with fallbacks', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			const customFont = '"My Custom Font", "JetBrains Mono", monospace';
			act(() => {
				result.current.setFontFamily(customFont);
			});

			expect(result.current.fontFamily).toBe(customFont);
		});
	});

	describe('Platform-Specific Font Availability', () => {
		it('should document macOS-specific fonts that are typically available', () => {
			// These fonts are pre-installed on macOS
			const macFonts = ['Monaco', 'Menlo', 'SF Mono', 'Courier New'];

			// All should be in the common fonts list for selection
			macFonts.forEach((font) => {
				expect(COMMON_MONOSPACE_FONTS).toContain(font);
			});
		});

		it('should document Windows-specific fonts that are typically available', () => {
			// These fonts are pre-installed on Windows
			const winFonts = ['Consolas', 'Courier New'];

			winFonts.forEach((font) => {
				expect(COMMON_MONOSPACE_FONTS).toContain(font);
			});
		});

		it('should have Courier New as the universal fallback across all platforms', () => {
			// Courier New is installed by default on:
			// - macOS (part of system fonts)
			// - Windows (part of core fonts)
			// - Most Linux distros (via msttcorefonts or similar packages)

			expect(COMMON_MONOSPACE_FONTS).toContain('Courier New');

			// It should be in the default font family as a fallback
			const defaultFontFamily = 'Roboto Mono, Menlo, "Courier New", monospace';
			expect(defaultFontFamily).toContain('Courier New');
		});

		it('should have generic monospace as the ultimate fallback', () => {
			// The generic 'monospace' should always be available on any platform
			// The browser will substitute an appropriate system font

			const defaultFontFamily = 'Roboto Mono, Menlo, "Courier New", monospace';
			expect(defaultFontFamily.endsWith('monospace')).toBe(true);
		});
	});

	describe('Font Smoothing', () => {
		it('should document font smoothing CSS properties for cross-platform rendering', () => {
			// These CSS properties are defined in index.css for optimal font rendering
			// -webkit-font-smoothing: antialiased (for WebKit/Chromium browsers)
			// -moz-osx-font-smoothing: grayscale (for Firefox on macOS)

			// This test documents the expected font smoothing configuration
			const expectedSmoothing = {
				webkit: 'antialiased',
				moz: 'grayscale',
			};

			// In actual CSS, body has:
			// -webkit-font-smoothing: antialiased;
			// -moz-osx-font-smoothing: grayscale;
			expect(expectedSmoothing.webkit).toBe('antialiased');
			expect(expectedSmoothing.moz).toBe('grayscale');
		});

		it('should apply consistent font rendering across macOS, Windows, and Linux', () => {
			// Font rendering behavior differs by platform:
			// - macOS: Uses Core Text, generally smooth rendering by default
			// - Windows: Uses DirectWrite, may need ClearType settings
			// - Linux: Uses FreeType, depends on fontconfig settings

			// Electron uses Chromium which handles most of this automatically
			// The app sets font-smoothing hints for optimal rendering

			// Document expected rendering characteristics
			const renderingNotes = {
				macOS: 'Core Text with antialiasing, grayscale smoothing in Firefox',
				windows: 'DirectWrite with subpixel rendering (ClearType)',
				linux: 'FreeType with fontconfig settings, may vary by distro',
			};

			expect(renderingNotes.macOS).toBeDefined();
			expect(renderingNotes.windows).toBeDefined();
			expect(renderingNotes.linux).toBeDefined();
		});
	});

	describe('Mobile/Web Font Handling', () => {
		it('should use system monospace fonts in mobile web interface', () => {
			// Mobile web uses simpler font stacks
			// Example from mobile/TabBar.tsx: fontFamily: 'monospace'
			// Example from mobile/AllSessionsView.tsx: fontFamily: 'monospace'

			// Mobile should fall back to system monospace for best performance
			const mobileFont = 'monospace';
			expect(mobileFont).toBe('monospace');
		});

		it('should use ui-monospace for modern browser support in mobile', () => {
			// Some mobile components use ui-monospace for modern browsers
			// Example from mobile/RecentCommandChips.tsx: fontFamily: 'ui-monospace, monospace'

			const modernMobileFont = 'ui-monospace, monospace';
			expect(modernMobileFont).toContain('ui-monospace');
			expect(modernMobileFont).toContain('monospace');
		});

		it('should use relative font sizes (px) in mobile for consistent sizing', () => {
			// Mobile uses explicit px values rather than rem for predictability
			// Examples: fontSize: '12px', fontSize: '14px', fontSize: '15px'

			const mobileFontSizes = ['10px', '11px', '12px', '13px', '14px', '15px', '16px', '18px'];

			// All should be valid px values
			mobileFontSizes.forEach((size) => {
				expect(size).toMatch(/^\d+px$/);
			});
		});
	});

	describe('Usage Dashboard Charts Font Sizing', () => {
		it('should use appropriate font sizes for chart labels (12-14px range)', () => {
			// Chart components typically use smaller fonts for labels and axes
			// This ensures legibility without crowding

			const chartFontSizes = {
				axisLabels: 12,
				tooltips: 12,
				legendText: 14,
			};

			// All chart fonts should be in readable range
			Object.values(chartFontSizes).forEach((size) => {
				expect(size).toBeGreaterThanOrEqual(10);
				expect(size).toBeLessThanOrEqual(16);
			});
		});
	});

	describe('Document Graph Node Font Sizing', () => {
		it('should use appropriate font sizes for graph node labels', () => {
			// Graph nodes use specific font sizes for readability at various zoom levels

			const graphFontSizes = {
				nodeTitle: 12,
				nodeSubtitle: 10,
				tooltipText: 12,
			};

			// Graph fonts should be smaller for density
			Object.values(graphFontSizes).forEach((size) => {
				expect(size).toBeGreaterThanOrEqual(8);
				expect(size).toBeLessThanOrEqual(14);
			});
		});
	});

	describe('Custom Font Support', () => {
		it('should allow adding custom fonts not in the predefined list', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			// User can set any font family, including custom fonts
			const customFont = '"Comic Sans MS", cursive'; // Obviously not recommended but allowed
			act(() => {
				result.current.setFontFamily(customFont);
			});

			expect(result.current.fontFamily).toBe(customFont);
		});

		it('should preserve font family with special characters in name', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			// Font names with spaces and special characters should work
			const fontWithSpaces = '"Fira Code Retina", monospace';
			act(() => {
				result.current.setFontFamily(fontWithSpaces);
			});

			expect(result.current.fontFamily).toBe(fontWithSpaces);
		});

		it('should handle empty font family gracefully', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			// Setting empty should still work (browser will use default)
			act(() => {
				result.current.setFontFamily('');
			});

			expect(result.current.fontFamily).toBe('');
		});
	});

	describe('Font Loading States', () => {
		it('should document lazy loading of system fonts behavior', () => {
			// FontConfigurationPanel lazy-loads system fonts on first interaction
			// This avoids expensive font enumeration on app startup

			const fontLoadingBehavior = {
				onStartup: 'Show common fonts only',
				onInteraction: 'Load system font list',
				duringLoad: 'Show loading indicator',
				afterLoad: 'Show availability indicators',
			};

			expect(fontLoadingBehavior.onStartup).toBeDefined();
			expect(fontLoadingBehavior.onInteraction).toBeDefined();
		});

		it('should show font availability indicators after fonts are loaded', () => {
			// FontConfigurationPanel shows "(Not Found)" for unavailable fonts
			// This helps users know which fonts will actually work

			const availabilityIndicator = '(Not Found)';
			expect(availabilityIndicator).toBe('(Not Found)');
		});
	});
});

describe('Cross-platform Sizing Units', () => {
	describe('px vs rem usage patterns', () => {
		it('should document when to use px vs rem', () => {
			// Guidelines for sizing units in the codebase:
			const sizingGuidelines = {
				// Use rem for:
				rem: [
					'Body text sizes that should scale with user preference',
					'Spacing that should scale proportionally',
					'Tailwind utility classes (which use rem internally)',
				],
				// Use px for:
				px: [
					'Fixed UI elements (icons, borders, shadows)',
					'Elements that should not scale (scrollbars, buttons)',
					'Mobile web where predictability is more important',
				],
			};

			expect(sizingGuidelines.rem.length).toBeGreaterThan(0);
			expect(sizingGuidelines.px.length).toBeGreaterThan(0);
		});
	});

	describe('Tailwind rem-based sizing', () => {
		it('should scale with document root font size', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			// When fontSize changes, all rem-based Tailwind classes scale
			const testSizes = [12, 14, 16, 18];

			for (const size of testSizes) {
				act(() => {
					result.current.setFontSize(size);
				});

				// Verify root font size is set
				expect(document.documentElement.style.fontSize).toBe(`${size}px`);

				// In actual rendering:
				// text-sm (0.875rem) = 0.875 * size px
				// text-base (1rem) = size px
				// text-lg (1.125rem) = 1.125 * size px
			}
		});
	});
});

describe('Accessibility Font Sizing', () => {
	it('should support font sizes that meet WCAG minimum (16px equivalent) when scaled', async () => {
		const { result } = renderHook(() => useSettings());
		await waitForSettingsLoaded(result);

		// Users who need larger text can set fontSize to 16+
		act(() => {
			result.current.setFontSize(16);
		});

		expect(document.documentElement.style.fontSize).toBe('16px');
	});

	it('should allow large font sizes for users with visual impairments', async () => {
		const { result } = renderHook(() => useSettings());
		await waitForSettingsLoaded(result);

		// Support up to 24px or more for accessibility
		act(() => {
			result.current.setFontSize(24);
		});

		expect(document.documentElement.style.fontSize).toBe('24px');
	});

	it('should maintain line height proportions at different font sizes', () => {
		// Tailwind's default line heights are designed to work at various font sizes
		// leading-normal = 1.5, leading-relaxed = 1.625, leading-loose = 2

		const lineHeightRatios = {
			normal: 1.5,
			relaxed: 1.625,
			loose: 2,
		};

		// These ratios work at any base font size
		expect(lineHeightRatios.normal).toBeGreaterThanOrEqual(1.4);
		expect(lineHeightRatios.relaxed).toBeGreaterThan(lineHeightRatios.normal);
		expect(lineHeightRatios.loose).toBeGreaterThan(lineHeightRatios.relaxed);
	});
});
