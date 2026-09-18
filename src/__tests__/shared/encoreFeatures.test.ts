/**
 * @file encoreFeatures.test.ts
 * @description Tests for the canonical Encore Feature defaults and resolver.
 */

import { describe, it, expect } from 'vitest';
import { ENCORE_FEATURE_DEFAULTS, resolveEncoreFeatures } from '../../shared/encoreFeatureDefaults';

describe('ENCORE_FEATURE_DEFAULTS', () => {
	it('ships every graduated feature on', () => {
		expect(ENCORE_FEATURE_DEFAULTS).toMatchObject({
			directorNotes: true,
			usageStats: true,
			symphony: true,
			maestroCue: true,
		});
	});
});

describe('resolveEncoreFeatures', () => {
	it('returns the defaults when nothing is persisted', () => {
		expect(resolveEncoreFeatures(undefined)).toEqual(ENCORE_FEATURE_DEFAULTS);
		expect(resolveEncoreFeatures(null)).toEqual(ENCORE_FEATURE_DEFAULTS);
		expect(resolveEncoreFeatures({})).toEqual(ENCORE_FEATURE_DEFAULTS);
	});

	it('honors a flag the user switched off', () => {
		expect(resolveEncoreFeatures({ maestroCue: false })).toEqual({
			...ENCORE_FEATURE_DEFAULTS,
			maestroCue: false,
		});
	});

	it('leaves a flag the stored object predates at its default', () => {
		// A settings file written before a flag existed must not read as off.
		const stored = { symphony: false };
		expect(resolveEncoreFeatures(stored)).toEqual({
			...ENCORE_FEATURE_DEFAULTS,
			symphony: false,
		});
	});

	it('ignores non-boolean values rather than coercing them', () => {
		const resolved = resolveEncoreFeatures({
			directorNotes: 'false',
			usageStats: 0,
			maestroCue: null,
		});
		expect(resolved).toEqual(ENCORE_FEATURE_DEFAULTS);
	});

	it('drops keys that are not Encore flags', () => {
		const resolved = resolveEncoreFeatures({ telepathy: true }) as unknown as Record<
			string,
			unknown
		>;
		expect(resolved.telepathy).toBeUndefined();
		expect(resolved).toEqual(ENCORE_FEATURE_DEFAULTS);
	});

	it('does not mutate the shared default object', () => {
		const resolved = resolveEncoreFeatures({ symphony: false });
		expect(resolved).not.toBe(ENCORE_FEATURE_DEFAULTS);
		expect(ENCORE_FEATURE_DEFAULTS.symphony).toBe(true);
	});
});
