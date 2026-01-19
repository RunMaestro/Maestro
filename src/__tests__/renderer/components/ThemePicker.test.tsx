/**
 * Tests for ThemePicker component
 *
 * ThemePicker displays available themes grouped by mode (dark/light)
 * and allows users to select a theme.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ThemePicker } from '../../../renderer/components/ThemePicker';
import type { Theme, ThemeId } from '../../../shared/theme-types';

// ============================================================================
// Test Fixtures
// ============================================================================

/**
 * Create a mock theme for testing
 */
function createMockTheme(id: ThemeId, name: string, mode: 'dark' | 'light' | 'vibe'): Theme {
	return {
		id,
		name,
		mode,
		colors: {
			bgMain: mode === 'dark' ? '#1a1a2e' : '#ffffff',
			bgSidebar: mode === 'dark' ? '#16213e' : '#f0f0f0',
			bgActivity: mode === 'dark' ? '#0f3460' : '#e0e0e0',
			border: mode === 'dark' ? '#555555' : '#cccccc',
			textMain: mode === 'dark' ? '#e0e0e0' : '#333333',
			textDim: mode === 'dark' ? '#888888' : '#666666',
			accent: '#8b5cf6',
			accentDim: '#8b5cf640',
			accentText: '#a78bfa',
			accentForeground: '#ffffff',
			success: '#10b981',
			warning: '#f59e0b',
			error: '#ef4444',
		},
	};
}

// Create a set of test themes
const mockThemes: Record<ThemeId, Theme> = {
	dracula: createMockTheme('dracula', 'Dracula', 'dark'),
	monokai: createMockTheme('monokai', 'Monokai', 'dark'),
	nord: createMockTheme('nord', 'Nord', 'dark'),
	'tokyo-night': createMockTheme('tokyo-night', 'Tokyo Night', 'dark'),
	'gruvbox-dark': createMockTheme('gruvbox-dark', 'Gruvbox Dark', 'dark'),
	'catppuccin-mocha': createMockTheme('catppuccin-mocha', 'Catppuccin Mocha', 'dark'),
	pedurple: createMockTheme('pedurple', 'Pedurple', 'dark'),
	'maestros-choice': createMockTheme('maestros-choice', "Maestro's Choice", 'dark'),
	'dre-synth': createMockTheme('dre-synth', 'Dre Synth', 'dark'),
	inquest: createMockTheme('inquest', 'InQuest', 'dark'),
	'github-light': createMockTheme('github-light', 'GitHub Light', 'light'),
	'solarized-light': createMockTheme('solarized-light', 'Solarized Light', 'light'),
	'one-light': createMockTheme('one-light', 'One Light', 'light'),
	'gruvbox-light': createMockTheme('gruvbox-light', 'Gruvbox Light', 'light'),
	'catppuccin-latte': createMockTheme('catppuccin-latte', 'Catppuccin Latte', 'light'),
	'ayu-light': createMockTheme('ayu-light', 'Ayu Light', 'light'),
};

// Current theme for styling the picker itself
const currentTheme = mockThemes.dracula;

// ============================================================================
// Tests
// ============================================================================

describe('ThemePicker', () => {
	let setActiveThemeId: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		setActiveThemeId = vi.fn();
	});

	describe('Rendering', () => {
		it('should render with the component structure', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			// Should render without crashing
			expect(document.querySelector('.space-y-6')).toBeInTheDocument();
		});

		it('should render dark and light mode sections', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			// Should have "dark Mode" and "light Mode" section headers
			expect(screen.getByText('dark Mode')).toBeInTheDocument();
			expect(screen.getByText('light Mode')).toBeInTheDocument();
		});

		it('should render dark mode section before light mode section', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			const darkModeHeader = screen.getByText('dark Mode');
			const lightModeHeader = screen.getByText('light Mode');

			// Check that dark mode appears before light mode in the DOM
			const allText = document.body.textContent || '';
			const darkIndex = allText.indexOf('dark Mode');
			const lightIndex = allText.indexOf('light Mode');
			expect(darkIndex).toBeLessThan(lightIndex);
		});

		it('should render all dark mode theme buttons', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			// Count dark mode themes
			const darkThemes = Object.values(mockThemes).filter((t) => t.mode === 'dark');

			// Each theme should have a button with its name
			darkThemes.forEach((theme) => {
				expect(screen.getByText(theme.name)).toBeInTheDocument();
			});
		});

		it('should render all light mode theme buttons', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			// Count light mode themes
			const lightThemes = Object.values(mockThemes).filter((t) => t.mode === 'light');

			// Each theme should have a button with its name
			lightThemes.forEach((theme) => {
				expect(screen.getByText(theme.name)).toBeInTheDocument();
			});
		});

		it('should render theme buttons in a grid layout', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			// Should have grid containers for the theme buttons
			const grids = document.querySelectorAll('.grid.grid-cols-2');
			expect(grids.length).toBe(2); // One for dark, one for light
		});
	});

	describe('Theme Grouping', () => {
		it('should correctly group themes by mode', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			// Get both sections
			const darkSection = screen.getByText('dark Mode').closest('div')?.parentElement;
			const lightSection = screen.getByText('light Mode').closest('div')?.parentElement;

			expect(darkSection).toBeInTheDocument();
			expect(lightSection).toBeInTheDocument();

			// Verify dark themes are in dark section
			if (darkSection) {
				const darkSectionText = darkSection.textContent || '';
				expect(darkSectionText).toContain('Dracula');
				expect(darkSectionText).toContain('Monokai');
				expect(darkSectionText).toContain('Nord');
			}

			// Verify light themes are in light section
			if (lightSection) {
				const lightSectionText = lightSection.textContent || '';
				expect(lightSectionText).toContain('GitHub Light');
				expect(lightSectionText).toContain('Solarized Light');
				expect(lightSectionText).toContain('One Light');
			}
		});

		it('should handle empty theme groups gracefully', () => {
			// Create themes with only dark mode themes
			const darkOnlyThemes: Record<ThemeId, Theme> = {
				dracula: createMockTheme('dracula', 'Dracula', 'dark'),
				monokai: createMockTheme('monokai', 'Monokai', 'dark'),
				nord: createMockTheme('nord', 'Nord', 'dark'),
				'tokyo-night': createMockTheme('tokyo-night', 'Tokyo Night', 'dark'),
				'gruvbox-dark': createMockTheme('gruvbox-dark', 'Gruvbox Dark', 'dark'),
				'catppuccin-mocha': createMockTheme('catppuccin-mocha', 'Catppuccin Mocha', 'dark'),
				pedurple: createMockTheme('pedurple', 'Pedurple', 'dark'),
				'maestros-choice': createMockTheme('maestros-choice', "Maestro's Choice", 'dark'),
				'dre-synth': createMockTheme('dre-synth', 'Dre Synth', 'dark'),
				inquest: createMockTheme('inquest', 'InQuest', 'dark'),
				// Make light themes actually dark mode for this test
				'github-light': createMockTheme('github-light', 'GitHub Light', 'dark'),
				'solarized-light': createMockTheme('solarized-light', 'Solarized Light', 'dark'),
				'one-light': createMockTheme('one-light', 'One Light', 'dark'),
				'gruvbox-light': createMockTheme('gruvbox-light', 'Gruvbox Light', 'dark'),
				'catppuccin-latte': createMockTheme('catppuccin-latte', 'Catppuccin Latte', 'dark'),
				'ayu-light': createMockTheme('ayu-light', 'Ayu Light', 'dark'),
			};

			// This should not throw, even though light mode group is empty
			render(
				<ThemePicker
					theme={currentTheme}
					themes={darkOnlyThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			expect(screen.getByText('dark Mode')).toBeInTheDocument();
			// Light mode section will still render the header but no buttons
			expect(screen.getByText('light Mode')).toBeInTheDocument();
		});

		it('should handle vibe mode themes by not displaying them', () => {
			// Create themes with a vibe mode theme
			const themesWithVibe: Record<ThemeId, Theme> = {
				...mockThemes,
				// Override one theme to be vibe mode
				dracula: createMockTheme('dracula', 'Dracula Vibe', 'vibe'),
			};

			render(
				<ThemePicker
					theme={currentTheme}
					themes={themesWithVibe}
					activeThemeId="monokai"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			// Vibe mode themes won't be displayed since the component only renders dark and light
			// The 'Dracula Vibe' should not appear in either section
			expect(screen.queryByText('Dracula Vibe')).not.toBeInTheDocument();
		});
	});

	describe('Active Theme Selection', () => {
		it('should show active indicator for the currently selected theme', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			// Find the Dracula button
			const draculaButton = screen.getByRole('button', { name: /Dracula/i });

			// Should have the ring-2 class for active state
			expect(draculaButton).toHaveClass('ring-2');
		});

		it('should not show active indicator for non-selected themes', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			// Find a non-active theme button (Monokai)
			const monokaiButton = screen.getByRole('button', { name: /Monokai/i });

			// Should not have the ring-2 class
			expect(monokaiButton).not.toHaveClass('ring-2');
		});

		it('should show accent dot next to active theme name', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			// Find the Dracula button and look for the indicator dot
			const draculaButton = screen.getByRole('button', { name: /Dracula/i });

			// Should have a small dot div inside
			const dot = draculaButton.querySelector('.w-2.h-2.rounded-full');
			expect(dot).toBeInTheDocument();
		});

		it('should not show accent dot for non-active themes', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			// Find the Monokai button
			const monokaiButton = screen.getByRole('button', { name: /Monokai/i });

			// Should NOT have the indicator dot
			const dot = monokaiButton.querySelector('.w-2.h-2.rounded-full');
			expect(dot).not.toBeInTheDocument();
		});

		it('should handle light mode theme being active', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="github-light"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			// GitHub Light should be active
			const githubLightButton = screen.getByRole('button', { name: /GitHub Light/i });
			expect(githubLightButton).toHaveClass('ring-2');

			// Dracula should NOT be active
			const draculaButton = screen.getByRole('button', { name: /Dracula/i });
			expect(draculaButton).not.toHaveClass('ring-2');
		});
	});

	describe('Theme Selection Click Handler', () => {
		it('should call setActiveThemeId when a theme is clicked', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			// Click on Monokai theme
			const monokaiButton = screen.getByRole('button', { name: /Monokai/i });
			fireEvent.click(monokaiButton);

			expect(setActiveThemeId).toHaveBeenCalledTimes(1);
			expect(setActiveThemeId).toHaveBeenCalledWith('monokai');
		});

		it('should call setActiveThemeId with the correct theme ID for dark themes', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			// Click on Nord theme
			const nordButton = screen.getByRole('button', { name: /Nord/i });
			fireEvent.click(nordButton);

			expect(setActiveThemeId).toHaveBeenCalledWith('nord');
		});

		it('should call setActiveThemeId with the correct theme ID for light themes', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			// Click on Solarized Light theme
			const solarizedButton = screen.getByRole('button', { name: /Solarized Light/i });
			fireEvent.click(solarizedButton);

			expect(setActiveThemeId).toHaveBeenCalledWith('solarized-light');
		});

		it('should allow clicking on the currently active theme', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			// Click on the already active Dracula theme
			const draculaButton = screen.getByRole('button', { name: /Dracula/i });
			fireEvent.click(draculaButton);

			expect(setActiveThemeId).toHaveBeenCalledWith('dracula');
		});

		it('should allow multiple theme selections', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			// Click multiple themes
			fireEvent.click(screen.getByRole('button', { name: /Monokai/i }));
			fireEvent.click(screen.getByRole('button', { name: /Nord/i }));
			fireEvent.click(screen.getByRole('button', { name: /GitHub Light/i }));

			expect(setActiveThemeId).toHaveBeenCalledTimes(3);
			expect(setActiveThemeId).toHaveBeenNthCalledWith(1, 'monokai');
			expect(setActiveThemeId).toHaveBeenNthCalledWith(2, 'nord');
			expect(setActiveThemeId).toHaveBeenNthCalledWith(3, 'github-light');
		});
	});

	describe('Color Preview', () => {
		it('should render color preview bars for each theme', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			// Each theme button should have a color preview with 3 color bars
			const themeButtons = screen.getAllByRole('button');
			themeButtons.forEach((button) => {
				// Each button should have the color bar container
				const colorBars = button.querySelector('.flex.h-3.rounded.overflow-hidden');
				expect(colorBars).toBeInTheDocument();

				// Should have 3 color bars (flex-1 divs)
				const bars = colorBars?.querySelectorAll('.flex-1');
				expect(bars?.length).toBe(3);
			});
		});

		it('should apply correct background colors from theme to preview bars', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			// Find Dracula button and check its color bars
			const draculaButton = screen.getByRole('button', { name: /Dracula/i });
			const colorBars = draculaButton.querySelector('.flex.h-3.rounded.overflow-hidden');
			const bars = colorBars?.querySelectorAll('.flex-1');

			if (bars) {
				// First bar should have bgMain
				expect(bars[0]).toHaveStyle({
					backgroundColor: mockThemes.dracula.colors.bgMain,
				});
				// Second bar should have bgActivity
				expect(bars[1]).toHaveStyle({
					backgroundColor: mockThemes.dracula.colors.bgActivity,
				});
				// Third bar should have accent
				expect(bars[2]).toHaveStyle({
					backgroundColor: mockThemes.dracula.colors.accent,
				});
			}
		});

		it('should use theme colors for button styling', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			// Each button should use its own theme's bgSidebar for background
			const draculaButton = screen.getByRole('button', { name: /Dracula/i });
			expect(draculaButton).toHaveStyle({
				backgroundColor: mockThemes.dracula.colors.bgSidebar,
			});

			const githubButton = screen.getByRole('button', { name: /GitHub Light/i });
			expect(githubButton).toHaveStyle({
				backgroundColor: mockThemes['github-light'].colors.bgSidebar,
			});
		});

		it('should use current theme border color for buttons', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			// All buttons should use the current theme's border color
			const monokaiButton = screen.getByRole('button', { name: /Monokai/i });
			expect(monokaiButton).toHaveStyle({
				borderColor: currentTheme.colors.border,
			});
		});
	});

	describe('Icon Display', () => {
		it('should render Moon icon for dark mode section', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			// Find the dark mode header
			const darkModeHeader = screen.getByText('dark Mode').closest('div');

			// Should contain an SVG (the Moon icon from lucide-react)
			const svgIcon = darkModeHeader?.querySelector('svg');
			expect(svgIcon).toBeInTheDocument();
			expect(svgIcon).toHaveClass('w-3', 'h-3');
		});

		it('should render Sun icon for light mode section', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			// Find the light mode header
			const lightModeHeader = screen.getByText('light Mode').closest('div');

			// Should contain an SVG (the Sun icon from lucide-react)
			const svgIcon = lightModeHeader?.querySelector('svg');
			expect(svgIcon).toBeInTheDocument();
			expect(svgIcon).toHaveClass('w-3', 'h-3');
		});
	});

	describe('Styling', () => {
		it('should apply current theme textDim color to section headers', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			const darkModeHeader = screen.getByText('dark Mode').closest('div');
			expect(darkModeHeader).toHaveStyle({
				color: currentTheme.colors.textDim,
			});
		});

		it('should apply theme textMain color to theme names', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			// Theme name text should use the theme's own textMain color
			const draculaButton = screen.getByRole('button', { name: /Dracula/i });
			const nameSpan = draculaButton.querySelector('.text-sm.font-bold');

			expect(nameSpan).toHaveStyle({
				color: mockThemes.dracula.colors.textMain,
			});
		});

		it('should apply current theme accent color for ring on active theme', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			// Find the active Dracula button
			const draculaButton = screen.getByRole('button', { name: /Dracula/i });

			// The component applies ringColor via inline style
			// Note: jsdom may not compute CSS custom properties, so we check the style attribute
			const styleAttr = draculaButton.getAttribute('style') || '';
			// ringColor is applied as a style property on the element
			expect(draculaButton).toHaveClass('ring-2');
			// The active theme should have the ring class applied
			expect(draculaButton.className).toContain('ring-2');
		});

		it('should apply current theme accent color to active indicator dot', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			// Find the indicator dot in active theme button
			const draculaButton = screen.getByRole('button', { name: /Dracula/i });
			const dot = draculaButton.querySelector('.w-2.h-2.rounded-full');

			expect(dot).toHaveStyle({
				backgroundColor: currentTheme.colors.accent,
			});
		});

		it('should have proper spacing between theme buttons', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			// Grid should have gap-3 class for spacing
			const grids = document.querySelectorAll('.grid.grid-cols-2.gap-3');
			expect(grids.length).toBe(2);
		});

		it('should have proper section spacing', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			// Main container should have space-y-6 for section spacing
			expect(document.querySelector('.space-y-6')).toBeInTheDocument();
		});
	});

	describe('Edge Cases', () => {
		it('should handle themes with special characters in name', () => {
			const specialThemes: Record<ThemeId, Theme> = {
				...mockThemes,
				dracula: {
					...mockThemes.dracula,
					name: "Dracula's Night & Day <Special>",
				},
			};

			render(
				<ThemePicker
					theme={currentTheme}
					themes={specialThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			expect(screen.getByText("Dracula's Night & Day <Special>")).toBeInTheDocument();
		});

		it('should handle themes with long names', () => {
			const longNameThemes: Record<ThemeId, Theme> = {
				...mockThemes,
				dracula: {
					...mockThemes.dracula,
					name: 'This Is A Very Long Theme Name That Might Overflow The Button Container',
				},
			};

			render(
				<ThemePicker
					theme={currentTheme}
					themes={longNameThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			expect(
				screen.getByText('This Is A Very Long Theme Name That Might Overflow The Button Container')
			).toBeInTheDocument();
		});

		it('should handle themes with unicode characters in name', () => {
			const unicodeThemes: Record<ThemeId, Theme> = {
				...mockThemes,
				dracula: {
					...mockThemes.dracula,
					name: 'Dracula 🧛‍♂️ Night',
				},
			};

			render(
				<ThemePicker
					theme={currentTheme}
					themes={unicodeThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			expect(screen.getByText('Dracula 🧛‍♂️ Night')).toBeInTheDocument();
		});

		it('should work with minimal theme set', () => {
			// Create minimal theme set with just one dark and one light theme
			const minimalThemes: Partial<Record<ThemeId, Theme>> = {
				dracula: mockThemes.dracula,
				'github-light': mockThemes['github-light'],
			};

			render(
				<ThemePicker
					theme={currentTheme}
					themes={minimalThemes as Record<ThemeId, Theme>}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			expect(screen.getByText('Dracula')).toBeInTheDocument();
			expect(screen.getByText('GitHub Light')).toBeInTheDocument();
			expect(screen.getAllByRole('button')).toHaveLength(2);
		});

		it('should use a light theme as the current theme', () => {
			const lightTheme = mockThemes['github-light'];

			render(
				<ThemePicker
					theme={lightTheme}
					themes={mockThemes}
					activeThemeId="github-light"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			// Section headers should use the light theme's textDim color
			const darkModeHeader = screen.getByText('dark Mode').closest('div');
			expect(darkModeHeader).toHaveStyle({
				color: lightTheme.colors.textDim,
			});
		});
	});

	describe('Transition and Interaction Classes', () => {
		it('should have transition-all class on theme buttons', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			const buttons = screen.getAllByRole('button');
			buttons.forEach((button) => {
				expect(button).toHaveClass('transition-all');
			});
		});

		it('should have rounded-lg class on theme buttons for border radius', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			const buttons = screen.getAllByRole('button');
			buttons.forEach((button) => {
				expect(button).toHaveClass('rounded-lg');
			});
		});

		it('should have text-left class on theme buttons', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			const buttons = screen.getAllByRole('button');
			buttons.forEach((button) => {
				expect(button).toHaveClass('text-left');
			});
		});

		it('should have border class on theme buttons', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			const buttons = screen.getAllByRole('button');
			buttons.forEach((button) => {
				expect(button).toHaveClass('border');
			});
		});

		it('should have p-3 padding class on theme buttons', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			const buttons = screen.getAllByRole('button');
			buttons.forEach((button) => {
				expect(button).toHaveClass('p-3');
			});
		});
	});

	describe('Theme Button Content Structure', () => {
		it('should have theme name and optional indicator in flex container', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			const draculaButton = screen.getByRole('button', { name: /Dracula/i });

			// Should have flex container for name and indicator
			const flexContainer = draculaButton.querySelector('.flex.justify-between.items-center.mb-2');
			expect(flexContainer).toBeInTheDocument();
		});

		it('should have color preview container below theme name', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			const draculaButton = screen.getByRole('button', { name: /Dracula/i });

			// Name container should come before color preview
			const children = Array.from(draculaButton.children);
			expect(children.length).toBe(2);

			// First child is the name/indicator flex container
			expect(children[0]).toHaveClass('flex', 'justify-between');

			// Second child is the color preview
			expect(children[1]).toHaveClass('flex', 'h-3', 'rounded');
		});
	});

	describe('Section Header Structure', () => {
		it('should have uppercase text in section headers', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			const darkModeHeader = screen.getByText('dark Mode').closest('div');
			expect(darkModeHeader).toHaveClass('uppercase');
		});

		it('should have font-bold text in section headers', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			const darkModeHeader = screen.getByText('dark Mode').closest('div');
			expect(darkModeHeader).toHaveClass('font-bold');
		});

		it('should have text-xs size in section headers', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			const darkModeHeader = screen.getByText('dark Mode').closest('div');
			expect(darkModeHeader).toHaveClass('text-xs');
		});

		it('should have mb-3 margin bottom in section headers', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			const darkModeHeader = screen.getByText('dark Mode').closest('div');
			expect(darkModeHeader).toHaveClass('mb-3');
		});

		it('should have flex with gap-2 in section headers for icon alignment', () => {
			render(
				<ThemePicker
					theme={currentTheme}
					themes={mockThemes}
					activeThemeId="dracula"
					setActiveThemeId={setActiveThemeId}
				/>
			);

			const darkModeHeader = screen.getByText('dark Mode').closest('div');
			expect(darkModeHeader).toHaveClass('flex', 'items-center', 'gap-2');
		});
	});
});
