/**
 * Tests for the shared activity event bus.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribeToActivity } from '../../../renderer/utils/activityBus';

describe('subscribeToActivity', () => {
	let cleanups: Array<() => void> = [];

	const subscribe = (callback: () => void) => {
		const unsubscribe = subscribeToActivity(callback);
		cleanups.push(unsubscribe);

		return () => {
			unsubscribe();
			cleanups = cleanups.filter((cleanup) => cleanup !== unsubscribe);
		};
	};

	afterEach(() => {
		for (const cleanup of cleanups.splice(0).reverse()) {
			cleanup();
		}
		vi.restoreAllMocks();
	});

	it('attaches passive activity listeners for the first subscriber', () => {
		const addEventListener = vi.spyOn(window, 'addEventListener');
		const removeEventListener = vi.spyOn(window, 'removeEventListener');
		const callback = vi.fn();

		const unsubscribe = subscribe(callback);

		expect(addEventListener).toHaveBeenCalledTimes(5);
		expect(addEventListener).toHaveBeenCalledWith('keydown', expect.any(Function), {
			passive: true,
		});
		expect(addEventListener).toHaveBeenCalledWith('mousedown', expect.any(Function), {
			passive: true,
		});
		expect(addEventListener).toHaveBeenCalledWith('wheel', expect.any(Function), {
			passive: true,
		});
		expect(addEventListener).toHaveBeenCalledWith('touchstart', expect.any(Function), {
			passive: true,
		});
		expect(addEventListener).toHaveBeenCalledWith('click', expect.any(Function), {
			passive: true,
		});

		window.dispatchEvent(new Event('keydown'));

		expect(callback).toHaveBeenCalledTimes(1);

		unsubscribe();

		expect(removeEventListener).toHaveBeenCalledTimes(5);
		expect(removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function));
		expect(removeEventListener).toHaveBeenCalledWith('mousedown', expect.any(Function));
		expect(removeEventListener).toHaveBeenCalledWith('wheel', expect.any(Function));
		expect(removeEventListener).toHaveBeenCalledWith('touchstart', expect.any(Function));
		expect(removeEventListener).toHaveBeenCalledWith('click', expect.any(Function));
	});

	it('does not attach duplicate listeners when subscribing the same callback twice', () => {
		const addEventListener = vi.spyOn(window, 'addEventListener');
		const removeEventListener = vi.spyOn(window, 'removeEventListener');
		const callback = vi.fn();

		const unsubscribeFirst = subscribe(callback);
		const unsubscribeSecond = subscribe(callback);

		expect(addEventListener).toHaveBeenCalledTimes(5);

		window.dispatchEvent(new Event('click'));

		expect(callback).toHaveBeenCalledTimes(1);

		unsubscribeFirst();
		unsubscribeSecond();

		expect(removeEventListener).toHaveBeenCalledTimes(5);
	});

	it('keeps listeners attached until the last distinct subscriber unsubscribes', () => {
		const addEventListener = vi.spyOn(window, 'addEventListener');
		const removeEventListener = vi.spyOn(window, 'removeEventListener');
		const firstCallback = vi.fn();
		const secondCallback = vi.fn();

		const unsubscribeFirst = subscribe(firstCallback);
		const unsubscribeSecond = subscribe(secondCallback);

		expect(addEventListener).toHaveBeenCalledTimes(5);

		window.dispatchEvent(new Event('wheel'));

		expect(firstCallback).toHaveBeenCalledTimes(1);
		expect(secondCallback).toHaveBeenCalledTimes(1);

		unsubscribeFirst();

		expect(removeEventListener).not.toHaveBeenCalled();

		window.dispatchEvent(new Event('wheel'));

		expect(firstCallback).toHaveBeenCalledTimes(1);
		expect(secondCallback).toHaveBeenCalledTimes(2);

		unsubscribeSecond();

		expect(removeEventListener).toHaveBeenCalledTimes(5);
	});
});
