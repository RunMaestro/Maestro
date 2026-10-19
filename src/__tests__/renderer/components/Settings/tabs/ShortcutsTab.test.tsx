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
 * - The keyboard mode toggle, the per-mode reset, inherited rows, and the
 *   displaced actions that need a binding in the active mode
 *
 * The tab reads its bindings from `useActiveShortcuts()`, which is mocked here
 * so the list is the four fixtures below rather than the whole shipped set.
 * `mockMode` / `mockInheritedIds` / `mockDisplaced` stand in for what that hook
 * computes from the live mode; they are reset in `afterEach` so a mode a test
 * switches to cannot leak into the next one.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ShortcutsTab } from '../../../../../renderer/components/Settings/tabs/ShortcutsTab';
import type { Shortcut } from '../../../../../renderer/types';
import type { KeyboardMode } from '../../../../../shared/shortcut-types';

import { mockTheme } from '../../../../helpers/mockTheme';
// Mock formatShortcutKeys
vi.mock('../../../../../renderer/utils/shortcutFormatter', () => ({
	formatShortcutKeys: vi.fn((keys: string[]) => keys.join('+')),
}));

const mockSetShortcuts = vi.fn();
const mockSetTabShortcuts = vi.fn();
const mockSetKeyboardMode = vi.fn();
const mockResetToDefaults = vi.fn();

const mockShortcuts: Record<string, Shortcut> = {
	'new-session': { id: 'new-session', label: 'New Session', keys: ['Meta', 'n'] },
	'close-session': { id: 'close-session', label: 'Close Session', keys: ['Meta', 'w'] },
	'toggle-mode': { id: 'toggle-mode', label: 'Toggle Mode', keys: ['Meta', 'j'] },
};

const mockTabShortcuts: Record<string, Shortcut> = {
	'tab-send': { id: 'tab-send', label: 'Send Message', keys: ['Enter'] },
};

let mockMode: KeyboardMode = 'default';
let mockInheritedIds: string[] = [];
let mockDisplaced: string[] = [];

vi.mock('../../../../../renderer/hooks/settings/useSettings', () => ({
	useSettings: () => ({
		encoreFeatures: undefined,
		setKeyboardMode: mockSetKeyboardMode,
	}),
}));

vi.mock('../../../../../renderer/hooks/settings/useActiveShortcuts', () => ({
	useActiveShortcuts: () => ({
		keyboardMode: mockMode,
		shortcuts: mockShortcuts,
		setShortcuts: mockSetShortcuts,
		tabShortcuts: mockTabShortcuts,
		setTabShortcuts: mockSetTabShortcuts,
		resetToDefaults: mockResetToDefaults,
		isInherited: (id: string) => mockInheritedIds.includes(id),
		displaced: mockDisplaced,
	}),
}));

/** Render and let the mount-time filter autofocus timer run. */
async function renderTab(props: Partial<React.ComponentProps<typeof ShortcutsTab>> = {}) {
	const result = render(<ShortcutsTab theme={mockTheme} {...props} />);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(100);
	});
	return result;
}

function resetModeFixtures() {
	mockMode = 'default';
	mockInheritedIds = [];
	mockDisplaced = [];
}

describe('ShortcutsTab', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
		resetModeFixtures();
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

	it('refuses Cmd+Shift+Down, which the OS owns for extending a text selection', async () => {
		render(<ShortcutsTab theme={mockTheme} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		const shortcutButton = screen.getByText('Meta+n');
		fireEvent.click(shortcutButton);

		fireEvent.keyDown(shortcutButton, {
			key: 'ArrowDown',
			code: 'ArrowDown',
			metaKey: true,
			shiftKey: true,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		});

		// Nothing else is bound to it, so the conflict check would have accepted
		// it. The reserved-combo guard is the only thing standing in the way.
		expect(mockSetShortcuts).not.toHaveBeenCalled();
		expect(screen.getByText(/reserved by the system/)).toBeInTheDocument();
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

	it('clears a binding from the clear button', async () => {
		render(<ShortcutsTab theme={mockTheme} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		fireEvent.click(screen.getByRole('button', { name: 'Clear New Session shortcut' }));

		expect(mockSetShortcuts).toHaveBeenCalledWith({
			...mockShortcuts,
			'new-session': { ...mockShortcuts['new-session'], keys: [] },
		});
	});

	it('clears a tab binding from the clear button', async () => {
		render(<ShortcutsTab theme={mockTheme} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		fireEvent.click(screen.getByRole('button', { name: 'Clear Send Message shortcut' }));

		expect(mockSetTabShortcuts).toHaveBeenCalledWith({
			...mockTabShortcuts,
			'tab-send': { ...mockTabShortcuts['tab-send'], keys: [] },
		});
		expect(mockSetShortcuts).not.toHaveBeenCalled();
	});

	it('clears a binding when bare Backspace is pressed while recording', async () => {
		render(<ShortcutsTab theme={mockTheme} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		const shortcutButton = screen.getByText('Meta+n');
		fireEvent.click(shortcutButton);
		fireEvent.keyDown(shortcutButton, { key: 'Backspace' });

		expect(mockSetShortcuts).toHaveBeenCalledWith({
			...mockShortcuts,
			'new-session': { ...mockShortcuts['new-session'], keys: [] },
		});
	});

	it('records Cmd+Backspace as a chord rather than clearing', async () => {
		render(<ShortcutsTab theme={mockTheme} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		const shortcutButton = screen.getByText('Meta+n');
		fireEvent.click(shortcutButton);
		fireEvent.keyDown(shortcutButton, { key: 'Backspace', metaKey: true });

		expect(mockSetShortcuts).toHaveBeenCalledWith({
			...mockShortcuts,
			'new-session': { ...mockShortcuts['new-session'], keys: ['Meta', 'Backspace'] },
		});
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

/**
 * Unbound shortcuts: an action can ship with `keys: []` so the user assigns
 * their own chord (the tile-below family for AI, browser, and file tabs).
 * `formatShortcutKeys([])` is an empty string, which would render as a blank
 * button nobody can tell is clickable, so the row must read "Not set" and stay
 * recordable. Lives in its own describe because the shared mock's counts are
 * asserted elsewhere.
 */
describe('ShortcutsTab unbound shortcuts', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockShortcuts['tile-ai'] = { id: 'tile-ai', label: 'Tile New AI Chat Below', keys: [] };
	});

	afterEach(() => {
		delete mockShortcuts['tile-ai'];
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('labels a shortcut with no keys as "Not set"', async () => {
		render(<ShortcutsTab theme={mockTheme} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		expect(screen.getByText('Tile New AI Chat Below')).toBeInTheDocument();
		expect(screen.getByText('Not set')).toBeInTheDocument();
	});

	it('records a chord onto an unbound shortcut', async () => {
		render(<ShortcutsTab theme={mockTheme} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		const button = screen.getByText('Not set');
		fireEvent.click(button);
		expect(screen.getByText('Press keys...')).toBeInTheDocument();

		fireEvent.keyDown(button, {
			key: 'y',
			metaKey: true,
			shiftKey: true,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		});

		expect(mockSetShortcuts).toHaveBeenCalledWith({
			...mockShortcuts,
			'tile-ai': { ...mockShortcuts['tile-ai'], keys: ['Meta', 'Shift', 'y'] },
		});
	});
});

/**
 * Keyboard mode: the toggle at the top of the tab, the per-mode reset, and the
 * "Default" tag on a row whose chord this mode does not replace.
 *
 * Exactly one mode is live, so the toggle is the only thing on this screen that
 * changes which set every row below it belongs to - and the reset beside it
 * must only ever touch the live mode's bucket.
 */
describe('ShortcutsTab keyboard mode', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
		resetModeFixtures();
	});

	it('offers both modes with the live one selected', async () => {
		await renderTab();

		expect(screen.getByTestId('shortcuts-keyboard-mode-default')).toHaveAttribute(
			'aria-checked',
			'true'
		);
		expect(screen.getByTestId('shortcuts-keyboard-mode-vim')).toHaveAttribute(
			'aria-checked',
			'false'
		);
	});

	it('switches the mode from the toggle', async () => {
		await renderTab();

		fireEvent.click(screen.getByTestId('shortcuts-keyboard-mode-vim'));

		expect(mockSetKeyboardMode).toHaveBeenCalledWith('vim');
	});

	it('shows the live mode as selected after a switch', async () => {
		mockMode = 'vim';
		await renderTab();

		expect(screen.getByTestId('shortcuts-keyboard-mode-vim')).toHaveAttribute(
			'aria-checked',
			'true'
		);
	});

	it('explains that one mode is live and that Vim inherits the rest', async () => {
		await renderTab();

		expect(screen.getByText(/Only one mode is active at a time/)).toBeInTheDocument();
		expect(screen.getByText(/keeps every default chord it does not replace/)).toBeInTheDocument();
	});

	it('wraps the toggle in the searchable setting id', async () => {
		const { container } = await renderTab();

		expect(container.querySelector('[data-setting-id="shortcuts-keyboard-mode"]')).not.toBeNull();
	});

	it('asks for a second click before resetting', async () => {
		await renderTab();

		const reset = screen.getByTestId('shortcuts-reset-defaults');
		fireEvent.click(reset);

		expect(mockResetToDefaults).not.toHaveBeenCalled();
		expect(reset).toHaveTextContent('Reset Default mode?');

		fireEvent.click(reset);

		expect(mockResetToDefaults).toHaveBeenCalledTimes(1);
	});

	it('names the mode the reset restores and the one it leaves alone', async () => {
		mockMode = 'vim';
		await renderTab();

		fireEvent.click(screen.getByTestId('shortcuts-reset-defaults'));

		expect(screen.getByTestId('shortcuts-reset-defaults')).toHaveTextContent('Reset Vim mode?');
		expect(
			screen.getByText(/shipped Vim mode bindings. Your Default mode customizations are kept/)
		).toBeInTheDocument();
	});

	it('disarms a pending reset when the mode changes under it', async () => {
		await renderTab();

		const reset = screen.getByTestId('shortcuts-reset-defaults');
		fireEvent.click(reset);
		expect(reset).toHaveTextContent('Reset Default mode?');

		fireEvent.click(screen.getByTestId('shortcuts-keyboard-mode-vim'));

		// The second click would otherwise land on the mode the user just left.
		expect(reset).toHaveTextContent('Reset to defaults');
		expect(mockResetToDefaults).not.toHaveBeenCalled();
	});

	it('tags a row whose chord this mode does not replace', async () => {
		mockMode = 'vim';
		mockInheritedIds = ['close-session'];
		await renderTab();

		expect(screen.getByTestId('shortcut-inherited-close-session')).toHaveTextContent('Default');
		expect(screen.queryByTestId('shortcut-inherited-new-session')).not.toBeInTheDocument();
	});

	it('tags nothing in default mode, which is the set every mode inherits', async () => {
		await renderTab();

		expect(screen.queryByTestId('shortcut-inherited-close-session')).not.toBeInTheDocument();
	});

	it('refuses a chord that fires an existing binding through the Meta/Ctrl collapse', async () => {
		await renderTab();

		const button = screen.getByText('Meta+w');
		fireEvent.click(button);
		fireEvent.keyDown(button, { key: 'n', ctrlKey: true });

		// Ctrl+N is not EQUAL to New Session's Meta+N, but it is the same
		// keypress to the matcher, so an equality check would have handed out a
		// chord that already fires another action.
		expect(mockSetShortcuts).not.toHaveBeenCalled();
		expect(screen.getByText(/already used by "New Session"/)).toBeInTheDocument();
	});
});

/**
 * Displaced actions: a mode override took the chord this action inherited, so
 * it is unbound until the user records one here. The tab must ask for that
 * chord rather than leaving the action silently unreachable.
 */
describe('ShortcutsTab displaced actions', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockMode = 'vim';
		mockDisplaced = ['toggle-mode'];
		// A displaced action has no override of its own, and the resolver hands
		// the tab an empty chord for it.
		mockInheritedIds = ['toggle-mode'];
		mockShortcuts['toggle-mode'] = { id: 'toggle-mode', label: 'Toggle Mode', keys: [] };
	});

	afterEach(() => {
		mockShortcuts['toggle-mode'] = {
			id: 'toggle-mode',
			label: 'Toggle Mode',
			keys: ['Meta', 'j'],
		};
		vi.useRealTimers();
		vi.clearAllMocks();
		resetModeFixtures();
	});

	it('leads the list with the actions that need a binding in this mode', async () => {
		await renderTab();

		expect(screen.getByText('Needs a Vim binding')).toBeInTheDocument();
		// Moved, not copied: two rows for one action would show two different
		// chords for it.
		expect(screen.getAllByText('Toggle Mode')).toHaveLength(1);
	});

	it('does not tag a displaced row as inherited', async () => {
		await renderTab();

		// It has no override either, but its chord is gone rather than inherited,
		// and the row already says so by reading "Not set".
		expect(screen.queryByTestId('shortcut-inherited-toggle-mode')).not.toBeInTheDocument();
		expect(screen.getByText('Not set')).toBeInTheDocument();
	});

	it('records a chord for a displaced action into the active mode', async () => {
		await renderTab();

		const button = screen.getByText('Not set');
		fireEvent.click(button);
		fireEvent.keyDown(button, { key: 'p', ctrlKey: true });

		expect(mockSetShortcuts).toHaveBeenCalledWith({
			...mockShortcuts,
			'toggle-mode': { ...mockShortcuts['toggle-mode'], keys: ['Ctrl', 'p'] },
		});
	});

	it('shows no such section when nothing is displaced', async () => {
		mockDisplaced = [];
		await renderTab();

		expect(screen.queryByText('Needs a Vim binding')).not.toBeInTheDocument();
		expect(screen.getAllByText('Toggle Mode')).toHaveLength(1);
	});
});
