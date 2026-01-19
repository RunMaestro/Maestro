/**
 * Tests for src/web/mobile/constants.ts
 *
 * Tests the utility functions that have actual logic.
 * Constants are not tested exhaustively - they're simple values.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
	defaultMobileConfig,
	MOBILE_BREAKPOINTS,
	GESTURE_THRESHOLDS,
	isMobileViewport,
	supportsHaptics,
	triggerHaptic,
	HAPTIC_PATTERNS,
	supportsVoiceInput,
} from '../../../web/mobile/constants';

describe('web/mobile/constants', () => {
	describe('defaultMobileConfig', () => {
		it('should have sensible defaults', () => {
			expect(defaultMobileConfig.enableHaptics).toBe(true);
			expect(defaultMobileConfig.enableVoiceInput).toBe(true);
			expect(defaultMobileConfig.enableOfflineQueue).toBe(true);
			expect(defaultMobileConfig.enablePullToRefresh).toBe(true);
			expect(typeof defaultMobileConfig.maxInputLines).toBe('number');
		});
	});

	describe('MOBILE_BREAKPOINTS', () => {
		it('should have breakpoints in ascending order', () => {
			expect(MOBILE_BREAKPOINTS.small).toBeLessThan(MOBILE_BREAKPOINTS.medium);
			expect(MOBILE_BREAKPOINTS.medium).toBeLessThan(MOBILE_BREAKPOINTS.large);
			expect(MOBILE_BREAKPOINTS.large).toBeLessThan(MOBILE_BREAKPOINTS.max);
		});
	});

	describe('GESTURE_THRESHOLDS', () => {
		it('should have reasonable UX values', () => {
			expect(GESTURE_THRESHOLDS.swipeDistance).toBeGreaterThan(0);
			expect(GESTURE_THRESHOLDS.swipeTime).toBeGreaterThan(0);
			expect(GESTURE_THRESHOLDS.pullToRefresh).toBeGreaterThan(GESTURE_THRESHOLDS.swipeDistance);
			expect(GESTURE_THRESHOLDS.longPress).toBeGreaterThan(GESTURE_THRESHOLDS.swipeTime);
		});
	});

	describe('isMobileViewport', () => {
		const originalInnerWidth = window.innerWidth;

		afterEach(() => {
			Object.defineProperty(window, 'innerWidth', {
				value: originalInnerWidth,
				writable: true,
				configurable: true,
			});
		});

		it('should return true for width <= max breakpoint', () => {
			Object.defineProperty(window, 'innerWidth', {
				value: MOBILE_BREAKPOINTS.max,
				configurable: true,
			});
			expect(isMobileViewport()).toBe(true);

			Object.defineProperty(window, 'innerWidth', { value: 320, configurable: true });
			expect(isMobileViewport()).toBe(true);
		});

		it('should return false for width > max breakpoint', () => {
			Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
			expect(isMobileViewport()).toBe(false);
		});
	});

	describe('supportsHaptics', () => {
		const originalNavigator = global.navigator;

		afterEach(() => {
			Object.defineProperty(global, 'navigator', {
				value: originalNavigator,
				writable: true,
				configurable: true,
			});
		});

		it('should return true when navigator.vibrate exists', () => {
			Object.defineProperty(global, 'navigator', {
				value: { vibrate: vi.fn() },
				configurable: true,
			});
			expect(supportsHaptics()).toBe(true);
		});

		it('should return false when navigator.vibrate does not exist', () => {
			Object.defineProperty(global, 'navigator', {
				value: {},
				configurable: true,
			});
			expect(supportsHaptics()).toBe(false);
		});
	});

	describe('triggerHaptic', () => {
		let vibrateMock: ReturnType<typeof vi.fn>;

		beforeEach(() => {
			vibrateMock = vi.fn().mockReturnValue(true);
			Object.defineProperty(global, 'navigator', {
				value: { vibrate: vibrateMock },
				configurable: true,
			});
		});

		it('should call navigator.vibrate with pattern', () => {
			triggerHaptic(HAPTIC_PATTERNS.tap);
			expect(vibrateMock).toHaveBeenCalledWith(HAPTIC_PATTERNS.tap);

			triggerHaptic(HAPTIC_PATTERNS.send);
			expect(vibrateMock).toHaveBeenCalledWith(HAPTIC_PATTERNS.send);
		});

		it('should not throw when haptics not supported', () => {
			Object.defineProperty(global, 'navigator', { value: {}, configurable: true });
			expect(() => triggerHaptic()).not.toThrow();
		});
	});

	describe('supportsVoiceInput', () => {
		afterEach(() => {
			// @ts-expect-error - Testing cleanup
			delete window.webkitSpeechRecognition;
			// @ts-expect-error - Testing cleanup
			delete window.SpeechRecognition;
		});

		it('should return true when speech recognition API exists', () => {
			// @ts-expect-error - Testing webkit property
			window.webkitSpeechRecognition = class {};
			expect(supportsVoiceInput()).toBe(true);
		});

		it('should return false when neither API exists', () => {
			expect(supportsVoiceInput()).toBe(false);
		});
	});
});
