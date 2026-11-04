import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	flashJumpTarget,
	jumpToElement,
	JUMP_FLASH_DURATION_MS,
} from '../../../renderer/utils/jumpHighlight';

/**
 * jsdom has no layout engine: offsetParent is always null and scrollIntoView is
 * undefined. Both are stubbed so the retry loop and the scroll call are
 * observable.
 */
function makeTarget(): HTMLElement {
	const el = document.createElement('div');
	el.scrollIntoView = vi.fn();
	Object.defineProperty(el, 'offsetParent', { get: () => document.body, configurable: true });
	document.body.appendChild(el);
	return el;
}

/** Run queued animation frames; rAF is faked to a 16ms timer by vi.useFakeTimers. */
function flushFrames(count = 5) {
	for (let i = 0; i < count; i++) {
		vi.advanceTimersByTime(16);
	}
}

describe('flashJumpTarget', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		document.body.innerHTML = '';
	});

	it('scrolls the element into view and applies the flash class', () => {
		const el = makeTarget();
		flashJumpTarget(el);

		expect(el.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
		expect(el.classList.contains('jump-flash')).toBe(true);
	});

	it('removes the flash after the animation duration', () => {
		const el = makeTarget();
		flashJumpTarget(el);

		vi.advanceTimersByTime(JUMP_FLASH_DURATION_MS);
		expect(el.classList.contains('jump-flash')).toBe(false);
	});

	it('applies the themed color and clears it afterwards', () => {
		const el = makeTarget();
		flashJumpTarget(el, { color: '#ff0000' });

		expect(el.style.getPropertyValue('--jump-flash-color')).toBe('#ff0000');
		vi.advanceTimersByTime(JUMP_FLASH_DURATION_MS);
		expect(el.style.getPropertyValue('--jump-flash-color')).toBe('');
	});

	it('adds the arrow modifier only when requested', () => {
		const plain = makeTarget();
		flashJumpTarget(plain);
		expect(plain.classList.contains('jump-flash--arrow')).toBe(false);

		const arrowed = makeTarget();
		flashJumpTarget(arrowed, { arrow: true });
		expect(arrowed.classList.contains('jump-flash--arrow')).toBe(true);
	});

	it('skips scrolling when block is false', () => {
		const el = makeTarget();
		flashJumpTarget(el, { block: false });
		expect(el.scrollIntoView).not.toHaveBeenCalled();
		expect(el.classList.contains('jump-flash')).toBe(true);
	});

	it('cancel() clears the flash early', () => {
		const el = makeTarget();
		const cancel = flashJumpTarget(el);
		cancel();
		expect(el.classList.contains('jump-flash')).toBe(false);
	});

	it('scrolls exactly once when stabilizeFrames is not requested', () => {
		const el = makeTarget();
		flashJumpTarget(el);

		flushFrames(5);
		expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
	});

	it('re-asserts the scroll position for the requested number of frames', () => {
		const el = makeTarget();
		flashJumpTarget(el, { behavior: 'auto', stabilizeFrames: 3 });

		// The initial scroll, then one correction per stabilize frame.
		expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
		flushFrames(3);
		expect(el.scrollIntoView).toHaveBeenCalledTimes(4);

		// And it stops there rather than re-scrolling forever.
		flushFrames(5);
		expect(el.scrollIntoView).toHaveBeenCalledTimes(4);
	});

	it('corrections are always instant, even when the first scroll is smooth', () => {
		const el = makeTarget();
		flashJumpTarget(el, { stabilizeFrames: 2 });
		flushFrames(2);

		expect(el.scrollIntoView).toHaveBeenNthCalledWith(1, { behavior: 'smooth', block: 'center' });
		expect(el.scrollIntoView).toHaveBeenNthCalledWith(2, { behavior: 'auto', block: 'center' });
	});

	it('cancel() stops the stabilize loop', () => {
		const el = makeTarget();
		const cancel = flashJumpTarget(el, { behavior: 'auto', stabilizeFrames: 5 });
		cancel();

		flushFrames(5);
		expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
	});
});

describe('jumpToElement', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		document.body.innerHTML = '';
	});

	it('waits for the element to appear before flashing it', () => {
		let el: HTMLElement | null = null;
		const onFound = vi.fn();
		jumpToElement(() => el, { onFound });

		flushFrames(3);
		expect(onFound).not.toHaveBeenCalled();

		el = makeTarget();
		flushFrames(2);

		expect(onFound).toHaveBeenCalledWith(el);
		expect(el.classList.contains('jump-flash')).toBe(true);
	});

	it('gives up after maxAttempts and reports the timeout', () => {
		const onTimeout = vi.fn();
		jumpToElement(() => null, { maxAttempts: 3, onTimeout });

		flushFrames(6);
		expect(onTimeout).toHaveBeenCalledTimes(1);
	});

	it('ignores elements that are not laid out yet', () => {
		const el = document.createElement('div');
		el.scrollIntoView = vi.fn();
		Object.defineProperty(el, 'offsetParent', { get: () => null, configurable: true });
		document.body.appendChild(el);

		const onTimeout = vi.fn();
		jumpToElement(() => el, { maxAttempts: 2, onTimeout });
		flushFrames(5);

		expect(el.scrollIntoView).not.toHaveBeenCalled();
		expect(onTimeout).toHaveBeenCalled();
	});

	it('acts on a detached-but-present element when requireVisible is off', () => {
		const el = document.createElement('div');
		el.scrollIntoView = vi.fn();
		Object.defineProperty(el, 'offsetParent', { get: () => null, configurable: true });

		jumpToElement(() => el, { requireVisible: false });
		flushFrames(2);

		expect(el.scrollIntoView).toHaveBeenCalled();
	});

	it('cancel() stops the search so a later match is not flashed', () => {
		let el: HTMLElement | null = null;
		const cancel = jumpToElement(() => el);
		cancel();

		el = makeTarget();
		flushFrames(5);

		expect(el.classList.contains('jump-flash')).toBe(false);
	});
});
