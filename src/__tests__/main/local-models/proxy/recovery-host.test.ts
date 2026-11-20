import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildAgentLaunchPlan } from '../../../../shared/maestro-lib/launch/launch-plan';
import { isWindows } from '../../../../shared/platformDetection';
import { resolveBundledCliPathSync } from '../../../../main/maestro-cli-manager';
import { localModelsDataDir } from '../../../../main/local-models/paths';
import { TOKEN_PROXY_CACHE_DIRNAME } from '../../../../main/local-models/proxy/compression-cache';
import { inspectTokenProxyRecoveryHost } from '../../../../main/local-models/proxy/recovery-host';

vi.mock('fs', async (importOriginal) => {
	const original = await importOriginal<typeof import('fs')>();
	return { ...original, promises: { ...original.promises } };
});
vi.mock('../../../../main/maestro-cli-manager', () => ({
	resolveBundledCliPathSync: vi.fn(),
}));
vi.mock('../../../../main/local-models/paths', () => ({ localModelsDataDir: vi.fn() }));
vi.mock('../../../../shared/platformDetection', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../shared/platformDetection')>()),
	isWindows: vi.fn(),
}));

// These fixtures exercise host filesystem prerequisites only. They never run a
// CLI, source tool, provider process, listener or sandbox probe.
describe.skipIf(process.platform === 'win32')('recovery host preflight', () => {
	let root: string;
	let cliPath: string;
	let archivePath: string;
	let discoveryPath: string;
	const effectiveEnv = { SHELL: '/bin/sh' };
	const bridge = {
		pid: process.pid,
		port: 48001,
		startedAt: 1794000000000,
		token: 'synthetic-bridge-token',
		cliSecret: 'synthetic-cli-secret',
	};

	function localPlan() {
		const result = buildAgentLaunchPlan({
			surface: 'desktop',
			agent: { id: 'claude-code' },
			command: process.execPath,
			args: [],
			cwd: root,
			gateway: { toolType: 'claude-code', url: 'http://127.0.0.1:48002/anthropic' },
		});
		if (!result.ok) throw new Error(result.error);
		return result.plan;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-host-')));
		cliPath = path.join(root, 'bundled CLI', 'maestro-cli.js');
		archivePath = path.join(root, TOKEN_PROXY_CACHE_DIRNAME);
		discoveryPath = path.join(root, 'cli-server.json');
		fs.mkdirSync(path.dirname(cliPath));
		fs.mkdirSync(archivePath);
		fs.writeFileSync(cliPath, '// synthetic CLI fixture, never executed\n');
		fs.writeFileSync(discoveryPath, JSON.stringify(bridge));
		vi.mocked(localModelsDataDir).mockReset().mockReturnValue(root);
		vi.mocked(resolveBundledCliPathSync).mockReset().mockReturnValue(cliPath);
		vi.mocked(isWindows).mockReturnValue(false);
		vi.stubEnv('MAESTRO_USER_DATA', root);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('returns stable, non-authorizing host evidence without altering the original store', async () => {
		const originalPath = path.join(archivePath, 'fixture-original.txt');
		const original = 'exact original\r\nUnicode: λ\n';
		fs.writeFileSync(originalPath, original);
		const names = fs.readdirSync(root);
		const result = await inspectTokenProxyRecoveryHost(localPlan(), effectiveEnv);
		expect(result).toEqual({
			kind: 'host-preflight-only',
			runtimePath: fs.realpathSync(process.execPath),
			cliPath,
			dataDir: root,
			shellPath: fs.realpathSync(effectiveEnv.SHELL),
			hostScope: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(await inspectTokenProxyRecoveryHost(localPlan(), effectiveEnv)).toEqual(result);
		expect(result).not.toHaveProperty('environmentId');
		expect(result).not.toHaveProperty('gatewayUrl');
		expect(result).not.toHaveProperty('launchBinding');
		expect(JSON.stringify(result)).not.toContain(bridge.token);
		expect(JSON.stringify(result)).not.toContain(bridge.cliSecret);
		expect(fs.readdirSync(root)).toEqual(names);
		expect(fs.readdirSync(archivePath)).toEqual(['fixture-original.txt']);
		expect(fs.readFileSync(originalPath, 'utf8')).toBe(original);
	});

	it('does not use arbitrary effective environment values as scope metadata', async () => {
		const plan = localPlan();
		const first = await inspectTokenProxyRecoveryHost(plan, {
			...effectiveEnv,
			API_KEY: 'synthetic-private-one',
		});
		const second = await inspectTokenProxyRecoveryHost(plan, {
			...effectiveEnv,
			API_KEY: 'synthetic-private-two',
			MAESTRO_USER_DATA: root,
		});
		expect(first).not.toBeNull();
		expect(second).toEqual(first);
		expect(JSON.stringify(second)).not.toContain('synthetic-private');
	});

	it('keeps the host fingerprint stable as the archive gains originals', async () => {
		const first = await inspectTokenProxyRecoveryHost(localPlan(), effectiveEnv);
		fs.writeFileSync(path.join(archivePath, 'another-original.txt'), 'not a retrieval');
		expect(first).not.toBeNull();
		expect(await inspectTokenProxyRecoveryHost(localPlan(), effectiveEnv)).toEqual(first);
	});

	it('refuses Windows before inspecting any paths', async () => {
		vi.mocked(isWindows).mockReturnValue(true);
		vi.mocked(resolveBundledCliPathSync).mockClear();
		await expect(inspectTokenProxyRecoveryHost(localPlan(), effectiveEnv)).resolves.toBeNull();
		expect(resolveBundledCliPathSync).not.toHaveBeenCalled();
	});

	it('uses the resolved execution target, not a local-looking gateway', async () => {
		const plan = buildAgentLaunchPlan({
			surface: 'desktop',
			agent: { id: 'claude-code', binaryName: 'claude' },
			command: process.execPath,
			args: [],
			cwd: root,
			sshRemoteConfig: { enabled: true, remoteId: 'remote' },
			sshStore: {
				getSshRemotes: () => [
					{
						id: 'remote',
						name: 'Remote',
						host: 'remote.example.test',
						port: 22,
						username: 'fixture',
						privateKeyPath: '',
						enabled: true,
					},
				],
			},
		});
		if (!plan.ok) throw new Error(plan.error);
		expect(plan.plan.target.kind).toBe('remote');
		await expect(
			inspectTokenProxyRecoveryHost(
				{
					...plan.plan,
					gateway: localPlan().gateway,
				},
				effectiveEnv
			)
		).resolves.toBeNull();
	});

	it('ignores launches without an applied gateway or replaced by Run on', async () => {
		const plan = localPlan();
		await expect(
			inspectTokenProxyRecoveryHost({ ...plan, gateway: undefined }, effectiveEnv)
		).resolves.toBeNull();
		await expect(
			inspectTokenProxyRecoveryHost(
				{
					...plan,
					runOn: {
						model: 'fixture',
						contextTokens: 4096,
						args: [],
						subcommandArgs: [],
						envVarNames: [],
						userOverrides: [],
						clearedEnvVars: [],
					},
				},
				effectiveEnv
			)
		).resolves.toBeNull();
	});

	it.each([undefined, '', 'sh', '/usr/bin/fish', '/bin/sh\n', '/unknown/bash'])(
		'refuses unknown or unsupported shell prerequisites: %s',
		async (SHELL) => {
			await expect(inspectTokenProxyRecoveryHost(localPlan(), { SHELL })).resolves.toBeNull();
		}
	);

	it.each([
		'NODE_OPTIONS',
		'NODE_PATH',
		'LD_PRELOAD',
		'LD_LIBRARY_PATH',
		'DYLD_INSERT_LIBRARIES',
		'BASH_ENV',
		'ENV',
		'ZDOTDIR',
	])('refuses an environment that redirects runtime or shell startup through %s', async (name) => {
		const env: NodeJS.ProcessEnv = { ...effectiveEnv, [name]: 'synthetic-override' };
		await expect(inspectTokenProxyRecoveryHost(localPlan(), env)).resolves.toBeNull();
		expect(env[name]).toBe('synthetic-override');
	});

	it('does not rewrite an effective data-directory override', async () => {
		const env = { ...effectiveEnv, MAESTRO_USER_DATA: `${root}-other` };
		await expect(inspectTokenProxyRecoveryHost(localPlan(), env)).resolves.toBeNull();
		expect(env.MAESTRO_USER_DATA).toBe(`${root}-other`);
	});

	it('does not reuse host scope across archive namespaces', async () => {
		const first = await inspectTokenProxyRecoveryHost(localPlan(), effectiveEnv);
		const other = path.join(root, 'other namespace');
		fs.mkdirSync(path.join(other, TOKEN_PROXY_CACHE_DIRNAME), { recursive: true });
		fs.writeFileSync(path.join(other, 'cli-server.json'), JSON.stringify(bridge));
		vi.mocked(localModelsDataDir).mockReturnValue(other);
		const second = await inspectTokenProxyRecoveryHost(localPlan(), effectiveEnv);
		expect(first).not.toBeNull();
		expect(second).not.toBeNull();
		expect(second?.hostScope).not.toBe(first?.hostScope);
		expect(second?.dataDir).toBe(other);
	});

	it.each([
		null,
		'maestro-cli.js',
		'/invalid\n/maestro-cli.js',
		`/${'x'.repeat(2048)}/maestro-cli.js`,
	])('refuses absent, relative, control-character or oversized CLI paths', async (candidate) => {
		vi.mocked(resolveBundledCliPathSync).mockReturnValue(candidate);
		await expect(inspectTokenProxyRecoveryHost(localPlan(), effectiveEnv)).resolves.toBeNull();
	});

	it.each(['archive', 'discovery', 'cli'])(
		'refuses a missing %s without creating or repairing it',
		async (missing) => {
			const target =
				missing === 'archive' ? archivePath : missing === 'cli' ? cliPath : discoveryPath;
			fs.rmSync(target, { recursive: true });
			await expect(inspectTokenProxyRecoveryHost(localPlan(), effectiveEnv)).resolves.toBeNull();
			expect(fs.existsSync(target)).toBe(false);
		}
	);

	it('rejects a directory masquerading as the CLI script', async () => {
		fs.unlinkSync(cliPath);
		fs.mkdirSync(cliPath);
		await expect(inspectTokenProxyRecoveryHost(localPlan(), effectiveEnv)).resolves.toBeNull();
	});

	it.each(['archive', 'discovery'])(
		'refuses a %s symlink escaping the data namespace',
		async (entry) => {
			const target = entry === 'archive' ? archivePath : discoveryPath;
			const outside = `${root}-outside`;
			try {
				fs.mkdirSync(outside);
				fs.writeFileSync(path.join(outside, 'cli-server.json'), JSON.stringify(bridge));
				fs.rmSync(target, { recursive: true });
				fs.symlinkSync(
					entry === 'archive' ? outside : path.join(outside, 'cli-server.json'),
					target
				);
				await expect(inspectTokenProxyRecoveryHost(localPlan(), effectiveEnv)).resolves.toBeNull();
			} finally {
				fs.rmSync(outside, { recursive: true, force: true });
			}
		}
	);

	it.each([
		{ pid: process.pid + 1 },
		{ port: 0 },
		{ port: 65536 },
		{ port: 1.5 },
		{ startedAt: 0 },
		{ startedAt: -1 },
		{ startedAt: 1.5 },
		{ token: '' },
	])('refuses bridge discovery without current host ownership: %j', async (invalid) => {
		fs.writeFileSync(discoveryPath, JSON.stringify({ ...bridge, ...invalid }));
		await expect(inspectTokenProxyRecoveryHost(localPlan(), effectiveEnv)).resolves.toBeNull();
	});

	it('refuses an unreadable or unexecutable runtime without running it', async () => {
		const access = fs.promises.access;
		const runtime = fs.realpathSync(process.execPath);
		vi.spyOn(fs.promises, 'access').mockImplementation(async (target, mode) => {
			if (target === runtime)
				throw Object.assign(new Error('fixture permission failure'), { code: 'EACCES' });
			return access(target, mode);
		});
		await expect(inspectTokenProxyRecoveryHost(localPlan(), effectiveEnv)).resolves.toBeNull();
	});

	it('rejects a CLI replaced between filesystem snapshots', async () => {
		const replacement = path.join(root, 'replacement.js');
		fs.writeFileSync(replacement, '// replacement fixture');
		const access = fs.promises.access;
		let replaced = false;
		vi.spyOn(fs.promises, 'access').mockImplementation(async (target, mode) => {
			if (target === cliPath && !replaced) {
				replaced = true;
				fs.renameSync(replacement, cliPath);
			}
			return access(target, mode);
		});
		await expect(inspectTokenProxyRecoveryHost(localPlan(), effectiveEnv)).resolves.toBeNull();
	});

	it('rejects a bundled script whose resolved name is not the supported CLI', async () => {
		const target = path.join(root, 'other-script.js');
		fs.renameSync(cliPath, target);
		fs.symlinkSync(target, cliPath);
		await expect(inspectTokenProxyRecoveryHost(localPlan(), effectiveEnv)).resolves.toBeNull();
	});

	it('rejects an archive link retargeted during inspection within the same data directory', async () => {
		const original = path.join(root, 'original archive');
		const replacement = path.join(root, 'replacement archive');
		fs.renameSync(archivePath, original);
		fs.mkdirSync(replacement);
		fs.symlinkSync(original, archivePath);
		const access = fs.promises.access;
		let changed = false;
		vi.spyOn(fs.promises, 'access').mockImplementation(async (target, mode) => {
			if (!changed) {
				changed = true;
				fs.unlinkSync(archivePath);
				fs.symlinkSync(replacement, archivePath);
			}
			return access(target, mode);
		});
		await expect(inspectTokenProxyRecoveryHost(localPlan(), effectiveEnv)).resolves.toBeNull();
	});

	it('refuses a bridge changed after discovery even if its replacement remains readable', async () => {
		const access = fs.promises.access;
		let changed = false;
		vi.spyOn(fs.promises, 'access').mockImplementation(async (target, mode) => {
			if (!changed) {
				changed = true;
				fs.writeFileSync(discoveryPath, JSON.stringify({ ...bridge, token: 'replacement-token' }));
			}
			return access(target, mode);
		});
		await expect(inspectTokenProxyRecoveryHost(localPlan(), effectiveEnv)).resolves.toBeNull();
	});

	it('refuses namespace or bundled resolver changes during the inspection', async () => {
		vi.mocked(localModelsDataDir).mockReturnValueOnce(root).mockReturnValue(`${root}-other`);
		await expect(inspectTokenProxyRecoveryHost(localPlan(), effectiveEnv)).resolves.toBeNull();
		vi.mocked(localModelsDataDir).mockReturnValue(root);
		vi.mocked(resolveBundledCliPathSync)
			.mockReturnValueOnce(cliPath)
			.mockReturnValue(`${root}/other/maestro-cli.js`);
		await expect(inspectTokenProxyRecoveryHost(localPlan(), effectiveEnv)).resolves.toBeNull();
	});
});
