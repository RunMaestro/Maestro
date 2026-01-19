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
