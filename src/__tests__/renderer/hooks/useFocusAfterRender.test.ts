/**
 * Tests for the useFocusAfterRender / useFocusOnMount hooks
 *
 * Verifies focus behavior based on condition, delay, and ref state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createRef } from 'react';
import {
	useFocusAfterRender,
	useFocusOnMount,
	MOUNT_FOCUS_DELAY_MS,
} from '../../../renderer/hooks/utils/useFocusAfterRender';

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('useFocusAfterRender', () => {
	it('focuses the element when condition is true and delay is 0', () => {
		const el = document.createElement('input');
		const focusSpy = vi.spyOn(el, 'focus');
		const ref = createRef<HTMLElement>() as { current: HTMLElement | null };
		ref.current = el;

		renderHook(() => useFocusAfterRender(ref, true, 0));

		expect(focusSpy).toHaveBeenCalledTimes(1);
	});

	it('does not focus when condition is false', () => {
		const el = document.createElement('input');
		const focusSpy = vi.spyOn(el, 'focus');
		const ref = createRef<HTMLElement>() as { current: HTMLElement | null };
		ref.current = el;

		renderHook(() => useFocusAfterRender(ref, false, 0));

		expect(focusSpy).not.toHaveBeenCalled();
	});

	it('focuses after delay when delay > 0', () => {
		const el = document.createElement('input');
		const focusSpy = vi.spyOn(el, 'focus');
		const ref = createRef<HTMLElement>() as { current: HTMLElement | null };
		ref.current = el;

		renderHook(() => useFocusAfterRender(ref, true, 100));

		expect(focusSpy).not.toHaveBeenCalled();

		vi.advanceTimersByTime(100);

		expect(focusSpy).toHaveBeenCalledTimes(1);
	});

	it('cleans up timeout on unmount before it fires', () => {
		const el = document.createElement('input');
		const focusSpy = vi.spyOn(el, 'focus');
		const ref = createRef<HTMLElement>() as { current: HTMLElement | null };
		ref.current = el;

		const { unmount } = renderHook(() => useFocusAfterRender(ref, true, 200));

		unmount();
		vi.advanceTimersByTime(200);

		expect(focusSpy).not.toHaveBeenCalled();
	});

	it('defaults delay to 0 (immediate focus)', () => {
		const el = document.createElement('input');
		const focusSpy = vi.spyOn(el, 'focus');
		const ref = createRef<HTMLElement>() as { current: HTMLElement | null };
		ref.current = el;

		// No delay argument - should default to 0
		renderHook(() => useFocusAfterRender(ref, true));

		expect(focusSpy).toHaveBeenCalledTimes(1);
	});

	it('handles null ref gracefully', () => {
		const ref = createRef<HTMLElement>();
		// ref.current is null by default

		// Should not throw
		expect(() => {
			renderHook(() => useFocusAfterRender(ref, true, 0));
		}).not.toThrow();
	});
});

describe('useFocusOnMount', () => {
	function makeRef() {
		const el = document.createElement('input');
		const focusSpy = vi.spyOn(el, 'focus');
		const ref = createRef<HTMLElement>() as { current: HTMLElement | null };
		ref.current = el;
		return { ref, focusSpy };
	}

	it('focuses after the default deferral, not synchronously', () => {
		const { ref, focusSpy } = makeRef();

		renderHook(() => useFocusOnMount(ref));

		// Deferred on purpose: the surface that opened the modal restores focus
		// on its way out in the same commit.
		expect(focusSpy).not.toHaveBeenCalled();

		vi.advanceTimersByTime(MOUNT_FOCUS_DELAY_MS);

		expect(focusSpy).toHaveBeenCalledTimes(1);
	});

	it('focuses synchronously when the delay is 0', () => {
		const { ref, focusSpy } = makeRef();

		renderHook(() => useFocusOnMount(ref, 0));

		expect(focusSpy).toHaveBeenCalledTimes(1);
	});

	it('does not re-focus on later renders', () => {
		const { ref, focusSpy } = makeRef();

		const { rerender } = renderHook(() => useFocusOnMount(ref));
		vi.advanceTimersByTime(MOUNT_FOCUS_DELAY_MS);
		expect(focusSpy).toHaveBeenCalledTimes(1);

		rerender();
		vi.advanceTimersByTime(MOUNT_FOCUS_DELAY_MS);

		expect(focusSpy).toHaveBeenCalledTimes(1);
	});

	it('cleans up the pending timeout on unmount', () => {
		const { ref, focusSpy } = makeRef();

		const { unmount } = renderHook(() => useFocusOnMount(ref));
		unmount();
		vi.advanceTimersByTime(MOUNT_FOCUS_DELAY_MS);

		expect(focusSpy).not.toHaveBeenCalled();
	});

	it('handles a null ref gracefully', () => {
		const ref = createRef<HTMLElement>();

		expect(() => {
			renderHook(() => useFocusOnMount(ref));
			vi.advanceTimersByTime(MOUNT_FOCUS_DELAY_MS);
		}).not.toThrow();
	});
});
