/**
 * Shared in-memory `localStorage` mock for renderer tests.
 *
 * jsdom in this environment doesn't provide a working `Storage` on
 * `window.localStorage`, so tests that exercise persistence must install a
 * minimal in-memory mock that satisfies the `Storage` methods they use. This
 * was previously copy-pasted across GitDiffViewer / ProcessMonitor /
 * QuickActionsModal tests; use this helper instead of hand-rolling another copy.
 *
 * Usage:
 *
 *   import { installLocalStorageMock } from '../../helpers/mockLocalStorage';
 *
 *   beforeEach(() => {
 *     installLocalStorageMock();
 *   });
 *
 * Each call installs a fresh, empty store, so a `beforeEach` install doubles as
 * a per-test reset (no separate `localStorage.clear()` needed).
 */
import { vi } from 'vitest';

/**
 * Installs a fresh in-memory `localStorage` on `window` and returns the backing
 * map in case a test wants to assert on raw stored values.
 */
export function installLocalStorageMock(): Map<string, string> {
	const store = new Map<string, string>();
	Object.defineProperty(window, 'localStorage', {
		configurable: true,
		writable: true,
		value: {
			getItem: vi.fn((key: string) => (store.has(key) ? store.get(key)! : null)),
			setItem: vi.fn((key: string, value: string) => {
				store.set(key, String(value));
			}),
			removeItem: vi.fn((key: string) => {
				store.delete(key);
			}),
			clear: vi.fn(() => {
				store.clear();
			}),
			key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
			get length() {
				return store.size;
			},
		},
	});
	return store;
}
