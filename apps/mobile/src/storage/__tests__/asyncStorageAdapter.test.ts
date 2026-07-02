/**
 * Tests for asyncStorageAdapter
 *
 * Verifies round-trip set/get/remove operations, null handling for missing keys,
 * and JSON-serializable value support.
 *
 * Since AsyncStorage is a native module, we mock @react-native-async-storage/async-storage
 * to test the adapter's behavior in isolation.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { asyncStorageAdapter } from '../asyncStorageAdapter';

// Jest already sets up the mock via jest.setup.ts or jest-expo preset
// We just verify the adapter delegates correctly

describe('asyncStorageAdapter', () => {
	beforeEach(() => {
		// Clear all mock data between tests
		jest.clearAllMocks();
	});

	describe('interface compliance', () => {
		it('exports getItem, setItem, and removeItem methods', () => {
			expect(asyncStorageAdapter.getItem).toBeDefined();
			expect(asyncStorageAdapter.setItem).toBeDefined();
			expect(asyncStorageAdapter.removeItem).toBeDefined();
		});

		it('getItem returns a Promise', () => {
			const result = asyncStorageAdapter.getItem('test-key');
			expect(result).toBeInstanceOf(Promise);
		});

		it('setItem returns a Promise', () => {
			const result = asyncStorageAdapter.setItem('test-key', 'test-value');
			expect(result).toBeInstanceOf(Promise);
		});

		it('removeItem returns a Promise', () => {
			const result = asyncStorageAdapter.removeItem('test-key');
			expect(result).toBeInstanceOf(Promise);
		});
	});

	describe('round-trip operations', () => {
		it('stores and retrieves a simple string', async () => {
			await asyncStorageAdapter.setItem('simple', 'hello');
			const result = await asyncStorageAdapter.getItem('simple');
			expect(result).toBe('hello');
		});

		it('stores and retrieves an empty string', async () => {
			await asyncStorageAdapter.setItem('empty', '');
			const result = await asyncStorageAdapter.getItem('empty');
			expect(result).toBe('');
		});

		it('stores and retrieves a JSON-serialized object', async () => {
			const obj = { foo: 'bar', count: 42 };
			await asyncStorageAdapter.setItem('json-obj', JSON.stringify(obj));
			const result = await asyncStorageAdapter.getItem('json-obj');
			expect(JSON.parse(result!)).toEqual(obj);
		});

		it('stores and retrieves a JSON-serialized array', async () => {
			const arr = [1, 2, 3, 'four', { five: 5 }];
			await asyncStorageAdapter.setItem('json-arr', JSON.stringify(arr));
			const result = await asyncStorageAdapter.getItem('json-arr');
			expect(JSON.parse(result!)).toEqual(arr);
		});

		it('stores and retrieves nested JSON structures', async () => {
			const nested = {
				level1: {
					level2: {
						level3: {
							value: 'deep',
						},
					},
				},
				array: [{ a: 1 }, { b: 2 }],
			};
			await asyncStorageAdapter.setItem('nested', JSON.stringify(nested));
			const result = await asyncStorageAdapter.getItem('nested');
			expect(JSON.parse(result!)).toEqual(nested);
		});

		it('overwrites existing values', async () => {
			await asyncStorageAdapter.setItem('overwrite', 'first');
			await asyncStorageAdapter.setItem('overwrite', 'second');
			const result = await asyncStorageAdapter.getItem('overwrite');
			expect(result).toBe('second');
		});

		it('handles unicode strings', async () => {
			const unicode = '🎉 Hello, 世界! مرحبا';
			await asyncStorageAdapter.setItem('unicode', unicode);
			const result = await asyncStorageAdapter.getItem('unicode');
			expect(result).toBe(unicode);
		});

		it('handles large JSON payloads', async () => {
			const largeArray = Array.from({ length: 1000 }, (_, i) => ({
				id: i,
				value: `item-${i}`,
				timestamp: Date.now(),
			}));
			await asyncStorageAdapter.setItem('large', JSON.stringify(largeArray));
			const result = await asyncStorageAdapter.getItem('large');
			expect(JSON.parse(result!)).toHaveLength(1000);
		});
	});

	describe('missing keys', () => {
		it('returns null for a key that was never set', async () => {
			const result = await asyncStorageAdapter.getItem('nonexistent-key');
			expect(result).toBeNull();
		});

		it('returns null for a key that was removed', async () => {
			await asyncStorageAdapter.setItem('to-remove', 'value');
			await asyncStorageAdapter.removeItem('to-remove');
			const result = await asyncStorageAdapter.getItem('to-remove');
			expect(result).toBeNull();
		});

		it('does not throw when removing a nonexistent key', async () => {
			await expect(asyncStorageAdapter.removeItem('never-existed')).resolves.not.toThrow();
		});
	});

	describe('remove operations', () => {
		it('removes a specific key without affecting others', async () => {
			await asyncStorageAdapter.setItem('keep', 'kept');
			await asyncStorageAdapter.setItem('remove', 'removed');
			await asyncStorageAdapter.removeItem('remove');

			const kept = await asyncStorageAdapter.getItem('keep');
			const removed = await asyncStorageAdapter.getItem('remove');

			expect(kept).toBe('kept');
			expect(removed).toBeNull();
		});

		it('allows re-setting a key after removal', async () => {
			await asyncStorageAdapter.setItem('reuse', 'first');
			await asyncStorageAdapter.removeItem('reuse');
			await asyncStorageAdapter.setItem('reuse', 'second');
			const result = await asyncStorageAdapter.getItem('reuse');
			expect(result).toBe('second');
		});
	});

	describe('key isolation', () => {
		it('stores different values for different keys', async () => {
			await asyncStorageAdapter.setItem('key1', 'value1');
			await asyncStorageAdapter.setItem('key2', 'value2');

			expect(await asyncStorageAdapter.getItem('key1')).toBe('value1');
			expect(await asyncStorageAdapter.getItem('key2')).toBe('value2');
		});

		it('handles keys with special characters', async () => {
			const specialKey = 'maestro.pairing.active:device-123';
			await asyncStorageAdapter.setItem(specialKey, 'special-value');
			const result = await asyncStorageAdapter.getItem(specialKey);
			expect(result).toBe('special-value');
		});
	});

	describe('delegation to AsyncStorage', () => {
		it('delegates getItem to AsyncStorage.getItem', async () => {
			await asyncStorageAdapter.getItem('test');
			expect(AsyncStorage.getItem).toHaveBeenCalledWith('test');
		});

		it('delegates setItem to AsyncStorage.setItem', async () => {
			await asyncStorageAdapter.setItem('test', 'value');
			expect(AsyncStorage.setItem).toHaveBeenCalledWith('test', 'value');
		});

		it('delegates removeItem to AsyncStorage.removeItem', async () => {
			await asyncStorageAdapter.removeItem('test');
			expect(AsyncStorage.removeItem).toHaveBeenCalledWith('test');
		});
	});
});
