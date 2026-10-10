/**
 * Tests for the shared main-process `debounce` helper. Uses fake timers so the
 * trailing-edge behaviour is asserted deterministically without real waits.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { debounce } from '../debounce';

describe('debounce', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('fires once on the trailing edge after the calls stop', () => {
		const fn = vi.fn();
		const debounced = debounce(fn, 400);

		debounced();
		debounced();
		debounced();
		expect(fn).not.toHaveBeenCalled();

		vi.advanceTimersByTime(399);
		expect(fn).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('resets the timer on each call so a steady stream never fires mid-stream', () => {
		const fn = vi.fn();
		const debounced = debounce(fn, 400);

		debounced();
		vi.advanceTimersByTime(300);
		debounced(); // resets the 400ms window
		vi.advanceTimersByTime(300);
		expect(fn).not.toHaveBeenCalled();

		vi.advanceTimersByTime(100);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('passes the most recent arguments to the wrapped function', () => {
		const fn = vi.fn();
		const debounced = debounce(fn, 400);

		debounced('first');
		debounced('second');
		debounced('third');

		vi.advanceTimersByTime(400);
		expect(fn).toHaveBeenCalledTimes(1);
		expect(fn).toHaveBeenCalledWith('third');
	});

	it('cancel() drops a pending invocation', () => {
		const fn = vi.fn();
		const debounced = debounce(fn, 400);

		debounced();
		debounced.cancel();
		vi.advanceTimersByTime(400);
		expect(fn).not.toHaveBeenCalled();
	});

	it('flush() runs a pending invocation immediately and clears the timer', () => {
		const fn = vi.fn();
		const debounced = debounce(fn, 400);

		debounced('payload');
		debounced.flush();
		expect(fn).toHaveBeenCalledTimes(1);
		expect(fn).toHaveBeenCalledWith('payload');

		// The pending timer was consumed, so advancing does not fire again.
		vi.advanceTimersByTime(400);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('flush() with nothing pending is a no-op', () => {
		const fn = vi.fn();
		const debounced = debounce(fn, 400);

		debounced.flush();
		expect(fn).not.toHaveBeenCalled();
	});
});
