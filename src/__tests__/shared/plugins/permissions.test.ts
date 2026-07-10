import { describe, it, expect } from 'vitest';
import {
	parsePermissions,
	grantsFromRequests,
	isPermitted,
	isPermittedUnattended,
	capabilityRisk,
	describeCapability,
	isPluginCapability,
	PLUGIN_CAPABILITIES,
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
		const r = parsePermissions([{ capability: 'notifications:toast', scope: '/x' }]);
		expect(r.requests).toEqual([]);
		expect(r.errors[0]).toMatch(/does not take a scope/);
	});

	it('rejects an UNSCOPED act-verb request (allowlist scope is required, never wildcard)', () => {
		for (const capability of ['agents:dispatch', 'process:spawn'] as const) {
			const r = parsePermissions([{ capability }]);
			expect(r.requests).toEqual([]);
			expect(r.errors[0]).toMatch(/requires an allowlist scope/);
		}
	});

	it('rejects allowlist members carrying pattern/path/shell characters', () => {
		for (const scope of ['agent-*', 'a b', '/usr/bin/tool', 'a,"b"', 'x;y'.replace(';', '\\')]) {
			const r = parsePermissions([{ capability: 'agents:dispatch', scope }]);
			expect(r.requests, `scope ${scope} must be rejected`).toEqual([]);
			expect(r.errors[0]).toMatch(/forbidden characters|no valid members/);
		}
	});

	it('keeps a valid allowlist request (comma-separated exact names)', () => {
		const r = parsePermissions([
			{ capability: 'agents:dispatch', scope: 'agent-one, agent-two', reason: 'run reports' },
		]);
		expect(r.errors).toEqual([]);
		expect(r.requests[0]).toEqual({
			capability: 'agents:dispatch',
			scope: 'agent-one, agent-two',
			reason: 'run reports',
		});
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

	it('collapses .. so traversal cannot escape the scope', () => {
		const g = [grant('fs:read', '/data')];
		expect(isPermitted(g, 'fs:read', '/data/../etc/passwd')).toBe(false);
		expect(isPermitted(g, 'fs:read', '/data/../../etc/passwd')).toBe(false);
		expect(isPermitted(g, 'fs:read', '/data/sub/../ok.txt')).toBe(true);
		expect(isPermitted(g, 'fs:read', '/data/./ok.txt')).toBe(true);
	});

	it('collapses .. in the grant scope too', () => {
		expect(isPermitted([grant('fs:read', '/a/b/../data')], 'fs:read', '/a/data/x')).toBe(true);
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

describe('allowlist scope matching (Phase-4 act verbs — exhaustive set membership)', () => {
	const at = 1;
	const grant = (capability: string, scope?: string, unattended?: boolean): PermissionGrant =>
		({
			capability,
			...(scope !== undefined ? { scope } : {}),
			...(unattended ? { unattended: true } : {}),
			grantedAt: at,
		}) as PermissionGrant;

	it('denies with no grant at all', () => {
		expect(isPermitted([], 'agents:dispatch', 'agent-a')).toBe(false);
		expect(isPermitted([], 'process:spawn', 'tool')).toBe(false);
	});

	it('DENIES an unscoped act-verb grant (unscoped is a wildcard, wildcard is forbidden)', () => {
		expect(isPermitted([grant('agents:dispatch')], 'agents:dispatch', 'agent-a')).toBe(false);
		expect(isPermitted([grant('process:spawn')], 'process:spawn', 'tool')).toBe(false);
	});

	it('DENIES an empty/whitespace allowlist scope', () => {
		expect(isPermitted([grant('agents:dispatch', '')], 'agents:dispatch', 'agent-a')).toBe(false);
		expect(isPermitted([grant('agents:dispatch', ' , ,')], 'agents:dispatch', 'agent-a')).toBe(
			false
		);
	});

	it('DENIES a call without a concrete target even when members are named', () => {
		expect(isPermitted([grant('agents:dispatch', 'agent-a')], 'agents:dispatch')).toBe(false);
	});

	it('allows EXACT member matches only', () => {
		const g = [grant('agents:dispatch', 'agent-a,agent-b')];
		expect(isPermitted(g, 'agents:dispatch', 'agent-a')).toBe(true);
		expect(isPermitted(g, 'agents:dispatch', 'agent-b')).toBe(true);
		expect(isPermitted(g, 'agents:dispatch', 'agent-c')).toBe(false);
	});

	it('never matches substrings, prefixes, suffixes, or case variants', () => {
		const g = [grant('agents:dispatch', 'agent-a')];
		expect(isPermitted(g, 'agents:dispatch', 'agent')).toBe(false); // prefix of member
		expect(isPermitted(g, 'agents:dispatch', 'agent-a2')).toBe(false); // member is prefix of target
		expect(isPermitted(g, 'agents:dispatch', 'gent-a')).toBe(false); // substring
		expect(isPermitted(g, 'agents:dispatch', 'Agent-A')).toBe(false); // case-sensitive
		expect(isPermitted(g, 'agents:dispatch', 'agent-a,agent-b')).toBe(false); // list is not a member
	});

	it('never treats a wildcard-looking member as a pattern', () => {
		// Even if a '*' member were somehow minted, it matches ONLY the literal
		// string '*' — never "anything".
		const g = [grant('process:spawn', '*')];
		expect(isPermitted(g, 'process:spawn', 'tool')).toBe(false);
	});

	it('trims whitespace around comma-separated members but not inside them', () => {
		const g = [grant('process:spawn', ' tool-one ,tool-two')];
		expect(isPermitted(g, 'process:spawn', 'tool-one')).toBe(true);
		expect(isPermitted(g, 'process:spawn', 'tool-two')).toBe(true);
		expect(isPermitted(g, 'process:spawn', 'tool one')).toBe(false);
	});

	it('does not let one act verb satisfy the other', () => {
		expect(isPermitted([grant('agents:dispatch', 'tool')], 'process:spawn', 'tool')).toBe(false);
		expect(isPermitted([grant('process:spawn', 'agent-a')], 'agents:dispatch', 'agent-a')).toBe(
			false
		);
	});

	it('isPermittedUnattended requires the SEPARATE unattended flag on a covering grant', () => {
		const interactiveOnly = [grant('agents:dispatch', 'agent-a')];
		expect(isPermittedUnattended(interactiveOnly, 'agents:dispatch', 'agent-a')).toBe(false);

		const withUnattended = [grant('agents:dispatch', 'agent-a', true)];
		expect(isPermittedUnattended(withUnattended, 'agents:dispatch', 'agent-a')).toBe(true);
		// Still exact-membership: the unattended flag widens nothing.
		expect(isPermittedUnattended(withUnattended, 'agents:dispatch', 'agent-b')).toBe(false);
		// And the interactive predicate still passes for the same grant.
		expect(isPermitted(withUnattended, 'agents:dispatch', 'agent-a')).toBe(true);
	});
});

describe('grantsFromRequests + capabilityRisk', () => {
	it('stamps grant time', () => {
		const g = grantsFromRequests([{ capability: 'fs:read', scope: '/d' }], 123);
		expect(g[0]).toEqual({ capability: 'fs:read', scope: '/d', grantedAt: 123 });
	});
	it('classifies risk', () => {
		expect(capabilityRisk('process:spawn')).toBe('high');
		expect(capabilityRisk('shell:openExternal')).toBe('high');
		expect(capabilityRisk('sessions:create')).toBe('high');
		expect(capabilityRisk('sessions:write')).toBe('high');
		expect(capabilityRisk('transcripts:write')).toBe('high');
		expect(capabilityRisk('decisions:write')).toBe('high');
		expect(capabilityRisk('background:service')).toBe('high');
		expect(capabilityRisk('power:preventSleep')).toBe('medium');
		expect(capabilityRisk('notifications:toast')).toBe('low');
	});
});

describe('P0 contract capabilities', () => {
	const p0Caps = [
		'history:read',
		'sessions:create',
		'sessions:write',
		'tabs:manage',
		'transcripts:write',
		'decisions:write',
		'shell:openExternal',
		'storage:sql',
		'fs:watch',
		'power:preventSleep',
		'background:service',
	] as const;

	it('recognizes and describes every P0 addition', () => {
		for (const cap of p0Caps) {
			expect(isPluginCapability(cap)).toBe(true);
			expect(PLUGIN_CAPABILITIES).toContain(cap);
			expect(describeCapability(cap)).toBeTruthy();
		}
	});

	it('enforces scoped P0 targets for fs.watch and shell.openExternal', () => {
		const grant = (capability: string, scope?: string): PermissionGrant =>
			({ capability, ...(scope ? { scope } : {}), grantedAt: 1 }) as PermissionGrant;
		expect(isPermitted([grant('fs:watch', '/repo')], 'fs:watch', '/repo/src/a.ts')).toBe(true);
		expect(isPermitted([grant('fs:watch', '/repo')], 'fs:watch', '/other/a.ts')).toBe(false);
		expect(
			isPermitted(
				[grant('shell:openExternal', 'example.com')],
				'shell:openExternal',
				'docs.example.com'
			)
		).toBe(true);
		expect(
			isPermitted([grant('shell:openExternal', 'example.com')], 'shell:openExternal', 'evil.com')
		).toBe(false);
	});
});

describe('UI customization capabilities', () => {
	it('recognizes the new UI capabilities', () => {
		for (const cap of ['ui:contribute', 'ui:panel', 'ui:hostView', 'ui:render-unsafe'] as const) {
			expect(isPluginCapability(cap)).toBe(true);
			expect(PLUGIN_CAPABILITIES).toContain(cap);
			expect(describeCapability(cap)).toBeTruthy();
		}
	});

	it('risk tiers: contribute/panel medium, render-unsafe high', () => {
		expect(capabilityRisk('ui:contribute')).toBe('medium');
		expect(capabilityRisk('ui:panel')).toBe('medium');
		expect(capabilityRisk('ui:hostView')).toBe('medium');
		expect(capabilityRisk('ui:render-unsafe')).toBe('high');
	});

	it('UI capabilities take no scope (none → any grant permits)', () => {
		const grant = (capability: string): PermissionGrant =>
			({ capability, grantedAt: 1 }) as PermissionGrant;
		expect(isPermitted([grant('ui:contribute')], 'ui:contribute')).toBe(true);
		expect(isPermitted([grant('ui:hostView')], 'ui:hostView')).toBe(true);
		expect(isPermitted([grant('ui:render-unsafe')], 'ui:render-unsafe')).toBe(true);
	});
});
