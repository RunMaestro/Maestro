/**
 * `usePersistedToggle` - one boolean remembered under a localStorage key.
 *
 * The behaviour worth pinning is the degradation: a renderer with storage
 * blocked (private mode, a hostile Storage, jsdom) must still get a working
 * in-memory toggle rather than an exception on the way to painting a pane.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { installLocalStorageMock } from '../../../helpers/mockLocalStorage';
import { usePersistedToggle } from '../../../../renderer/hooks/ui/usePersistedToggle';

const KEY = 'test.toggle';

describe('usePersistedToggle', () => {
	beforeEach(() => {
		// jsdom here ships no working Storage - install the shared in-memory
		// stand-in, which also resets the store between tests.
		installLocalStorageMock();
	});

	it('starts at the default with nothing persisted', () => {
		expect(renderHook(() => usePersistedToggle(KEY)).result.current.value).toBe(false);
		expect(renderHook(() => usePersistedToggle(KEY, true)).result.current.value).toBe(true);
	});

	it('reads a stored value in preference to the default', () => {
		window.localStorage.setItem(KEY, 'false');
		expect(renderHook(() => usePersistedToggle(KEY, true)).result.current.value).toBe(false);
	});

	it('writes the new value on toggle', () => {
		const { result } = renderHook(() => usePersistedToggle(KEY));
		act(() => result.current.toggle());
		expect(result.current.value).toBe(true);
		expect(window.localStorage.getItem(KEY)).toBe('true');
	});

	it('writes the new value on setValue', () => {
		const { result } = renderHook(() => usePersistedToggle(KEY, true));
		act(() => result.current.setValue(false));
		expect(result.current.value).toBe(false);
		expect(window.localStorage.getItem(KEY)).toBe('false');
	});

	it('survives a remount under the same key', () => {
		const first = renderHook(() => usePersistedToggle(KEY));
		act(() => first.result.current.toggle());
		first.unmount();

		expect(renderHook(() => usePersistedToggle(KEY)).result.current.value).toBe(true);
	});

	it('keeps keys separate', () => {
		const a = renderHook(() => usePersistedToggle('surface.a'));
		act(() => a.result.current.toggle());
		expect(renderHook(() => usePersistedToggle('surface.b')).result.current.value).toBe(false);
	});

	it('still toggles in memory when storage throws', () => {
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			get() {
				throw new Error('storage blocked');
			},
		});

		const { result } = renderHook(() => usePersistedToggle(KEY, false));
		expect(result.current.value).toBe(false);
		act(() => result.current.toggle());
		expect(result.current.value).toBe(true);
	});

	it('still toggles when there is no Storage at all', () => {
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			writable: true,
			value: undefined,
		});

		const { result } = renderHook(() => usePersistedToggle(KEY, true));
		expect(result.current.value).toBe(true);
		act(() => result.current.setValue(false));
		expect(result.current.value).toBe(false);
	});
});
