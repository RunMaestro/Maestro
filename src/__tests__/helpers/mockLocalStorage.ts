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

/** Builds one in-memory `Storage` and the map behind it. */
function createStorageMock(): { storage: Storage; store: Map<string, string> } {
	const store = new Map<string, string>();
	const storage = {
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
	} as unknown as Storage;
	return { storage, store };
}

function installStorage(name: 'localStorage' | 'sessionStorage'): Map<string, string> {
	const { storage, store } = createStorageMock();
	Object.defineProperty(window, name, {
		configurable: true,
		writable: true,
		value: storage,
	});
	return store;
}

/**
 * Installs a fresh in-memory `localStorage` on `window` and returns the backing
 * map in case a test wants to assert on raw stored values.
 */
export function installLocalStorageMock(): Map<string, string> {
	return installStorage('localStorage');
}

/**
 * The `sessionStorage` twin, for the per-tab half of a two-tier persistence
 * scheme. `sessionStorage` is missing in this environment for the same reason
 * `localStorage` is, so a test that touches both must install both or it fails
 * on whichever one it forgot.
 */
export function installSessionStorageMock(): Map<string, string> {
	return installStorage('sessionStorage');
}
