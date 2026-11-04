/**
 * Tests for the internal store-write tracker used by the settings file watcher
 * to tell the app's own writes apart from external edits.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	markInternalWrite,
	hadRecentInternalWrite,
	resetInternalWriteTracking,
	trackStoreWrites,
	INTERNAL_WRITE_SHADOW_MS,
} from '../../../main/stores/write-tracker';

describe('main/stores/write-tracker', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		resetInternalWriteTracking();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('reports no recent write for an untouched file', () => {
		expect(hadRecentInternalWrite('maestro-settings.json')).toBe(false);
	});

	it('reports a recent write inside the shadow window', () => {
		markInternalWrite('maestro-settings.json');
		vi.advanceTimersByTime(INTERNAL_WRITE_SHADOW_MS - 1);

		expect(hadRecentInternalWrite('maestro-settings.json')).toBe(true);
	});

	it('expires once the shadow window has elapsed', () => {
		markInternalWrite('maestro-settings.json');
		vi.advanceTimersByTime(INTERNAL_WRITE_SHADOW_MS + 1);

		expect(hadRecentInternalWrite('maestro-settings.json')).toBe(false);
	});

	it('keeps files independent', () => {
		markInternalWrite('maestro-settings.json');

		expect(hadRecentInternalWrite('maestro-agent-configs.json')).toBe(false);
	});

	describe('trackStoreWrites', () => {
		function makeStore() {
			return {
				data: {} as Record<string, unknown>,
				set(key: string, value: unknown) {
					this.data[key] = value;
					return 'set-result';
				},
				delete(key: string) {
					delete this.data[key];
				},
				clear() {
					this.data = {};
				},
				reset() {
					this.data = {};
				},
				get(key: string) {
					return this.data[key];
				},
			};
		}

		it('stamps a write and preserves the return value and behaviour', () => {
			const store = trackStoreWrites(makeStore(), 'maestro-settings.json');

			const result = store.set('conductorProfile', 'hello');

			expect(result).toBe('set-result');
			expect(store.get('conductorProfile')).toBe('hello');
			expect(hadRecentInternalWrite('maestro-settings.json')).toBe(true);
		});

		it('stamps delete, clear, and reset too', () => {
			for (const method of ['delete', 'clear', 'reset'] as const) {
				resetInternalWriteTracking();
				const store = trackStoreWrites(makeStore(), 'maestro-settings.json');

				store[method]('conductorProfile');

				expect(hadRecentInternalWrite('maestro-settings.json')).toBe(true);
			}
		});

		it('does not stamp reads', () => {
			const store = trackStoreWrites(makeStore(), 'maestro-settings.json');

			store.get('conductorProfile');

			expect(hadRecentInternalWrite('maestro-settings.json')).toBe(false);
		});

		it('stamps even when the underlying write throws', () => {
			const store = trackStoreWrites(
				{
					set() {
						throw new Error('ENOSPC');
					},
				},
				'maestro-settings.json'
			);

			expect(() => store.set()).toThrow('ENOSPC');
			expect(hadRecentInternalWrite('maestro-settings.json')).toBe(true);
		});
	});
});
