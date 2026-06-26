import { describe, it, expect } from 'vitest';
import {
	parsePermissions,
	grantsFromRequests,
	isPermitted,
	capabilityRisk,
	type PermissionGrant,
} from '../../../shared/plugins/permissions';

describe('parsePermissions', () => {
	it('returns empty for undefined', () => {
		expect(parsePermissions(undefined)).toEqual({ requests: [], errors: [] });
	});

	it('rejects a non-array', () => {
		expect(parsePermissions({}).errors.length).toBe(1);
	});

	it('rejects unknown capabilities (never silently drops to allow-all)', () => {
		const r = parsePermissions([{ capability: 'fs:delete' }]);
		expect(r.requests).toEqual([]);
		expect(r.errors[0]).toMatch(/unknown capability/);
	});

	it('rejects a scope on a non-scoped capability', () => {
		const r = parsePermissions([{ capability: 'process:spawn', scope: '/x' }]);
		expect(r.requests).toEqual([]);
		expect(r.errors[0]).toMatch(/does not take a scope/);
	});

	it('keeps a valid scoped request with reason', () => {
		const r = parsePermissions([{ capability: 'fs:read', scope: '/data', reason: 'read config' }]);
		expect(r.errors).toEqual([]);
		expect(r.requests[0]).toEqual({ capability: 'fs:read', scope: '/data', reason: 'read config' });
	});
});

describe('isPermitted (default deny + scope matching)', () => {
	const at = 1;
	const grant = (capability: string, scope?: string): PermissionGrant =>
		({ capability, ...(scope ? { scope } : {}), grantedAt: at }) as PermissionGrant;

	it('denies when no grant exists', () => {
		expect(isPermitted([], 'fs:read', '/x')).toBe(false);
	});

	it('allows a none-scope capability with any grant of it', () => {
		expect(isPermitted([grant('notifications:toast')], 'notifications:toast')).toBe(true);
	});

	it('an unscoped path grant allows any target', () => {
		expect(isPermitted([grant('fs:read')], 'fs:read', '/anything/here')).toBe(true);
	});

	it('a scoped path grant only covers paths inside the scope', () => {
		const g = [grant('fs:read', '/data')];
		expect(isPermitted(g, 'fs:read', '/data/file.txt')).toBe(true);
		expect(isPermitted(g, 'fs:read', '/data')).toBe(true);
		expect(isPermitted(g, 'fs:read', '/data2/file.txt')).toBe(false);
		expect(isPermitted(g, 'fs:read', '/etc/passwd')).toBe(false);
	});

	it('a scoped path grant does not match a sibling prefix (boundary)', () => {
		expect(isPermitted([grant('fs:read', '/data/foo')], 'fs:read', '/data/foobar')).toBe(false);
	});

	it('a scoped path grant denies when no concrete target is given', () => {
		expect(isPermitted([grant('fs:read', '/data')], 'fs:read', undefined)).toBe(false);
	});

	it('host scope matches exact host and subdomains only', () => {
		const g = [grant('net:fetch', 'api.example.com')];
		expect(isPermitted(g, 'net:fetch', 'api.example.com')).toBe(true);
		expect(isPermitted(g, 'net:fetch', 'v2.api.example.com')).toBe(true);
		expect(isPermitted(g, 'net:fetch', 'example.com')).toBe(false);
		expect(isPermitted(g, 'net:fetch', 'evilexample.com')).toBe(false);
		expect(isPermitted(g, 'net:fetch', 'api.example.com.evil.com')).toBe(false);
	});

	it('does not let one capability satisfy another', () => {
		expect(isPermitted([grant('fs:read', '/data')], 'fs:write', '/data/x')).toBe(false);
	});
});

describe('grantsFromRequests + capabilityRisk', () => {
	it('stamps grant time', () => {
		const g = grantsFromRequests([{ capability: 'fs:read', scope: '/d' }], 123);
		expect(g[0]).toEqual({ capability: 'fs:read', scope: '/d', grantedAt: 123 });
	});
	it('classifies risk', () => {
		expect(capabilityRisk('process:spawn')).toBe('high');
		expect(capabilityRisk('notifications:toast')).toBe('low');
	});
});
