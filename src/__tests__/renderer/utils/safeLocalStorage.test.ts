/**
 * `safeLocalStorage` - the guarded accessor every persisted-view-preference
 * hook reaches Storage through.
 *
 * Its whole contract is that it never throws: a storage-blocked renderer, a
 * private-mode browser, or a jsdom test without a Storage implementation must
 * cost the user their persistence, never their pane. These tests pin both
 * failure shapes, because the callers (`usePersistedToggle`,
 * `usePersistedChoice`, `useScalePreference`) optional-chain through the result
 * rather than branching on it - so a throw here would surface as a blank pane
 * rather than a lost preference.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { installLocalStorageMock } from '../../helpers/mockLocalStorage';
import { safeLocalStorage } from '../../../renderer/utils/safeLocalStorage';

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

		// Exactly what every calling hook does on read and on write.
		expect(() => safeLocalStorage()?.getItem('anything')).not.toThrow();
		expect(safeLocalStorage()?.getItem('anything')).toBeUndefined();
		expect(() => safeLocalStorage()?.setItem('anything', 'value')).not.toThrow();
	});
});
