/**
 * @file contextWindowPrecedence.test.ts
 * @description Pins the ONE context-window ranking (findings P1 and AD1) and,
 * critically, WHICH source won. The winning source is what lets the Edit Agent
 * note say "your stored value is overridden" without re-deriving the order
 * (#1370); a resolved number alone cannot answer that, because a stored 200k
 * and a provider-reported 200k are the same figure for different reasons.
 */

import { describe, it, expect } from 'vitest';
import {
	resolveContextWindow,
	isStoredContextWindowOverridden,
} from '../../../renderer/utils/contextWindowPrecedence';

describe('resolveContextWindow', () => {
	it('ranks a [1m] model marker above everything', () => {
		const resolved = resolveContextWindow({
			customModel: 'opus[1m]',
			customContextWindow: 120000,
			contextWindowSource: 'user-edited',
			reportedWindow: 200000,
			reportedResolved: true,
			configuredWindow: 200000,
		});

		expect(resolved).toEqual({ window: 1_000_000, source: 'model-marker' });
	});

	it('ranks a user-edited window above a provider report', () => {
		const resolved = resolveContextWindow({
			customContextWindow: 120000,
			contextWindowSource: 'user-edited',
			reportedWindow: 1_000_000,
			reportedResolved: true,
		});

		expect(resolved).toEqual({ window: 120000, source: 'user-edited' });
	});

	it('ranks a provider report above a stored value with no provenance', () => {
		const resolved = resolveContextWindow({
			customContextWindow: 200000,
			reportedWindow: 1_000_000,
			reportedResolved: true,
		});

		expect(resolved).toEqual({ window: 1_000_000, source: 'provider' });
	});

	it('keeps the stored value when the reported window is not flagged resolved', () => {
		const resolved = resolveContextWindow({
			customContextWindow: 200000,
			reportedWindow: 1_000_000,
		});

		expect(resolved).toEqual({ window: 200000, source: 'stored' });
	});

	it('falls back to the configured window, then the raw report', () => {
		expect(resolveContextWindow({ configuredWindow: 200000, reportedWindow: 99 })).toEqual({
			window: 200000,
			source: 'configured',
		});
		expect(resolveContextWindow({ reportedWindow: 150000 })).toEqual({
			window: 150000,
			source: 'reported',
		});
	});

	it('reports nothing known as zero', () => {
		expect(resolveContextWindow({})).toEqual({ window: 0, source: 'none' });
	});

	it('ignores a non-positive stored value', () => {
		const resolved = resolveContextWindow({
			customContextWindow: 0,
			contextWindowSource: 'user-edited',
			configuredWindow: 200000,
		});

		expect(resolved).toEqual({ window: 200000, source: 'configured' });
	});
});

describe('isStoredContextWindowOverridden', () => {
	it('is true only when a higher rank than the stored value won', () => {
		expect(isStoredContextWindowOverridden({ window: 1, source: 'model-marker' })).toBe(true);
		expect(isStoredContextWindowOverridden({ window: 1, source: 'provider' })).toBe(true);
	});

	it('is false when the stored value itself won, in either provenance', () => {
		expect(isStoredContextWindowOverridden({ window: 1, source: 'user-edited' })).toBe(false);
		expect(isStoredContextWindowOverridden({ window: 1, source: 'stored' })).toBe(false);
	});

	it('is false for the ranks below the stored value', () => {
		// Reaching these means there was no stored value to override.
		expect(isStoredContextWindowOverridden({ window: 1, source: 'configured' })).toBe(false);
		expect(isStoredContextWindowOverridden({ window: 1, source: 'reported' })).toBe(false);
		expect(isStoredContextWindowOverridden({ window: 0, source: 'none' })).toBe(false);
	});

	it('agrees with resolveContextWindow on the same figure from different sources', () => {
		// The reason this takes a source rather than comparing numbers: both of
		// these resolve to 200000, but only one is an override.
		const overridden = resolveContextWindow({
			customContextWindow: 200000,
			reportedWindow: 200000,
			reportedResolved: true,
		});
		const notOverridden = resolveContextWindow({ customContextWindow: 200000 });

		expect(overridden.window).toBe(notOverridden.window);
		expect(isStoredContextWindowOverridden(overridden)).toBe(true);
		expect(isStoredContextWindowOverridden(notOverridden)).toBe(false);
	});
});
