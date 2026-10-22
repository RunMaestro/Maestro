/**
 * @file contract.test.ts
 * @description Maestro's reading of MaestroRun's published contract: versions,
 * release picking, the checksum file, and what a `doctor` run proves.
 */

import { describe, it, expect } from 'vitest';
import {
	MAESTRO_RUN_CODE_REQUIREMENT,
	compareMaestroRunVersions,
	doctorProvesAccess,
	maestroRunAppCandidates,
	maestroRunArchiveName,
	maestroRunBinaryPath,
	parseMaestroRunChecksum,
	parseMaestroRunDoctor,
	parseMaestroRunVersion,
	pickMaestroRunRelease,
} from '../../../shared/maestro-run/contract';
import {
	describeMaestroRunPhase,
	maestroRunStatePath,
	parseMaestroRunState,
	type MaestroRunStatus,
} from '../../../shared/maestro-run/status';

function release(version: string, archs: string[] = ['arm64', 'x86_64'], extra: object = {}) {
	return {
		tag_name: `v${version}`,
		draft: false,
		prerelease: false,
		assets: archs.flatMap((arch) => {
			const name = maestroRunArchiveName(version, arch as 'arm64' | 'x86_64');
			return [
				{ name, browser_download_url: `https://example.test/${name}` },
				{ name: `${name}.sha256`, browser_download_url: `https://example.test/${name}.sha256` },
			];
		}),
		...extra,
	};
}

describe('MaestroRun identity', () => {
	it('pins the identifier and the signing team', () => {
		expect(MAESTRO_RUN_CODE_REQUIREMENT).toBe(
			'identifier "com.maestro.run" and anchor apple generic and certificate leaf[subject.OU] = "4N4DQ24LED"'
		);
	});

	it('looks in ~/Applications first, then /Applications', () => {
		expect(maestroRunAppCandidates('/Users/me')).toEqual([
			'/Users/me/Applications/MaestroRun.app',
			'/Applications/MaestroRun.app',
		]);
		expect(maestroRunBinaryPath('/Users/me/Applications/MaestroRun.app')).toBe(
			'/Users/me/Applications/MaestroRun.app/Contents/MacOS/maestro-run'
		);
	});
});

describe('parseMaestroRunVersion / compareMaestroRunVersions', () => {
	it('accepts three decimal fields and nothing else', () => {
		expect(parseMaestroRunVersion('0.1.0')).toEqual([0, 1, 0]);
		expect(parseMaestroRunVersion(' 12.3.45\n')).toEqual([12, 3, 45]);
		for (const bad of ['v0.1.0', '0.1', '0.1.0-rc1', '0.1.0.4', '', 'one.two.three']) {
			expect(parseMaestroRunVersion(bad)).toBeNull();
		}
	});

	it('compares numerically, field by field', () => {
		const cmp = (a: string, b: string) =>
			compareMaestroRunVersions(parseMaestroRunVersion(a)!, parseMaestroRunVersion(b)!);
		expect(cmp('0.10.0', '0.9.9')).toBeGreaterThan(0);
		expect(cmp('1.0.0', '0.99.99')).toBeGreaterThan(0);
		expect(cmp('0.1.0', '0.1.1')).toBeLessThan(0);
		expect(cmp('2.3.4', '2.3.4')).toBe(0);
	});
});

describe('pickMaestroRunRelease', () => {
	it('picks the highest version for the architecture', () => {
		const pick = pickMaestroRunRelease(
			[release('0.1.0'), release('0.10.0'), release('0.9.0')],
			'arm64'
		);
		expect(pick).toEqual({
			version: '0.10.0',
			archiveName: 'MaestroRun-0.10.0-macos-arm64.zip',
			archiveUrl: 'https://example.test/MaestroRun-0.10.0-macos-arm64.zip',
			checksumUrl: 'https://example.test/MaestroRun-0.10.0-macos-arm64.zip.sha256',
		});
	});

	it('skips drafts, prereleases, and tags that are not v<version>', () => {
		const releases = [
			release('0.3.0', undefined, { draft: true }),
			release('0.2.0', undefined, { prerelease: true }),
			{ ...release('0.4.0'), tag_name: '0.4.0' },
			{ ...release('0.5.0'), tag_name: 'v0.5.0-beta' },
			release('0.1.0'),
		];
		expect(pickMaestroRunRelease(releases, 'x86_64')?.version).toBe('0.1.0');
	});

	it('skips a release that lacks the archive or its checksum for this architecture', () => {
		const noChecksum = release('0.3.0');
		noChecksum.assets = noChecksum.assets.filter((a) => !a.name.endsWith('arm64.zip.sha256'));
		const releases = [release('0.4.0', ['x86_64']), noChecksum, release('0.2.0')];
		expect(pickMaestroRunRelease(releases, 'arm64')?.version).toBe('0.2.0');
		expect(pickMaestroRunRelease(releases, 'x86_64')?.version).toBe('0.4.0');
	});

	it('skips a major version newer than this Maestro supports', () => {
		expect(pickMaestroRunRelease([release('2.0.0'), release('1.4.0')], 'arm64')?.version).toBe(
			'1.4.0'
		);
		expect(pickMaestroRunRelease([release('2.0.0')], 'arm64')).toBeNull();
		expect(pickMaestroRunRelease([release('2.0.0')], 'arm64', 2)?.version).toBe('2.0.0');
	});

	it('returns null when nothing is published', () => {
		expect(pickMaestroRunRelease([], 'arm64')).toBeNull();
		expect(pickMaestroRunRelease([{ tag_name: 42, assets: 'junk' }], 'arm64')).toBeNull();
	});
});

describe('parseMaestroRunChecksum', () => {
	const digest = 'a'.repeat(64);
	const name = 'MaestroRun-0.1.0-macos-arm64.zip';

	it('reads the digest from a shasum line that names the archive', () => {
		expect(parseMaestroRunChecksum(`${digest}  ${name}\n`, name)).toBe(digest);
	});

	it('refuses a line for another file, a short digest, or uppercase hex', () => {
		expect(parseMaestroRunChecksum(`${digest}  other.zip\n`, name)).toBeNull();
		expect(parseMaestroRunChecksum(`${'a'.repeat(63)}  ${name}\n`, name)).toBeNull();
		expect(parseMaestroRunChecksum(`${'A'.repeat(64)}  ${name}\n`, name)).toBeNull();
		expect(parseMaestroRunChecksum('', name)).toBeNull();
	});
});

describe('doctor', () => {
	const granted = [
		'version: 0.1.0',
		'executable: /Users/me/Applications/MaestroRun.app/Contents/MacOS/maestro-run',
		'responsible-process: self',
		'allowlist: /Users/me/Library/Application Support/MaestroRun/allowlist (3 entries)',
		'full-disk-access: granted',
	].join('\n');

	it('reads only the two promised keys', () => {
		expect(parseMaestroRunDoctor(granted)).toEqual({
			fullDiskAccess: 'granted',
			responsibleProcess: 'self',
		});
		expect(parseMaestroRunDoctor('full-disk-access: not-granted\n')).toEqual({
			fullDiskAccess: 'not-granted',
			responsibleProcess: 'unknown',
		});
		expect(parseMaestroRunDoctor('full-disk-access: maybe\nnoise')).toEqual({
			fullDiskAccess: 'unknown',
			responsibleProcess: 'unknown',
		});
	});

	it('proves access only with exit 0, granted, AND responsible-process self', () => {
		const report = parseMaestroRunDoctor(granted);
		expect(doctorProvesAccess(0, report)).toBe(true);
		expect(doctorProvesAccess(3, report)).toBe(false);
		expect(doctorProvesAccess('ENOENT', report)).toBe(false);
		expect(doctorProvesAccess(0, { ...report, fullDiskAccess: 'not-granted' })).toBe(false);
		// The launcher inherited the grant of whatever started it: a false positive.
		expect(doctorProvesAccess(0, { ...report, responsibleProcess: 'Maestro (412)' })).toBe(false);
	});
});

describe('state file', () => {
	it('lives under the Maestro data directory', () => {
		expect(maestroRunStatePath('/data')).toBe('/data/maestro-run/state.json');
	});

	it('parses a valid state and rejects anything else', () => {
		expect(
			parseMaestroRunState(
				'{"ready":true,"binaryPath":"/a/maestro-run","version":"0.1.0","checkedAt":5}'
			)
		).toEqual({ ready: true, binaryPath: '/a/maestro-run', version: '0.1.0', checkedAt: 5 });
		expect(parseMaestroRunState('{"ready":false,"binaryPath":"/a"}')).toEqual({
			ready: false,
			binaryPath: '/a',
			version: null,
			checkedAt: 0,
		});
		for (const bad of [
			'',
			'not json',
			'[]',
			'{"ready":"yes","binaryPath":"/a"}',
			'{"ready":true}',
		]) {
			expect(parseMaestroRunState(bad)).toBeNull();
		}
	});

	it('describes each phase in one line', () => {
		const phases = ['unsupported', 'not-installed', 'invalid', 'needs-access', 'ready'] as const;
		const lines = phases.map((phase) => describeMaestroRunPhase({ phase } as MaestroRunStatus));
		expect(new Set(lines).size).toBe(phases.length);
		expect(lines[4]).toBe('Ready');
	});
});
