/**
 * Tests for streaming store pub/sub
 */

import { createStreamingStore } from '../streaming-store';

describe('createStreamingStore', () => {
	it('initializes with empty string', () => {
		const store = createStreamingStore();
		expect(store.get()).toBe('');
	});

	it('updates value with set()', () => {
		const store = createStreamingStore();
		store.set('Hello');
		expect(store.get()).toBe('Hello');
	});

	it('appends text on consecutive set() calls', () => {
		const store = createStreamingStore();
		store.set('Hello');
		store.set('Hello world');
		expect(store.get()).toBe('Hello world');
	});

	it('notifies subscribers on set()', () => {
		const store = createStreamingStore();
		const listener = jest.fn();

		store.subscribe(listener);
		store.set('test');

		expect(listener).toHaveBeenCalledTimes(1);
	});

	it('notifies multiple subscribers', () => {
		const store = createStreamingStore();
		const listener1 = jest.fn();
		const listener2 = jest.fn();

		store.subscribe(listener1);
		store.subscribe(listener2);
		store.set('test');

		expect(listener1).toHaveBeenCalledTimes(1);
		expect(listener2).toHaveBeenCalledTimes(1);
	});

	it('unsubscribes correctly', () => {
		const store = createStreamingStore();
		const listener = jest.fn();

		const unsubscribe = store.subscribe(listener);
		unsubscribe();
		store.set('test');

		expect(listener).not.toHaveBeenCalled();
	});

	it('allows re-subscribing after unsubscribe', () => {
		const store = createStreamingStore();
		const listener = jest.fn();

		const unsub1 = store.subscribe(listener);
		unsub1();
		store.subscribe(listener);
		store.set('test');

		expect(listener).toHaveBeenCalledTimes(1);
	});

	it('handles rapid updates', () => {
		const store = createStreamingStore();
		const listener = jest.fn();

		store.subscribe(listener);

		for (let i = 0; i < 100; i++) {
			store.set(`chunk-${i}`);
		}

		expect(listener).toHaveBeenCalledTimes(100);
		expect(store.get()).toBe('chunk-99');
	});

	it('handles empty string updates', () => {
		const store = createStreamingStore();
		const listener = jest.fn();

		store.set('some text');
		store.subscribe(listener);
		store.set('');

		expect(store.get()).toBe('');
		expect(listener).toHaveBeenCalledTimes(1);
	});
});
