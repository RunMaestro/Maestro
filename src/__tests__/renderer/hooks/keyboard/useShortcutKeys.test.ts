/**
 * Tests for useShortcutKeys - the hook every chord-drawing surface reads.
 *
 * The lookup rules themselves are pinned in
 * `src/__tests__/renderer/utils/shortcutResolve.test.ts`. What matters here is
 * the wiring: the hook has to take its maps from the LIVE keyboard mode, so
 * switching modes moves what is on screen without the call site knowing a mode
 * exists.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useShortcutKeys } from '../../../../renderer/hooks/keyboard/useShortcutKeys';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import {
	DEFAULT_SHORTCUTS,
	FIXED_SHORTCUTS,
	TAB_SHORTCUTS,
} from '../../../../renderer/constants/shortcuts';
import { VIM_SHORTCUTS, VIM_TAB_SHORTCUTS } from '../../../../renderer/constants/vimShortcuts';

describe('useShortcutKeys', () => {
	beforeEach(() => {
		useSettingsStore.setState({
			keyboardMode: 'default',
			shortcuts: DEFAULT_SHORTCUTS,
			tabShortcuts: TAB_SHORTCUTS,
			vimShortcuts: VIM_SHORTCUTS,
			vimTabShortcuts: VIM_TAB_SHORTCUTS,
		});
	});

	it('returns the default-mode chord while default mode is live', () => {
		const { result } = renderHook(() => useShortcutKeys('goToHistory'));
		expect(result.current.keys).toEqual(['Meta', 'Shift', 'h']);
	});

	it('returns the Vim chord while Vim mode is live', () => {
		useSettingsStore.setState({ keyboardMode: 'vim' });
		const { result } = renderHook(() => useShortcutKeys('goToHistory'));
		expect(result.current.keys).toEqual(['Ctrl', 'Alt', 'Shift', 'h']);
	});

	it('inherits the default chord in Vim mode for an action Vim does not override', () => {
		useSettingsStore.setState({ keyboardMode: 'vim' });
		const { result } = renderHook(() => useShortcutKeys('settings'));
		expect(result.current.keys).toEqual(DEFAULT_SHORTCUTS.settings.keys);
	});

	it('follows a rebind rather than the bundled default', () => {
		useSettingsStore.setState({
			shortcuts: {
				...DEFAULT_SHORTCUTS,
				goToHistory: { ...DEFAULT_SHORTCUTS.goToHistory, keys: ['Alt', 'Meta', 'y'] },
			},
		});
		const { result } = renderHook(() => useShortcutKeys('goToHistory'));
		expect(result.current.keys).toEqual(['Alt', 'Meta', 'y']);
	});

	it('returns the sequence beside the chord in Vim mode', () => {
		useSettingsStore.setState({ keyboardMode: 'vim' });
		const { result } = renderHook(() => useShortcutKeys('goToTab1'));
		expect(result.current.sequence).toEqual([['g'], ['g']]);
	});

	it('reads a fixed binding, which no mode overrides', () => {
		useSettingsStore.setState({ keyboardMode: 'vim' });
		const { result } = renderHook(() => useShortcutKeys('fontSizeIncrease'));
		expect(result.current.keys).toEqual(FIXED_SHORTCUTS.fontSizeIncrease.keys);
	});

	it('returns nothing to draw for an unknown or absent action id', () => {
		const unknown = renderHook(() => useShortcutKeys('noSuchAction'));
		expect(unknown.result.current.keys).toEqual([]);
		expect(unknown.result.current.sequence).toBeUndefined();

		const absent = renderHook(() => useShortcutKeys(undefined));
		expect(absent.result.current.keys).toEqual([]);
	});

	it('keeps one object across re-renders, so a consumer memo holds', () => {
		const { result, rerender } = renderHook(() => useShortcutKeys('goToHistory'));
		const first = result.current;
		rerender();
		expect(result.current).toBe(first);
	});
});
