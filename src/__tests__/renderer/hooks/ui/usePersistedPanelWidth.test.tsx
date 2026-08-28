/**
 * `usePersistedPanelWidth` - one panel width remembered under a localStorage key.
 *
 * Two behaviours worth pinning: a stored width is clamped on READ (bounds that
 * tighten in a later build must not restore a pane wider than its container),
 * and a blocked or missing Storage costs the user persistence, not their pane.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { installLocalStorageMock } from '../../../helpers/mockLocalStorage';
import { usePersistedPanelWidth } from '../../../../renderer/hooks/ui/usePersistedPanelWidth';

const KEY = 'test.panelWidth';
const BOUNDS = { defaultWidth: 560, minWidth: 320, maxWidth: 1400 };

describe('usePersistedPanelWidth', () => {
	beforeEach(() => {
		// jsdom here ships no working Storage - install the shared in-memory
		// stand-in, which also resets the store between tests.
		installLocalStorageMock();
	});

	it('starts at the default with nothing persisted', () => {
		expect(renderHook(() => usePersistedPanelWidth(KEY, BOUNDS)).result.current.width).toBe(560);
	});

	it('reads a stored width in preference to the default', () => {
		window.localStorage.setItem(KEY, '820');
		expect(renderHook(() => usePersistedPanelWidth(KEY, BOUNDS)).result.current.width).toBe(820);
	});

	it('clamps a stored width that falls outside the current bounds', () => {
		window.localStorage.setItem(KEY, '4000');
		expect(renderHook(() => usePersistedPanelWidth(KEY, BOUNDS)).result.current.width).toBe(1400);

		window.localStorage.setItem(KEY, '10');
		expect(renderHook(() => usePersistedPanelWidth(KEY, BOUNDS)).result.current.width).toBe(320);
	});

	it('falls back to the default for junk in storage', () => {
		window.localStorage.setItem(KEY, 'not-a-number');
		expect(renderHook(() => usePersistedPanelWidth(KEY, BOUNDS)).result.current.width).toBe(560);

		window.localStorage.setItem(KEY, '0');
		expect(renderHook(() => usePersistedPanelWidth(KEY, BOUNDS)).result.current.width).toBe(560);
	});

	it('clamps, rounds, and stores on setWidth', () => {
		const { result } = renderHook(() => usePersistedPanelWidth(KEY, BOUNDS));

		act(() => result.current.setWidth(700.6));
		expect(result.current.width).toBe(701);
		expect(window.localStorage.getItem(KEY)).toBe('701');

		act(() => result.current.setWidth(9000));
		expect(result.current.width).toBe(1400);
		expect(window.localStorage.getItem(KEY)).toBe('1400');
	});

	it('survives a remount under the same key', () => {
		const first = renderHook(() => usePersistedPanelWidth(KEY, BOUNDS));
		act(() => first.result.current.setWidth(900));
		first.unmount();

		expect(renderHook(() => usePersistedPanelWidth(KEY, BOUNDS)).result.current.width).toBe(900);
	});

	it('forgets the stored width on reset', () => {
		const { result } = renderHook(() => usePersistedPanelWidth(KEY, BOUNDS));
		act(() => result.current.setWidth(900));
		act(() => result.current.reset());

		expect(result.current.width).toBe(560);
		expect(window.localStorage.getItem(KEY)).toBeNull();
	});

	it('keeps keys separate', () => {
		const a = renderHook(() => usePersistedPanelWidth('surface.a', BOUNDS));
		act(() => a.result.current.setWidth(900));
		expect(renderHook(() => usePersistedPanelWidth('surface.b', BOUNDS)).result.current.width).toBe(
			560
		);
	});

	it('still resizes in memory when storage throws', () => {
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			get() {
				throw new Error('storage blocked');
			},
		});

		const { result } = renderHook(() => usePersistedPanelWidth(KEY, BOUNDS));
		expect(result.current.width).toBe(560);
		act(() => result.current.setWidth(700));
		expect(result.current.width).toBe(700);
	});

	it('still resizes when there is no Storage at all', () => {
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			writable: true,
			value: undefined,
		});

		const { result } = renderHook(() => usePersistedPanelWidth(KEY, BOUNDS));
		act(() => result.current.setWidth(700));
		expect(result.current.width).toBe(700);
	});
});
