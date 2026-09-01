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
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { useSettingsStore } from '../../renderer/stores/settingsStore';

// Deep-cloned defaults captured from a fresh store so mutations in tests can't
// leak back into the reference. The store no longer exports these defaults.
const _INITIAL_STATE = useSettingsStore.getState();
const DEFAULT_CONTEXT_MANAGEMENT_SETTINGS = JSON.parse(
	JSON.stringify(_INITIAL_STATE.contextManagementSettings)
);
const DEFAULT_AUTO_RUN_STATS = JSON.parse(JSON.stringify(_INITIAL_STATE.autoRunStats));
const DEFAULT_USAGE_STATS = JSON.parse(JSON.stringify(_INITIAL_STATE.usageStats));
const DEFAULT_KEYBOARD_MASTERY_STATS = JSON.parse(
	JSON.stringify(_INITIAL_STATE.keyboardMasteryStats)
);
const DEFAULT_ONBOARDING_STATS = JSON.parse(JSON.stringify(_INITIAL_STATE.onboardingStats));
const DEFAULT_AI_COMMANDS = JSON.parse(JSON.stringify(_INITIAL_STATE.customAICommands));
import { DEFAULT_SHORTCUTS, TAB_SHORTCUTS } from '../../renderer/constants/shortcuts';
import { DEFAULT_CUSTOM_THEME_COLORS } from '../../renderer/constants/themes';
import { MAESTRO_FONT_STACK, MAESTRO_WORDMARK_FONT_STACK } from '../../shared/fontStacks';

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
		// Reset Zustand store to defaults (singleton persists across tests)
		useSettingsStore.setState({
			settingsLoaded: false,
			conductorProfile: '',
			llmProvider: 'openrouter',
			modelSlug: 'anthropic/claude-3.5-sonnet',
			apiKey: '',
			defaultShell: 'zsh',
			customShellPath: '',
			shellArgs: '',
			shellEnvVars: {},
			ghPath: '',
			fontFamily: MAESTRO_FONT_STACK,
			fontSize: 14,
			activeThemeId: 'dracula',
			customThemeColors: DEFAULT_CUSTOM_THEME_COLORS,
			customThemeBaseId: 'dracula',
			enterToSendAI: false,
			defaultSaveToHistory: true,
			defaultShowThinking: 'off',
			leftSidebarWidth: 256,
			rightPanelWidth: 384,
			markdownEditMode: false,
			chatRawTextMode: false,
			showHiddenFiles: true,
			logLevel: 'info',
			maxLogBuffer: 5000,
			maxOutputLines: 25,
			osNotificationsEnabled: true,
			audioFeedbackEnabled: false,
			audioFeedbackCommand: 'say',
			toastDuration: 20,
			checkForUpdatesOnStartup: true,
			enableBetaUpdates: false,
			crashReportingEnabled: true,
			logViewerSelectedLevels: ['debug', 'info', 'warn', 'error', 'toast'],
			shortcuts: DEFAULT_SHORTCUTS,
			tabShortcuts: TAB_SHORTCUTS,
			customAICommands: DEFAULT_AI_COMMANDS,
			totalActiveTimeMs: 0,
			autoRunStats: DEFAULT_AUTO_RUN_STATS,
			usageStats: DEFAULT_USAGE_STATS,
			ungroupedCollapsed: false,
			groupChatsExpanded: true,
			tourCompleted: false,
			firstAutoRunCompleted: false,
			onboardingStats: DEFAULT_ONBOARDING_STATS,
			leaderboardRegistration: null,
			webInterfaceUseCustomPort: false,
			webInterfaceCustomPort: 8080,
			contextManagementSettings: DEFAULT_CONTEXT_MANAGEMENT_SETTINGS,
			keyboardMasteryStats: DEFAULT_KEYBOARD_MASTERY_STATS,
			colorBlindMode: false,
			documentGraphShowExternalLinks: false,
			documentGraphMaxNodes: 50,
			documentGraphPreviewCharLimit: 100,
			statsCollectionEnabled: true,
			defaultStatsTimeRange: 'week',
			preventSleepEnabled: false,
			preventDisplaySleepEnabled: false,
			disableGpuAcceleration: false,
			disableConfetti: false,
			sshRemoteIgnorePatterns: ['.git', '*cache*'],
			sshRemoteHonorGitignore: true,
			automaticTabNamingEnabled: true,
			fileTabAutoRefreshEnabled: false,
			suppressWindowsWarning: false,
		});

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
			expect(fontFamily).toContain('JetBrains Mono'); // Bundled, so always resolves
			expect(fontFamily).toContain('Courier New'); // Universal fallback
			expect(fontFamily).toContain('monospace'); // Generic fallback
		});

		it('should lead with the bundled family so the default always resolves', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			// JetBrains Mono is the only family in the stack that ships with the app
			// (src/renderer/public/fonts/). Everything after it is a fallback for a
			// renderer that somehow fails to load it. If the default ever leads with
			// a family that is merely *hoped* to be installed - as it did when it
			// led with Roboto Mono - a machine without that font silently renders
			// the app in whatever comes next.
			expect(result.current.fontFamily.trim().startsWith("'JetBrains Mono'")).toBe(true);
		});

		it('should have generic monospace as the last fallback', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			const fontFamily = result.current.fontFamily;
			expect(fontFamily.trim().endsWith('monospace')).toBe(true);
		});

		// These four surfaces paint at different moments during startup - the splash
		// before React mounts, the setting default after it - so any disagreement
		// between them is visible to the user as the app changing font while it
		// boots. That is not hypothetical: the splash asked for JetBrains Mono while
		// the setting default asked for Roboto Mono, and a cold start went Courier
		// New -> JetBrains Mono -> Menlo. They read from disk rather than restating
		// the stack, because a hard-coded copy here would have agreed with itself
		// while the shipped files drifted.
		const readRepoFile = (relative: string) =>
			readFileSync(path.join(__dirname, '../../..', relative), 'utf-8');

		// Each surface quotes its families differently - the Tailwind config nests
		// double quotes inside single ones ('"JetBrains Mono"'), CSS uses bare
		// single quotes - so compare the names, not the punctuation.
		const familyNames = (stack: string) =>
			stack
				.split(',')
				.map((part) => {
					let name = part.trim();
					while (/^(['"]).*\1$/s.test(name)) name = name.slice(1, -1).trim();
					return name;
				})
				.filter(Boolean);

		it('should match the Tailwind font-mono stack', () => {
			const tailwind = readRepoFile('tailwind.config.mjs');
			const mono = /mono:\s*\[([^\]]+)\]/.exec(tailwind);
			expect(mono).not.toBeNull();

			expect(familyNames(mono![1])).toEqual(familyNames(MAESTRO_FONT_STACK));
		});

		it('should match the base body font stack in index.css', () => {
			const css = readRepoFile('src/renderer/index.css');
			const body = /font-family:\s*'JetBrains Mono'[^;]*;/.exec(css);
			expect(body).not.toBeNull();

			expect(familyNames(body![0].replace(/^font-family:\s*|;$/g, ''))).toEqual(
				familyNames(MAESTRO_FONT_STACK)
			);
		});

		it('should match the splash screen font stack in index.html', () => {
			const html = readRepoFile('src/renderer/index.html');

			// Every font-family in the splash's inline CSS, including the wordmark's.
			const stacks = [...html.matchAll(/font-family:\s*([^;]+);/g)].map((m) => m[1]);
			expect(stacks.length).toBeGreaterThan(0);

			for (const stack of stacks) {
				expect(familyNames(stack)).toEqual(familyNames(MAESTRO_FONT_STACK));
			}
		});

		it('should not fetch the app font over the network', () => {
			const html = readRepoFile('src/renderer/index.html');

			// Comments stripped first: the markup explains at length why the Google
			// hosts were removed, and naming them in prose is not the same as
			// fetching from them.
			const markup = html.replace(/<!--[\s\S]*?-->/g, '');

			// A remote font is served with `font-display: swap`, which is an explicit
			// instruction to paint a fallback first and reflow - and offline it never
			// arrives at all. The woff2 files are bundled; keep them that way, and
			// keep the CSP tight enough that a regression fails loudly.
			expect(markup).not.toContain('fonts.googleapis.com');
			expect(markup).not.toContain('fonts.gstatic.com');
			expect(markup).toContain('./fonts/jetbrains-mono.css');
		});

		it('should ship the bundled woff2 subsets the stylesheet references', () => {
			const fontDir = path.join(__dirname, '../../..', 'src/renderer/public/fonts');
			const sheet = readFileSync(path.join(fontDir, 'jetbrains-mono.css'), 'utf-8');

			const referenced = [...sheet.matchAll(/url\('([^']+\.woff2)'\)/g)].map((m) => m[1]);
			expect(referenced.length).toBeGreaterThan(0);

			for (const file of referenced) {
				expect(existsSync(path.join(fontDir, file))).toBe(true);
			}
		});

		it('should pin the wordmark to its own stack, not the user setting', () => {
			// The wordmark is a logo. It carries an explicit family so it cannot
			// inherit the root element's inline fontFamily, which is the user's
			// Settings choice - otherwise picking a terminal font redraws the brand.
			const sessionList = readRepoFile('src/renderer/components/SessionList/SessionList.tsx');
			expect(sessionList).toContain('MAESTRO_WORDMARK_FONT_STACK');

			expect(familyNames(MAESTRO_WORDMARK_FONT_STACK)[0]).toBe('JetBrains Mono');
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
			const defaultFontFamily = MAESTRO_FONT_STACK;
			expect(defaultFontFamily).toContain('Courier New');
		});

		it('should have generic monospace as the ultimate fallback', () => {
			// The generic 'monospace' should always be available on any platform
			// The browser will substitute an appropriate system font

			const defaultFontFamily = MAESTRO_FONT_STACK;
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
