/**
 * Tests for the shared tap-vs-hold classifier behind every microphone button.
 *
 * Each case here is a bug the two hand-rolled copies had, or would have had:
 * a release that never fires because the pointer moved off the button, a hold
 * that survives the surface closing, and a classifier that has to agree with the
 * global hotkey about where a tap ends and a hold begins.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePressAndHold } from '../../../../renderer/hooks/utils/usePressAndHold';

const HOLD_MS = 300;

function setup(overrides: Partial<Parameters<typeof usePressAndHold>[0]> = {}) {
	const onHoldStart = vi.fn();
	const onHoldEnd = vi.fn();
	const onTap = vi.fn();
	const rendered = renderHook(() =>
		usePressAndHold({ holdThresholdMs: HOLD_MS, onHoldStart, onHoldEnd, onTap, ...overrides })
	);
	return { ...rendered, onHoldStart, onHoldEnd, onTap };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('usePressAndHold', () => {
	it('reads a short press as a tap', () => {
		const { result, onTap, onHoldStart, onHoldEnd } = setup();

		act(() => result.current.beginPress());
		act(() => {
			vi.advanceTimersByTime(HOLD_MS - 1);
		});
		act(() => result.current.endPress());

		expect(onTap).toHaveBeenCalledTimes(1);
		expect(onHoldStart).not.toHaveBeenCalled();
		expect(onHoldEnd).not.toHaveBeenCalled();
	});

	it('reads a long press as a hold, and its release as the end', () => {
		const { result, onTap, onHoldStart, onHoldEnd } = setup();

		act(() => result.current.beginPress());
		act(() => {
			vi.advanceTimersByTime(HOLD_MS);
		});
		expect(onHoldStart).toHaveBeenCalledTimes(1);
		expect(result.current.holding).toBe(true);

		act(() => result.current.endPress());

		expect(onHoldEnd).toHaveBeenCalledTimes(1);
		expect(onTap).not.toHaveBeenCalled();
		expect(result.current.holding).toBe(false);
	});

	it('releases when the pointer comes up somewhere else entirely', () => {
		// Dragging off the button is the commonest way to abort a press, and an
		// element-scoped `pointerup` never sees it - which leaves the microphone
		// open with nothing holding it.
		const { result, onHoldEnd } = setup();

		act(() => result.current.beginPress());
		act(() => {
			vi.advanceTimersByTime(HOLD_MS);
		});
		act(() => {
			window.dispatchEvent(new Event('pointerup'));
		});

		expect(onHoldEnd).toHaveBeenCalledTimes(1);
	});

	it('releases a hold interrupted by the surface closing', () => {
		const { result, unmount, onHoldEnd } = setup();

		act(() => result.current.beginPress());
		act(() => {
			vi.advanceTimersByTime(HOLD_MS);
		});
		unmount();

		expect(onHoldEnd).toHaveBeenCalledTimes(1);
	});

	it('does not report a tap for a press that was never begun', () => {
		const { result, onTap } = setup();

		act(() => result.current.endPress());

		expect(onTap).not.toHaveBeenCalled();
	});

	it('ignores a second press while one is already in flight', () => {
		const { result, onHoldStart } = setup();

		act(() => result.current.beginPress());
		act(() => result.current.beginPress());
		act(() => {
			vi.advanceTimersByTime(HOLD_MS);
		});

		expect(onHoldStart).toHaveBeenCalledTimes(1);
	});

	it('ignores presses entirely while disabled', () => {
		const { result, onTap, onHoldStart } = setup({ disabled: true });

		act(() => result.current.beginPress());
		act(() => {
			vi.advanceTimersByTime(HOLD_MS);
		});
		act(() => result.current.endPress());

		expect(onHoldStart).not.toHaveBeenCalled();
		expect(onTap).not.toHaveBeenCalled();
	});
});
