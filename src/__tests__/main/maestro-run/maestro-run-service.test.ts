/**
 * @file maestro-run-service.test.ts
 * @description The MaestroRun installer and readiness gate, driven end to end
 * against real temp directories with the system tools (codesign, spctl, ditto,
 * plutil, sysctl, the launcher's own `doctor`) and GitHub replaced by fakes.
 */

import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	FULL_DISK_ACCESS_SETTINGS_URL,
	MaestroRunService,
	READY_MAX_AGE_MS,
	type MaestroRunServiceDeps,
} from '../../../main/maestro-run/maestro-run-service';
import { maestroRunArchiveName } from '../../../shared/maestro-run/contract';
import { maestroRunStatePath, parseMaestroRunState } from '../../../shared/maestro-run/status';
import type { MaestroRunStatus } from '../../../shared/maestro-run/status';

interface World {
	service: MaestroRunService;
	appPath: string;
	userDataDir: string;
	calls: Array<{ tool: string; args: string[]; env?: NodeJS.ProcessEnv }>;
	fetched: string[];
	opened: string[];
	revealed: string[];
	statuses: MaestroRunStatus[];
	/** Mutable knobs the fakes read on every call. */
	knobs: {
		enabled: boolean;
		arm64: string;
		releases: unknown[];
		/** Version written inside the bundle a download unpacks to. */
		archiveVersion: string;
		corruptChecksum: boolean;
		identityFails: (bundle: string) => boolean;
		notarized: boolean;
		doctor: { exitCode: number; access: string; responsible: string };
		now: number;
	};
	writeInstalled: (version: string) => void;
	toolCalls: (tool: string) => string[][];
}

let tmp: string;
let world: World;

function writeBundle(appPath: string, version: string): void {
	fs.mkdirSync(path.join(appPath, 'Contents', 'MacOS'), { recursive: true });
	fs.writeFileSync(path.join(appPath, 'Contents', 'Info.plist'), version);
	fs.writeFileSync(path.join(appPath, 'Contents', 'MacOS', 'maestro-run'), '#!/bin/sh\n');
}

function release(version: string, arch = 'arm64') {
	const name = maestroRunArchiveName(version, arch as 'arm64' | 'x86_64');
	return {
		tag_name: `v${version}`,
		draft: false,
		prerelease: false,
		assets: [
			{ name, browser_download_url: `https://dl.test/${name}` },
			{ name: `${name}.sha256`, browser_download_url: `https://dl.test/${name}.sha256` },
		],
	};
}

function makeWorld(overrides: Partial<MaestroRunServiceDeps> = {}): World {
	const homeDir = path.join(tmp, 'home');
	const userDataDir = path.join(tmp, 'userData');
	const appPath = path.join(homeDir, 'Applications', 'MaestroRun.app');
	const knobs: World['knobs'] = {
		enabled: true,
		arm64: '1',
		releases: [release('0.2.0')],
		archiveVersion: '0.2.0',
		corruptChecksum: false,
		identityFails: () => false,
		notarized: true,
		doctor: { exitCode: 3, access: 'not-granted', responsible: 'self' },
		now: 1_000_000,
	};
	const calls: World['calls'] = [];
	const fetched: string[] = [];
	const opened: string[] = [];
	const revealed: string[] = [];
	const statuses: MaestroRunStatus[] = [];
	const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });

	const exec: MaestroRunServiceDeps['exec'] = async (command, args, _cwd, options) => {
		const tool = path.basename(command);
		calls.push({ tool, args, env: options?.env });
		const target = args[args.length - 1];
		switch (tool) {
			case 'sysctl':
				return ok(`${knobs.arm64}\n`);
			case 'codesign':
				return knobs.identityFails(target)
					? {
							stdout: '',
							stderr: 'code failed to satisfy specified code requirement(s)',
							exitCode: 3,
						}
					: ok();
			case 'plutil':
				return ok(`${fs.readFileSync(target, 'utf-8')}\n`);
			case 'ditto':
				writeBundle(path.join(target, 'MaestroRun.app'), knobs.archiveVersion);
				return ok();
			case 'spctl':
				return knobs.notarized
					? ok()
					: { stdout: '', stderr: 'rejected\nsource=Unnotarized Developer ID', exitCode: 3 };
			case 'maestro-run':
				return {
					stdout: `version: 0\nresponsible-process: ${knobs.doctor.responsible}\nfull-disk-access: ${knobs.doctor.access}\n`,
					stderr: knobs.doctor.exitCode === 126 ? 'allowlist cannot be examined' : '',
					exitCode: knobs.doctor.exitCode,
				};
			default:
				throw new Error(`unexpected tool ${tool}`);
		}
	};

	const fetchFake: MaestroRunServiceDeps['fetch'] = async (url) => {
		fetched.push(url);
		if (url.includes('api.github.com')) return new Response(JSON.stringify(knobs.releases));
		const archive = Buffer.from(`archive:${url.replace(/\.sha256$/, '')}`);
		if (url.endsWith('.sha256')) {
			const digest = knobs.corruptChecksum
				? '0'.repeat(64)
				: createHash('sha256').update(archive).digest('hex');
			return new Response(`${digest}  ${path.posix.basename(url).replace(/\.sha256$/, '')}\n`);
		}
		return new Response(archive);
	};

	const service = new MaestroRunService({
		platform: 'darwin',
		homeDir,
		userDataDir,
		appCandidates: [appPath],
		isEnabled: () => knobs.enabled,
		exec,
		fetch: fetchFake,
		openExternal: async (url) => {
			opened.push(url);
		},
		showItemInFolder: (p) => {
			revealed.push(p);
		},
		onStatusChange: (status) => statuses.push(status),
		now: () => knobs.now,
		watchIntervalMs: 5,
		...overrides,
	});

	return {
		service,
		appPath,
		userDataDir,
		calls,
		fetched,
		opened,
		revealed,
		statuses,
		knobs,
		writeInstalled: (version) => writeBundle(appPath, version),
		toolCalls: (tool) => calls.filter((c) => c.tool === tool).map((c) => c.args),
	};
}

function readState(w: World) {
	return parseMaestroRunState(fs.readFileSync(maestroRunStatePath(w.userDataDir), 'utf-8'));
}

function stagingLeftovers(w: World): string[] {
	const parent = path.dirname(w.appPath);
	if (!fs.existsSync(parent)) return [];
	return fs.readdirSync(parent).filter((name) => name.startsWith('.maestro-run-install-'));
}

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-run-test-'));
	world = makeWorld();
});

afterEach(() => {
	world.service.dispose();
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('on a host that is not macOS', () => {
	it.each(['win32', 'linux'] as const)(
		'%s: reports unsupported and touches nothing',
		async (platform) => {
			const w = makeWorld({ platform });
			const status = await w.service.refresh({ checkLatest: true });
			expect(status).toMatchObject({ supported: false, phase: 'unsupported' });
			expect(w.calls).toEqual([]);
			expect(w.fetched).toEqual([]);
			await expect(w.service.install()).rejects.toThrow('macOS only');
			await expect(w.service.requestAccess()).rejects.toThrow('macOS only');
			expect(await w.service.readyBinaryPath()).toBeUndefined();
		}
	);
});

describe('inspecting the launcher', () => {
	it('reports not-installed without running any tool', async () => {
		const status = await world.service.refresh();
		expect(status).toMatchObject({ phase: 'not-installed', installedVersion: null, enabled: true });
		expect(world.calls).toEqual([]);
		expect(readState(world)).toMatchObject({ ready: false });
	});

	it('never runs a bundle that fails the identity check', async () => {
		world.writeInstalled('0.2.0');
		world.knobs.identityFails = () => true;
		const status = await world.service.refresh();
		expect(status.phase).toBe('invalid');
		expect(status.detail).toContain('failed to satisfy');
		expect(world.toolCalls('maestro-run')).toEqual([]);
		expect(world.toolCalls('plutil')).toEqual([]);
		expect(await world.service.readyBinaryPath()).toBeUndefined();
	});

	it('verifies the code requirement against the bundle', async () => {
		world.writeInstalled('0.2.0');
		await world.service.refresh();
		expect(world.toolCalls('codesign')[0]).toEqual([
			'--verify',
			'--strict',
			'-R=identifier "com.maestro.run" and anchor apple generic and certificate leaf[subject.OU] = "4N4DQ24LED"',
			world.appPath,
		]);
	});

	it('is needs-access while doctor says not granted', async () => {
		world.writeInstalled('0.2.0');
		const status = await world.service.refresh();
		expect(status).toMatchObject({
			phase: 'needs-access',
			installedVersion: '0.2.0',
			fullDiskAccess: 'not-granted',
			detail: null,
		});
		expect(readState(world)).toMatchObject({ ready: false, version: '0.2.0' });
		expect(await world.service.readyBinaryPath()).toBeUndefined();
	});

	it('is ready once doctor proves the grant, and records it for the CLI', async () => {
		world.writeInstalled('0.2.0');
		world.knobs.doctor = { exitCode: 0, access: 'granted', responsible: 'self' };
		const status = await world.service.refresh();
		expect(status.phase).toBe('ready');
		expect(status.binaryPath).toBe(`${world.appPath}/Contents/MacOS/maestro-run`);
		expect(readState(world)).toEqual({
			ready: true,
			binaryPath: status.binaryPath,
			version: '0.2.0',
			checkedAt: world.knobs.now,
		});
		expect(await world.service.readyBinaryPath()).toBe(status.binaryPath);
		expect(world.service.readyBinaryPathCached()).toBe(status.binaryPath);
	});

	it('does not accept a grant the launcher inherited from its parent', async () => {
		world.writeInstalled('0.2.0');
		world.knobs.doctor = { exitCode: 0, access: 'granted', responsible: 'Maestro (412)' };
		const status = await world.service.refresh();
		expect(status.phase).toBe('needs-access');
		expect(status.detail).toContain('Maestro (412)');
	});

	it('reports a doctor failure of its own instead of calling it "not granted"', async () => {
		world.writeInstalled('0.2.0');
		world.knobs.doctor = { exitCode: 126, access: 'unknown', responsible: 'self' };
		const status = await world.service.refresh();
		expect(status).toMatchObject({ phase: 'needs-access', fullDiskAccess: 'unknown' });
		expect(status.detail).toContain('exit 126');
	});

	it('never passes MAESTRO_RUN_CONFIG_DIR to the launcher', async () => {
		process.env.MAESTRO_RUN_CONFIG_DIR = '/tmp/elsewhere';
		try {
			world.writeInstalled('0.2.0');
			await world.service.refresh();
		} finally {
			delete process.env.MAESTRO_RUN_CONFIG_DIR;
		}
		const doctor = world.calls.find((c) => c.tool === 'maestro-run');
		expect(doctor?.env).toBeDefined();
		expect(doctor?.env).not.toHaveProperty('MAESTRO_RUN_CONFIG_DIR');
	});
});

describe('the readiness gate for the system prompt', () => {
	beforeEach(() => {
		world.writeInstalled('0.2.0');
		world.knobs.doctor = { exitCode: 0, access: 'granted', responsible: 'self' };
	});

	it('is closed while the feature is off, however ready the launcher is', async () => {
		await world.service.refresh();
		world.knobs.enabled = false;
		expect(await world.service.readyBinaryPath()).toBeUndefined();
		expect(world.service.readyBinaryPathCached()).toBeUndefined();
	});

	it('answers from the last inspection while it is fresh', async () => {
		await world.service.refresh();
		const before = world.calls.length;
		world.knobs.now += READY_MAX_AGE_MS - 1;
		expect(await world.service.readyBinaryPath()).toBeDefined();
		expect(world.calls.length).toBe(before);
	});

	it('re-inspects a stale answer, so a revoked grant stops being advertised', async () => {
		await world.service.refresh();
		world.knobs.doctor = { exitCode: 3, access: 'not-granted', responsible: 'self' };
		world.knobs.now += READY_MAX_AGE_MS + 1;
		expect(await world.service.readyBinaryPath()).toBeUndefined();
		expect(readState(world)).toMatchObject({ ready: false });
	});
});

describe('install', () => {
	it('downloads, verifies, and installs the release for this Mac', async () => {
		const status = await world.service.install();
		expect(status).toMatchObject({
			phase: 'needs-access',
			installedVersion: '0.2.0',
			installing: false,
			updateAvailable: false,
			latestVersion: '0.2.0',
		});
		expect(fs.readFileSync(path.join(world.appPath, 'Contents', 'Info.plist'), 'utf-8')).toBe(
			'0.2.0'
		);
		expect(world.fetched).toContain('https://dl.test/MaestroRun-0.2.0-macos-arm64.zip');
		expect(stagingLeftovers(world)).toEqual([]);

		// Identity and notarization are both checked on the unpacked download,
		// and nothing from it runs before they pass.
		const order = world.calls.map((c) => c.tool);
		const firstDoctor = order.indexOf('maestro-run');
		expect(order.indexOf('ditto')).toBeGreaterThan(-1);
		expect(order.indexOf('codesign')).toBeGreaterThan(order.indexOf('ditto'));
		expect(order.indexOf('spctl')).toBeGreaterThan(order.indexOf('codesign'));
		expect(firstDoctor).toBeGreaterThan(order.indexOf('spctl'));
		expect(world.toolCalls('spctl')[0].slice(0, 4)).toEqual([
			'--assess',
			'--type',
			'execute',
			'--verbose=2',
		]);
	});

	it('reports installing while it runs', async () => {
		const pending = world.service.install();
		expect(world.service.status().installing).toBe(true);
		await pending;
		expect(world.service.status().installing).toBe(false);
	});

	it('picks the Intel archive when the hardware is not arm64', async () => {
		world.knobs.arm64 = '0';
		world.knobs.releases = [release('0.2.0', 'x86_64')];
		await world.service.install();
		expect(world.fetched).toContain('https://dl.test/MaestroRun-0.2.0-macos-x86_64.zip');
	});

	it('says so when no release is published', async () => {
		world.knobs.releases = [];
		await expect(world.service.install()).rejects.toThrow('has not published a release');
		expect(fs.existsSync(world.appPath)).toBe(false);
		expect(world.service.status().detail).toContain('has not published a release');
	});

	it.each([
		['a checksum mismatch', (w: World) => (w.knobs.corruptChecksum = true), 'Checksum mismatch'],
		[
			'a download that is not signed by MaestroRun',
			(w: World) => (w.knobs.identityFails = (bundle) => bundle.includes('.maestro-run-install-')),
			'not signed by MaestroRun',
		],
		['a download that is not notarized', (w: World) => (w.knobs.notarized = false), 'notarized'],
		[
			'a bundle whose version is not the release version',
			(w: World) => (w.knobs.archiveVersion = '9.9.9'),
			'refusing to install',
		],
	])('refuses %s and leaves nothing behind', async (_name, breakIt, message) => {
		breakIt(world);
		await expect(world.service.install()).rejects.toThrow(message);
		expect(fs.existsSync(world.appPath)).toBe(false);
		expect(stagingLeftovers(world)).toEqual([]);
		expect(world.toolCalls('maestro-run')).toEqual([]);
	});

	it('does not unpack a download whose checksum is wrong', async () => {
		world.knobs.corruptChecksum = true;
		await expect(world.service.install()).rejects.toThrow();
		expect(world.toolCalls('ditto')).toEqual([]);
	});

	it('keeps the installed copy when an update fails verification', async () => {
		world.writeInstalled('0.1.0');
		world.knobs.notarized = false;
		await expect(world.service.install()).rejects.toThrow('notarized');
		expect(fs.readFileSync(path.join(world.appPath, 'Contents', 'Info.plist'), 'utf-8')).toBe(
			'0.1.0'
		);
	});

	it('updates in place and keeps no copy of the old bundle', async () => {
		world.writeInstalled('0.1.0');
		const status = await world.service.install();
		expect(status.installedVersion).toBe('0.2.0');
		expect(fs.readdirSync(path.dirname(world.appPath))).toEqual(['MaestroRun.app']);
	});

	it('refuses to downgrade', async () => {
		world.writeInstalled('0.3.0');
		await expect(world.service.install()).rejects.toThrow('refusing to downgrade');
		expect(fs.readFileSync(path.join(world.appPath, 'Contents', 'Info.plist'), 'utf-8')).toBe(
			'0.3.0'
		);
		expect(world.fetched.some((url) => url.endsWith('.zip'))).toBe(false);
	});

	it('downloads nothing when the installed copy is already current', async () => {
		world.writeInstalled('0.2.0');
		const status = await world.service.install();
		expect(status.installedVersion).toBe('0.2.0');
		expect(world.fetched.some((url) => url.endsWith('.zip'))).toBe(false);
	});

	it('replaces a present bundle that is not MaestroRun', async () => {
		world.writeInstalled('7.7.7');
		world.knobs.identityFails = (bundle) =>
			bundle === world.appPath &&
			fs.readFileSync(path.join(bundle, 'Contents', 'Info.plist'), 'utf-8') === '7.7.7';
		const status = await world.service.install();
		expect(status.installedVersion).toBe('0.2.0');
	});

	it('flags an update after a release check', async () => {
		world.writeInstalled('0.1.0');
		const status = await world.service.refresh({ checkLatest: true });
		expect(status).toMatchObject({ latestVersion: '0.2.0', updateAvailable: true });
	});

	it('keeps the installed status when the release check cannot reach GitHub', async () => {
		world.writeInstalled('0.1.0');
		const w = makeWorld({
			fetch: async () => {
				throw new Error('offline');
			},
		});
		const status = await w.service.refresh({ checkLatest: true });
		expect(status).toMatchObject({
			phase: 'needs-access',
			latestVersion: null,
			updateAvailable: false,
		});
	});
});

describe('the Full Disk Access walkthrough', () => {
	it('refuses before the launcher is installed', async () => {
		await expect(world.service.requestAccess()).rejects.toThrow('Install MaestroRun first');
		expect(world.opened).toEqual([]);
	});

	it('refuses to walk a bundle that is not MaestroRun', async () => {
		world.writeInstalled('0.2.0');
		world.knobs.identityFails = () => true;
		await expect(world.service.requestAccess()).rejects.toThrow('failed verification');
		expect(world.opened).toEqual([]);
	});

	it('registers the launcher, opens the list, and watches for the switch', async () => {
		world.writeInstalled('0.2.0');
		const status = await world.service.requestAccess();
		// doctor ran first: an ungranted run is what puts MaestroRun in the list.
		expect(world.toolCalls('maestro-run')[0]).toEqual(['doctor']);
		expect(world.opened).toEqual([FULL_DISK_ACCESS_SETTINGS_URL]);
		expect(world.revealed).toEqual([]);
		expect(status).toMatchObject({ phase: 'needs-access', watchingForAccess: true });

		// The user flips the switch.
		world.knobs.doctor = { exitCode: 0, access: 'granted', responsible: 'self' };
		await vi.waitFor(() => expect(world.service.status().phase).toBe('ready'));
		expect(world.service.status().watchingForAccess).toBe(false);
		expect(world.statuses[world.statuses.length - 1]).toMatchObject({ phase: 'ready' });
	});

	it('also reveals the bundle when asked', async () => {
		world.writeInstalled('0.2.0');
		await world.service.requestAccess({ reveal: true });
		expect(world.revealed).toEqual([world.appPath]);
	});

	it('opens nothing when access is already in effect', async () => {
		world.writeInstalled('0.2.0');
		world.knobs.doctor = { exitCode: 0, access: 'granted', responsible: 'self' };
		const status = await world.service.requestAccess();
		expect(status).toMatchObject({ phase: 'ready', watchingForAccess: false });
		expect(world.opened).toEqual([]);
	});

	it('stops watching when the feature is turned off', async () => {
		world.writeInstalled('0.2.0');
		await world.service.requestAccess();
		world.knobs.enabled = false;
		await world.service.reconcile();
		expect(world.service.status().watchingForAccess).toBe(false);
	});
});
