/**
 * @file permission-broker-userdata-exclusion.test.ts
 * @description fs:read AND fs:write are structurally excluded from the
 * userData/config tree regardless of grant breadth, with separator-boundary
 * matching (so a sibling dir sharing the prefix is NOT caught). The target and
 * the protected folder are compared as canonical paths: case-folded on macOS and
 * Windows, with `..` collapsed and symlinks followed.
 */

import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PermissionBroker } from '../../../main/plugins/permission-broker';
import type { PermissionGrant } from '../../../shared/plugins/permissions';

function grant(capability: string, scope?: string): PermissionGrant {
	return { capability, ...(scope ? { scope } : {}), grantedAt: 1 } as PermissionGrant;
}

const userData =
	process.platform === 'win32' ? 'C:/Users/me/AppData/Maestro' : '/home/me/.config/Maestro';

/** Unscoped fs grants: only the protected-folder exclusion can say no. */
const BROAD_FS = [grant('fs:read'), grant('fs:write')];

function broker(
	grants: PermissionGrant[],
	options: { protectedPath?: string; platform?: NodeJS.Platform } = {}
): PermissionBroker {
	return new PermissionBroker({
		getGrants: () => grants,
		protectedPaths: () => [options.protectedPath ?? userData],
		platform: options.platform,
	});
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
		for (const target of targets) {
			expect(b.authorize('p', 'fs.read', { path: target }).allowed).toBe(false);
			expect(b.authorize('p', 'fs.write', { path: target }).allowed).toBe(false);
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

describe('PermissionBroker data-folder exclusion and case', () => {
	// Where macOS keeps the folder. APFS is case-insensitive by default, so `MAESTRO` IS this folder there.
	// The user does not exist on any host, so only the injected platform decides the answer.
	const macUserData = '/Users/maestro-test-user/Library/Application Support/Maestro';
	const shouting = '/Users/maestro-test-user/Library/Application Support/MAESTRO';

	it.each(['darwin', 'win32'] as const)(
		'blocks an upper-case and a lower-case spelling of the data folder on %s',
		(platform) => {
			const b = broker(BROAD_FS, { protectedPath: macUserData, platform });
			const targets = [
				`${shouting}/plugin-grants.json`,
				`${shouting}/plugins/evil/x`,
				`${macUserData.toLowerCase()}/cli-server.json`,
				shouting,
			];
			for (const target of targets) {
				expect(b.authorize('p', 'fs.read', { path: target }).allowed).toBe(false);
				expect(b.authorize('p', 'fs.write', { path: target }).allowed).toBe(false);
			}
		}
	);

	it('keeps case-sensitive matching on Linux, where MAESTRO is another folder than Maestro', () => {
		const b = broker(BROAD_FS, { protectedPath: macUserData, platform: 'linux' });
		expect(b.authorize('p', 'fs.read', { path: `${shouting}/plugin-grants.json` }).allowed).toBe(
			true
		);
		// The exact spelling is still protected.
		expect(b.authorize('p', 'fs.read', { path: `${macUserData}/plugin-grants.json` }).allowed).toBe(
			false
		);
	});

	it('still treats a sibling that shares the name prefix as outside, case folded or not', () => {
		const b = broker(BROAD_FS, { protectedPath: macUserData, platform: 'darwin' });
		expect(b.authorize('p', 'fs.read', { path: `${shouting}-SIBLING/x` }).allowed).toBe(true);
	});
});

describe('PermissionBroker data-folder exclusion on real folders', () => {
	let base: string;
	let dataDir: string;

	function allowed(target: string, protectedPath = dataDir): boolean {
		return broker(BROAD_FS, { protectedPath }).authorize('p', 'fs.read', { path: target }).allowed;
	}

	beforeAll(() => {
		// realpath.native: the macOS temp folder sits behind the /var -> /private/var link, and the Windows
		// runner's behind an 8.3 short name (RUNNER~1); the broker resolves both the same way.
		base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'broker-userdata-')));
		dataDir = path.join(base, 'Maestro');
		fs.mkdirSync(path.join(dataDir, 'plugins'), { recursive: true });
		fs.writeFileSync(path.join(dataDir, 'cli-server.json'), '{}');
		fs.mkdirSync(path.join(base, 'other'));
		fs.writeFileSync(path.join(base, 'other', 'notes.txt'), 'ok');
		fs.mkdirSync(path.join(base, 'Maestro-sibling'));
	});

	afterAll(() => {
		fs.rmSync(base, { recursive: true, force: true });
	});

	it('applies the host file system case rules by default', () => {
		// macOS and Windows are case-insensitive, so MAESTRO is the data folder there. On Linux it is
		// another folder that does not exist.
		const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32';
		expect(allowed(path.join(base, 'MAESTRO', 'cli-server.json'))).toBe(!caseInsensitive);
		expect(allowed(path.join(dataDir, 'cli-server.json'))).toBe(false);
	});

	it('resolves a `..` hop that lands in the data folder, and one that leaves it', () => {
		const into = `${base}${path.sep}other${path.sep}..${path.sep}Maestro${path.sep}cli-server.json`;
		expect(allowed(into)).toBe(false);
		const out = `${dataDir}${path.sep}plugins${path.sep}..${path.sep}..${path.sep}other${path.sep}notes.txt`;
		expect(allowed(out)).toBe(true);
	});

	it('allows an unrelated folder and a sibling that shares the name prefix', () => {
		expect(allowed(path.join(base, 'other', 'notes.txt'))).toBe(true);
		expect(allowed(path.join(base, 'Maestro-sibling', 'x'))).toBe(true);
	});

	// Symlinks need a privilege Windows runners may lack; real-path-containment.test.ts skips the same way.
	describe.skipIf(process.platform === 'win32')('through symlinks', () => {
		let linkToDataDir: string;
		let linkToFile: string;
		let linkElsewhere: string;

		beforeAll(() => {
			linkToDataDir = path.join(base, 'shortcut');
			fs.symlinkSync(dataDir, linkToDataDir, 'dir');
			linkToFile = path.join(base, 'innocent.json');
			fs.symlinkSync(path.join(dataDir, 'cli-server.json'), linkToFile);
			linkElsewhere = path.join(base, 'tour');
			fs.symlinkSync(path.join(base, 'other'), linkElsewhere, 'dir');
		});

		it('blocks a path that reaches the data folder through a symlink', () => {
			expect(allowed(path.join(linkToDataDir, 'cli-server.json'))).toBe(false);
			expect(allowed(linkToFile)).toBe(false);
		});

		it('blocks a file that does not exist yet under a symlink into the data folder', () => {
			const b = broker(BROAD_FS, { protectedPath: dataDir });
			const target = path.join(linkToDataDir, 'plugins', 'not-yet.json');
			expect(b.authorize('p', 'fs.write', { path: target }).allowed).toBe(false);
		});

		it('blocks the real path of a data folder that is itself named through a symlink', () => {
			expect(allowed(path.join(dataDir, 'cli-server.json'), linkToDataDir)).toBe(false);
			expect(allowed(path.join(base, 'other', 'notes.txt'), linkToDataDir)).toBe(true);
		});

		it('does not block a symlink that leads somewhere else', () => {
			expect(allowed(path.join(linkElsewhere, 'notes.txt'))).toBe(true);
		});
	});
});
