import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import type { ExecResult } from '../../../main/utils/execFile';
import type { SshRemoteConfig, SshRemoteTestResult } from '../../../shared/types';
import type { SshRemoteHandlerDependencies } from '../../../main/ipc/handlers/ssh-remote';

vi.mock('fs/promises', async (original) => {
	const actual = await original<typeof import('fs/promises')>();
	return { ...actual, default: { ...actual, realpath: vi.fn() } };
});
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../../../main/process-manager', () => ({}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import { ipcMain } from 'electron';
import { logger } from '../../../main/utils/logger';
import { execFileNoThrow } from '../../../main/utils/execFile';

describe('SSH connection-test IPC activity', () => {
	const target = path.resolve('ssh-test-ipc-target');
	const config: SshRemoteConfig = {
		id: 'remote',
		name: 'Remote',
		host: 'remote.example',
		port: 2222,
		username: 'test',
		privateKeyPath: '',
		enabled: true,
	};
	const response: SshRemoteTestResult = { success: true, remoteInfo: { hostname: 'remote-host' } };
	const output = { stdout: 'SSH_OK\nremote-host\n/usr/bin/claude\n', stderr: '', exitCode: 0 };
	let gate: typeof import('../../../main/git/worktreeActivity');
	let manager: typeof import('../../../main/ssh-remote-manager').sshRemoteManager;
	let deps: SshRemoteHandlerDependencies;
	let releases: Array<() => void>;
	let natives: Array<{
		child: EventEmitter;
		result: ReturnType<typeof Promise.withResolvers<ExecResult>>;
	}>;
	let active: number;
	const drain = () => new Promise(setImmediate);
	const start = (input: string | SshRemoteConfig = config, agentCommand?: string) => {
		const handler = vi
			.mocked(ipcMain.handle)
			.mock.calls.find(([name]) => name === 'ssh-remote:test')![1];
		return handler({} as never, input, agentCommand);
	};
	async function reservation(root = target) {
		const hold = await gate.reserveWorktreeCleanup(root);
		if (hold.status === 'reserved-partially') releases.push(hold.release);
		return hold;
	}
	async function idle(root = target) {
		const hold = await reservation(root);
		expect(hold.status).toBe('reserved-partially');
		if (hold.status !== 'reserved-partially') throw new Error('Expected partial reservation');
		expect(hold.blockers.map((b) => b.message).join(' ')).toMatch(/native.*registration.*OS/);
		return hold;
	}
	const busy = async () =>
		expect(await reservation()).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'mutation-busy' }],
		});
	beforeEach(async () => {
		vi.resetModules();
		vi.resetAllMocks();
		releases = [];
		natives = [];
		active = 0;
		vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
		gate = await import('../../../main/git/worktreeActivity');
		const admit = gate.beginGlobalWorktreeActivity;
		vi.spyOn(gate, 'beginGlobalWorktreeActivity').mockImplementation(() => {
			const release = admit();
			active++;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				active--;
				release();
			};
		});
		({ sshRemoteManager: manager } = await import('../../../main/ssh-remote-manager'));
		vi.spyOn(manager, 'testConnection').mockResolvedValue(response);
		deps = { settingsStore: { get: vi.fn(() => [config]) } as never };
		const { registerSshRemoteHandlers } = await import('../../../main/ipc/handlers/ssh-remote');
		registerSshRemoteHandlers(deps);
	});
	afterEach(async () => {
		for (const release of releases) release();
		for (const native of natives) {
			native.result.resolve(output);
			native.child.emit('close');
		}
		await drain();
		vi.restoreAllMocks();
	});

	it.each([target, path.join(target, 'child'), path.resolve('other-repository')])(
		'refuses config-ID and direct access before setup or recovery under %s',
		async (root) => {
			await idle(root);
			const read = vi.fn(() => {
				throw new Error('config read');
			});
			for (const input of ['remote', new Proxy(config, { get: read })])
				await expect(start(input)).resolves.toMatchObject({
					success: false,
					error: expect.stringMatching(/reserved/),
				});
			for (const work of [
				read,
				deps.settingsStore.get,
				manager.testConnection,
				logger.info,
				logger.warn,
				execFileNoThrow,
			])
				expect(work).not.toHaveBeenCalled();
		}
	);
	it('admits before pending canonicalization and retains the request', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const hold = reservation();
		const completion = Promise.withResolvers<SshRemoteTestResult>();
		vi.mocked(manager.testConnection).mockReturnValueOnce(completion.promise);
		const pending = start('remote');
		canonical.resolve(target);
		await expect(hold).resolves.toMatchObject({ status: 'blocked' });
		await busy();
		completion.resolve(response);
		await expect(pending).resolves.toEqual({ success: true, result: response });
		await idle();
	});
	it('keeps concurrent requests independent after either nested result settles', async () => {
		const first = Promise.withResolvers<SshRemoteTestResult>();
		const second = Promise.withResolvers<SshRemoteTestResult>();
		vi.mocked(manager.testConnection)
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const one = start();
		const two = start('remote');
		await busy();
		first.resolve(response);
		await one;
		await busy();
		second.resolve({ success: false, error: 'offline' });
		await expect(two).resolves.toEqual({
			success: true,
			result: { success: false, error: 'offline' },
		});
		await idle();
	});
	it.each(['store', 'config', 'logging', 'connection'])(
		'admits before %s setup and releases after its failure',
		async (stage) => {
			let during: number | undefined;
			const fail = () => {
				during = active;
				throw new Error(stage);
			};
			if (stage === 'store') vi.mocked(deps.settingsStore.get).mockImplementationOnce(fail);
			if (stage === 'logging') vi.mocked(logger.info).mockImplementationOnce(fail);
			if (stage === 'connection') vi.mocked(manager.testConnection).mockImplementationOnce(fail);
			await expect(
				start(
					stage === 'store'
						? 'remote'
						: stage === 'config'
							? new Proxy(config, { get: fail })
							: config
				)
			).resolves.toEqual({ success: false, error: `Error: ${stage}` });
			expect(during).toBe(1);
			await idle();
		}
	);
	it('preserves missing stored config, object identity, agent command and no local path lookup', async () => {
		await expect(start('missing')).resolves.toEqual({
			success: false,
			error: 'Error: SSH remote not found: missing',
		});
		expect(manager.testConnection).not.toHaveBeenCalled();
		await expect(start('remote', 'custom-agent')).resolves.toEqual({
			success: true,
			result: response,
		});
		expect(manager.testConnection).toHaveBeenLastCalledWith(config, 'custom-agent');
		await start(config);
		expect(manager.testConnection).toHaveBeenLastCalledWith(config, undefined);
		expect(vi.mocked(fs.realpath).mock.calls).toEqual([]);
		await idle();
	});
	it.each(['success', 'hostname', 'error', 'report'])(
		'holds %s result access/reporting after nested settlement and releases on failure',
		async (stage) => {
			let during: number | undefined;
			const fail = () => {
				during = active;
				throw new Error(stage);
			};
			if (stage === 'success')
				vi.mocked(manager.testConnection).mockResolvedValueOnce({
					get success() {
						return fail();
					},
				});
			if (stage === 'hostname')
				vi.mocked(manager.testConnection).mockResolvedValueOnce({
					success: true,
					remoteInfo: {
						get hostname() {
							return fail();
						},
					},
				});
			if (stage === 'error')
				vi.mocked(manager.testConnection).mockResolvedValueOnce({
					success: false,
					get error() {
						return fail();
					},
				});
			if (stage === 'report')
				vi.mocked(logger.info).mockImplementation((message) => {
					if (message.startsWith('SSH connection test successful:')) fail();
				});
			await expect(start()).resolves.toEqual({ success: false, error: `Error: ${stage}` });
			expect(during).toBe(1);
			await idle();
		}
	);
	it('retains only its own scope on rejected connection and failed warning reporting', async () => {
		const releaseNative = gate.beginGlobalWorktreeActivity();
		releases.push(releaseNative);
		vi.mocked(manager.testConnection).mockRejectedValueOnce(new Error('connection rejection'));
		await expect(start()).resolves.toEqual({
			success: false,
			error: 'Error: connection rejection',
		});
		vi.mocked(manager.testConnection).mockResolvedValueOnce({ success: false, error: 'offline' });
		vi.mocked(logger.warn).mockImplementationOnce(() => {
			expect(active).toBe(2);
			throw new Error('report failed');
		});
		await expect(start()).resolves.toEqual({ success: false, error: 'Error: report failed' });
		await busy();
		releaseNative();
		await idle();
	});
	it.each(['result', 'error', 'exit', 'close-first', 'unknown'])(
		'composes the actual manager native ownership with IPC (%s)',
		async (event) => {
			vi.mocked(manager.testConnection).mockRestore();
			vi.mocked(execFileNoThrow).mockImplementation((_cmd, _args, _cwd, _opts, observe) => {
				const child = new EventEmitter();
				child.on('error', () => {});
				const result = Promise.withResolvers<ExecResult>();
				natives.push({ child, result });
				if (event !== 'unknown') observe?.(child as Parameters<NonNullable<typeof observe>>[0]);
				return result.promise;
			});
			const pending = start(config, 'claude');
			await busy();
			const { child, result } = natives[0];
			if (event === 'error') child.emit('error', new Error('native error'));
			if (event === 'exit') child.emit('exit', 0);
			if (event === 'close-first') {
				child.emit('close');
				await busy();
			}
			result.resolve(output);
			await expect(pending).resolves.toMatchObject({ success: true, result: { success: true } });
			await drain();
			if (event !== 'close-first') await busy();
			child.emit('close');
			await drain();
			if (event === 'unknown') await busy();
			else await idle();
		}
	);
});
