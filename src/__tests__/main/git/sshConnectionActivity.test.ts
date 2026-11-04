import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import type { ExecResult } from '../../../main/utils/execFile';
import type { SshRemoteConfig } from '../../../shared/types';
import { buildSshConnectionArgs, buildSshProbeCommand } from '../../../shared/sshConnection';

vi.mock('fs/promises', async (original) => {
	const actual = await original<typeof import('fs/promises')>();
	return { ...actual, default: { ...actual, realpath: vi.fn() } };
});
vi.mock('../../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/utils/path-access-cache', () => ({
	getPathAccessCache: vi.fn(),
	defaultReadableProbe: vi.fn(),
}));
import { execFileNoThrow } from '../../../main/utils/execFile';
import { captureException } from '../../../main/utils/sentry';
import { getPathAccessCache } from '../../../main/utils/path-access-cache';

describe('standalone SSH connection activity', () => {
	const target = path.resolve('ssh-connection-target');
	const success = { stdout: 'SSH_OK\nremote-host\n/usr/bin/claude\n', stderr: '', exitCode: 0 };
	const shellFailure = {
		stdout: '',
		stderr: "The token '&&' is not a valid statement separator in this version.",
		exitCode: 1,
	};
	const config: SshRemoteConfig = {
		id: 'remote',
		name: 'Remote',
		host: 'remote.example',
		port: 2222,
		username: 'test',
		privateKeyPath: '',
		enabled: true,
		sshOptions: { ProxyCommand: 'proxy transport %h %p' },
	};
	let gate: typeof import('../../../main/git/worktreeActivity');
	let manager: import('../../../main/ssh-remote-manager').SshRemoteManager;
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
		vi.mocked(captureException).mockReset().mockResolvedValue(undefined);
		vi.mocked(getPathAccessCache).mockReset();
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
		const { SshRemoteManager } = await import('../../../main/ssh-remote-manager');
		manager = new SshRemoteManager();
	});
	afterEach(async () => {
		for (const release of releases) release();
		for (let i = 0; i < natives.length; i++) {
			natives[i].result.resolve(success);
			natives[i].child.emit('close');
			await drain();
		}
		vi.restoreAllMocks();
	});

	it.each([target, path.join(target, 'descendant'), path.resolve('other-repository')])(
		'refuses before config, key, native setup or recovery under %s',
		async (root) => {
			await reserve(root);
			const readConfig = vi.fn(() => {
				throw new Error('config accessed');
			});
			await expect(
				manager.testConnection({
					...config,
					get name() {
						return readConfig();
					},
				})
			).rejects.toThrow(/reserved/);
			expect(readConfig).not.toHaveBeenCalled();
			expect(getPathAccessCache).not.toHaveBeenCalled();
			expect(execFileNoThrow).not.toHaveBeenCalled();
			expect(captureException).not.toHaveBeenCalled();
		}
	);
	it('admits before pending reservation canonicalization', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const reservation = gate.reserveWorktreeCleanup(target);
		const request = manager.testConnection(config);
		canonical.resolve(target);
		await expect(reservation).resolves.toMatchObject({ status: 'blocked' });
		natives[0].result.resolve(success);
		await request;
		await blocked();
		natives[0].child.emit('close');
		await reserve();
	});
	it('preserves invalid validation without a native launch or leaked request', async () => {
		vi.spyOn(manager, 'validateConfig').mockImplementation(() => {
			return { valid: false, errors: ['Private key not readable'] };
		});
		await expect(manager.testConnection(config)).resolves.toEqual({
			success: false,
			error: 'Private key not readable',
		});
		expect(execFileNoThrow).not.toHaveBeenCalled();
		await reserve();
	});
	it.each([false, true])(
		'preserves SSH config routing %s, argv and executor defaults',
		async (useSshConfig) => {
			const remote = { ...config, useSshConfig, port: 22 };
			const request = manager.testConnection(remote, 'claude');
			expect(execFileNoThrow).toHaveBeenCalledWith(
				'ssh',
				[...buildSshConnectionArgs(remote), buildSshProbeCommand('claude')],
				undefined,
				undefined,
				expect.any(Function)
			);
			natives[0].result.resolve(success);
			await expect(request).resolves.toEqual({
				success: true,
				remoteInfo: { hostname: 'remote-host', agentVersion: 'installed' },
			});
			await blocked();
			natives[0].child.emit('close');
			await reserve();
		}
	);
	it.each(['result', 'error', 'exit', 'rejection'])(
		'does not mistake %s for native close',
		async (event) => {
			const request = manager.testConnection(config);
			if (event === 'error') natives[0].child.emit('error', new Error('timeout'));
			if (event === 'exit') natives[0].child.emit('exit', 0);
			if (event === 'rejection') natives[0].result.reject(new Error('timeout'));
			else
				natives[0].result.resolve(
					event === 'result'
						? success
						: {
								stdout: '',
								stderr: 'Connection timed out',
								exitCode: 'ETIMEDOUT',
							}
				);
			await request;
			await drain();
			await blocked();
			natives[0].child.emit('close');
			await reserve();
		}
	);
	it('retains concurrent requests after close and ignores duplicate close', async () => {
		const first = manager.testConnection(config);
		const second = manager.testConnection(config);
		natives[0].child.emit('close');
		natives[1].child.emit('close');
		await blocked();
		natives[0].result.resolve(success);
		await first;
		natives[0].child.emit('close');
		await blocked();
		natives[1].result.resolve(success);
		await second;
		await reserve();
	});
	it.each([false, true])(
		'holds both main and hostname fallback children, close first=%s',
		async (closeFirst) => {
			const request = manager.testConnection(config);
			natives[0].result.resolve(shellFailure);
			await drain();
			expect(natives).toHaveLength(2);
			expect(execFileNoThrow).toHaveBeenLastCalledWith(
				'ssh',
				[...buildSshConnectionArgs(config), 'hostname'],
				undefined,
				undefined,
				expect.any(Function)
			);
			await blocked();
			if (closeFirst) {
				natives[0].child.emit('close');
				natives[1].child.emit('close');
				await blocked();
			}
			natives[1].result.resolve({ stdout: 'windows-host\n', stderr: '', exitCode: 0 });
			await expect(request).resolves.toMatchObject({
				success: false,
				remediation: { detail: expect.stringContaining('windows-host') },
			});
			if (!closeFirst) {
				natives[1].child.emit('close');
				await blocked();
				natives[0].child.emit('close');
			}
			await reserve();
		}
	);
	it('preserves fallback failure while retaining its native child', async () => {
		const request = manager.testConnection(config);
		natives[0].result.resolve(shellFailure);
		await drain();
		natives[0].child.emit('close');
		natives[1].result.reject(new Error('hostname failed'));
		await expect(request).resolves.toMatchObject({ success: false });
		await blocked();
		natives[1].child.emit('close');
		await reserve();
	});
	it.each(['resolve', 'reject'])(
		'retains asynchronous failure report until %s',
		async (outcome) => {
			const report = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValueOnce(report.promise);
			const request = manager.testConnection(config);
			natives[0].child.emit('close');
			natives[0].result.reject(new Error('probe failed'));
			await expect(request).resolves.toMatchObject({
				success: false,
				error: expect.stringContaining('probe failed'),
			});
			await blocked();
			if (outcome === 'reject') report.reject(new Error('report failed'));
			else report.resolve();
			await drain();
			await reserve();
		}
	);
	it('settles a synchronous diagnostic failure without leaking known-closed activity', async () => {
		vi.mocked(captureException).mockImplementationOnce(() => {
			throw new Error('report failed');
		});
		const request = manager.testConnection(config);
		natives[0].child.emit('close');
		natives[0].result.reject(new Error('probe failed'));
		await expect(request).rejects.toThrow('report failed');
		await drain();
		await reserve();
	});
	it('releases setup rejection before any native attempt', async () => {
		vi.spyOn(manager, 'buildSshArgs').mockImplementationOnce(() => {
			throw new Error('args');
		});
		await expect(manager.testConnection(config)).rejects.toThrow('args');
		expect(execFileNoThrow).not.toHaveBeenCalled();
		await drain();
		await reserve();
	});
	it.each(['missing', 'handle', 'observer', 'launch'])(
		'keeps unknown %s native observations busy',
		async (mode) => {
			vi.mocked(execFileNoThrow).mockImplementationOnce((_cmd, _args, _cwd, _opts, observe) => {
				if (mode === 'launch') throw new Error('unknown launch');
				if (mode === 'handle') observe?.(undefined as never);
				if (mode === 'observer')
					observe?.({
						once() {
							throw new Error('observer failed');
						},
					} as never);
				return Promise.resolve(success);
			});
			await manager.testConnection(config);
			await drain();
			await blocked();
		}
	);
});
