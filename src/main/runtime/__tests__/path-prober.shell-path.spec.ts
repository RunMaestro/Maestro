import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import * as nativeFs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { isWindows } from '../../../shared/platformDetection';

vi.mock('fs/promises', async (original) => {
	const actual = await original<typeof import('fs/promises')>();
	return { ...actual, default: { ...actual, realpath: vi.fn() } };
});
vi.mock('child_process', async (original) => ({
	...(await original<typeof import('child_process')>()),
	spawn: vi.fn(),
}));
vi.mock('../../../shared/platformDetection', async (original) => ({
	...(await original<typeof import('../../../shared/platformDetection')>()),
	isWindows: vi.fn(() => false),
}));

vi.mock('../../../shared/maestro-lib/launch/exec-file', () => ({
	execFileNoThrow: vi.fn(),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { getExpandedEnvWithShell, checkBinaryExists } from '../../../main/agents/path-prober';
import * as shellPathCore from '../../../shared/maestro-lib/launch/getShellPath';
import { execFileNoThrow } from '../../../main/utils/execFile';

describe('path-prober shell path integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(shellPathCore, 'getShellPath');
		// Force the which fallback independently of the host's installed binaries.
		vi.spyOn(nativeFs.promises, 'access').mockRejectedValue(new Error('not installed'));
	});
	afterEach(() => vi.restoreAllMocks());

	it('should include shell PATH entries and prefer them when resolving with which', async () => {
		// Stub shell path to include a custom bin
		vi.mocked(shellPathCore.getShellPath).mockResolvedValue('/tmp/custom/bin');

		const env = await getExpandedEnvWithShell();
		expect(env.PATH).toContain('/tmp/custom/bin');

		// Simulate which finding binary in shell path
		vi.mocked(execFileNoThrow).mockResolvedValue({
			exitCode: 0,
			stdout: '/tmp/custom/bin/node\n',
			stderr: '',
		});

		const result = await checkBinaryExists('node');
		expect(result.exists).toBe(true);
		expect(result.path).toBe('/tmp/custom/bin/node');
	});

	it('falls back to base PATH when getShellPath rejects and checkBinaryExists uses base PATH', async () => {
		// Simulate shell probe failing
		vi.mocked(shellPathCore.getShellPath).mockRejectedValue(new Error('fail'));

		const env = await getExpandedEnvWithShell();
		// Should still return an env with a PATH (the base expanded PATH)
		expect(env.PATH).toBeDefined();
		expect((env.PATH ?? '').length).toBeGreaterThan(0);

		// Simulate which/where finding binary in base PATH
		vi.mocked(execFileNoThrow).mockResolvedValue({
			exitCode: 0,
			stdout: '/usr/bin/node\n',
			stderr: '',
		});

		const result = await checkBinaryExists('node');
		expect(result.exists).toBe(true);
		expect(result.path).toBe('/usr/bin/node');
	});
});

describe('desktop login-shell PATH activity', () => {
	const target = path.resolve('shell-path-target');
	let gate: typeof import('../../git/worktreeActivity');
	let desktop: typeof import('../getShellPath');
	let core: typeof import('../../../shared/maestro-lib/launch/getShellPath');
	let children: Array<
		EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> }
	>;
	let releases: Array<() => void>;
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
	function close(index = 0, code = 0, output = '/login/bin') {
		children[index].stdout.emit('data', Buffer.from(output));
		children[index].emit('close', code);
	}
	beforeEach(async () => {
		vi.resetModules();
		vi.useFakeTimers();
		vi.stubEnv('SHELL', '/bin/bash');
		vi.mocked(fs.realpath)
			.mockReset()
			.mockImplementation(async (p) => String(p));
		vi.mocked(isWindows).mockReset().mockReturnValue(false);
		children = [];
		releases = [];
		vi.mocked(spawn)
			.mockReset()
			.mockImplementation(() => {
				const child = Object.assign(new EventEmitter(), {
					stdout: new EventEmitter(),
					stderr: new EventEmitter(),
					kill: vi.fn(),
				});
				children.push(child);
				return child as unknown as ReturnType<typeof spawn>;
			});
		gate = await import('../../git/worktreeActivity');
		desktop = await import('../getShellPath');
		core = await import('../../../shared/maestro-lib/launch/getShellPath');
	});
	afterEach(async () => {
		for (const release of releases) release();
		for (let i = 0; i < children.length; i++) close(i);
		vi.useRealTimers();
		await new Promise(setImmediate);
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it('retains a path-prober fallback shell until native close after timeout', async () => {
		const prober = await import('../../agents/path-prober');
		const pending = prober.getExpandedEnvWithShell();
		expect(spawn).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(2000);
		expect((await pending).PATH).toBeTruthy();
		expect(children[0].kill).toHaveBeenCalled();
		children[0].emit('error', new Error('late error'));
		children[0].emit('exit', 1);
		await blocked();
		close();
		await reserve();
	});

	describe.each(['getShellPath', 'refreshShellPath'] as const)('%s', (method) => {
		const request = () => desktop[method]();
		it.each([target, path.join(target, 'child'), path.resolve('other-repository')])(
			'refuses before setup or recovery under %s',
			async (root) => {
				await reserve(root);
				await expect(request()).rejects.toThrow('reserved');
				expect(isWindows).not.toHaveBeenCalled();
				expect(spawn).not.toHaveBeenCalled();
			}
		);
		it('admits before pending reservation canonicalization completes', async () => {
			const canonical = Promise.withResolvers<string>();
			vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
			const reservation = gate.reserveWorktreeCleanup(target);
			const pending = request();
			canonical.resolve(target);
			await expect(reservation).resolves.toMatchObject({ status: 'blocked' });
			close();
			await expect(pending).resolves.toBe('/login/bin');
			await reserve();
		});
		it('refuses a shared cached result before platform setup', async () => {
			const warm = core.getShellPath();
			close();
			await warm;
			vi.mocked(isWindows).mockClear();
			vi.mocked(spawn).mockClear();
			await reserve();
			const pending = request();
			// Settle an unexpected probe so regressions fail without a test timeout.
			if (children[1]) close(1);
			await expect(pending).rejects.toThrow('reserved');
			expect(isWindows).not.toHaveBeenCalled();
			expect(spawn).not.toHaveBeenCalled();
			expect(desktop.peekShellPath()).toBe('/login/bin');
		});
		it('retains the native shell after timeout and kill delivery', async () => {
			const pending = request();
			const failure = expect(pending).rejects.toThrow('Timed out reading shell PATH');
			await vi.advanceTimersByTimeAsync(2000);
			await failure;
			expect(children[0].kill).toHaveBeenCalledOnce();
			await blocked();
			children[0].emit('exit', 0);
			await blocked();
			close();
			await reserve();
		});
		it('retains native ownership after error and independent retry settlement', async () => {
			const pending = request();
			children[0].emit('error', new Error('native failure'));
			await expect(pending).rejects.toThrow('native failure');
			const retry = request();
			close(1);
			await retry;
			children[1].emit('close', 0);
			await blocked();
			close();
			await reserve();
		});
		it('does not release concurrent requests or native work on cache invalidation', async () => {
			const first = request();
			const joined = request();
			expect(spawn).toHaveBeenCalledOnce();
			core.clearShellPathCache();
			const next = request();
			expect(spawn).toHaveBeenCalledTimes(2);
			close();
			await Promise.all([first, joined]);
			await blocked();
			close(1);
			await next;
			await reserve();
		});
		it('retains request processing if close precedes its continuations', async () => {
			const processing = Promise.withResolvers<void>();
			const original = core[method];
			vi.spyOn(core, method).mockImplementation(async (...args) => {
				const result = await original(...args);
				await processing.promise;
				return result;
			});
			const pending = request();
			close();
			await blocked();
			processing.resolve();
			await pending;
			await reserve();
		});
		it('preserves Windows fallback without launching a shell', async () => {
			vi.mocked(isWindows).mockReturnValue(true);
			vi.stubEnv('PATH', '/windows/path');
			await expect(request()).resolves.toBe('/windows/path');
			expect(spawn).not.toHaveBeenCalled();
			await reserve();
		});
		it('releases setup failure before any native launch', async () => {
			vi.mocked(isWindows).mockImplementation(() => {
				throw new Error('platform failed');
			});
			await expect(request()).rejects.toThrow('platform failed');
			expect(spawn).not.toHaveBeenCalled();
			await reserve();
		});
		it.each(['throw', 'missing-child', 'observer-failure'])(
			'keeps unknown native observation busy: %s',
			async (failure) => {
				vi.mocked(spawn).mockImplementationOnce(() => {
					if (failure === 'throw') throw new Error('unknown launch');
					if (failure === 'missing-child') return undefined as unknown as ReturnType<typeof spawn>;
					const child = new EventEmitter();
					vi.spyOn(child, 'once').mockImplementation(() => {
						throw new Error('observer failed');
					});
					return child as ReturnType<typeof spawn>;
				});
				await expect(request()).rejects.toThrow();
				await blocked();
			}
		);
	});

	it.each(['/bin/bash', '/bin/zsh'])(
		'preserves library/default argv, stdio and shared cache for %s',
		async (shell) => {
			vi.stubEnv('SHELL', shell);
			const pending = desktop.default();
			expect(spawn).toHaveBeenCalledWith(
				shell,
				shell.endsWith('zsh')
					? ['-l', '-i', '-c', 'printf "%s" "$PATH"']
					: ['-l', '-c', 'printf "%s" "$PATH"'],
				{ stdio: ['ignore', 'pipe', 'pipe'] }
			);
			close(0, 0, '  /first/bin:/second/bin\n');
			await expect(pending).resolves.toBe('/first/bin:/second/bin');
			await expect(core.getShellPath()).resolves.toBe('/first/bin:/second/bin');
			expect(spawn).toHaveBeenCalledOnce();
			core.clearShellPathCache();
			const library = core.refreshShellPath();
			close(1);
			await expect(library).resolves.toBe('/login/bin');
			await reserve();
		}
	);
	it('preserves empty output, failed-exit stderr and retry results', async () => {
		const empty = desktop.getShellPath();
		close(0, 0, '');
		await expect(empty).resolves.toBe('');
		const failed = desktop.getShellPath();
		children[1].stderr.emit('data', Buffer.from('shell init failed'));
		close(1, 2, '');
		await expect(failed).rejects.toThrow('shell init failed');
		const retry = desktop.getShellPath();
		close(2);
		await expect(retry).resolves.toBe('/login/bin');
		await reserve();
	});
	it('preserves the default bash shell when SHELL is absent', async () => {
		vi.stubEnv('SHELL', undefined);
		const pending = desktop.getShellPath();
		expect(spawn).toHaveBeenCalledWith('/bin/bash', expect.any(Array), {
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		close();
		await pending;
		await reserve();
	});
	it('preserves empty Windows fallback when PATH is absent', async () => {
		vi.mocked(isWindows).mockReturnValue(true);
		vi.stubEnv('PATH', undefined);
		await expect(desktop.getShellPath()).resolves.toBe('');
		expect(spawn).not.toHaveBeenCalled();
		await reserve();
	});
	it('preserves nonzero exit failure without stderr', async () => {
		const pending = desktop.getShellPath();
		close(0, 3, '');
		await expect(pending).rejects.toThrow('Shell exited with code 3');
		await reserve();
	});
	it('keeps native ownership when timeout signalling throws', async () => {
		const pending = desktop.getShellPath();
		children[0].kill.mockImplementation(() => {
			throw new Error('kill failed');
		});
		const failure = expect(pending).rejects.toThrow('Timed out reading shell PATH');
		await vi.advanceTimersByTimeAsync(2000);
		await failure;
		await blocked();
		close();
		await reserve();
	});
});
