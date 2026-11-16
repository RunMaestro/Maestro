/**
 * installMotionPause - pauses looping animations while the window is unfocused
 * or hidden, so an idle Maestro stops drawing a frame every vsync.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	MOTION_PAUSED_CLASS,
	installMotionPause,
	shouldPauseMotion,
} from '../../../renderer/utils/motionPause';

function setFocus(focused: boolean) {
	vi.spyOn(document, 'hasFocus').mockReturnValue(focused);
}

function setVisibility(state: DocumentVisibilityState) {
	Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

const paused = () => document.documentElement.classList.contains(MOTION_PAUSED_CLASS);

describe('motionPause', () => {
	let dispose: (() => void) | null = null;

	beforeEach(() => {
		vi.useFakeTimers();
		setVisibility('visible');
		setFocus(true);
	});

	afterEach(() => {
		dispose?.();
		dispose = null;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('pauses when the document is hidden or unfocused', () => {
		expect(shouldPauseMotion(document)).toBe(false);
		setFocus(false);
		expect(shouldPauseMotion(document)).toBe(true);
		setFocus(true);
		setVisibility('hidden');
		expect(shouldPauseMotion(document)).toBe(true);
	});

	it('applies the current state on install', () => {
		setFocus(false);
		dispose = installMotionPause(window);
		expect(paused()).toBe(true);
	});

	it('follows window blur and focus, one task after the event', () => {
		dispose = installMotionPause(window);
		expect(paused()).toBe(false);

		setFocus(false);
		window.dispatchEvent(new Event('blur'));
		// Deferred: a blur that moves focus into a child frame has not settled yet.
		expect(paused()).toBe(false);
		vi.runAllTimers();
		expect(paused()).toBe(true);

		setFocus(true);
		window.dispatchEvent(new Event('focus'));
		vi.runAllTimers();
		expect(paused()).toBe(false);
	});

	it('stays running when blur only moved focus into a child frame', () => {
		dispose = installMotionPause(window);
		// hasFocus() keeps reporting true while a hosted <iframe>/<webview> has focus.
		window.dispatchEvent(new Event('blur'));
		vi.runAllTimers();
		expect(paused()).toBe(false);
	});

	it('follows visibilitychange', () => {
		dispose = installMotionPause(window);
		setVisibility('hidden');
		document.dispatchEvent(new Event('visibilitychange'));
		vi.runAllTimers();
		expect(paused()).toBe(true);
	});

	it('removes the class and its listeners on dispose', () => {
		setFocus(false);
		dispose = installMotionPause(window);
		expect(paused()).toBe(true);
		dispose();
		dispose = null;
		expect(paused()).toBe(false);
		window.dispatchEvent(new Event('blur'));
		vi.runAllTimers();
		expect(paused()).toBe(false);
	});
});
