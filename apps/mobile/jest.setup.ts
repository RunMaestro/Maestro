/**
 * Jest setup file for mobile app tests.
 *
 * Add any global test setup here:
 * - Jest matchers
 * - Mocks for native modules
 * - Global test utilities
 */

// Mock @react-native-async-storage/async-storage
// Uses a simple in-memory store for testing
jest.mock('@react-native-async-storage/async-storage', () => {
	const store: Map<string, string> = new Map();

	return {
		__esModule: true,
		default: {
			getItem: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
			setItem: jest.fn((key: string, value: string) => {
				store.set(key, value);
				return Promise.resolve();
			}),
			removeItem: jest.fn((key: string) => {
				store.delete(key);
				return Promise.resolve();
			}),
			clear: jest.fn(() => {
				store.clear();
				return Promise.resolve();
			}),
			getAllKeys: jest.fn(() => Promise.resolve([...store.keys()])),
			multiGet: jest.fn((keys: string[]) =>
				Promise.resolve(keys.map((key) => [key, store.get(key) ?? null]))
			),
			multiSet: jest.fn((pairs: [string, string][]) => {
				pairs.forEach(([key, value]) => store.set(key, value));
				return Promise.resolve();
			}),
			multiRemove: jest.fn((keys: string[]) => {
				keys.forEach((key) => store.delete(key));
				return Promise.resolve();
			}),
		},
	};
});

// Silence console during tests unless explicitly needed
// global.console = {
// 	...console,
// 	warn: jest.fn(),
// 	error: jest.fn(),
// };
