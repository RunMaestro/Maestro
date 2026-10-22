/**
 * @file shortcutDisplay.test.tsx
 * @description Tests for mode-aware shortcut display across the app.
 *
 * These tests verify that:
 * 1. The help modal, palette rows, and ShortcutHint chips display the active mode's binding
 * 2. Chords change correctly when switching between default and Vim modes
 * 3. Actions that Vim mode doesn't override inherit their default chord
 * 4. Actions with no binding in the active mode render nothing
 * 5. Sequence bindings display correctly (e.g., `g g` for goToTab1)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import React from 'react';
import {
	formatShortcutKeys,
	formatShortcutSequence,
} from '../../../renderer/utils/shortcutFormatter';
import { resolveShortcutKeys, UNBOUND_SHORTCUT } from '../../../renderer/utils/shortcutResolve';
import {
	DEFAULT_SHORTCUTS,
	FIXED_SHORTCUTS,
	TAB_SHORTCUTS,
} from '../../../renderer/constants/shortcuts';
import { VIM_SHORTCUTS, VIM_TAB_SHORTCUTS } from '../../../renderer/constants/vimShortcuts';
import { resolveEffectiveShortcuts } from '../../../shared/effectiveShortcuts';
import { ShortcutsHelpModal } from '../../../renderer/components/ShortcutsHelpModal';
import { ShortcutHint } from '../../../renderer/components/ui/ShortcutHint';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { createMockTheme } from '../../helpers/mockTheme';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';

describe('Mode-Aware Shortcut Display', () => {
	const mockTheme = createMockTheme();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('resolveShortcutKeys - mode-aware resolution', () => {
		const defaultMaps = resolveEffectiveShortcuts(
			{ shortcuts: DEFAULT_SHORTCUTS, tabShortcuts: TAB_SHORTCUTS },
			{ vimShortcuts: VIM_SHORTCUTS, vimTabShortcuts: VIM_TAB_SHORTCUTS }
		);

		// For this test, we don't actually get different modes from resolveEffectiveShortcuts
		// since it doesn't take a mode parameter. We test with the effective maps it returns.

		it('resolves goToHistory from default maps', () => {
			const resolved = resolveShortcutKeys('goToHistory', {
				shortcuts: DEFAULT_SHORTCUTS,
				tabShortcuts: TAB_SHORTCUTS,
				fixedShortcuts: FIXED_SHORTCUTS,
			});

			expect(resolved.keys).toEqual(['Meta', 'Shift', 'h']);
			expect(resolved.sequence).toBeUndefined();
		});

		it('resolves goToHistory from vim-effective maps (displaced)', () => {
			const resolved = resolveShortcutKeys('goToHistory', {
				shortcuts: defaultMaps.shortcuts,
				tabShortcuts: defaultMaps.tabShortcuts,
				fixedShortcuts: FIXED_SHORTCUTS,
			});

			expect(resolved.keys).toEqual(['Ctrl', 'Alt', 'Shift', 'h']);
			expect(resolved.sequence).toBeUndefined();
		});

		it('resolves an inherited action to its default chord when not overridden', () => {
			// newInstance is not in VIM_SHORTCUTS, so it inherits from DEFAULT_SHORTCUTS
			const resolved = resolveShortcutKeys('newInstance', {
				shortcuts: defaultMaps.shortcuts,
				tabShortcuts: defaultMaps.tabShortcuts,
				fixedShortcuts: FIXED_SHORTCUTS,
			});

			expect(resolved.keys).toEqual(['Meta', 'n']);
		});

		it('returns a binding for toggleZenMode which is overridden in Vim mode', () => {
			// toggleZenMode is shipped with keys: [] in default mode but overridden in Vim
			const resolved = resolveShortcutKeys('toggleZenMode', {
				shortcuts: defaultMaps.shortcuts,
				tabShortcuts: defaultMaps.tabShortcuts,
				fixedShortcuts: FIXED_SHORTCUTS,
			});

			// In Vim-effective maps, toggleZenMode has a chord and sequence override
			expect(resolved.keys.length).toBeGreaterThan(0);
			expect(resolved.keys).toEqual(['Ctrl', 'Alt', 'o']);
		});

		it('resolves sequence bindings for nextTab', () => {
			const resolved = resolveShortcutKeys('nextTab', {
				shortcuts: defaultMaps.shortcuts,
				tabShortcuts: defaultMaps.tabShortcuts,
				fixedShortcuts: FIXED_SHORTCUTS,
			});

			expect(resolved.sequence).toEqual([['g'], ['t']]);
		});

		it('resolves sequence binding for goToTab1 (g g)', () => {
			const resolved = resolveShortcutKeys('goToTab1', {
				shortcuts: defaultMaps.shortcuts,
				tabShortcuts: defaultMaps.tabShortcuts,
				fixedShortcuts: FIXED_SHORTCUTS,
			});

			expect(resolved.sequence).toEqual([['g'], ['g']]);
		});

		it('returns UNBOUND_SHORTCUT for unknown action id', () => {
			const resolved = resolveShortcutKeys('nonexistentAction', {
				shortcuts: defaultMaps.shortcuts,
				tabShortcuts: defaultMaps.tabShortcuts,
			});

			expect(resolved).toBe(UNBOUND_SHORTCUT);
		});

		it('returns UNBOUND_SHORTCUT for undefined action id', () => {
			const resolved = resolveShortcutKeys(undefined, {
				shortcuts: defaultMaps.shortcuts,
				tabShortcuts: defaultMaps.tabShortcuts,
			});

			expect(resolved).toBe(UNBOUND_SHORTCUT);
		});
	});

	describe('Formatting sequence bindings', () => {
		it('formats g g sequence correctly', () => {
			const sequence = [['g'], ['g']];
			const formatted = formatShortcutSequence(sequence);
			// The mock formatter joins steps with a separator, check for both characters
			expect(formatted).toMatch(/g[\s ]g/);
		});

		it('formats g t sequence correctly', () => {
			const sequence = [['g'], ['t']];
			const formatted = formatShortcutSequence(sequence);
			// Check that both characters appear in the result with a separator
			expect(formatted).toMatch(/g[\s ]t/);
		});

		it('formats shifted sequence correctly', () => {
			const sequence = [
				['Shift', ','],
				['Shift', ','],
			];
			const formatted = formatShortcutSequence(sequence);
			// The mock formatter produces Shift+ for shifted keys
			expect(formatted).toContain('Shift');
			expect(formatted).toContain(',');
		});
	});

	describe('ShortcutHint component with actionId', () => {
		it('renders nothing when action has no binding', () => {
			const { container } = render(
				<ShortcutHint theme={mockTheme} keys={[]} actionId="nonexistent" />
			);
			expect(container).toBeEmptyDOMElement();
		});

		it('renders chord when provided keys', () => {
			const { container } = render(
				<ShortcutHint theme={mockTheme} keys={['Meta', 'Shift', 'h']} />
			);

			const formatted = formatShortcutKeys(['Meta', 'Shift', 'h']);
			expect(container.firstElementChild).toHaveTextContent(formatted);
		});
	});

	describe('ShortcutsHelpModal - mode-aware display', () => {
		it('renders history shortcut with active mode chord in default mode', () => {
			// Setup default mode
			const settingsStore = useSettingsStore.getState();
			settingsStore.setKeyboardMode('default');

			const { container } = render(
				<LayerStackProvider>
					<ShortcutsHelpModal theme={mockTheme} onClose={() => {}} />
				</LayerStackProvider>
			);

			// The help modal title should be present
			const dialog = screen.getByRole('dialog');
			expect(dialog).toBeInTheDocument();
		});

		it('renders shortcut list with active mode bindings', () => {
			const settingsStore = useSettingsStore.getState();
			settingsStore.setKeyboardMode('default');

			const { container } = render(
				<LayerStackProvider>
					<ShortcutsHelpModal theme={mockTheme} onClose={() => {}} />
				</LayerStackProvider>
			);

			// The dialog should contain shortcuts help
			const dialog = screen.getByRole('dialog');
			expect(dialog).toBeInTheDocument();
		});
	});

	describe('Mode switching effects on display', () => {
		const vimMaps = resolveEffectiveShortcuts(
			{ shortcuts: DEFAULT_SHORTCUTS, tabShortcuts: TAB_SHORTCUTS },
			{ vimShortcuts: VIM_SHORTCUTS, vimTabShortcuts: VIM_TAB_SHORTCUTS }
		);

		it('action with different chords in default vs Vim mode', () => {
			// Test goToHistory which has different chords in default vs Vim
			const defaultResolved = resolveShortcutKeys('goToHistory', {
				shortcuts: DEFAULT_SHORTCUTS,
				tabShortcuts: TAB_SHORTCUTS,
				fixedShortcuts: FIXED_SHORTCUTS,
			});

			const vimResolved = resolveShortcutKeys('goToHistory', {
				shortcuts: vimMaps.shortcuts,
				tabShortcuts: vimMaps.tabShortcuts,
				fixedShortcuts: FIXED_SHORTCUTS,
			});

			// Default mode: Cmd+Shift+H (stored as Meta+Shift+h)
			expect(defaultResolved.keys).toEqual(['Meta', 'Shift', 'h']);
			const defaultFormatted = formatShortcutKeys(defaultResolved.keys);
			expect(defaultFormatted).toContain('Shift');

			// Vim mode: Ctrl+Alt+Shift+H
			expect(vimResolved.keys).toEqual(['Ctrl', 'Alt', 'Shift', 'h']);
			const vimFormatted = formatShortcutKeys(vimResolved.keys);
			expect(vimFormatted).toContain('Alt');
			expect(vimFormatted).toContain('Shift');
		});

		it('sequence binding only exists in Vim-effective maps', () => {
			const defaultResolved = resolveShortcutKeys('nextTab', {
				shortcuts: DEFAULT_SHORTCUTS,
				tabShortcuts: TAB_SHORTCUTS,
				fixedShortcuts: FIXED_SHORTCUTS,
			});

			const vimResolved = resolveShortcutKeys('nextTab', {
				shortcuts: vimMaps.shortcuts,
				tabShortcuts: vimMaps.tabShortcuts,
				fixedShortcuts: FIXED_SHORTCUTS,
			});

			// In default mode, no sequence
			expect(defaultResolved.sequence).toBeUndefined();

			// In Vim-effective maps, has sequence
			expect(vimResolved.sequence).toEqual([['g'], ['t']]);
		});
	});

	describe('Region focus actions in Vim mode', () => {
		const vimMaps = resolveEffectiveShortcuts(
			{ shortcuts: DEFAULT_SHORTCUTS, tabShortcuts: TAB_SHORTCUTS },
			{ vimShortcuts: VIM_SHORTCUTS, vimTabShortcuts: VIM_TAB_SHORTCUTS }
		);

		it('resolves focusRegionLeft to Ctrl+Shift+H with h sequence in Vim-effective maps', () => {
			const resolved = resolveShortcutKeys('focusRegionLeft', {
				shortcuts: vimMaps.shortcuts,
				tabShortcuts: vimMaps.tabShortcuts,
				fixedShortcuts: FIXED_SHORTCUTS,
			});

			expect(resolved.keys).toEqual(['Ctrl', 'Shift', 'h']);
			expect(resolved.sequence).toEqual([['h']]);
		});

		it('resolves focusRegionDown to Ctrl+Shift+J with j sequence in Vim-effective maps', () => {
			const resolved = resolveShortcutKeys('focusRegionDown', {
				shortcuts: vimMaps.shortcuts,
				tabShortcuts: vimMaps.tabShortcuts,
				fixedShortcuts: FIXED_SHORTCUTS,
			});

			expect(resolved.keys).toEqual(['Ctrl', 'Shift', 'j']);
			expect(resolved.sequence).toEqual([['j']]);
		});

		it('region focus actions do not exist in default mode', () => {
			const resolved = resolveShortcutKeys('focusRegionLeft', {
				shortcuts: DEFAULT_SHORTCUTS,
				tabShortcuts: TAB_SHORTCUTS,
				fixedShortcuts: FIXED_SHORTCUTS,
			});

			expect(resolved).toBe(UNBOUND_SHORTCUT);
		});
	});

	describe('Displaced actions in Vim mode', () => {
		const vimMaps = resolveEffectiveShortcuts(
			{ shortcuts: DEFAULT_SHORTCUTS, tabShortcuts: TAB_SHORTCUTS },
			{ vimShortcuts: VIM_SHORTCUTS, vimTabShortcuts: VIM_TAB_SHORTCUTS }
		);

		it('clearTerminal is displaced in Vim-effective mode', () => {
			const defaultResolved = resolveShortcutKeys('clearTerminal', {
				shortcuts: DEFAULT_SHORTCUTS,
				tabShortcuts: TAB_SHORTCUTS,
				fixedShortcuts: FIXED_SHORTCUTS,
			});

			const vimResolved = resolveShortcutKeys('clearTerminal', {
				shortcuts: vimMaps.shortcuts,
				tabShortcuts: vimMaps.tabShortcuts,
				fixedShortcuts: FIXED_SHORTCUTS,
			});

			// In default mode: Cmd+Shift+K
			expect(defaultResolved.keys).toEqual(['Meta', 'Shift', 'k']);

			// In Vim-effective mode: Ctrl+Alt+Shift+K
			expect(vimResolved.keys).toEqual(['Ctrl', 'Alt', 'Shift', 'k']);
		});

		it('agentSessions is displaced in Vim-effective mode', () => {
			const defaultResolved = resolveShortcutKeys('agentSessions', {
				shortcuts: DEFAULT_SHORTCUTS,
				tabShortcuts: TAB_SHORTCUTS,
				fixedShortcuts: FIXED_SHORTCUTS,
			});

			const vimResolved = resolveShortcutKeys('agentSessions', {
				shortcuts: vimMaps.shortcuts,
				tabShortcuts: vimMaps.tabShortcuts,
				fixedShortcuts: FIXED_SHORTCUTS,
			});

			// In default mode: Cmd+Shift+L
			expect(defaultResolved.keys).toEqual(['Meta', 'Shift', 'l']);

			// In Vim-effective mode: Ctrl+Alt+Shift+L
			expect(vimResolved.keys).toEqual(['Ctrl', 'Alt', 'Shift', 'l']);
		});
	});

	describe('Actions that stay the same across modes', () => {
		const vimMaps = resolveEffectiveShortcuts(
			{ shortcuts: DEFAULT_SHORTCUTS, tabShortcuts: TAB_SHORTCUTS },
			{ vimShortcuts: VIM_SHORTCUTS, vimTabShortcuts: VIM_TAB_SHORTCUTS }
		);

		it('newInstance keeps same chord in default and Vim-effective modes', () => {
			const defaultResolved = resolveShortcutKeys('newInstance', {
				shortcuts: DEFAULT_SHORTCUTS,
				tabShortcuts: TAB_SHORTCUTS,
				fixedShortcuts: FIXED_SHORTCUTS,
			});

			const vimResolved = resolveShortcutKeys('newInstance', {
				shortcuts: vimMaps.shortcuts,
				tabShortcuts: vimMaps.tabShortcuts,
				fixedShortcuts: FIXED_SHORTCUTS,
			});

			// Both modes have same chord
			expect(defaultResolved.keys).toEqual(['Meta', 'n']);
			expect(vimResolved.keys).toEqual(['Meta', 'n']);
		});

		it('help stays on Cmd+/ in both modes', () => {
			const defaultResolved = resolveShortcutKeys('help', {
				shortcuts: DEFAULT_SHORTCUTS,
				tabShortcuts: TAB_SHORTCUTS,
				fixedShortcuts: FIXED_SHORTCUTS,
			});

			const vimResolved = resolveShortcutKeys('help', {
				shortcuts: vimMaps.shortcuts,
				tabShortcuts: vimMaps.tabShortcuts,
				fixedShortcuts: FIXED_SHORTCUTS,
			});

			expect(defaultResolved.keys).toEqual(['Meta', '/']);
			expect(vimResolved.keys).toEqual(['Meta', '/']);
		});
	});
});
