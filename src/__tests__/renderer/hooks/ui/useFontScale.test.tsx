/**
 * Tests for useFontScale - the shared, persisted font-zoom state behind the
 * Director's Notes and file-preview zoom controls.
 *
 * The rounding assertions are not cosmetic: the value is interpolated straight
 * into a `calc()` and written to localStorage, so a raw float sum would ship
 * `calc(0.875rem * 1.0000000000000002)` to the DOM.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useFontScale,
	clampFontScale,
	FONT_SCALE_MIN,
	FONT_SCALE_MAX,
} from '../../../../renderer/hooks/ui/useFontScale';
import { installLocalStorageMock } from '../../../helpers/mockLocalStorage';

const KEY = 'test.fontScale';

describe('clampFontScale', () => {
	it('holds the supported range', () => {
		expect(clampFontScale(5)).toBe(FONT_SCALE_MAX);
		expect(clampFontScale(0.1)).toBe(FONT_SCALE_MIN);
	});

	it('falls back to 1 for junk', () => {
		expect(clampFontScale(Number.NaN)).toBe(1);
	});

	it('rounds float drift away', () => {
		expect(clampFontScale(1.0000000000000002)).toBe(1);
		expect(clampFontScale(1.2000000000000002)).toBe(1.2);
	});
});

describe('useFontScale', () => {
	beforeEach(() => {
		// jsdom in this environment ships no working Storage, so install the same
		// in-memory stand-in the other localStorage-backed tests use.
		installLocalStorageMock();
	});

	it('starts at 100% with nothing persisted', () => {
		const { result } = renderHook(() => useFontScale(KEY));
		expect(result.current.fontScale).toBe(1);
		expect(result.current.canDecrease).toBe(true);
		expect(result.current.canIncrease).toBe(true);
	});

	it('loads and clamps the persisted value', () => {
		window.localStorage.setItem(KEY, '9');
		const { result } = renderHook(() => useFontScale(KEY));
		expect(result.current.fontScale).toBe(FONT_SCALE_MAX);
		expect(result.current.canIncrease).toBe(false);
		expect(result.current.canDecrease).toBe(true);
	});

	it('steps up and persists a clean number', () => {
		const { result } = renderHook(() => useFontScale(KEY));

		act(() => result.current.adjustFontScale(1));

		expect(result.current.fontScale).toBe(1.1);
		expect(window.localStorage.getItem(KEY)).toBe('1.1');
	});

	it('steps down and persists', () => {
		const { result } = renderHook(() => useFontScale(KEY));

		act(() => result.current.adjustFontScale(-1));

		expect(result.current.fontScale).toBe(0.9);
		expect(window.localStorage.getItem(KEY)).toBe('0.9');
	});

	it('does not drift past the bounds on repeated steps', () => {
		const { result } = renderHook(() => useFontScale(KEY));

		act(() => {
			for (let i = 0; i < 40; i++) result.current.adjustFontScale(1);
		});
		expect(result.current.fontScale).toBe(FONT_SCALE_MAX);

		act(() => {
			for (let i = 0; i < 40; i++) result.current.adjustFontScale(-1);
		});
		expect(result.current.fontScale).toBe(FONT_SCALE_MIN);
	});

	it('resets back to 100% and persists that', () => {
		window.localStorage.setItem(KEY, '1.5');
		const { result } = renderHook(() => useFontScale(KEY));

		act(() => result.current.resetFontScale());

		expect(result.current.fontScale).toBe(1);
		expect(window.localStorage.getItem(KEY)).toBe('1');
	});

	it('keys surfaces independently', () => {
		const a = renderHook(() => useFontScale('surface.a'));
		const b = renderHook(() => useFontScale('surface.b'));

		act(() => a.result.current.adjustFontScale(1));

		expect(window.localStorage.getItem('surface.a')).toBe('1.1');
		expect(window.localStorage.getItem('surface.b')).toBeNull();
		expect(b.result.current.fontScale).toBe(1);
	});
});

/**
 * The hook runs during render of panes as large as the whole file preview, so a
 * Storage that is missing or refuses access has to cost the user their
 * persistence and nothing else. Mounting FilePreview in a jsdom without Storage
 * is exactly how this surfaced.
 */
describe('useFontScale without a working Storage', () => {
	let descriptor: PropertyDescriptor | undefined;

	beforeEach(() => {
		descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			writable: true,
			value: undefined,
		});
	});

	afterEach(() => {
		if (descriptor) Object.defineProperty(window, 'localStorage', descriptor);
	});

	it('starts at 100% instead of throwing', () => {
		const { result } = renderHook(() => useFontScale(KEY));
		expect(result.current.fontScale).toBe(1);
	});

	it('still zooms, it just cannot remember', () => {
		const { result } = renderHook(() => useFontScale(KEY));

		act(() => result.current.adjustFontScale(1));

		expect(result.current.fontScale).toBe(1.1);
	});
});
