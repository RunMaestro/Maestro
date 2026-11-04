import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import type { ExecResult } from '../../../main/utils/execFile';

vi.mock('fs/promises', async (original) => {
	const actual = await original<typeof import('fs/promises')>();
	return { ...actual, default: { ...actual, realpath: vi.fn() } };
});
vi.mock('../../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../../shared/platformDetection', () => ({
	isWindows: vi.fn(() => false),
	getWhichCommand: vi.fn(() => 'which'),
}));

import { execFileNoThrow } from '../../../main/utils/execFile';
import { isWindows, getWhichCommand } from '../../../shared/platformDetection';

describe('standalone shell discovery activity', () => {
	const target = path.resolve('shell-discovery-target');
	const success = { stdout: '/test/bin/shell\n', stderr: '', exitCode: 0 };
	let gate: typeof import('../../../main/git/worktreeActivity');
	let detector: typeof import('../../../main/utils/shellDetector');
	let natives: Array<{
		child: EventEmitter;
		result: ReturnType<typeof Promise.withResolvers<ExecResult>>;
	}>;
	let releases: Array<() => void>;

	async function drain() {
		await new Promise(setImmediate);
	}
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
	async function settle(count = 5, result = success) {
		for (let i = 0; i < count; i++) {
			natives[i].result.resolve(result);
			await drain();
		}
	}
	beforeEach(async () => {
		vi.resetModules();
		vi.mocked(fs.realpath)
			.mockReset()
			.mockImplementation(async (p) => String(p));
		vi.mocked(isWindows).mockReset().mockReturnValue(false);
		vi.mocked(getWhichCommand).mockReset().mockReturnValue('which');
		natives = [];
		releases = [];
		vi.mocked(execFileNoThrow)
			.mockReset()
			.mockImplementation((_cmd, _args, _cwd, _opts, onSpawn) => {
				const child = new EventEmitter();
				child.on('error', () => {});
				const result = Promise.withResolvers<ExecResult>();
				natives.push({ child, result });
				onSpawn?.(child as Parameters<NonNullable<typeof onSpawn>>[0]);
				return result.promise;
			});
		gate = await import('../../../main/git/worktreeActivity');
		detector = await import('../../../main/utils/shellDetector');
	});
	afterEach(async () => {
		// Resolve later sequential probes too; no native child is actually started.
		for (let i = 0; i < natives.length; i++) {
			natives[i].result.resolve(success);
			natives[i].child.emit('close');
			await drain();
		}
		for (const release of releases) release();
		vi.restoreAllMocks();
	});

	it.each([target, path.join(target, 'descendant'), path.resolve('unrelated-repository')])(
		'refuses before platform, command or recovery setup under %s',
		async (root) => {
			await reserve(root);
			await expect(detector.detectShells()).rejects.toThrow(/reserved/);
			expect(isWindows).not.toHaveBeenCalled();
			expect(getWhichCommand).not.toHaveBeenCalled();
			expect(execFileNoThrow).not.toHaveBeenCalled();
		}
	);

	it('admits synchronously while cleanup is still resolving its canonical target', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const reservation = gate.reserveWorktreeCleanup(target);
		const request = detector.detectShells();
		canonical.resolve(target);
		await expect(reservation).resolves.toMatchObject({ status: 'blocked' });
		await settle();
		await request;
		for (const native of natives) native.child.emit('close');
		await reserve();
	});

	it.each([
		[false, 'which', ['zsh', 'bash', 'sh', 'fish', 'tcsh']],
		[true, 'where', ['powershell.exe', 'pwsh.exe', 'cmd.exe', 'bash.exe', 'wsl.exe']],
	] as const)(
		'preserves ordered platform probes and results (Windows=%s)',
		async (windows, cmd, args) => {
			vi.mocked(isWindows).mockReturnValue(windows);
			vi.mocked(getWhichCommand).mockReturnValue(cmd);
			const request = detector.detectShells();
			await settle();
			const shells = await request;
			expect(shells).toHaveLength(5);
			expect(shells.every((s) => s.available && s.path === '/test/bin/shell')).toBe(true);
			expect(vi.mocked(execFileNoThrow).mock.calls.map((call) => call.slice(0, 4))).toEqual(
				args.map((arg) => [cmd, [arg], undefined, undefined])
			);
			await blocked();
			for (const native of natives.slice(0, -1)) native.child.emit('close');
			await blocked();
			natives.at(-1)!.child.emit('close');
			await reserve();
		}
	);

	it.each(['error', 'exit', 'timeout'] as const)(
		'retains %s results until every observed close',
		async (event) => {
			const request = detector.detectShells();
			if (event === 'error') natives[0].child.emit('error', new Error('native failure'));
			else natives[0].child.emit('exit', 1);
			const failed = { stdout: '', stderr: event, exitCode: event === 'timeout' ? 'ETIMEDOUT' : 1 };
			for (let i = 0; i < 5; i++) {
				natives[i].result.resolve(i === 0 ? failed : success);
				await drain();
			}
			const shells = await request;
			expect(shells[0].available).toBe(false);
			expect(shells.slice(1).every((s) => s.available)).toBe(true);
			for (const native of natives.slice(1)) native.child.emit('close');
			await blocked();
			natives[0].child.emit('close');
			await reserve();
		}
	);

	it('holds request and parsing after native close, across each sequential launch', async () => {
		const request = detector.detectShells();
		for (let i = 0; i < 5; i++) {
			natives[i].child.emit('close');
			await blocked();
			natives[i].result.resolve(success);
			await drain();
		}
		await request;
		await reserve();
	});

	it('keeps concurrent requests and late native generations independent', async () => {
		const first = detector.detectShells();
		const second = detector.detectShells();
		await settle(10);
		await Promise.all([first, second]);
		expect(natives).toHaveLength(10);
		for (const native of natives.slice(0, 9).reverse()) native.child.emit('close');
		await blocked();
		// Duplicate old-generation close cannot release the last outstanding child.
		natives[0].child.emit('close');
		await blocked();
		natives[9].child.emit('close');
		await reserve();
	});

	it('retains a rejected attempt through fallback after its result promise settles', async () => {
		const request = detector.detectShells();
		natives[0].result.reject(new Error('execution failed'));
		await drain();
		for (let i = 1; i < 5; i++) {
			natives[i].child.emit('close');
			natives[i].result.resolve(success);
			await drain();
		}
		expect((await request)[0].available).toBe(false);
		await blocked();
		natives[0].child.emit('close');
		await reserve();
	});

	it('releases known pre-launch setup failure without invoking a child', async () => {
		vi.mocked(isWindows).mockImplementationOnce(() => {
			throw new Error('platform setup');
		});
		await expect(detector.detectShells()).rejects.toThrow('platform setup');
		expect(execFileNoThrow).not.toHaveBeenCalled();
		await reserve();
	});

	it('preserves per-shell setup fallback and releases the request after all attempts', async () => {
		vi.mocked(getWhichCommand).mockImplementation(() => {
			throw new Error('lookup setup');
		});
		expect((await detector.detectShells()).every((s) => !s.available)).toBe(true);
		expect(getWhichCommand).toHaveBeenCalledTimes(5);
		expect(execFileNoThrow).not.toHaveBeenCalled();
		await reserve();
	});

	it.each(['missing observer', 'failed observer', 'unknown launch'])(
		'fails closed for %s despite a completed fallback request',
		async (mode) => {
			vi.mocked(execFileNoThrow).mockImplementationOnce((_cmd, _args, _cwd, _opts, onSpawn) => {
				if (mode === 'unknown launch') throw new Error('unknown launch');
				if (mode === 'failed observer') onSpawn?.(undefined!);
				return Promise.resolve(success);
			});
			const request = detector.detectShells();
			await drain();
			await settle(4);
			await request;
			for (const native of natives) native.child.emit('close');
			await blocked();
		}
	);

	it('releases closed probes after malformed result recovery and keeps following results', async () => {
		const request = detector.detectShells();
		natives[0].child.emit('close');
		natives[0].result.resolve({
			...success,
			get stdout(): string {
				throw new Error('parse failure');
			},
		});
		await drain();
		for (let i = 1; i < 5; i++) {
			natives[i].child.emit('close');
			natives[i].result.resolve(success);
			await drain();
		}
		const shells = await request;
		expect(shells[0].available).toBe(false);
		expect(shells.slice(1).every((s) => s.available)).toBe(true);
		await reserve();
	});
});
