/**
 * Tests for ShortcutsTab component
 *
 * Tests the keyboard shortcuts settings tab including:
 * - Displaying shortcuts list with grouping
 * - Filtering shortcuts by label
 * - Shortcut count display
 * - Recording new shortcuts
 * - Canceling recording with Escape
 * - Recording change callback
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ShortcutsTab } from '../../../../../renderer/components/Settings/tabs/ShortcutsTab';
import type { Theme, Shortcut } from '../../../../../renderer/types';

// Mock formatShortcutKeys
vi.mock('../../../../../renderer/utils/shortcutFormatter', () => ({
	formatShortcutKeys: vi.fn((keys: string[]) => keys.join('+')),
}));

const mockSetShortcuts = vi.fn();
const mockSetTabShortcuts = vi.fn();

const mockShortcuts: Record<string, Shortcut> = {
	'new-session': { id: 'new-session', label: 'New Session', keys: ['Meta', 'n'] },
	'close-session': { id: 'close-session', label: 'Close Session', keys: ['Meta', 'w'] },
	'toggle-mode': { id: 'toggle-mode', label: 'Toggle Mode', keys: ['Meta', 'j'] },
};

const mockTabShortcuts: Record<string, Shortcut> = {
	'tab-send': { id: 'tab-send', label: 'Send Message', keys: ['Enter'] },
};

vi.mock('../../../../../renderer/hooks/settings/useSettings', () => ({
	useSettings: () => ({
		shortcuts: mockShortcuts,
		setShortcuts: mockSetShortcuts,
		tabShortcuts: mockTabShortcuts,
		setTabShortcuts: mockSetTabShortcuts,
	}),
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

describe('ShortcutsTab', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('should display shortcuts list', async () => {
		render(<ShortcutsTab theme={mockTheme} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		expect(screen.getByText('New Session')).toBeInTheDocument();
		expect(screen.getByText('Close Session')).toBeInTheDocument();
		expect(screen.getByText('Toggle Mode')).toBeInTheDocument();
	});

	it('should display tab shortcuts in AI Tab section', async () => {
		render(<ShortcutsTab theme={mockTheme} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		expect(screen.getByText('Send Message')).toBeInTheDocument();
		expect(screen.getByText('AI Tab')).toBeInTheDocument();
	});

	it('should filter shortcuts by label', async () => {
		render(<ShortcutsTab theme={mockTheme} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		const filterInput = screen.getByPlaceholderText('Filter shortcuts...');
		fireEvent.change(filterInput, { target: { value: 'New' } });

		expect(screen.getByText('New Session')).toBeInTheDocument();
		expect(screen.queryByText('Close Session')).not.toBeInTheDocument();
	});

	it('should show total shortcut count', async () => {
		render(<ShortcutsTab theme={mockTheme} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		// 3 general + 1 tab = 4 total
		expect(screen.getByText('4')).toBeInTheDocument();
	});

	it('should show filtered count when filtering', async () => {
		render(<ShortcutsTab theme={mockTheme} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		const filterInput = screen.getByPlaceholderText('Filter shortcuts...');
		fireEvent.change(filterInput, { target: { value: 'Session' } });

		expect(screen.getByText('2 / 4')).toBeInTheDocument();
	});

	it('should enter recording mode when shortcut button is clicked', async () => {
		render(<ShortcutsTab theme={mockTheme} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		const shortcutButton = screen.getByText('Meta+n');
		fireEvent.click(shortcutButton);

		expect(screen.getByText('Press keys...')).toBeInTheDocument();
	});

	it('should record new shortcut on keydown', async () => {
		render(<ShortcutsTab theme={mockTheme} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		// Click to enter recording mode
		const shortcutButton = screen.getByText('Meta+n');
		fireEvent.click(shortcutButton);

		// Press new key combination
		fireEvent.keyDown(shortcutButton, {
			key: 'k',
			metaKey: true,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		});

		expect(mockSetShortcuts).toHaveBeenCalledWith({
			...mockShortcuts,
			'new-session': { ...mockShortcuts['new-session'], keys: ['Meta', 'k'] },
		});
	});

	it('should cancel recording on Escape', async () => {
		render(<ShortcutsTab theme={mockTheme} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		// Click to enter recording mode
		const shortcutButton = screen.getByText('Meta+n');
		fireEvent.click(shortcutButton);

		expect(screen.getByText('Press keys...')).toBeInTheDocument();

		// Press Escape
		fireEvent.keyDown(shortcutButton, {
			key: 'Escape',
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		});

		// Should exit recording mode without calling setShortcuts
		expect(mockSetShortcuts).not.toHaveBeenCalled();
		expect(screen.getByText('Meta+n')).toBeInTheDocument();
	});

	it('should call onRecordingChange when recording starts and stops', async () => {
		const onRecordingChange = vi.fn();
		render(<ShortcutsTab theme={mockTheme} onRecordingChange={onRecordingChange} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		// Initially called with false
		expect(onRecordingChange).toHaveBeenCalledWith(false);
		onRecordingChange.mockClear();

		// Click to enter recording mode
		const shortcutButton = screen.getByText('Meta+n');
		fireEvent.click(shortcutButton);

		expect(onRecordingChange).toHaveBeenCalledWith(true);
		onRecordingChange.mockClear();

		// Cancel recording
		fireEvent.keyDown(shortcutButton, {
			key: 'Escape',
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		});

		expect(onRecordingChange).toHaveBeenCalledWith(false);
	});

	it('should show hasNoAgents message when set', async () => {
		render(<ShortcutsTab theme={mockTheme} hasNoAgents={true} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		expect(screen.getByText(/Most functionality is unavailable/)).toBeInTheDocument();
	});

	it('should display General and AI Tab section headers', async () => {
		render(<ShortcutsTab theme={mockTheme} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		expect(screen.getByText('General')).toBeInTheDocument();
		expect(screen.getByText('AI Tab')).toBeInTheDocument();
	});

	it('should handle Alt+key recording using e.code for macOS', async () => {
		render(<ShortcutsTab theme={mockTheme} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		// Click to enter recording mode
		const shortcutButton = screen.getByText('Meta+n');
		fireEvent.click(shortcutButton);

		// Press Alt+L (which on macOS produces ¬)
		fireEvent.keyDown(shortcutButton, {
			key: '¬',
			code: 'KeyL',
			altKey: true,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		});

		expect(mockSetShortcuts).toHaveBeenCalledWith({
			...mockShortcuts,
			'new-session': { ...mockShortcuts['new-session'], keys: ['Alt', 'l'] },
		});
	});

	it('should record tab shortcuts with setTabShortcuts', async () => {
		render(<ShortcutsTab theme={mockTheme} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		// Click the tab shortcut button to enter recording mode
		const sendButton = screen.getByText('Enter');
		fireEvent.click(sendButton);

		// Press new key combination
		fireEvent.keyDown(sendButton, {
			key: 'Return',
			metaKey: true,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		});

		expect(mockSetTabShortcuts).toHaveBeenCalled();
	});

	it('should handle Ctrl modifier key', async () => {
		render(<ShortcutsTab theme={mockTheme} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		const shortcutButton = screen.getByText('Meta+n');
		fireEvent.click(shortcutButton);

		fireEvent.keyDown(shortcutButton, {
			key: 'k',
			ctrlKey: true,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		});

		expect(mockSetShortcuts).toHaveBeenCalledWith({
			...mockShortcuts,
			'new-session': { ...mockShortcuts['new-session'], keys: ['Ctrl', 'k'] },
		});
	});

	it('should handle Shift modifier key', async () => {
		render(<ShortcutsTab theme={mockTheme} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		const shortcutButton = screen.getByText('Meta+n');
		fireEvent.click(shortcutButton);

		fireEvent.keyDown(shortcutButton, {
			key: 'k',
			shiftKey: true,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		});

		expect(mockSetShortcuts).toHaveBeenCalledWith({
			...mockShortcuts,
			'new-session': { ...mockShortcuts['new-session'], keys: ['Shift', 'k'] },
		});
	});

	it('should handle multiple modifier keys', async () => {
		render(<ShortcutsTab theme={mockTheme} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		const shortcutButton = screen.getByText('Meta+n');
		fireEvent.click(shortcutButton);

		fireEvent.keyDown(shortcutButton, {
			key: 'k',
			metaKey: true,
			shiftKey: true,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		});

		expect(mockSetShortcuts).toHaveBeenCalledWith({
			...mockShortcuts,
			'new-session': { ...mockShortcuts['new-session'], keys: ['Meta', 'Shift', 'k'] },
		});
	});

	it('should ignore modifier-only key presses during recording', async () => {
		render(<ShortcutsTab theme={mockTheme} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		const shortcutButton = screen.getByText('Meta+n');
		fireEvent.click(shortcutButton);

		// Press just the Meta key (no main key)
		fireEvent.keyDown(shortcutButton, {
			key: 'Meta',
			metaKey: true,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		});

		// Should remain in recording mode and not save
		expect(mockSetShortcuts).not.toHaveBeenCalled();
		expect(screen.getByText('Press keys...')).toBeInTheDocument();
	});

	it('should handle Alt+Digit recording using e.code', async () => {
		render(<ShortcutsTab theme={mockTheme} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		const shortcutButton = screen.getByText('Meta+n');
		fireEvent.click(shortcutButton);

		fireEvent.keyDown(shortcutButton, {
			key: '¡',
			code: 'Digit1',
			altKey: true,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		});

		expect(mockSetShortcuts).toHaveBeenCalledWith({
			...mockShortcuts,
			'new-session': { ...mockShortcuts['new-session'], keys: ['Alt', '1'] },
		});
	});

	it('should not show hasNoAgents message when hasNoAgents is false', async () => {
		render(<ShortcutsTab theme={mockTheme} hasNoAgents={false} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		expect(screen.queryByText(/Most functionality is unavailable/)).not.toBeInTheDocument();
	});

	it('should clear filter and restore all shortcuts', async () => {
		render(<ShortcutsTab theme={mockTheme} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		const filterInput = screen.getByPlaceholderText('Filter shortcuts...');

		// Filter to show only one
		fireEvent.change(filterInput, { target: { value: 'New' } });
		expect(screen.queryByText('Close Session')).not.toBeInTheDocument();

		// Clear filter
		fireEvent.change(filterInput, { target: { value: '' } });
		expect(screen.getByText('Close Session')).toBeInTheDocument();
		expect(screen.getByText('Toggle Mode')).toBeInTheDocument();
	});

	it('should show help text about viewing full shortcut list', async () => {
		render(<ShortcutsTab theme={mockTheme} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		expect(screen.getByText(/Not all shortcuts can be modified/)).toBeInTheDocument();
	});

	it('should filter across both general and tab shortcuts', async () => {
		render(<ShortcutsTab theme={mockTheme} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		const filterInput = screen.getByPlaceholderText('Filter shortcuts...');
		fireEvent.change(filterInput, { target: { value: 'Send' } });

		// Only tab shortcut "Send Message" should match
		expect(screen.getByText('Send Message')).toBeInTheDocument();
		expect(screen.queryByText('New Session')).not.toBeInTheDocument();
		expect(screen.getByText('1 / 4')).toBeInTheDocument();
	});

	it('should hide section headers when no shortcuts match filter', async () => {
		render(<ShortcutsTab theme={mockTheme} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		const filterInput = screen.getByPlaceholderText('Filter shortcuts...');
		fireEvent.change(filterInput, { target: { value: 'nonexistent' } });

		expect(screen.queryByText('General')).not.toBeInTheDocument();
		expect(screen.queryByText('AI Tab')).not.toBeInTheDocument();
	});
});
