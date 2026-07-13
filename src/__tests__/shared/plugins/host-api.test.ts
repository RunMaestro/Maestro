import { describe, it, expect } from 'vitest';
import { HOST_API_VERSION, isHostApiCompatible } from '../../../shared/plugins/host-api';

describe('isHostApiCompatible', () => {
	it('treats an absent/empty minimum as compatible', () => {
		expect(isHostApiCompatible(undefined).compatible).toBe(true);
		expect(isHostApiCompatible('').compatible).toBe(true);
		expect(isHostApiCompatible('   ').compatible).toBe(true);
	});

	it('rejects a non-semver minimum (manifest is malformed)', () => {
		const r = isHostApiCompatible('not-a-version', '1.0.0');
		expect(r.compatible).toBe(false);
		expect(r.reason).toMatch(/not a valid semver/);
	});

	it('rejects semver-looking versions with invalid suffixes', () => {
		const r = isHostApiCompatible('1.7.0junk', '1.7.0');
		expect(r.compatible).toBe(false);
		expect(r.reason).toMatch(/not a valid semver/);
	});

	it('rejects when the plugin needs a higher minor than the host provides', () => {
		const r = isHostApiCompatible('1.2.0', '1.1.0');
		expect(r.compatible).toBe(false);
		expect(r.reason).toMatch(/needs host API >= 1\.2\.0/);
	});

	it('accepts the node-semver v prefix', () => {
		expect(isHostApiCompatible('v1.7.0', '1.7.0').compatible).toBe(true);
		expect(isHostApiCompatible('1.7.0', 'v1.7.0').compatible).toBe(true);
	});

	it('accepts when host equals or exceeds the minimum within the same major', () => {
		expect(isHostApiCompatible('1.0.0', '1.0.0').compatible).toBe(true);
		expect(isHostApiCompatible('1.0.0', '1.5.0').compatible).toBe(true);
		expect(isHostApiCompatible('1.2.3', '1.2.3').compatible).toBe(true);
	});

	it('rejects across major versions in both directions', () => {
		expect(isHostApiCompatible('2.0.0', '1.0.0').compatible).toBe(false);
		expect(isHostApiCompatible('1.0.0', '2.0.0').compatible).toBe(false);
	});

	it('rejects a malformed host version defensively', () => {
		const r = isHostApiCompatible('1.0.0', 'garbage');
		expect(r.compatible).toBe(false);
		expect(r.reason).toMatch(/host API version/);
	});

	it('uses HOST_API_VERSION as the default host', () => {
		expect(isHostApiCompatible(HOST_API_VERSION).compatible).toBe(true);
	});
});

describe('HOST_API_VERSION', () => {
	it('publishes the additive workspace and interactive-panel API version', () => {
		expect(HOST_API_VERSION).toBe('1.13.0');
	});
});
