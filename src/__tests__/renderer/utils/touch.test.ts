/**
 * Tests for the hoisted touch primitives in `src/renderer/utils/touch.ts`.
 * Focuses on `isCoarsePointer` (the new helper) and `triggerHaptic`.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	isCoarsePointer,
	triggerHaptic,
	supportsHaptics,
	isTapGesture,
	installPointerTypeTracking,
	isTouchEmulatedMouseEvent,
	resetPointerTypeTrackingForTests,
	GESTURE_THRESHOLDS,
	HAPTIC_PATTERNS,
} from '../../../renderer/utils/touch';

describe('touch primitives', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('isCoarsePointer', () => {
		it('returns true when the coarse-pointer media query matches', () => {
			vi.spyOn(window, 'matchMedia').mockImplementation(
				(query: string) =>
					({
						matches: query === '(pointer: coarse)',
						media: query,
					}) as MediaQueryList
			);
			expect(isCoarsePointer()).toBe(true);
		});

		it('returns false when the media query does not match (fine pointer)', () => {
			vi.spyOn(window, 'matchMedia').mockImplementation(
				(query: string) =>
					({
						matches: false,
						media: query,
					}) as MediaQueryList
			);
			expect(isCoarsePointer()).toBe(false);
		});

		it('falls back to false when matchMedia throws', () => {
			vi.spyOn(window, 'matchMedia').mockImplementation(() => {
				throw new Error('matchMedia unavailable');
			});
			expect(isCoarsePointer()).toBe(false);
		});
	});

	describe('triggerHaptic', () => {
		it('calls navigator.vibrate with the given pattern when supported', () => {
			const vibrate = vi.fn();
			Object.defineProperty(navigator, 'vibrate', {
				configurable: true,
				value: vibrate,
			});
			expect(supportsHaptics()).toBe(true);
			triggerHaptic(HAPTIC_PATTERNS.tap);
			expect(vibrate).toHaveBeenCalledWith(HAPTIC_PATTERNS.tap);
		});

		it('is a no-op when vibrate is unavailable', () => {
			Object.defineProperty(navigator, 'vibrate', {
				configurable: true,
				value: undefined,
			});
			expect(supportsHaptics()).toBe(false);
			// Should not throw.
			expect(() => triggerHaptic(HAPTIC_PATTERNS.success)).not.toThrow();
		});
	});

	describe('isTapGesture', () => {
		it('treats a stationary touch as a tap', () => {
			expect(isTapGesture({ x: 100, y: 100 }, { x: 100, y: 100 })).toBe(true);
		});

		it('treats sub-tolerance jitter on both axes as a tap', () => {
			const tol = GESTURE_THRESHOLDS.tapMoveTolerance;
			expect(isTapGesture({ x: 0, y: 0 }, { x: tol, y: tol })).toBe(true);
			expect(isTapGesture({ x: 20, y: 20 }, { x: 20 - tol, y: 20 - tol })).toBe(true);
		});

		it('treats travel past the tolerance on either axis as a scroll (not a tap)', () => {
			const tol = GESTURE_THRESHOLDS.tapMoveTolerance;
			expect(isTapGesture({ x: 0, y: 0 }, { x: tol + 1, y: 0 })).toBe(false);
			expect(isTapGesture({ x: 0, y: 0 }, { x: 0, y: tol + 1 })).toBe(false);
			// A vertical scroll gesture (common on a terminal scrollback).
			expect(isTapGesture({ x: 50, y: 50 }, { x: 52, y: 140 })).toBe(false);
		});

		it('honors an explicit tolerance override', () => {
			expect(isTapGesture({ x: 0, y: 0 }, { x: 40, y: 0 }, 50)).toBe(true);
			expect(isTapGesture({ x: 0, y: 0 }, { x: 60, y: 0 }, 50)).toBe(false);
		});
	});

	describe('isTouchEmulatedMouseEvent', () => {
		const fire = (type: 'pointerover' | 'pointerdown', pointerType: string) => {
			const event = new Event(type, { bubbles: true });
			Object.defineProperty(event, 'pointerType', { value: pointerType });
			document.dispatchEvent(event);
		};

		afterEach(() => {
			resetPointerTypeTrackingForTests();
		});

		it('falls back to the primary pointer before any pointer event is seen', () => {
			installPointerTypeTracking();
			vi.spyOn(window, 'matchMedia').mockImplementation(
				(query: string) =>
					({ matches: query === '(pointer: coarse)', media: query }) as MediaQueryList
			);
			expect(isTouchEmulatedMouseEvent()).toBe(true);
		});

		it('follows the pointer that produced the latest pointerover or pointerdown', () => {
			installPointerTypeTracking();
			fire('pointerover', 'touch');
			expect(isTouchEmulatedMouseEvent()).toBe(true);
			fire('pointerover', 'mouse');
			expect(isTouchEmulatedMouseEvent()).toBe(false);
			fire('pointerdown', 'pen');
			expect(isTouchEmulatedMouseEvent()).toBe(true);
		});

		it('installs its listeners once however many times it is called', () => {
			const add = vi.spyOn(document, 'addEventListener');
			installPointerTypeTracking();
			installPointerTypeTracking();
			expect(add.mock.calls.filter(([type]) => type === 'pointerover')).toHaveLength(1);
		});
	});
});
