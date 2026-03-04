/**
 * Tests for ThemeTab component
 *
 * Tests the theme selection and customization tab including:
 * - Displaying theme mode sections (dark, light, vibe)
 * - Theme button display
 * - Theme selection
 * - Active theme highlighting
 * - Tab key navigation through themes
 * - Custom theme builder integration
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ThemeTab } from '../../../../../renderer/components/Settings/tabs/ThemeTab';
import type { Theme } from '../../../../../renderer/types';

const mockSetActiveThemeId = vi.fn();
const mockSetCustomThemeColors = vi.fn();
const mockSetCustomThemeBaseId = vi.fn();

// Mock useSettings hook
vi.mock('../../../../../renderer/hooks/settings/useSettings', () => ({
	useSettings: () => ({
		activeThemeId: 'dracula',
		setActiveThemeId: mockSetActiveThemeId,
		customThemeColors: {
			bgMain: '#282a36',
			bgSidebar: '#21222c',
			bgActivity: '#343746',
			border: '#44475a',
			textMain: '#f8f8f2',
			textDim: '#6272a4',
			accent: '#bd93f9',
			accentDim: '#bd93f920',
			accentText: '#ff79c6',
			accentForeground: '#ffffff',
			success: '#50fa7b',
			warning: '#ffb86c',
			error: '#ff5555',
		},
		setCustomThemeColors: mockSetCustomThemeColors,
		customThemeBaseId: 'dracula',
		setCustomThemeBaseId: mockSetCustomThemeBaseId,
	}),
}));

// Mock CustomThemeBuilder
vi.mock('../../../../../renderer/components/CustomThemeBuilder', () => ({
	CustomThemeBuilder: ({ isSelected, onSelect }: { isSelected: boolean; onSelect: () => void }) => (
		<div data-testid="custom-theme-builder">
			<button onClick={onSelect} data-theme-id="custom" className={isSelected ? 'ring-2' : ''}>
				Custom Theme
			</button>
		</div>
	),
}));

const mockTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#343746',
		border: '#44475a',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentDim: '#bd93f920',
		accentText: '#ff79c6',
		accentForeground: '#ffffff',
		success: '#50fa7b',
		warning: '#ffb86c',
		error: '#ff5555',
	},
};

const mockLightTheme: Theme = {
	id: 'github-light',
	name: 'GitHub Light',
	mode: 'light',
	colors: {
		bgMain: '#ffffff',
		bgSidebar: '#f6f8fa',
		bgActivity: '#e1e4e8',
		border: '#e1e4e8',
		textMain: '#24292e',
		textDim: '#586069',
		accent: '#0366d6',
		accentDim: '#0366d620',
		accentText: '#0366d6',
		accentForeground: '#ffffff',
		success: '#28a745',
		warning: '#f59e0b',
		error: '#d73a49',
	},
};

const mockVibeTheme: Theme = {
	id: 'pedurple',
	name: 'Pedurple',
	mode: 'vibe',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgActivity: '#0f3460',
		border: '#e94560',
		textMain: '#eaeaea',
		textDim: '#a8a8a8',
		accent: '#e94560',
		accentDim: '#e9456020',
		accentText: '#ff8dc7',
		accentForeground: '#ffffff',
		success: '#50fa7b',
		warning: '#ffb86c',
		error: '#ff5555',
	},
};

const mockThemes: Record<string, Theme> = {
	dracula: mockTheme,
	'github-light': mockLightTheme,
	pedurple: mockVibeTheme,
};

describe('ThemeTab', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('should display theme mode sections', async () => {
		render(<ThemeTab theme={mockTheme} themes={mockThemes} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		expect(screen.getByText('dark Mode')).toBeInTheDocument();
		expect(screen.getByText('light Mode')).toBeInTheDocument();
		expect(screen.getByText('vibe Mode')).toBeInTheDocument();
	});

	it('should display theme buttons', async () => {
		render(<ThemeTab theme={mockTheme} themes={mockThemes} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		expect(screen.getByText('Dracula')).toBeInTheDocument();
		expect(screen.getByText('GitHub Light')).toBeInTheDocument();
		expect(screen.getByText('Pedurple')).toBeInTheDocument();
	});

	it('should call setActiveThemeId when theme is selected', async () => {
		render(<ThemeTab theme={mockTheme} themes={mockThemes} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		fireEvent.click(screen.getByRole('button', { name: 'GitHub Light' }));
		expect(mockSetActiveThemeId).toHaveBeenCalledWith('github-light');
	});

	it('should highlight active theme', async () => {
		render(<ThemeTab theme={mockTheme} themes={mockThemes} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		const draculaButton = screen.getByText('Dracula').closest('button');
		expect(draculaButton).toHaveClass('ring-2');
	});

	it('should navigate themes with Tab key', async () => {
		render(<ThemeTab theme={mockTheme} themes={mockThemes} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		// Find the theme picker container
		const themePickerContainer = screen.getByText('dark Mode').closest('.space-y-6');

		// Fire Tab keydown on the theme picker container
		fireEvent.keyDown(themePickerContainer!, { key: 'Tab' });

		// Should move to next theme
		expect(mockSetActiveThemeId).toHaveBeenCalled();
	});

	it('should navigate themes backwards with Shift+Tab', async () => {
		render(<ThemeTab theme={mockTheme} themes={mockThemes} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		const themePickerContainer = screen.getByText('dark Mode').closest('.space-y-6');

		// Fire Shift+Tab keydown
		fireEvent.keyDown(themePickerContainer!, { key: 'Tab', shiftKey: true });

		// Should move to previous theme (wraps to custom)
		expect(mockSetActiveThemeId).toHaveBeenCalledWith('custom');
	});

	it('should render custom theme builder', async () => {
		render(<ThemeTab theme={mockTheme} themes={mockThemes} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		expect(screen.getByTestId('custom-theme-builder')).toBeInTheDocument();
	});

	it('should exclude custom theme from regular grouping', async () => {
		const themesWithCustom = {
			...mockThemes,
			custom: { ...mockTheme, id: 'custom', name: 'Custom', mode: 'dark' as const },
		};
		render(<ThemeTab theme={mockTheme} themes={themesWithCustom} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		// Custom theme should only appear in CustomThemeBuilder, not in the regular grid
		const darkSection = screen.getByText('dark Mode').closest('div');
		const darkButtons = darkSection?.querySelectorAll('button[data-theme-id]') || [];
		const darkThemeIds = Array.from(darkButtons).map((b) => b.getAttribute('data-theme-id'));
		expect(darkThemeIds).not.toContain('custom');
	});

	it('should select custom theme via CustomThemeBuilder', async () => {
		render(<ThemeTab theme={mockTheme} themes={mockThemes} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		const customButton = screen.getByText('Custom Theme');
		fireEvent.click(customButton);

		expect(mockSetActiveThemeId).toHaveBeenCalledWith('custom');
	});

	it('should not highlight non-active themes', async () => {
		render(<ThemeTab theme={mockTheme} themes={mockThemes} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		const lightButton = screen.getByText('GitHub Light').closest('button');
		expect(lightButton).not.toHaveClass('ring-2');
	});

	it('should render theme color preview bars', async () => {
		render(<ThemeTab theme={mockTheme} themes={mockThemes} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		// Each theme button should have color preview divs
		const draculaButton = screen.getByText('Dracula').closest('button');
		const colorBars = draculaButton?.querySelectorAll('.flex.h-3 > div') || [];
		expect(colorBars).toHaveLength(3);
	});

	it('should have correct aria attributes', async () => {
		render(<ThemeTab theme={mockTheme} themes={mockThemes} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		const picker = screen.getByRole('group', { name: 'Theme picker' });
		expect(picker).toBeInTheDocument();
		expect(picker).toHaveAttribute('tabindex', '0');
	});

	it('should ignore non-Tab key presses on theme picker', async () => {
		render(<ThemeTab theme={mockTheme} themes={mockThemes} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		const themePickerContainer = screen.getByRole('group', { name: 'Theme picker' });
		fireEvent.keyDown(themePickerContainer, { key: 'Enter' });

		// setActiveThemeId should NOT be called for non-Tab keys
		expect(mockSetActiveThemeId).not.toHaveBeenCalled();
	});

	it('should handle empty themes gracefully', async () => {
		render(<ThemeTab theme={mockTheme} themes={{}} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		// Mode sections should still render, just with no theme buttons
		expect(screen.getByText('dark Mode')).toBeInTheDocument();
		expect(screen.getByText('light Mode')).toBeInTheDocument();
		expect(screen.getByText('vibe Mode')).toBeInTheDocument();
	});

	it('should pass import callbacks to CustomThemeBuilder', async () => {
		const onError = vi.fn();
		const onSuccess = vi.fn();

		render(
			<ThemeTab
				theme={mockTheme}
				themes={mockThemes}
				onThemeImportError={onError}
				onThemeImportSuccess={onSuccess}
			/>
		);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		expect(screen.getByTestId('custom-theme-builder')).toBeInTheDocument();
	});
});
