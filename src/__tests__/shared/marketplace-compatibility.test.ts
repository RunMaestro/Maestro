/**
 * Tests for marketplace compatibility helpers.
 *
 * Verifies semver gating behavior, defensive fallbacks for invalid input,
 * and strict beta-flag handling.
 */

import { describe, it, expect } from 'vitest';
import { isCompatible, isBeta } from '../../shared/marketplace-compatibility';
import type { MarketplacePlaybook } from '../../shared/marketplace-types';

function makePlaybook(overrides: Partial<MarketplacePlaybook>): MarketplacePlaybook {
	return {
		id: 'test',
		title: 'Test',
		description: 'Test playbook',
		category: 'Development',
		author: 'Test',
		lastUpdated: '2026-01-01',
		path: 'test',
		documents: [],
		loopEnabled: false,
		prompt: null,
		...overrides,
	};
}

describe('isCompatible', () => {
	it('returns true when minMaestroVersion is absent', () => {
		expect(isCompatible(makePlaybook({}), '0.1.0')).toBe(true);
	});

	it('returns true when minMaestroVersion is invalid semver (treats as no minimum)', () => {
		expect(isCompatible(makePlaybook({ minMaestroVersion: 'not-a-version' }), '1.0.0')).toBe(true);
	});

	it('returns true when running version is invalid (defensive fallback)', () => {
		expect(isCompatible(makePlaybook({ minMaestroVersion: '1.0.0' }), 'unknown')).toBe(true);
	});

	// Documented edge cases from the spec
	it('final release ≥ its own prerelease', () => {
		expect(isCompatible(makePlaybook({ minMaestroVersion: '0.16.17-rc' }), '0.16.17')).toBe(true);
	});

	it('exact prerelease match', () => {
		expect(isCompatible(makePlaybook({ minMaestroVersion: '0.16.17-rc' }), '0.16.17-rc')).toBe(
			true
		);
	});

	it('newer prerelease ≥ older prerelease', () => {
		expect(isCompatible(makePlaybook({ minMaestroVersion: '0.16.17-rc.1' }), '0.16.17-rc.2')).toBe(
			true
		);
	});

	it('older release < newer prerelease', () => {
		expect(isCompatible(makePlaybook({ minMaestroVersion: '0.16.17-rc' }), '0.16.16')).toBe(false);
	});

	it('newer minor (even prerelease) ≥ older final', () => {
		expect(isCompatible(makePlaybook({ minMaestroVersion: '0.16.17' }), '0.17.0-alpha.1')).toBe(
			true
		);
	});

	// Case-insensitivity for prerelease tags - addresses the package.json
	// using "0.16.17-RC" (uppercase) while playbook manifests pin "0.16.17-rc".
	it('treats uppercase and lowercase prerelease tags as equivalent', () => {
		expect(isCompatible(makePlaybook({ minMaestroVersion: '0.16.17-rc' }), '0.16.17-RC')).toBe(
			true
		);
		expect(isCompatible(makePlaybook({ minMaestroVersion: '0.16.17-RC' }), '0.16.17-rc')).toBe(
			true
		);
	});

	it('older release blocked by newer min', () => {
		expect(isCompatible(makePlaybook({ minMaestroVersion: '99.0.0' }), '0.16.0')).toBe(false);
	});
});

describe('isBeta', () => {
	it('returns true only for the strict boolean true', () => {
		expect(isBeta(makePlaybook({ beta: true }))).toBe(true);
	});

	it('returns false when absent', () => {
		expect(isBeta(makePlaybook({}))).toBe(false);
	});

	it('returns false for false', () => {
		expect(isBeta(makePlaybook({ beta: false }))).toBe(false);
	});

	it('returns false for truthy non-boolean values', () => {
		// Cast through unknown to simulate manifest data that didn't validate.
		expect(isBeta(makePlaybook({ beta: 'yes' as unknown as boolean }))).toBe(false);
		expect(isBeta(makePlaybook({ beta: 1 as unknown as boolean }))).toBe(false);
		expect(isBeta(makePlaybook({ beta: 'true' as unknown as boolean }))).toBe(false);
	});
});
