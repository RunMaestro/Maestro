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
import { triggerHapticFeedback, useLongPressMenu } from '../../web/hooks/useLongPressMenu';

function createTouchEvent(target: HTMLButtonElement): React.TouchEvent<HTMLButtonElement> {
	return {
		currentTarget: target,
		touches: [{ clientX: 0, clientY: 0 }],
		preventDefault: vi.fn(),
	} as unknown as React.TouchEvent<HTMLButtonElement>;
}

describe('useLongPressMenu', () => {
	let originalVibrate: PropertyDescriptor | undefined;

	beforeEach(() => {
		originalVibrate = Object.getOwnPropertyDescriptor(navigator, 'vibrate');
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.runOnlyPendingTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
		if (originalVibrate) {
			Object.defineProperty(navigator, 'vibrate', originalVibrate);
		} else {
			delete (navigator as Navigator & { vibrate?: unknown }).vibrate;
		}
	});

	it('maps haptic feedback patterns to vibration durations and swallows vibration failures', () => {
		const vibrate = vi.fn();
		Object.defineProperty(navigator, 'vibrate', {
			configurable: true,
			value: vibrate,
		});

		triggerHapticFeedback('light');
		triggerHapticFeedback('medium');
		triggerHapticFeedback('strong');
		triggerHapticFeedback(75);

		expect(vibrate).toHaveBeenNthCalledWith(1, 10);
		expect(vibrate).toHaveBeenNthCalledWith(2, 25);
		expect(vibrate).toHaveBeenNthCalledWith(3, 50);
		expect(vibrate).toHaveBeenNthCalledWith(4, 75);

		vibrate.mockImplementationOnce(() => {
			throw new Error('vibration denied');
		});
		expect(() => triggerHapticFeedback('medium')).not.toThrow();
	});

	it('opens the menu after long press', () => {
		const button = document.createElement('button');
		button.getBoundingClientRect = vi.fn(() => ({
			left: 10,
			top: 20,
			width: 30,
			height: 40,
			right: 40,
			bottom: 60,
			x: 10,
			y: 20,
			toJSON: () => {},
		})) as unknown as () => DOMRect;

		const { result } = renderHook(() =>
			useLongPressMenu({
				inputMode: 'ai',
				value: 'hello',
			})
		);

		act(() => {
			result.current.sendButtonRef.current = button;
		});

		act(() => {
			result.current.handleTouchStart(createTouchEvent(button));
			vi.advanceTimersByTime(500);
		});

		expect(result.current.isMenuOpen).toBe(true);
		expect(result.current.menuAnchor).toEqual({ x: 25, y: 20 });
	});

	it('does not open the menu when touch starts without a button ref', () => {
		const button = document.createElement('button');
		const { result } = renderHook(() =>
			useLongPressMenu({
				inputMode: 'ai',
				value: 'hello',
			})
		);

		act(() => {
			result.current.handleTouchStart(createTouchEvent(button));
			vi.advanceTimersByTime(500);
		});

		expect(result.current.isMenuOpen).toBe(false);
		expect(result.current.menuAnchor).toBeNull();
		expect(button.style.transform).toBe('scale(0.95)');
	});

	it('does not scale the touched button when disabled or empty', () => {
		const disabledButton = document.createElement('button');
		const emptyButton = document.createElement('button');
		const { result: disabledResult } = renderHook(() =>
			useLongPressMenu({
				inputMode: 'ai',
				disabled: true,
				value: 'hello',
			})
		);
		const { result: emptyResult } = renderHook(() =>
			useLongPressMenu({
				inputMode: 'ai',
				value: '   ',
			})
		);

		act(() => {
			disabledResult.current.handleTouchStart(createTouchEvent(disabledButton));
			emptyResult.current.handleTouchStart(createTouchEvent(emptyButton));
		});

		expect(disabledButton.style.transform).toBe('');
		expect(emptyButton.style.transform).toBe('');
	});

	it('cancels long press on touch move', () => {
		const button = document.createElement('button');
		button.getBoundingClientRect = vi.fn(() => ({
			left: 0,
			top: 0,
			width: 10,
			height: 10,
			right: 10,
			bottom: 10,
			x: 0,
			y: 0,
			toJSON: () => {},
		})) as unknown as () => DOMRect;

		const { result } = renderHook(() =>
			useLongPressMenu({
				inputMode: 'ai',
				value: 'hello',
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

		expect(result.current.isMenuOpen).toBe(false);
	});

	it('resets touch scale and cancels long press on touch end', () => {
		const button = document.createElement('button');
		button.getBoundingClientRect = vi.fn(() => ({
			left: 0,
			top: 0,
			width: 10,
			height: 10,
			right: 10,
			bottom: 10,
			x: 0,
			y: 0,
			toJSON: () => {},
		})) as unknown as () => DOMRect;

		const { result } = renderHook(() =>
			useLongPressMenu({
				inputMode: 'ai',
				value: 'hello',
			})
		);

		act(() => {
			result.current.sendButtonRef.current = button;
			result.current.handleTouchStart(createTouchEvent(button));
			result.current.handleTouchEnd(createTouchEvent(button));
			vi.advanceTimersByTime(500);
		});

		expect(button.style.transform).toBe('scale(1)');
		expect(result.current.isMenuOpen).toBe(false);
	});

	it('cleans up a pending long-press timer on unmount', () => {
		const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
		const button = document.createElement('button');
		button.getBoundingClientRect = vi.fn(() => ({
			left: 0,
			top: 0,
			width: 10,
			height: 10,
			right: 10,
			bottom: 10,
			x: 0,
			y: 0,
			toJSON: () => {},
		})) as unknown as () => DOMRect;

		const { result, unmount } = renderHook(() =>
			useLongPressMenu({
				inputMode: 'ai',
				value: 'hello',
			})
		);

		act(() => {
			result.current.sendButtonRef.current = button;
			result.current.handleTouchStart(createTouchEvent(button));
		});

		unmount();

		expect(clearTimeoutSpy).toHaveBeenCalled();
	});

	it('handles quick action selection', () => {
		const onModeToggle = vi.fn();
		const { result } = renderHook(() =>
			useLongPressMenu({
				inputMode: 'ai',
				onModeToggle,
				value: 'hello',
			})
		);

		act(() => {
			result.current.handleQuickAction('switch_mode');
		});

		expect(onModeToggle).toHaveBeenCalledWith('terminal');
	});

	it('toggles terminal mode back to AI and ignores unsupported quick actions', () => {
		const onModeToggle = vi.fn();
		const { result } = renderHook(() =>
			useLongPressMenu({
				inputMode: 'terminal',
				onModeToggle,
				value: 'hello',
			})
		);

		act(() => {
			result.current.handleQuickAction('switch_mode');
			result.current.handleQuickAction('unsupported' as never);
		});

		expect(onModeToggle).toHaveBeenCalledTimes(1);
		expect(onModeToggle).toHaveBeenCalledWith('ai');
	});

	it('closes the menu when requested', () => {
		const button = document.createElement('button');
		button.getBoundingClientRect = vi.fn(() => ({
			left: 0,
			top: 0,
			width: 10,
			height: 10,
			right: 10,
			bottom: 10,
			x: 0,
			y: 0,
			toJSON: () => {},
		})) as unknown as () => DOMRect;

		const { result } = renderHook(() =>
			useLongPressMenu({
				inputMode: 'ai',
				value: 'hello',
			})
		);

		act(() => {
			result.current.sendButtonRef.current = button;
		});

		act(() => {
			result.current.handleTouchStart(createTouchEvent(button));
			vi.advanceTimersByTime(500);
		});

		expect(result.current.isMenuOpen).toBe(true);

		act(() => {
			result.current.closeMenu();
		});

		expect(result.current.isMenuOpen).toBe(false);
	});
});
