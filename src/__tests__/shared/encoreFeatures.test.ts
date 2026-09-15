/**
 * @file encoreFeatures.test.ts
 * @description Tests for the canonical Encore Feature defaults and resolver.
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_ENCORE_FEATURES, resolveEncoreFeatures } from '../../shared/encoreFeatures';

describe('DEFAULT_ENCORE_FEATURES', () => {
	it('ships every graduated feature on', () => {
		expect(DEFAULT_ENCORE_FEATURES).toEqual({
			directorNotes: true,
			usageStats: true,
			symphony: true,
			maestroCue: true,
		});
	});
});

describe('resolveEncoreFeatures', () => {
	it('returns the defaults when nothing is persisted', () => {
		expect(resolveEncoreFeatures(undefined)).toEqual(DEFAULT_ENCORE_FEATURES);
		expect(resolveEncoreFeatures(null)).toEqual(DEFAULT_ENCORE_FEATURES);
		expect(resolveEncoreFeatures({})).toEqual(DEFAULT_ENCORE_FEATURES);
	});

	it('honors a flag the user switched off', () => {
		expect(resolveEncoreFeatures({ maestroCue: false })).toEqual({
			...DEFAULT_ENCORE_FEATURES,
			maestroCue: false,
		});
	});

	it('leaves a flag the stored object predates at its default', () => {
		// A settings file written before a flag existed must not read as off.
		const stored = { symphony: false };
		expect(resolveEncoreFeatures(stored)).toEqual({
			...DEFAULT_ENCORE_FEATURES,
			symphony: false,
		});
	});

	it('ignores non-boolean values rather than coercing them', () => {
		const resolved = resolveEncoreFeatures({
			directorNotes: 'false',
			usageStats: 0,
			maestroCue: null,
		});
		expect(resolved).toEqual(DEFAULT_ENCORE_FEATURES);
	});

	it('drops keys that are not Encore flags', () => {
		const resolved = resolveEncoreFeatures({ telepathy: true }) as unknown as Record<
			string,
			unknown
		>;
		expect(resolved.telepathy).toBeUndefined();
		expect(resolved).toEqual(DEFAULT_ENCORE_FEATURES);
	});

	it('does not mutate the shared default object', () => {
		const resolved = resolveEncoreFeatures({ symphony: false });
		expect(resolved).not.toBe(DEFAULT_ENCORE_FEATURES);
		expect(DEFAULT_ENCORE_FEATURES.symphony).toBe(true);
	});
});
