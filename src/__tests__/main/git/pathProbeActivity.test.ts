import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import * as nativeFs from 'fs';
import * as os from 'os';
import path from 'path';
import type { ExecResult } from '../../../main/utils/execFile';

vi.mock('os', async (original) => {
	const actual = await original<typeof import('os')>();
	return { ...actual, homedir: vi.fn(actual.homedir) };
});
vi.mock('fs/promises', async (original) => {
	const actual = await original<typeof import('fs/promises')>();
	return { ...actual, default: { ...actual, realpath: vi.fn() } };
});
vi.mock('../../../shared/maestro-lib/launch/exec-file', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../../shared/maestro-lib/launch/getShellPath', () => ({ getShellPath: vi.fn() }));
vi.mock('../../../shared/platformDetection', async (original) => ({
	...(await original<typeof import('../../../shared/platformDetection')>()),
	isWindows: vi.fn(() => false),
	getWhichCommand: vi.fn(() => 'which'),
}));
vi.mock('../../../shared/maestro-lib/host', async (original) => ({
	...(await original<typeof import('../../../shared/maestro-lib/host')>()),
	captureException: vi.fn(),
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import { execFileNoThrow } from '../../../main/utils/execFile';
import { getShellPath } from '../../../shared/maestro-lib/launch/getShellPath';
import { captureException } from '../../../shared/maestro-lib/host';
import { isWindows, getWhichCommand } from '../../../shared/platformDetection';

describe('desktop binary path probe activity', () => {
	const target = path.resolve('binary-probe-target');
	const found = { stdout: '/custom/probe\n/custom/alias\n', stderr: '', exitCode: 0 };
	let gate: typeof import('../../../main/git/worktreeActivity');
	let desktop: typeof import('../../../main/agents/path-prober');
	let core: typeof import('../../../shared/maestro-lib/launch/path-prober');
	let releases: Array<() => void> = [];
	let natives: Array<{
		child: EventEmitter;
		result: ReturnType<typeof Promise.withResolvers<ExecResult>>;
	}> = [];
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
		vi.spyOn(nativeFs.promises, 'access').mockRejectedValue(new Error('not installed'));
		vi.spyOn(nativeFs.promises, 'realpath').mockImplementation(async (p) => String(p));
		vi.mocked(os.homedir).mockClear();
		vi.mocked(isWindows).mockReset().mockReturnValue(false);
		vi.mocked(getWhichCommand).mockReset().mockReturnValue('which');
		vi.mocked(getShellPath).mockReset().mockResolvedValue('/custom:/custom:/other');
		vi.mocked(captureException).mockReset().mockResolvedValue();
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
		desktop = await import('../../../main/agents/path-prober');
		core = await import('../../../shared/maestro-lib/launch/path-prober');
	});
	afterEach(async () => {
		for (const release of releases) release();
		for (const native of natives) {
			native.result.resolve(found);
			native.child.emit('close');
		}
		await drain();
		vi.restoreAllMocks();
	});

	describe.each(['getExpandedEnvWithShell', 'checkBinaryExists', 'findAllBinaryPaths'] as const)(
		'%s',
		(method) => {
			const request = () => desktop[method]('unknown-probe');
			it.each([target, path.join(target, 'descendant'), path.resolve('other-repository')])(
				'refuses before shared setup or recovery under %s',
				async (root) => {
					await reserve(root);
					await expect(request()).rejects.toThrow(/reserved/);
					for (const work of [
						os.homedir,
						nativeFs.promises.access,
						isWindows,
						getShellPath,
						execFileNoThrow,
						captureException,
					]) {
						expect(work).not.toHaveBeenCalled();
					}
				}
			);
			it('blocks a reservation pending canonicalization and retains async shell setup', async () => {
				const canonical = Promise.withResolvers<string>();
				vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
				const reservation = gate.reserveWorktreeCleanup(target);
				const shell = Promise.withResolvers<string>();
				vi.mocked(getShellPath).mockReturnValueOnce(shell.promise);
				const pending = request();
				canonical.resolve(target);
				expect(await reservation).toMatchObject({ status: 'blocked' });
				await blocked();
				shell.resolve('/custom');
				await drain();
				for (const native of natives) {
					native.result.resolve(found);
					native.child.emit('close');
				}
				await pending;
				await reserve();
			});
		}
	);

	it.each(['checkBinaryExists', 'findAllBinaryPaths'] as const)(
		'%s preserves argv/options and retains native lifetime after result/error/exit',
		async (method) => {
			const pending = desktop[method]('unknown-probe');
			await drain();
			const [command, args, cwd, options, observe] = vi.mocked(execFileNoThrow).mock.calls[0];
			expect(command).toBe('which');
			expect(args).toEqual(
				method === 'findAllBinaryPaths' ? ['-a', 'unknown-probe'] : ['unknown-probe']
			);
			expect(cwd).toBeUndefined();
			expect(observe).toEqual(expect.any(Function));
			const env =
				method === 'findAllBinaryPaths'
					? (options as { env: NodeJS.ProcessEnv }).env
					: (options as NodeJS.ProcessEnv);
			expect(env.PATH?.split(path.delimiter).slice(0, 2)).toEqual(['/custom', '/other']);
			if (method === 'findAllBinaryPaths') expect(options).toMatchObject({ timeout: 5000 });
			natives[0].result.resolve(found);
			expect(await pending).toEqual(
				method === 'findAllBinaryPaths'
					? ['/custom/probe', '/custom/alias']
					: { exists: true, path: '/custom/probe' }
			);
			natives[0].child.emit('error', new Error('late error'));
			natives[0].child.emit('exit', 0);
			await blocked();
			natives[0].child.emit('close');
			await reserve();
		}
	);

	it.each(['timeout', 'rejection'] as const)(
		'retains native lifetime after %s fallback',
		async (kind) => {
			const pending = desktop.checkBinaryExists('unknown-probe');
			await drain();
			if (kind === 'timeout')
				natives[0].result.resolve({ stdout: '', stderr: 'timeout', exitCode: 1 });
			else natives[0].result.reject(new Error('executor failed'));
			expect(await pending).toEqual({ exists: false });
			await blocked();
			natives[0].child.emit('close');
			await reserve();
		}
	);

	it('retains canonicalization beyond native close and preserves ordered deduplication', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(nativeFs.promises.realpath)
			.mockReturnValueOnce(canonical.promise)
			.mockResolvedValue('/same/binary');
		const pending = desktop.findAllBinaryPaths('unknown-probe');
		await drain();
		natives[0].result.resolve(found);
		natives[0].child.emit('close');
		await blocked();
		canonical.resolve('/same/binary');
		expect(await pending).toEqual(['/custom/probe']);
		await reserve();
	});

	it.each([false, true])(
		'retains asynchronous fallback diagnostics (reject=%s)',
		async (reject) => {
			const report = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValueOnce(report.promise);
			vi.mocked(getShellPath).mockRejectedValueOnce(new Error('unexpected shell failure'));
			expect((await desktop.getExpandedEnvWithShell()).PATH).toBeTruthy();
			expect(captureException).toHaveBeenCalledOnce();
			await blocked();
			if (reject) report.reject(new Error('diagnostic failed'));
			else report.resolve();
			await drain();
			await reserve();
		}
	);

	it('keeps concurrent probes independent, including duplicate closes', async () => {
		const a = desktop.checkBinaryExists('unknown-a');
		const b = desktop.checkBinaryExists('unknown-b');
		await drain();
		for (const native of natives) native.result.resolve(found);
		await Promise.all([a, b]);
		natives[0].child.emit('close');
		natives[0].child.emit('close');
		await blocked();
		natives[1].child.emit('close');
		await reserve();
	});

	it.each(['throw', 'missing', 'observer'] as const)(
		'fails closed for unknown native observation: %s',
		async (kind) => {
			vi.mocked(execFileNoThrow).mockImplementationOnce((_cmd, _args, _cwd, _opts, observe) => {
				if (kind === 'throw') throw new Error('unknown native launch');
				if (kind === 'observer')
					observe?.({
						once: () => {
							throw new Error('observer failed');
						},
					} as never);
				return Promise.resolve(found);
			});
			await desktop.checkBinaryExists('unknown-probe');
			await blocked();
		}
	);

	it('releases setup failure before a native attempt', async () => {
		vi.mocked(os.homedir).mockImplementationOnce(() => {
			throw new Error('setup failed');
		});
		await expect(desktop.getExpandedEnvWithShell()).rejects.toThrow('setup failed');
		expect(execFileNoThrow).not.toHaveBeenCalled();
		await reserve();
	});

	it('holds direct filesystem discovery until settled and skips the native fallback', async () => {
		const access = Promise.withResolvers<void>();
		vi.mocked(nativeFs.promises.access).mockReturnValueOnce(access.promise);
		const pending = desktop.checkBinaryExists('claude');
		await blocked();
		access.resolve();
		expect(await pending).toMatchObject({ exists: true });
		expect(execFileNoThrow).not.toHaveBeenCalled();
		await reserve();
	});

	it('preserves Windows selection, CRLF and where argv', async () => {
		vi.mocked(isWindows).mockReturnValue(true);
		vi.mocked(getWhichCommand).mockReturnValue('where');
		const pending = desktop.checkBinaryExists('unknown-probe');
		await drain();
		natives[0].result.resolve({ ...found, stdout: 'C:\\bin\\p.cmd\r\nC:\\bin\\p.exe\r\n' });
		natives[0].child.emit('close');
		expect(await pending).toEqual({ exists: true, path: 'C:\\bin\\p.exe' });
		expect(vi.mocked(execFileNoThrow).mock.calls[0].slice(0, 2)).toEqual([
			'where',
			['unknown-probe'],
		]);
		await reserve();
	});

	it('keeps default library discovery independent with its original executor signature', async () => {
		const hold = await reserve();
		const pending = core.checkBinaryExists('unknown-probe');
		await drain();
		expect(vi.mocked(execFileNoThrow).mock.calls[0]).toHaveLength(4);
		natives[0].result.resolve(found);
		expect(await pending).toEqual({ exists: true, path: '/custom/probe' });
		hold.release();
		await reserve();
	});
});
