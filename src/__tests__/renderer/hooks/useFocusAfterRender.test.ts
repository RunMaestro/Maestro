/**
 * Tests for useFocusAfterRender hook
 *
 * Verifies focus behavior based on condition, delay, and ref state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createRef } from 'react';
import { useFocusAfterRender } from '../../../renderer/hooks/utils/useFocusAfterRender';

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

		// No delay argument — should default to 0
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
