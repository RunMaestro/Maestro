/**
 * Tests for useLongPressMenu hook
 *
 * Covers:
 * - Long-press detection and menu opening
 * - Canceling long press on touch move
 * - Quick action handling
 * - Manual menu close
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLongPressMenu } from '../../../web/hooks/useLongPressMenu';

function createTouchEvent(target: HTMLButtonElement): React.TouchEvent<HTMLButtonElement> {
	return {
		currentTarget: target,
		touches: [{ clientX: 0, clientY: 0 }],
		preventDefault: vi.fn(),
	} as unknown as React.TouchEvent<HTMLButtonElement>;
}

describe('useLongPressMenu', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.runOnlyPendingTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('triggers onOpenCommandPalette after long press', () => {
		const onOpenCommandPalette = vi.fn();
		const button = document.createElement('button');

		const { result } = renderHook(() =>
			useLongPressMenu({
				inputMode: 'ai',
				value: 'hello',
				onOpenCommandPalette,
			})
		);

		act(() => {
			result.current.sendButtonRef.current = button;
		});

		act(() => {
			result.current.handleTouchStart(createTouchEvent(button));
			vi.advanceTimersByTime(500);
		});

		expect(onOpenCommandPalette).toHaveBeenCalledTimes(1);
	});

	it('cancels long press on touch move', () => {
		const onOpenCommandPalette = vi.fn();
		const button = document.createElement('button');

		const { result } = renderHook(() =>
			useLongPressMenu({
				inputMode: 'ai',
				value: 'hello',
				onOpenCommandPalette,
			})
		);

		act(() => {
			result.current.sendButtonRef.current = button;
		});

		act(() => {
			result.current.handleTouchStart(createTouchEvent(button));
			result.current.handleTouchMove();
			vi.advanceTimersByTime(500);
		});

		expect(onOpenCommandPalette).not.toHaveBeenCalled();
	});

	it('does not trigger onOpenCommandPalette when touch ends before duration', () => {
		const onOpenCommandPalette = vi.fn();
		const button = document.createElement('button');

		const { result } = renderHook(() =>
			useLongPressMenu({
				inputMode: 'ai',
				value: 'hello',
				onOpenCommandPalette,
			})
		);

		act(() => {
			result.current.sendButtonRef.current = button;
		});

		act(() => {
			result.current.handleTouchStart(createTouchEvent(button));
			result.current.handleTouchEnd(createTouchEvent(button));
			vi.advanceTimersByTime(500);
		});

		expect(onOpenCommandPalette).not.toHaveBeenCalled();
	});

	it('returns expected handler functions', () => {
		const { result } = renderHook(() =>
			useLongPressMenu({
				inputMode: 'ai',
				value: 'hello',
			})
		);

		expect(typeof result.current.handleTouchStart).toBe('function');
		expect(typeof result.current.handleTouchEnd).toBe('function');
		expect(typeof result.current.handleTouchMove).toBe('function');
		expect(result.current.sendButtonRef).toBeDefined();
	});
});
