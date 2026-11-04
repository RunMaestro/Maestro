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
vi.mock('../../../shared/pathUtils', () => ({ buildExpandedEnv: vi.fn() }));
vi.mock('../../../shared/platformDetection', () => ({ getWhichCommand: vi.fn() }));
import { execFileNoThrow } from '../../../main/utils/execFile';
import { buildExpandedEnv } from '../../../shared/pathUtils';
import { getWhichCommand } from '../../../shared/platformDetection';

describe('standalone local CLI detection activity', () => {
	const target = path.resolve('cli-detection-target');
	const env = { PATH: '/custom/bin' };
	const found = { stdout: '/path with spaces/tool\r\n/second/tool\n', stderr: '', exitCode: 0 };
	let gate: typeof import('../../../main/git/worktreeActivity');
	let cli: typeof import('../../../main/utils/cliDetection');
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
		vi.mocked(buildExpandedEnv).mockReset().mockReturnValue(env);
		vi.mocked(getWhichCommand).mockReset().mockReturnValue('which');
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
	});
	afterEach(async () => {
		for (const release of releases) release();
		for (const native of natives) {
			native.result.resolve(found);
			native.child.emit('close');
		}
		await drain();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	describe.each(['gh', 'cloudflared'] as const)('%s', (binary) => {
		const detect = () => (binary === 'gh' ? cli.isGhInstalled() : cli.isCloudflaredInstalled());
		const clear = () => (binary === 'gh' ? cli.clearGhCache() : cli.clearCloudflaredCache());
		it.each([target, path.join(target, 'descendant'), path.resolve('other-repository')])(
			'refuses before platform/environment/native setup under %s',
			async (root) => {
				await reserve(root);
				await expect(detect()).rejects.toThrow(/reserved/);
				for (const work of [buildExpandedEnv, getWhichCommand, execFileNoThrow]) {
					expect(work).not.toHaveBeenCalled();
				}
			}
		);
		it('admits synchronously while reservation canonicalization is pending', async () => {
			const canonical = Promise.withResolvers<string>();
			vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
			const reservation = gate.reserveWorktreeCleanup(target);
			const request = detect();
			canonical.resolve(target);
			await expect(reservation).resolves.toMatchObject({ status: 'blocked' });
			natives[0].result.resolve(found);
			await expect(request).resolves.toBe(true);
			await blocked();
			natives[0].child.emit('close');
			await reserve();
		});
		it.each(['which', 'where'] as const)(
			'preserves %s argv, bare env and parsing',
			async (command) => {
				vi.mocked(getWhichCommand).mockReturnValue(command);
				const request = detect();
				expect(execFileNoThrow).toHaveBeenCalledWith(
					command,
					[binary],
					undefined,
					env,
					expect.any(Function)
				);
				natives[0].result.resolve(found);
				await expect(request).resolves.toBe(true);
				if (binary === 'gh')
					await expect(cli.resolveGhPath()).resolves.toBe('/path with spaces/tool');
				else expect(cli.getCloudflaredPath()).toBe('/path with spaces/tool');
				await blocked();
				natives[0].child.emit('close');
				await reserve();
			}
		);
		it.each(['result', 'error', 'exit', 'timeout', 'rejection'])(
			'does not mistake %s for native close',
			async (event) => {
				const request = detect();
				if (event === 'error') natives[0].child.emit('error', new Error('native error'));
				if (event === 'exit') natives[0].child.emit('exit', 1);
				if (event === 'rejection') {
					natives[0].result.reject(new Error('execution failed'));
					await expect(request).rejects.toThrow('execution failed');
				} else {
					natives[0].result.resolve(
						event === 'timeout' ? { stdout: '', stderr: 'timeout', exitCode: 1 } : found
					);
					await expect(request).resolves.toBe(event !== 'timeout');
				}
				await blocked();
				natives[0].child.emit('close');
				await reserve();
			}
		);
		it('retains parsing/cache work when close arrives before the result', async () => {
			const request = detect();
			natives[0].child.emit('close');
			await blocked();
			natives[0].result.resolve(found);
			await expect(request).resolves.toBe(true);
			await reserve();
		});
		it.each([true, false])(
			'refuses cached answers without re-probing, installed=%s',
			async (installed) => {
				const request = detect();
				natives[0].result.resolve(installed ? found : { stdout: '', stderr: '', exitCode: 1 });
				natives[0].child.emit('close');
				await expect(request).resolves.toBe(installed);
				await expect(detect()).resolves.toBe(installed);
				await reserve();
				await expect(detect()).rejects.toThrow(/reserved/);
				expect(execFileNoThrow).toHaveBeenCalledTimes(1);
			}
		);
		it('keeps concurrent and retried children independent of cache clearing and duplicate close', async () => {
			const requests = [detect(), detect()];
			natives[0].result.resolve(found);
			natives[1].result.resolve(found);
			await Promise.all(requests);
			clear();
			const retry = detect();
			natives[0].child.emit('close');
			natives[0].child.emit('close');
			natives[2].child.emit('close');
			natives[2].result.resolve(found);
			await retry;
			await blocked();
			natives[1].child.emit('close');
			await reserve();
		});
		it('preserves setup failures and releases when no native launch was attempted', async () => {
			vi.mocked(buildExpandedEnv).mockImplementationOnce(() => {
				throw new Error('environment failed');
			});
			await expect(detect()).rejects.toThrow('environment failed');
			expect(execFileNoThrow).not.toHaveBeenCalled();
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
				if (failure === 'missing observer') await expect(detect()).resolves.toBe(true);
				else await expect(detect()).rejects.toThrow();
				await blocked();
			}
		);
	});
	it('refuses custom and default gh resolution before setup', async () => {
		await reserve();
		await expect(cli.resolveGhPath('/custom/gh')).rejects.toThrow(/reserved/);
		await expect(cli.resolveGhPath()).rejects.toThrow(/reserved/);
		expect(execFileNoThrow).not.toHaveBeenCalled();
		expect(buildExpandedEnv).not.toHaveBeenCalled();
	});
	it('preserves custom resolution without a child and fallback after an absent gh', async () => {
		await expect(cli.resolveGhPath('/custom/gh')).resolves.toBe('/custom/gh');
		expect(execFileNoThrow).not.toHaveBeenCalled();
		const request = cli.resolveGhPath();
		natives[0].result.resolve({ stdout: '', stderr: 'absent', exitCode: 1 });
		await expect(request).resolves.toBe('gh');
		await blocked();
		natives[0].child.emit('close');
		await reserve();
	});
	it('preserves gh auth verdict identity and TTL invalidation independently of native close', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const request = cli.isGhInstalled();
		natives[0].result.resolve(found);
		await request;
		cli.setCachedGhStatus('gh', false, false);
		expect(cli.getCachedGhStatus('/custom/gh')).toBeNull();
		expect(cli.getCachedGhStatus('gh')).toEqual({ installed: false, authenticated: false });
		vi.setSystemTime(Date.now() + 60001);
		expect(cli.getCachedGhStatus('gh')).toBeNull();
		const retry = cli.isGhInstalled();
		natives[1].result.resolve(found);
		natives[1].child.emit('close');
		await retry;
		await blocked();
		natives[0].child.emit('close');
		await reserve();
	});
});
