import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import * as nativeFs from 'fs';
import path from 'path';
import type { ExecResult } from '../../../main/utils/execFile';
import type { SshRemoteConfig } from '../../../shared/types';

vi.mock('fs/promises', async (original) => {
	const actual = await original<typeof import('fs/promises')>();
	return { ...actual, default: { ...actual, realpath: vi.fn() } };
});
vi.mock('fs', async (original) => ({
	...(await original<typeof import('fs')>()),
	existsSync: vi.fn(),
}));
vi.mock('../../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../../shared/maestro-lib/launch/exec-file', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../../shared/pathUtils', async (original) => ({
	...(await original<typeof import('../../../shared/pathUtils')>()),
	buildExpandedEnv: vi.fn(),
}));
vi.mock('../../../shared/platformDetection', async (original) => ({
	...(await original<typeof import('../../../shared/platformDetection')>()),
	getWhichCommand: vi.fn(),
	isWindows: vi.fn(),
}));
import { execFileNoThrow } from '../../../main/utils/execFile';
import { execFileNoThrow as libraryExec } from '../../../shared/maestro-lib/launch/exec-file';
import { buildExpandedEnv } from '../../../shared/pathUtils';
import { getWhichCommand, isWindows } from '../../../shared/platformDetection';

describe('desktop SSH command construction activity', () => {
	const target = path.resolve('ssh-builder-target');
	const env = { PATH: '/custom/bin' };
	const found = { stdout: '/path with spaces/ssh\r\n/second/ssh\n', stderr: '', exitCode: 0 };
	const absent = { stdout: '', stderr: 'not found', exitCode: 1 };
	const config: SshRemoteConfig = {
		id: 'remote',
		name: 'Remote',
		host: 'example.invalid',
		port: 2222,
		username: 'worker',
		privateKeyPath: '',
		enabled: true,
		sshOptions: { ConnectTimeout: '7' },
	};
	const options = {
		command: 'claude',
		args: ['--print', 'hello'],
		cwd: '~/remote project',
		env: { TASK: 'a b' },
	};
	let gate: typeof import('../../../main/git/worktreeActivity');
	let desktop: typeof import('../../../main/utils/ssh-command-builder');
	let core: typeof import('../../../shared/maestro-lib/launch/ssh-command-builder');
	let releases: Array<() => void>;
	let natives: Array<{
		child: EventEmitter;
		result: ReturnType<typeof Promise.withResolvers<ExecResult>>;
	}>;
	const drain = () => new Promise(setImmediate);
	async function reserve(root = target) {
		const hold = await gate.reserveWorktreeCleanup(root);
		if (hold.status === 'reserved-partially') releases.push(hold.release);
		expect(hold.status).toBe('reserved-partially');
		if (hold.status !== 'reserved-partially') throw new Error('Expected partial reservation');
		expect(hold.blockers.map((b) => b.message).join(' ')).toMatch(/native.*registration.*OS/);
		return hold;
	}
	async function blocked() {
		const hold = await gate.reserveWorktreeCleanup(target);
		if (hold.status === 'reserved-partially') releases.push(hold.release);
		expect(hold).toMatchObject({ status: 'blocked', blockers: [{ code: 'mutation-busy' }] });
	}
	beforeEach(async () => {
		vi.resetModules();
		vi.mocked(fs.realpath)
			.mockReset()
			.mockImplementation(async (p) => String(p));
		vi.mocked(nativeFs.existsSync).mockReset().mockReturnValue(false);
		vi.mocked(buildExpandedEnv).mockReset().mockReturnValue(env);
		vi.mocked(getWhichCommand).mockReset().mockReturnValue('which');
		vi.mocked(isWindows).mockReset().mockReturnValue(false);
		vi.mocked(libraryExec).mockReset().mockResolvedValue(found);
		releases = [];
		natives = [];
		vi.mocked(execFileNoThrow)
			.mockReset()
			.mockImplementation((_cmd, _args, _cwd, _opts, observe) => {
				const child = new EventEmitter();
				child.on('error', () => {});
				const result = Promise.withResolvers<ExecResult>();
				natives.push({ child, result });
				observe?.(child as Parameters<NonNullable<typeof observe>>[0]);
				return result.promise;
			});
		gate = await import('../../../main/git/worktreeActivity');
		desktop = await import('../../../main/utils/ssh-command-builder');
		core = await import('../../../shared/maestro-lib/launch/ssh-command-builder');
	});
	afterEach(async () => {
		for (const release of releases) release();
		for (const native of natives) {
			native.result.resolve(found);
			native.child.emit('close');
		}
		await drain();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	describe.each(['buildSshCommand', 'buildSshCommandWithStdin'] as const)('%s', (method) => {
		const request = () => desktop[method](config, options);
		it.each([target, path.join(target, 'descendant'), path.resolve('other-repository')])(
			'refuses before configuration, resolution or recovery under %s',
			async (root) => {
				await reserve(root);
				const read = vi.fn(() => {
					throw new Error('Must not read configuration');
				});
				const guarded = new Proxy(config, { get: read });
				await expect(desktop[method](guarded, options)).rejects.toThrow(/reserved/);
				for (const work of [
					read,
					execFileNoThrow,
					libraryExec,
					buildExpandedEnv,
					getWhichCommand,
					nativeFs.existsSync,
				]) {
					expect(work).not.toHaveBeenCalled();
				}
			}
		);
		it('admits synchronously while reservation canonicalization is pending', async () => {
			const canonical = Promise.withResolvers<string>();
			vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
			const reservation = gate.reserveWorktreeCleanup(target);
			const pending = request();
			canonical.resolve(target);
			await expect(reservation).resolves.toMatchObject({ status: 'blocked' });
			natives[0].result.resolve(found);
			await pending;
			await blocked();
			natives[0].child.emit('close');
			await reserve();
		});
		it.each(['result', 'error', 'exit', 'timeout', 'rejection'])(
			'retains native ownership after %s settles the builder',
			async (event) => {
				const pending = request();
				if (event === 'error') natives[0].child.emit('error', new Error('native failed'));
				if (event === 'exit') natives[0].child.emit('exit', 1);
				if (event === 'rejection') {
					natives[0].result.reject(new Error('executor rejected'));
					await expect(pending).rejects.toThrow('executor rejected');
				} else {
					natives[0].result.resolve(event === 'timeout' ? absent : found);
					await expect(pending).resolves.toMatchObject({
						command: event === 'timeout' ? 'ssh' : '/path with spaces/ssh',
					});
				}
				await blocked();
				natives[0].child.emit('close');
				await reserve();
			}
		);
		it('retains setup after native close until discovery and assembly settle', async () => {
			const pending = request();
			natives[0].child.emit('close');
			await blocked();
			natives[0].result.resolve(found);
			await pending;
			await reserve();
		});
		it('preserves library output and shared discovery cache without losing an older child', async () => {
			const pending = request();
			expect(execFileNoThrow).toHaveBeenCalledWith(
				'which',
				['ssh'],
				undefined,
				env,
				expect.any(Function)
			);
			natives[0].result.resolve(found);
			const result = await pending;
			await expect(
				core[method](config, options, async () => '/path with spaces/ssh')
			).resolves.toEqual(result);
			await expect(request()).resolves.toEqual(result);
			expect(execFileNoThrow).toHaveBeenCalledTimes(1);
			expect(libraryExec).not.toHaveBeenCalled();
			await blocked();
			natives[0].child.emit('close');
			const hold = await reserve();
			await expect(request()).rejects.toThrow(/reserved/);
			hold.release();
			await expect(request()).resolves.toEqual(result);
		});
		it('keeps concurrent native generations independent of duplicate close', async () => {
			const first = request();
			const second = request();
			natives[0].result.resolve(found);
			natives[1].result.resolve(found);
			await Promise.all([first, second]);
			natives[0].child.emit('close');
			natives[0].child.emit('close');
			await blocked();
			natives[1].child.emit('close');
			await reserve();
		});
		it('releases a pre-native setup failure and allows a retry', async () => {
			vi.mocked(buildExpandedEnv).mockImplementationOnce(() => {
				throw new Error('environment failed');
			});
			await expect(request()).rejects.toThrow('environment failed');
			expect(execFileNoThrow).not.toHaveBeenCalled();
			(await reserve()).release();
			const retry = request();
			natives[0].result.resolve(found);
			natives[0].child.emit('close');
			await retry;
			await reserve();
		});
		it('retains an early-result native child even if later command assembly throws', async () => {
			const badConfig = new Proxy(config, {
				get: () => {
					throw new Error('config failed');
				},
			});
			const pending = desktop[method](badConfig, options);
			natives[0].result.resolve(found);
			await expect(pending).rejects.toThrow('config failed');
			await blocked();
			natives[0].child.emit('close');
			await reserve();
		});
		it('uses Windows where and OpenSSH fallback without releasing the unresolved child', async () => {
			vi.mocked(getWhichCommand).mockReturnValue('where');
			vi.mocked(isWindows).mockReturnValue(true);
			vi.stubEnv('SystemRoot', 'C:\\TaskWindows');
			vi.mocked(nativeFs.existsSync).mockReturnValue(true);
			const pending = request();
			natives[0].result.resolve(absent);
			await expect(pending).resolves.toMatchObject({
				command: path.join('C:\\TaskWindows', 'System32', 'OpenSSH', 'ssh.exe'),
			});
			expect(execFileNoThrow).toHaveBeenCalledWith(
				'where',
				['ssh'],
				undefined,
				env,
				expect.any(Function)
			);
			await blocked();
			natives[0].child.emit('close');
			await reserve();
		});
	});

	it.each(['missing observer', 'launch exception', 'failed observation'])(
		'fails closed for %s',
		async (failure) => {
			vi.mocked(execFileNoThrow).mockImplementation((_cmd, _args, _cwd, _opts, observe) => {
				if (failure === 'launch exception') throw new Error('unknown launch');
				if (failure === 'failed observation')
					observe?.({
						once: () => {
							throw new Error('observer failed');
						},
					} as never);
				return Promise.resolve(found);
			});
			const pending = desktop.buildSshCommand(config, options);
			if (failure === 'missing observer') await pending;
			else await expect(pending).rejects.toThrow(/unknown launch|observer failed/);
			await blocked();
		}
	);
	it('keeps default library discovery independent of desktop admission', async () => {
		await reserve();
		await expect(core.buildSshCommand(config, options)).resolves.toMatchObject({
			command: '/path with spaces/ssh',
		});
		await expect(core.buildSshCommandWithStdin(config, options)).resolves.toMatchObject({
			command: '/path with spaces/ssh',
		});
		expect(libraryExec).toHaveBeenCalledTimes(1);
		expect(execFileNoThrow).not.toHaveBeenCalled();
		await expect(desktop.buildSshCommand(config, options)).rejects.toThrow(/reserved/);
	});
});
