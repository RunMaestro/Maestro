import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import * as nativeFs from 'fs';
import path from 'path';
import type { ExecResult } from '../../../main/utils/execFile';

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
vi.mock('../../../shared/pathUtils', () => ({ buildExpandedEnv: vi.fn() }));
vi.mock('../../../shared/platformDetection', () => ({
	getWhichCommand: vi.fn(),
	isWindows: vi.fn(),
}));
import { execFileNoThrow } from '../../../main/utils/execFile';
import { execFileNoThrow as libraryExec } from '../../../shared/maestro-lib/launch/exec-file';
import { buildExpandedEnv } from '../../../shared/pathUtils';
import { getWhichCommand, isWindows } from '../../../shared/platformDetection';

describe('desktop SSH binary discovery activity', () => {
	const target = path.resolve('ssh-detection-target');
	const env = { PATH: '/custom/bin' };
	const found = { stdout: '/path with spaces/ssh\r\n/second/ssh\n', stderr: '', exitCode: 0 };
	const absent = { stdout: '', stderr: 'not found', exitCode: 1 };
	let gate: typeof import('../../../main/git/worktreeActivity');
	let cli: typeof import('../../../main/utils/cliDetection');
	let core: typeof import('../../../shared/maestro-lib/launch/ssh-path');
	let natives: Array<{
		child: EventEmitter;
		result: ReturnType<typeof Promise.withResolvers<ExecResult>>;
	}>;
	let releases: Array<() => void>;
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
		natives = [];
		releases = [];
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
		cli = await import('../../../main/utils/cliDetection');
		core = await import('../../../shared/maestro-lib/launch/ssh-path');
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

	describe.each(['detectSshPath', 'resolveSshPath'] as const)('%s', (method) => {
		const request = () => cli[method]();
		it.each([target, path.join(target, 'descendant'), path.resolve('other-repository')])(
			'refuses before shared cache/platform/environment/fallback setup under %s',
			async (root) => {
				await reserve(root);
				await expect(request()).rejects.toThrow(/reserved/);
				for (const work of [
					getWhichCommand,
					buildExpandedEnv,
					isWindows,
					nativeFs.existsSync,
					execFileNoThrow,
					libraryExec,
				]) {
					expect(work).not.toHaveBeenCalled();
				}
			}
		);
		it('admits synchronously during pending reservation canonicalization', async () => {
			const canonical = Promise.withResolvers<string>();
			vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
			const reservation = gate.reserveWorktreeCleanup(target);
			const pending = request();
			canonical.resolve(target);
			await expect(reservation).resolves.toMatchObject({ status: 'blocked' });
			natives[0].result.resolve(found);
			await expect(pending).resolves.toBe('/path with spaces/ssh');
			await blocked();
			natives[0].child.emit('close');
			await reserve();
		});
		it.each(['result', 'error', 'exit', 'timeout', 'rejection'])(
			'does not mistake %s for native close',
			async (event) => {
				const pending = request();
				if (event === 'error') natives[0].child.emit('error', new Error('native failed'));
				if (event === 'exit') natives[0].child.emit('exit', 1);
				if (event === 'rejection') {
					natives[0].result.reject(new Error('executor failed'));
					await expect(pending).rejects.toThrow('executor failed');
				} else {
					natives[0].result.resolve(event === 'timeout' ? absent : found);
					await expect(pending).resolves.toBe(
						event === 'timeout'
							? method === 'detectSshPath'
								? null
								: 'ssh'
							: '/path with spaces/ssh'
					);
				}
				await blocked();
				natives[0].child.emit('close');
				await reserve();
			}
		);
		it('retains request processing when close precedes the result', async () => {
			const pending = request();
			natives[0].child.emit('close');
			await blocked();
			natives[0].result.resolve(found);
			await expect(pending).resolves.toBe('/path with spaces/ssh');
			await reserve();
		});
		it.each([true, false])('refuses shared cached results, installed=%s', async (installed) => {
			vi.mocked(libraryExec).mockResolvedValueOnce(installed ? found : absent);
			await core.detectSshPath();
			await expect(request()).resolves.toBe(
				installed ? '/path with spaces/ssh' : method === 'detectSshPath' ? null : 'ssh'
			);
			await reserve();
			await expect(request()).rejects.toThrow(/reserved/);
			expect(execFileNoThrow).not.toHaveBeenCalled();
			expect(libraryExec).toHaveBeenCalledTimes(1);
		});
	});

	it.each(['which', 'where'] as const)(
		'preserves %s argv, bare environment and shared cache',
		async (command) => {
			vi.mocked(getWhichCommand).mockReturnValue(command);
			const pending = cli.resolveSshPath();
			expect(execFileNoThrow).toHaveBeenCalledWith(
				command,
				['ssh'],
				undefined,
				env,
				expect.any(Function)
			);
			natives[0].result.resolve(found);
			natives[0].child.emit('close');
			await expect(pending).resolves.toBe('/path with spaces/ssh');
			await expect(core.resolveSshPath()).resolves.toBe('/path with spaces/ssh');
			expect(libraryExec).not.toHaveBeenCalled();
			await reserve();
		}
	);
	it('keeps concurrent native generations independent of shared cache and duplicate close', async () => {
		const requests = [cli.detectSshPath(), cli.resolveSshPath()];
		natives[0].result.resolve(found);
		natives[1].result.resolve(found);
		await Promise.all(requests);
		await cli.resolveSshPath();
		expect(natives).toHaveLength(2);
		natives[0].child.emit('close');
		natives[0].child.emit('close');
		await blocked();
		natives[1].child.emit('close');
		await reserve();
	});
	it.each(['present', 'absent', 'throws'])(
		'retains Windows OpenSSH fallback after close: %s',
		async (state) => {
			vi.stubEnv('SystemRoot', 'C:\\Windows root');
			vi.mocked(isWindows).mockReturnValue(true);
			vi.mocked(nativeFs.existsSync).mockImplementation(() => {
				if (state === 'throws') throw new Error('access failed');
				return state === 'present';
			});
			const pending = cli.resolveSshPath();
			natives[0].child.emit('close');
			natives[0].result.resolve(absent);
			await blocked();
			const fallback = path.join('C:\\Windows root', 'System32', 'OpenSSH', 'ssh.exe');
			await expect(pending).resolves.toBe(state === 'present' ? fallback : 'ssh');
			expect(nativeFs.existsSync).toHaveBeenCalledWith(fallback);
			await reserve();
		}
	);
	it('preserves setup failure, releases pre-launch work and permits retry', async () => {
		vi.mocked(buildExpandedEnv).mockImplementationOnce(() => {
			throw new Error('env failed');
		});
		await expect(cli.detectSshPath()).rejects.toThrow('env failed');
		expect(execFileNoThrow).not.toHaveBeenCalled();
		const hold = await reserve();
		hold.release();
		const pending = cli.resolveSshPath();
		natives[0].result.resolve(found);
		natives[0].child.emit('close');
		await expect(pending).resolves.toBe('/path with spaces/ssh');
		await reserve();
	});
	it('retains a rejected native attempt independently of a successful retry', async () => {
		const first = cli.detectSshPath();
		natives[0].result.reject(new Error('probe failed'));
		await expect(first).rejects.toThrow('probe failed');
		const retry = cli.resolveSshPath();
		natives[1].result.resolve(found);
		natives[1].child.emit('close');
		await expect(retry).resolves.toBe('/path with spaces/ssh');
		await blocked();
		natives[0].child.emit('close');
		await reserve();
	});
	it.each(['unknown launch', 'missing observer', 'missing child', 'failed observer'])(
		'keeps %s blocked',
		async (failure) => {
			vi.mocked(execFileNoThrow).mockImplementationOnce((_cmd, _args, _cwd, _opts, observe) => {
				if (failure === 'unknown launch') throw new Error(failure);
				if (failure === 'missing observer') return Promise.resolve(found);
				const child = failure === 'missing child' ? undefined : new EventEmitter();
				if (child)
					vi.spyOn(child, 'once').mockImplementationOnce(() => {
						throw new Error(failure);
					});
				observe?.(child as Parameters<NonNullable<typeof observe>>[0]);
				return Promise.resolve(found);
			});
			if (failure === 'missing observer')
				await expect(cli.resolveSshPath()).resolves.toBe('/path with spaces/ssh');
			else await expect(cli.resolveSshPath()).rejects.toThrow();
			await blocked();
		}
	);
	it('preserves the uninstrumented library default executor and cached failure', async () => {
		vi.mocked(libraryExec).mockResolvedValueOnce(absent);
		await expect(core.resolveSshPath()).resolves.toBe('ssh');
		await expect(core.detectSshPath()).resolves.toBeNull();
		expect(libraryExec).toHaveBeenCalledExactlyOnceWith('which', ['ssh'], undefined, env);
		expect(execFileNoThrow).not.toHaveBeenCalled();
		await reserve();
	});
});
