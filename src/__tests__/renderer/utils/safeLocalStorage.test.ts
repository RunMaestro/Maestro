/**
 * `safeLocalStorage` - the guarded accessor every persisted-view-preference
 * hook reaches Storage through.
 *
 * Its whole contract is that it never throws: a storage-blocked renderer, a
 * private-mode browser, or a jsdom test without a Storage implementation must
 * cost the user their persistence, never their pane. The accessor itself only
 * covers reaching the global; `safeStorageGet` / `safeStorageSet` /
 * `writeStorageValue` are what swallow method-level failures (`getItem` /
 * `setItem` throws) so a quota or private-mode write cannot take a pane down.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { installLocalStorageMock } from '../../helpers/mockLocalStorage';
import {
	safeLocalStorage,
	safeSessionStorage,
	safeStorageGet,
	safeStorageSet,
	writeStorageValue,
} from '../../../renderer/utils/safeLocalStorage';

/** Restore a working Storage so a hostile define cannot leak into later tests. */
afterEach(() => {
	installLocalStorageMock();
});

describe('safeLocalStorage', () => {
	it('returns the Storage when there is one', () => {
		const store = installLocalStorageMock();
		const storage = safeLocalStorage();

		expect(storage).not.toBeNull();
		storage?.setItem('probe', 'value');
		expect(store.get('probe')).toBe('value');
		expect(storage?.getItem('probe')).toBe('value');
	});

	it('returns null instead of throwing when reading the global throws', () => {
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			get() {
				throw new Error('storage blocked');
			},
		});

		expect(() => safeLocalStorage()).not.toThrow();
		expect(safeLocalStorage()).toBeNull();
	});

	it('returns null when there is no Storage at all', () => {
		// `undefined` rather than a throwing getter: the other half of the guard,
		// and the shape a non-browser environment presents.
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			writable: true,
			value: undefined,
		});

		expect(safeLocalStorage()).toBeNull();
	});

	it('lets a caller optional-chain through a missing Storage without throwing', () => {
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			get() {
				throw new Error('storage blocked');
			},
		});

		// Callers that still need the raw Storage (removeItem, key, enumeration)
		// optional-chain through this. Preference get/set should use the helpers.
		expect(() => safeLocalStorage()?.getItem('anything')).not.toThrow();
		expect(safeLocalStorage()?.getItem('anything')).toBeUndefined();
		expect(() => safeLocalStorage()?.setItem('anything', 'value')).not.toThrow();
	});
});

describe('safeSessionStorage', () => {
	it('returns the tab-scoped Storage when there is one', () => {
		const storage = safeSessionStorage();

		expect(storage).not.toBeNull();
		storage?.setItem('probe', 'value');
		expect(storage?.getItem('probe')).toBe('value');
	});

	it('returns null instead of throwing when reading the global throws', () => {
		const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
		Object.defineProperty(window, 'sessionStorage', {
			configurable: true,
			get() {
				throw new Error('storage blocked');
			},
		});

		try {
			expect(() => safeSessionStorage()).not.toThrow();
			expect(safeSessionStorage()).toBeNull();
		} finally {
			if (original) Object.defineProperty(window, 'sessionStorage', original);
		}
	});
});

describe('writeStorageValue', () => {
	it('writes through a working Storage', () => {
		const store = installLocalStorageMock();
		writeStorageValue(safeLocalStorage(), 'key', 'value');
		expect(store.get('key')).toBe('value');
	});

	it('swallows a Storage that refuses the write', () => {
		// The guarded accessor only covers REACHING the object; setItem itself
		// still throws on a full quota or in Safari private mode, and the contract
		// is that a failed write costs the user their persistence, not their pane.
		// Spy the instance: the in-memory mock is not on Storage.prototype.
		installLocalStorageMock();
		vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
			throw new DOMException('QuotaExceededError');
		});

		expect(() => writeStorageValue(safeLocalStorage(), 'key', 'value')).not.toThrow();
	});

	it('is a no-op when there is no Storage', () => {
		expect(() => writeStorageValue(null, 'key', 'value')).not.toThrow();
	});
});

describe('safeStorageGet', () => {
	it('reads a stored value', () => {
		installLocalStorageMock();
		window.localStorage.setItem('probe', 'value');
		expect(safeStorageGet('probe')).toBe('value');
	});

	it('returns null for a missing key', () => {
		installLocalStorageMock();
		expect(safeStorageGet('missing')).toBeNull();
	});

	it('returns null instead of throwing when reading the global throws', () => {
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			get() {
				throw new Error('storage blocked');
			},
		});

		expect(() => safeStorageGet('anything')).not.toThrow();
		expect(safeStorageGet('anything')).toBeNull();
	});

	it('returns null when the global resolves but getItem throws', () => {
		// The accessor-only guard misses this path: Storage is reachable, then
		// the method itself refuses. A store initializer that called getItem
		// directly would throw and take the pane down.
		installLocalStorageMock();
		vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
			throw new Error('getItem denied');
		});

		expect(() => safeStorageGet('probe')).not.toThrow();
		expect(safeStorageGet('probe')).toBeNull();
	});
});

describe('safeStorageSet', () => {
	it('writes through a working Storage', () => {
		const store = installLocalStorageMock();
		safeStorageSet('key', 'value');
		expect(store.get('key')).toBe('value');
		expect(window.localStorage.getItem('key')).toBe('value');
	});

	it('swallows QuotaExceededError when the global resolves but setItem throws', () => {
		// Pedram's merge-blocking case: Storage is reachable, then the write
		// refuses (full origin, Safari private mode). A persist useEffect that
		// called setItem directly would hit the nearest error boundary.
		installLocalStorageMock();
		vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
			throw new DOMException('QuotaExceededError');
		});

		expect(() => safeStorageSet('key', 'value')).not.toThrow();
		expect(safeStorageGet('key')).toBeNull();
	});

	it('is a no-op when there is no Storage', () => {
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			writable: true,
			value: undefined,
		});

		expect(() => safeStorageSet('key', 'value')).not.toThrow();
	});
});
