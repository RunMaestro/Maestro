/**
 * Tests for shared/providerFailover.ts - Provider Failover endpoint selection,
 * env resolution, and fail-back timing.
 */

import { describe, it, expect } from 'vitest';
import {
	failoverArmed,
	findEndpoint,
	selectNextEndpoint,
	shouldReturnToPrimary,
	resolveFailoverEnv,
	failoverUnsetEnvKeys,
	validateEndpoint,
	DEFAULT_RETURN_TO_PRIMARY_MINUTES,
	type FailoverConfig,
	type FailoverEndpoint,
	type FailoverState,
} from '../../shared/providerFailover';

function endpoint(id: string, over: Partial<FailoverEndpoint> = {}): FailoverEndpoint {
	return {
		id,
		label: id.toUpperCase(),
		env: { ANTHROPIC_BASE_URL: `https://${id}.example.com`, ANTHROPIC_AUTH_TOKEN: `tok-${id}` },
		...over,
	};
}

function config(over: Partial<FailoverConfig> = {}): FailoverConfig {
	return { endpoints: [endpoint('a'), endpoint('b')], enabled: true, ...over };
}

function state(over: Partial<FailoverState> = {}): FailoverState {
	return { endpointId: null, since: 0, exhausted: [], ...over };
}

describe('failoverArmed', () => {
	it('requires both the enabled flag and at least one endpoint', () => {
		expect(failoverArmed(config())).toBe(true);
		expect(failoverArmed(config({ enabled: false }))).toBe(false);
		expect(failoverArmed(config({ endpoints: [] }))).toBe(false);
		expect(failoverArmed(undefined)).toBe(false);
	});
});

describe('selectNextEndpoint', () => {
	it('returns the first endpoint in user order when nothing has been tried', () => {
		expect(selectNextEndpoint(config(), undefined)?.id).toBe('a');
	});

	it('walks down the list, skipping endpoints already burned this outage', () => {
		expect(selectNextEndpoint(config(), state({ exhausted: ['a'] }))?.id).toBe('b');
	});

	it('returns null once every endpoint has been tried', () => {
		expect(selectNextEndpoint(config(), state({ exhausted: ['a', 'b'] }))).toBeNull();
	});

	it('returns null when failover is configured but disarmed', () => {
		expect(selectNextEndpoint(config({ enabled: false }), undefined)).toBeNull();
	});

	it('ignores exhausted ids that no longer exist in the config', () => {
		// An endpoint deleted mid-outage must not block the remaining ones.
		const trimmed = config({ endpoints: [endpoint('b')] });
		expect(selectNextEndpoint(trimmed, state({ exhausted: ['a'] }))?.id).toBe('b');
	});
});

describe('shouldReturnToPrimary', () => {
	const minute = 60 * 1000;

	it('is false while the agent is already on its primary', () => {
		expect(shouldReturnToPrimary(config(), state({ endpointId: null, since: 0 }), 10 ** 9)).toBe(
			false
		);
	});

	it('is false before the dwell time elapses and true after', () => {
		const cfg = config({ returnToPrimaryMinutes: 30 });
		const st = state({ endpointId: 'a', since: 0 });
		expect(shouldReturnToPrimary(cfg, st, 29 * minute)).toBe(false);
		expect(shouldReturnToPrimary(cfg, st, 30 * minute)).toBe(true);
	});

	it('falls back to the 60m default when no dwell time is configured', () => {
		const st = state({ endpointId: 'a', since: 0 });
		expect(shouldReturnToPrimary(config(), st, 59 * minute)).toBe(false);
		expect(shouldReturnToPrimary(config(), st, DEFAULT_RETURN_TO_PRIMARY_MINUTES * minute)).toBe(
			true
		);
	});

	it('never returns when the dwell time is zero or negative (pinned to backup)', () => {
		const st = state({ endpointId: 'a', since: 0 });
		expect(shouldReturnToPrimary(config({ returnToPrimaryMinutes: 0 }), st, 10 ** 9)).toBe(false);
		expect(shouldReturnToPrimary(config({ returnToPrimaryMinutes: -5 }), st, 10 ** 9)).toBe(false);
	});
});

describe('resolveFailoverEnv', () => {
	it('returns the base env untouched when on the primary', () => {
		const base = { FOO: 'bar' };
		expect(resolveFailoverEnv(base, undefined)).toBe(base);
	});

	it('layers the endpoint env over the agent’s own vars', () => {
		const resolved = resolveFailoverEnv(
			{ FOO: 'bar', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
			endpoint('a').env
		);
		expect(resolved).toEqual({
			FOO: 'bar',
			ANTHROPIC_BASE_URL: 'https://a.example.com',
			ANTHROPIC_AUTH_TOKEN: 'tok-a',
		});
	});

	// The security property: a backup that redirects the base URL is a different
	// operator, so a credential it does not supply is REMOVED, never inherited.
	// A URL-only backup row is the most natural way to configure failover, and
	// inheriting here presented the user's primary Anthropic key to a third party.
	it('never passes the primary credential to an endpoint that supplies none', () => {
		const resolved = resolveFailoverEnv(
			{ ANTHROPIC_AUTH_TOKEN: 'primary-token', ANTHROPIC_API_KEY: 'primary-key' },
			{ ANTHROPIC_BASE_URL: 'https://a.example.com' }
		);
		expect(resolved?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
		expect(resolved?.ANTHROPIC_API_KEY).toBeUndefined();
		expect(resolved?.ANTHROPIC_BASE_URL).toBe('https://a.example.com');
	});

	it('treats a blank endpoint credential as "supplies none" rather than "keep the primary"', () => {
		const resolved = resolveFailoverEnv(
			{ ANTHROPIC_AUTH_TOKEN: 'primary-token' },
			{ ANTHROPIC_BASE_URL: 'https://a.example.com', ANTHROPIC_AUTH_TOKEN: '' }
		);
		expect(resolved?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
		expect(resolved?.ANTHROPIC_BASE_URL).toBe('https://a.example.com');
	});

	it('keeps non-credential vars when the endpoint redirects', () => {
		const resolved = resolveFailoverEnv(
			{ FOO: 'bar', HTTP_PROXY: 'http://proxy' },
			{ ANTHROPIC_BASE_URL: 'https://a.example.com' }
		);
		expect(resolved?.FOO).toBe('bar');
		expect(resolved?.HTTP_PROXY).toBe('http://proxy');
	});

	// An endpoint that only layers extra vars is still talking to the primary
	// operator, so there is nothing to protect the credential from.
	it('leaves the primary credential alone when the endpoint does not redirect', () => {
		const resolved = resolveFailoverEnv(
			{ ANTHROPIC_AUTH_TOKEN: 'primary-token' },
			{ HTTP_PROXY: 'http://proxy' }
		);
		expect(resolved?.ANTHROPIC_AUTH_TOKEN).toBe('primary-token');
	});

	it('handles an agent with no env of its own', () => {
		expect(resolveFailoverEnv(undefined, endpoint('a').env)).toEqual({
			ANTHROPIC_BASE_URL: 'https://a.example.com',
			ANTHROPIC_AUTH_TOKEN: 'tok-a',
		});
	});
});

describe('failoverUnsetEnvKeys', () => {
	it('lists the credentials a redirecting endpoint does not supply', () => {
		expect(failoverUnsetEnvKeys({ ANTHROPIC_BASE_URL: 'https://a.example.com' })).toEqual([
			'ANTHROPIC_AUTH_TOKEN',
			'ANTHROPIC_API_KEY',
		]);
	});

	it('does not list a credential the endpoint supplies itself', () => {
		expect(
			failoverUnsetEnvKeys({
				ANTHROPIC_BASE_URL: 'https://a.example.com',
				ANTHROPIC_AUTH_TOKEN: 'tok-a',
			})
		).toEqual(['ANTHROPIC_API_KEY']);
	});

	it('strips nothing when the endpoint does not redirect the base URL', () => {
		expect(failoverUnsetEnvKeys({ HTTP_PROXY: 'http://proxy' })).toEqual([]);
		expect(failoverUnsetEnvKeys(undefined)).toEqual([]);
	});

	it('treats a whitespace-only base URL as no redirect', () => {
		expect(failoverUnsetEnvKeys({ ANTHROPIC_BASE_URL: '   ' })).toEqual([]);
	});
});

describe('findEndpoint', () => {
	it('resolves a live id and returns undefined for primary or a stale id', () => {
		expect(findEndpoint(config(), 'b')?.label).toBe('B');
		expect(findEndpoint(config(), null)).toBeUndefined();
		expect(findEndpoint(config(), 'gone')).toBeUndefined();
	});
});

describe('validateEndpoint', () => {
	it('accepts a well-formed endpoint', () => {
		expect(validateEndpoint(endpoint('a'))).toBeNull();
	});

	it('rejects a missing name', () => {
		expect(validateEndpoint(endpoint('a', { label: '  ' }))).toMatch(/name is required/i);
	});

	it('rejects an endpoint with no env vars', () => {
		expect(validateEndpoint(endpoint('a', { env: {} }))).toMatch(/at least one environment/i);
	});

	it('requires ANTHROPIC_BASE_URL so the agent actually points somewhere new', () => {
		expect(validateEndpoint(endpoint('a', { env: { ANTHROPIC_AUTH_TOKEN: 'x' } }))).toMatch(
			/ANTHROPIC_BASE_URL/
		);
	});

	it('rejects a base URL that is not http(s)', () => {
		expect(
			validateEndpoint(endpoint('a', { env: { ANTHROPIC_BASE_URL: 'a.example.com' } }))
		).toMatch(/must start with http/i);
	});
});
