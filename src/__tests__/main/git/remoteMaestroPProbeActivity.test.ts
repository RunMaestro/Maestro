import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import type { ExecResult } from '../../../main/utils/execFile';
import type { SshRemoteConfig } from '../../../shared/types';

vi.mock('fs/promises', async (original) => {
	const actual = await original<typeof import('fs/promises')>();
	return { ...actual, default: { ...actual, realpath: vi.fn() } };
});
vi.mock('../../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../../main/utils/ssh-command-builder', () => ({ buildSshCommand: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

import { execFileNoThrow } from '../../../main/utils/execFile';
import { buildSshCommand } from '../../../main/utils/ssh-command-builder';
import { logger } from '../../../main/utils/logger';

describe('remote maestro-p launch probe activity', () => {
	const target = path.resolve('remote-probe-target');
	const success = { stdout: '\u001b[32m0.16.20-RC\u001b[0m\n', stderr: '', exitCode: 0 };
	const remote: SshRemoteConfig = {
		id: 'remote',
		name: 'Remote',
		host: 'remote.example',
		port: 22,
		username: 'test',
		privateKeyPath: '',
		enabled: true,
	};
	let gate: typeof import('../../../main/git/worktreeActivity');
	let probe: typeof import('../../../main/agents/probeRemoteMaestroP');
	let cache: typeof import('../../../main/agents/remoteMaestroPCache');
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
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		vi.mocked(fs.realpath)
			.mockReset()
			.mockImplementation(async (p) => String(p));
		vi.mocked(logger.info).mockReset();
		vi.mocked(logger.warn).mockReset();
		vi.mocked(buildSshCommand)
			.mockReset()
			.mockResolvedValue({ command: 'ssh', args: ['wire'] });
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
		probe = await import('../../../main/agents/probeRemoteMaestroP');
		cache = await import('../../../main/agents/remoteMaestroPCache');
	});
	afterEach(async () => {
		for (const native of natives) {
			native.result.resolve(success);
			native.child.emit('close');
		}
		await drain();
		for (const release of releases) release();
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it.each([target, path.join(target, 'descendant'), path.resolve('unrelated-repository')])(
		'refuses both exports before config, cache, SSH or recovery under %s',
		async (root) => {
			cache.setRemoteMaestroPAvailable(remote.id, true);
			await reserve(root);
			const id = vi.fn(() => remote.id);
			const config = {
				...remote,
				get id() {
					return id();
				},
			};
			await expect(probe.probeRemoteMaestroP(config)).rejects.toThrow(/reserved/);
			await expect(probe.ensureRemoteMaestroPProbed(config)).rejects.toThrow(/reserved/);
			expect(id).not.toHaveBeenCalled();
			expect(buildSshCommand).not.toHaveBeenCalled();
			expect(execFileNoThrow).not.toHaveBeenCalled();
			expect(logger.info).not.toHaveBeenCalled();
			expect(logger.warn).not.toHaveBeenCalled();
		}
	);

	it('admits synchronously during pending reservation setup and retains SSH setup', async () => {
		const canonical = Promise.withResolvers<string>();
		const setup = Promise.withResolvers<Awaited<ReturnType<typeof buildSshCommand>>>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		vi.mocked(buildSshCommand).mockReturnValueOnce(setup.promise);
		const reservation = gate.reserveWorktreeCleanup(target);
		const request = probe.ensureRemoteMaestroPProbed(remote);
		canonical.resolve(target);
		await expect(reservation).resolves.toMatchObject({ status: 'blocked' });
		await blocked();
		expect(execFileNoThrow).not.toHaveBeenCalled();
		setup.resolve({ command: 'ssh', args: ['wire'] });
		await drain();
		natives[0].child.emit('close');
		await blocked();
		natives[0].result.resolve(success);
		await expect(request).resolves.toBe(true);
		await reserve();
	});

	it.each([true, false])(
		'preserves %s TTL cache hits and refreshes after expiry',
		async (available) => {
			cache.setRemoteMaestroPAvailable(remote.id, available);
			await expect(probe.ensureRemoteMaestroPProbed(remote)).resolves.toBe(available);
			expect(buildSshCommand).not.toHaveBeenCalled();
			vi.advanceTimersByTime(cache.REMOTE_MAESTRO_P_TTL_MS + 1);
			const request = probe.ensureRemoteMaestroPProbed(remote);
			await drain();
			natives[0].result.resolve(success);
			await expect(request).resolves.toBe(true);
			expect(buildSshCommand).toHaveBeenCalledWith(remote, {
				command: 'maestro-p',
				args: ['--version'],
			});
			expect(execFileNoThrow).toHaveBeenCalledWith(
				'ssh',
				['wire'],
				undefined,
				undefined,
				expect.any(Function)
			);
			await blocked();
			natives[0].child.emit('close');
			await reserve();
		}
	);

	it.each(['error', 'exit', 'result'] as const)(
		'retains native %s independently of availability',
		async (event) => {
			const request = probe.probeRemoteMaestroP(remote);
			await drain();
			if (event === 'error') natives[0].child.emit('error', new Error('native failure'));
			if (event === 'exit') natives[0].child.emit('exit', 0);
			natives[0].result.resolve(success);
			await expect(request).resolves.toBe(true);
			expect(cache.getRemoteMaestroPAvailable(remote.id)).toBe(true);
			await blocked();
			natives[0].child.emit('close');
			await reserve();
		}
	);

	it('retains concurrent requests and native generations after cached results', async () => {
		const first = probe.probeRemoteMaestroP(remote);
		const second = probe.ensureRemoteMaestroPProbed(remote);
		await drain();
		expect(natives).toHaveLength(2);
		natives[0].result.resolve(success);
		await first;
		natives[0].child.emit('close');
		await expect(probe.ensureRemoteMaestroPProbed(remote)).resolves.toBe(true);
		await blocked();
		natives[1].child.emit('close');
		natives[0].child.emit('close');
		await blocked();
		natives[1].result.resolve(success);
		await second;
		await reserve();
	});

	it('keeps timed-out SSH alive across retry, then ignores late stale results', async () => {
		const first = probe.ensureRemoteMaestroPProbed(remote);
		await drain();
		await vi.advanceTimersByTimeAsync(15000);
		await expect(first).resolves.toBeUndefined();
		expect(cache.getRemoteMaestroPAvailable(remote.id)).toBeUndefined();
		await blocked();
		const retry = probe.ensureRemoteMaestroPProbed(remote);
		await drain();
		natives[1].result.resolve({ stdout: '', stderr: 'not installed', exitCode: 127 });
		natives[1].child.emit('close');
		await expect(retry).resolves.toBe(false);
		await blocked();
		natives[0].result.resolve(success);
		await drain();
		expect(cache.getRemoteMaestroPAvailable(remote.id)).toBe(false);
		natives[0].child.emit('close');
		await reserve();
	});

	it.each(['Connection refused', 'Permission denied', 'reject'])(
		'preserves unknown recovery for %s until close',
		async (error) => {
			cache.setRemoteMaestroPAvailable(
				remote.id,
				false,
				Date.now() - cache.REMOTE_MAESTRO_P_TTL_MS - 1
			);
			const request = probe.ensureRemoteMaestroPProbed(remote);
			await drain();
			if (error === 'reject') natives[0].result.reject(new Error('execution failed'));
			else natives[0].result.resolve({ stdout: '', stderr: error, exitCode: 255 });
			await expect(request).resolves.toBe(false);
			await blocked();
			natives[0].child.emit('close');
			await reserve();
		}
	);

	it('releases known pre-launch setup failure after recovery and preserves unknown', async () => {
		vi.mocked(buildSshCommand).mockRejectedValueOnce(new Error('SSH setup'));
		await expect(probe.probeRemoteMaestroP(remote)).resolves.toBeNull();
		expect(execFileNoThrow).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('SSH setup'),
			'ProbeRemoteMaestroP'
		);
		await reserve();
	});

	it('releases ensure when cache config lookup throws before any child setup', async () => {
		const config = {
			...remote,
			get id(): string {
				throw new Error('cache config');
			},
		};
		await expect(probe.ensureRemoteMaestroPProbed(config)).rejects.toThrow('cache config');
		expect(buildSshCommand).not.toHaveBeenCalled();
		await reserve();
	});

	it('keeps native ownership when cache success reporting and recovery both fail', async () => {
		vi.mocked(logger.info).mockImplementationOnce(() => {
			throw new Error('report');
		});
		vi.mocked(logger.warn).mockImplementationOnce(() => {
			throw new Error('recovery');
		});
		const request = probe.ensureRemoteMaestroPProbed(remote);
		await drain();
		const rejected = expect(request).rejects.toThrow('recovery');
		natives[0].result.resolve(success);
		await rejected;
		expect(cache.getRemoteMaestroPAvailable(remote.id)).toBe(true);
		await blocked();
		natives[0].child.emit('close');
		await reserve();
	});

	it('holds parsing after close and releases after malformed result recovery', async () => {
		const request = probe.probeRemoteMaestroP(remote);
		await drain();
		natives[0].child.emit('close');
		await blocked();
		natives[0].result.resolve({
			...success,
			get stdout(): string {
				throw new Error('parse');
			},
		});
		await expect(request).resolves.toBeNull();
		expect(cache.getRemoteMaestroPAvailable(remote.id)).toBeUndefined();
		await reserve();
	});

	it.each(['missing observer', 'failed observer', 'unknown launch'])(
		'fails closed for %s after request recovery',
		async (mode) => {
			vi.mocked(execFileNoThrow).mockImplementationOnce((_cmd, _args, _cwd, _opts, observe) => {
				if (mode === 'unknown launch') throw new Error('unknown launch');
				if (mode === 'failed observer') observe?.(undefined!);
				return Promise.resolve(success);
			});
			await expect(probe.probeRemoteMaestroP(remote)).resolves.toBe(
				mode === 'missing observer' ? true : null
			);
			await blocked();
		}
	);
});
