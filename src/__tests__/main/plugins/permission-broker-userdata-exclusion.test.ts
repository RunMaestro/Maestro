/**
 * @file permission-broker-userdata-exclusion.test.ts
 * @description fs:read AND fs:write are structurally excluded from the
 * userData/config tree regardless of grant breadth, with separator-boundary
 * matching (so a sibling dir sharing the prefix is NOT caught).
 */

import { describe, it, expect } from 'vitest';
import { PermissionBroker } from '../../../main/plugins/permission-broker';
import type { PermissionGrant } from '../../../shared/plugins/permissions';

function grant(capability: string, scope?: string): PermissionGrant {
	return { capability, ...(scope ? { scope } : {}), grantedAt: 1 } as PermissionGrant;
}

const userData =
	process.platform === 'win32' ? 'C:/Users/me/AppData/Maestro' : '/home/me/.config/Maestro';

function broker(grants: PermissionGrant[]): PermissionBroker {
	return new PermissionBroker({ getGrants: () => grants, protectedPaths: () => [userData] });
}

describe('PermissionBroker userData/config-tree exclusion', () => {
	it('denies fs.read/fs.write into the userData tree even with a broad grant', () => {
		const b = broker([grant('fs:read'), grant('fs:write')]);
		const targets = [
			`${userData}/plugin-grants.json`,
			`${userData}/cli-server.json`,
			`${userData}/plugins/evil/x`,
			`${userData}/maestro-pianola-supervisor.json`,
			userData,
		];
		for (const path of targets) {
			expect(b.authorize('p', 'fs.read', { path }).allowed).toBe(false);
			expect(b.authorize('p', 'fs.write', { path }).allowed).toBe(false);
		}
	});

	it('still allows fs access OUTSIDE the protected tree (separator boundary)', () => {
		const b = broker([grant('fs:read')]);
		// A sibling dir sharing the textual prefix must NOT be treated as inside.
		expect(b.authorize('p', 'fs.read', { path: `${userData}-sibling/x` }).allowed).toBe(true);
		const elsewhere = process.platform === 'win32' ? 'D:/work/x' : '/var/data/x';
		expect(b.authorize('p', 'fs.read', { path: elsewhere }).allowed).toBe(true);
	});

	it('gives a descriptive protected-location reason', () => {
		const d = broker([grant('fs:write')]).authorize('p', 'fs.write', { path: `${userData}/x` });
		expect(d.allowed).toBe(false);
		expect(d.reason).toMatch(/protected location/);
	});

	it('non-fs capabilities are unaffected by the path exclusion', () => {
		const b = broker([grant('notifications:toast')]);
		expect(b.authorize('p', 'notifications.toast', {}).allowed).toBe(true);
	});
});
