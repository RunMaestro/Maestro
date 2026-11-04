import fs from 'fs/promises';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	ProcessConfig,
	ManagedProcess,
	CommandResult,
} from '../../../main/process-manager/types';

vi.mock('fs/promises', () => ({ default: { realpath: vi.fn() } }));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/process-manager/utils/spawnCwd', () => ({ unusableCwdReason: vi.fn() }));
vi.mock('../../../main/process-manager/steering-client', () => ({ sendSteeringRequest: vi.fn() }));
vi.mock('../../../main/codex-app-server/steering', () => ({ steerCodexAppServerTurn: vi.fn() }));
vi.mock('../../../main/process-manager/spawners/AcpServerSpawner', () => ({
	AcpServerSpawner: class {
		spawn = vi.fn();
	},
}));
vi.mock('../../../main/process-manager/spawners/ClaudeSdkSpawner', () => ({
	ClaudeSdkSpawner: class {
		spawn = vi.fn();
	},
}));
vi.mock('../../../main/process-manager/spawners/CopilotSdkSpawner', () => ({
	CopilotSdkSpawner: class {
		spawn = vi.fn();
	},
}));

import { ProcessManager } from '../../../main/process-manager/ProcessManager';
import { PtySpawner } from '../../../main/process-manager/spawners/PtySpawner';
import { ChildProcessSpawner } from '../../../main/process-manager/spawners/ChildProcessSpawner';
import { LocalCommandRunner } from '../../../main/process-manager/runners/LocalCommandRunner';
import { SshCommandRunner } from '../../../main/process-manager/runners/SshCommandRunner';
import { unusableCwdReason } from '../../../main/process-manager/utils/spawnCwd';
import { logger } from '../../../main/utils/logger';
import * as sentry from '../../../main/utils/sentry';
import { sendSteeringRequest } from '../../../main/process-manager/steering-client';
import { steerCodexAppServerTurn } from '../../../main/codex-app-server/steering';
import type { HarnessControlRegistry } from '../../../main/harness-control/HarnessControlRegistry';
import type { SteeringResultFrame } from '../../../shared/chatSteering';
import {
	beginGlobalWorktreeActivity,
	reserveWorktreeCleanup,
} from '../../../main/git/worktreeActivity';

const target = path.resolve('manager-cleanup-target');
const config: ProcessConfig = {
	sessionId: 'manager-ai-tab',
	toolType: 'terminal',
	cwd: target,
	command: 'bash',
	args: [],
};
let manager: ProcessManager;
let releases: Array<() => void>;

async function reserve(root = target) {
	const hold = await reserveWorktreeCleanup(root);
	if (hold.status === 'reserved-partially') releases.push(hold.release);
	expect(hold.status).toBe('reserved-partially');
	if (hold.status !== 'reserved-partially') throw new Error('Expected partial reservation');
	expect(hold.blockers.map((b) => b.message).join(' ')).toMatch(/native.*registration.*OS/);
	return hold;
}

async function blocked() {
	const hold = await reserveWorktreeCleanup(target);
	if (hold.status === 'reserved-partially') releases.push(hold.release);
	expect(hold).toMatchObject({ status: 'blocked', blockers: [{ code: 'mutation-busy' }] });
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
	vi.mocked(unusableCwdReason).mockReturnValue(null);
	manager = new ProcessManager(() => false, { isCoworkingEnabled: () => false });
	releases = [];
	vi.spyOn(PtySpawner.prototype, 'spawn').mockReturnValue({ success: true, pid: 123 });
	vi.spyOn(ChildProcessSpawner.prototype, 'spawn').mockReturnValue({ success: true, pid: 456 });
});

afterEach(() => {
	for (const release of releases) release();
	vi.restoreAllMocks();
});

describe('direct manager activity admission', () => {
	it.each([target, path.join(target, 'child'), path.resolve('other-repository')])(
		'refuses all spawn routes before cwd/reuse/recovery or reporting under %s',
		async (root) => {
			const hold = await reserve(root);
			vi.mocked(fs.realpath).mockClear();
			const kill = vi.spyOn(manager, 'kill');
			const capture = vi.fn();
			manager.on('spawn', capture);
			for (const options of [
				{},
				{ toolType: 'claude-code', prompt: 'test' },
				{ toolType: 'copilot-cli', harnessControlMode: 'native' as const, prompt: 'test' },
				{ command: 'ssh', cwd: '/remote/project', sshRemoteId: 'remote' },
			])
				expect(() => manager.spawn({ ...config, ...options })).toThrow(/reserved/);
			for (const probe of [
				unusableCwdReason,
				PtySpawner.prototype.spawn,
				ChildProcessSpawner.prototype.spawn,
				logger.info,
				logger.warn,
				kill,
				capture,
				fs.realpath,
			])
				expect(probe).not.toHaveBeenCalled();
			expect(manager.getAll()).toEqual([]);
			hold.release();
			expect(manager.spawn(config)).toMatchObject({ success: true });
			(await reserve()).release();
		}
	);

	it.each([true, false])(
		'refuses terminal reuse/restart before touching its entry (reuse=%s)',
		async (reuseTerminal) => {
			const existing = {
				sessionId: config.sessionId,
				pid: 123,
				isTerminal: true,
				ptyProcess: { kill: vi.fn() },
			} as unknown as ManagedProcess;
			const entries = Reflect.get(manager, 'processes') as Map<string, ManagedProcess>;
			entries.set(config.sessionId, existing);
			const kill = vi.spyOn(manager, 'kill');
			const hold = await reserve();
			expect(() => manager.spawn({ ...config, reuseTerminal })).toThrow(/reserved/);
			expect(manager.get(config.sessionId)).toBe(existing);
			expect(kill).not.toHaveBeenCalled();
			expect(unusableCwdReason).not.toHaveBeenCalled();
			hold.release();
			if (reuseTerminal) expect(manager.spawn({ ...config, reuseTerminal }).attached).toBe(true);
		}
	);

	it('refuses stale AI recovery before cleaning temp files or deleting registration', async () => {
		const existing = {
			sessionId: config.sessionId,
			pid: 0,
			isTerminal: false,
			tempFiles: ['user-file'],
		} as ManagedProcess;
		(Reflect.get(manager, 'processes') as Map<string, ManagedProcess>).set(
			config.sessionId,
			existing
		);
		await reserve();
		expect(() => manager.spawn({ ...config, toolType: 'claude-code' })).toThrow(/reserved/);
		expect(existing.tempFiles).toEqual(['user-file']);
		expect(manager.get(config.sessionId)).toBe(existing);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('refuses terminal-tab setup before shell/config getters and logging', async () => {
		const shell = vi.fn(() => 'bash');
		await reserve();
		expect(() =>
			manager.spawnTerminalTab({
				sessionId: config.sessionId,
				cwd: target,
				get shell() {
					return shell();
				},
			})
		).toThrow(/reserved/);
		expect(shell).not.toHaveBeenCalled();
		expect(logger.info).not.toHaveBeenCalled();
	});

	it('releases terminal setup failure and cwd refusal without manufacturing native completion', async () => {
		expect(() =>
			manager.spawnTerminalTab({
				sessionId: config.sessionId,
				cwd: target,
				get shell(): string {
					throw new Error('shell failed');
				},
			})
		).toThrow('shell failed');
		(await reserve()).release();
		vi.mocked(unusableCwdReason).mockReturnValue('missing cwd');
		expect(manager.spawn(config)).toMatchObject({ success: false });
		(await reserve()).release();
	});

	it.each(['success', 'failure', 'throw', 'reporting-error'])(
		'retains independent native activity after manager %s',
		async (outcome) => {
			vi.mocked(PtySpawner.prototype.spawn).mockImplementationOnce(() => {
				releases.push(beginGlobalWorktreeActivity());
				if (outcome === 'throw') throw new Error('post-start error');
				return { success: outcome !== 'failure', pid: 123 };
			});
			if (outcome === 'reporting-error')
				manager.on('spawn', () => {
					throw new Error('capture failed');
				});
			if (outcome === 'throw') expect(() => manager.spawn(config)).toThrow('post-start error');
			else expect(manager.spawn(config).success).toBe(outcome !== 'failure');
			manager.emit('exit', config.sessionId, 0);
			manager.emit('query-complete', config.sessionId);
			await blocked();
			releases.pop()!(); // The independently observed native completion owns release.
			(await reserve()).release();
		}
	);

	it('blocks a reservation already resolving when a direct spawn admits native work', async () => {
		let ready!: (value: string) => void;
		vi.mocked(fs.realpath).mockImplementationOnce(
			() =>
				new Promise((r) => {
					ready = r;
				})
		);
		const pending = reserveWorktreeCleanup(target);
		vi.mocked(PtySpawner.prototype.spawn).mockImplementationOnce(() => {
			releases.push(beginGlobalWorktreeActivity());
			return { success: true, pid: 123 };
		});
		manager.spawn(config);
		ready(target);
		expect(await pending).toMatchObject({ status: 'blocked' });
		releases.pop()!();
		(await reserve()).release();
	});

	it('releases synchronous dispatch failure without an independent native hold', async () => {
		vi.mocked(PtySpawner.prototype.spawn).mockImplementationOnce(() => {
			throw new Error('nonstart');
		});
		expect(() => manager.spawn(config)).toThrow('nonstart');
		(await reserve()).release();
	});

	it('refuses late fallback before harness recovery or child dispatch, then permits retry', async () => {
		const fallback = (Reflect.get(manager, 'fallbackToCli') as (c: ProcessConfig) => unknown).bind(
			manager
		);
		const harness = Reflect.get(manager, 'harnessControls') as { forget: (id: string) => void };
		const forget = vi.spyOn(harness, 'forget');
		const hold = await reserve();
		expect(() => fallback(config)).toThrow(/reserved/);
		expect(forget).not.toHaveBeenCalled();
		expect(ChildProcessSpawner.prototype.spawn).not.toHaveBeenCalled();
		hold.release();
		expect(fallback(config)).toEqual({ success: true, pid: 456 });
		expect(forget).toHaveBeenCalledWith(config.sessionId);
		(await reserve()).release();
	});

	it('releases failing fallback setup', async () => {
		const harness = Reflect.get(manager, 'harnessControls') as { forget: (id: string) => void };
		vi.spyOn(harness, 'forget').mockImplementationOnce(() => {
			throw new Error('recovery failed');
		});
		expect(() =>
			(Reflect.get(manager, 'fallbackToCli') as (c: ProcessConfig) => unknown).call(manager, config)
		).toThrow('recovery failed');
		(await reserve()).release();
	});

	it.each([false, true])(
		'refuses command routing before runner invocation (remote=%s)',
		async (remote) => {
			const local = vi.spyOn(LocalCommandRunner.prototype, 'run');
			const ssh = vi.spyOn(SshCommandRunner.prototype, 'run');
			await reserve();
			await expect(
				manager.runCommand(
					'cmd',
					'pwd',
					'/remote/project',
					undefined,
					undefined,
					remote ? ({ id: 'remote' } as never) : undefined
				)
			).rejects.toThrow(/reserved/);
			expect(local).not.toHaveBeenCalled();
			expect(ssh).not.toHaveBeenCalled();
		}
	);

	it.each([false, true])(
		'holds pending runner setup despite cancellation, releases on settlement (remote=%s)',
		async (remote) => {
			let settle!: (result: CommandResult) => void;
			const runner = remote ? SshCommandRunner : LocalCommandRunner;
			vi.spyOn(runner.prototype, 'run').mockImplementationOnce(
				() =>
					new Promise<CommandResult>((r) => {
						settle = r;
					})
			);
			vi.spyOn(runner.prototype, 'cancel').mockReturnValue(true);
			const pending = manager.runCommand(
				'cmd',
				'pwd',
				'/remote/project',
				undefined,
				undefined,
				remote ? ({ id: 'remote' } as never) : undefined
			);
			manager.cancelCommand('cmd');
			manager.emit('command-exit', 'cmd', 0);
			await blocked();
			expect(() => manager.spawn(config)).not.toThrow(); // Concurrent normal work is permitted.
			settle({ exitCode: 0 });
			await expect(pending).resolves.toEqual({ exitCode: 0 });
			(await reserve()).release();
		}
	);

	it.each(['throw', 'reject', 'native-close-later'])(
		'settles command %s without releasing independent child activity',
		async (outcome) => {
			vi.spyOn(LocalCommandRunner.prototype, 'run').mockImplementationOnce(() => {
				if (outcome === 'throw') throw new Error('setup failed');
				if (outcome === 'reject') return Promise.reject(new Error('setup failed'));
				releases.push(beginGlobalWorktreeActivity());
				return Promise.resolve({ exitCode: 137 });
			});
			const pending = manager.runCommand('cmd', 'pwd', target);
			if (outcome === 'native-close-later') {
				await pending;
				await blocked();
				releases.pop()!();
			} else await expect(pending).rejects.toThrow('setup failed');
			(await reserve()).release();
		}
	);
});

describe('direct manager input and steering activity', () => {
	it.each([target, path.join(target, 'child'), path.resolve('other-repository')])(
		'refuses input before process/control lookup or mutation under %s',
		async (root) => {
			const entries = Reflect.get(manager, 'processes') as Map<string, ManagedProcess>;
			const lookup = vi.spyOn(entries, 'get');
			const harness = Reflect.get(manager, 'harnessControls') as HarnessControlRegistry;
			const has = vi.spyOn(harness, 'has');
			await reserve(root);
			expect(() => manager.write(config.sessionId, 'rm user-file\n')).toThrow(/reserved/);
			expect(() => manager.resize(config.sessionId, 90, 30)).toThrow(/reserved/);
			await expect(manager.steer(config.sessionId, 'change files')).rejects.toThrow(/reserved/);
			for (const probe of [lookup, has, logger.error, sendSteeringRequest, steerCodexAppServerTurn])
				expect(probe).not.toHaveBeenCalled();
		}
	);

	it.each(['write', 'resize'] as const)(
		'protects retained PTY %s state under reservation, then permits retry',
		async (operation) => {
			const pty = { write: vi.fn(), resize: vi.fn() };
			const proc = {
				sessionId: config.sessionId,
				isTerminal: true,
				ptyProcess: pty,
				lastCommand: 'previous',
			} as unknown as ManagedProcess;
			(Reflect.get(manager, 'processes') as Map<string, ManagedProcess>).set(
				config.sessionId,
				proc
			);
			const invoke = () =>
				operation === 'write'
					? manager.write(config.sessionId, 'echo next\n')
					: manager.resize(config.sessionId, 90, 30);
			const hold = await reserve();
			expect(invoke).toThrow(/reserved/);
			expect(proc.lastCommand).toBe('previous');
			expect(pty[operation]).not.toHaveBeenCalled();
			hold.release();
			expect(invoke()).toBe(true);
			expect(pty[operation]).toHaveBeenCalledOnce();
			(await reserve()).release();
		}
	);

	it.each(['write', 'resize'] as const)(
		'releases synchronous PTY %s failure and reports the error',
		async (operation) => {
			const error = new Error('native dispatch failed');
			const capture = vi.spyOn(sentry, 'captureException').mockResolvedValue(undefined);
			const fail = vi.fn(() => {
				throw error;
			});
			(Reflect.get(manager, 'processes') as Map<string, ManagedProcess>).set(config.sessionId, {
				isTerminal: true,
				ptyProcess: { write: fail, resize: fail },
			} as unknown as ManagedProcess);
			expect(
				operation === 'write'
					? manager.write(config.sessionId, 'text')
					: manager.resize(config.sessionId, 90, 30)
			).toBe(false);
			expect(capture).toHaveBeenCalledWith(error);
			(await reserve()).release();
		}
	);

	it.each(['success', 'error'])(
		'holds each buffered stdin callback across removal/replacement and %s',
		async (outcome) => {
			const capture = vi.spyOn(sentry, 'captureException').mockResolvedValue(undefined);
			const callbacks: Array<(error?: Error | null) => void> = [];
			const write = vi.fn((_data: string, callback: (error?: Error | null) => void) => {
				callbacks.push(callback);
				return false; // Backpressure does not change the manager's accepted verdict.
			});
			const entries = Reflect.get(manager, 'processes') as Map<string, ManagedProcess>;
			const proc = { childProcess: { stdin: { write } } } as unknown as ManagedProcess;
			entries.set(config.sessionId, proc);
			expect(manager.write(config.sessionId, 'first')).toBe(true);
			entries.delete(config.sessionId);
			manager.emit('exit', config.sessionId, 0);
			manager.emit('query-complete', config.sessionId);
			await blocked();
			entries.set(config.sessionId, { ...proc });
			expect(manager.write(config.sessionId, 'replacement')).toBe(true);
			callbacks[1]();
			await blocked();
			const error = new Error('late stdin error');
			callbacks[0](outcome === 'error' ? error : undefined);
			await vi.waitFor(async () => (await reserve()).release());
			if (outcome === 'error') expect(capture).toHaveBeenCalledWith(error);
			else expect(capture).not.toHaveBeenCalled();
		}
	);

	it('releases a synchronous stdin throw without changing the false verdict', async () => {
		const error = new Error('write threw');
		const capture = vi.spyOn(sentry, 'captureException').mockResolvedValue(undefined);
		(Reflect.get(manager, 'processes') as Map<string, ManagedProcess>).set(config.sessionId, {
			childProcess: {
				stdin: {
					write: () => {
						throw error;
					},
				},
			},
		} as unknown as ManagedProcess);
		expect(manager.write(config.sessionId, 'text')).toBe(false);
		await vi.waitFor(async () => (await reserve()).release());
		expect(capture).toHaveBeenCalledExactlyOnceWith(error);
	});

	it('blocks an already pending reservation until stdin acknowledgement', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockImplementationOnce(() => canonical.promise);
		const pending = reserveWorktreeCleanup(target);
		let acknowledge!: () => void;
		(Reflect.get(manager, 'processes') as Map<string, ManagedProcess>).set(config.sessionId, {
			childProcess: {
				stdin: {
					write: (_data: string, callback: () => void) => {
						acknowledge = callback;
					},
				},
			},
		} as unknown as ManagedProcess);
		manager.write(config.sessionId, 'text');
		canonical.resolve(target);
		expect(await pending).toMatchObject({ status: 'blocked' });
		acknowledge();
		await vi.waitFor(async () => (await reserve()).release());
	});

	it.each(['harness', 'codex', 'maestro-p'] as const)(
		'holds complete %s steering through entry replacement and settlement',
		async (route) => {
			const completion = Promise.withResolvers<SteeringResultFrame>();
			const harness = Reflect.get(manager, 'harnessControls') as HarnessControlRegistry;
			vi.spyOn(harness, 'has').mockReturnValue(route === 'harness');
			const steer = vi.spyOn(harness, 'steer').mockReturnValue(completion.promise);
			vi.mocked(steerCodexAppServerTurn).mockReturnValue(completion.promise);
			vi.mocked(sendSteeringRequest).mockReturnValue(completion.promise);
			const entries = Reflect.get(manager, 'processes') as Map<string, ManagedProcess>;
			entries.set(config.sessionId, {
				codexAppServer: route === 'codex' ? {} : undefined,
			} as ManagedProcess);
			const pending = manager.steer(config.sessionId, 'text');
			entries.delete(config.sessionId);
			manager.emit('exit', config.sessionId, 0);
			await blocked();
			entries.set(config.sessionId, {} as ManagedProcess);
			const verdict = { type: 'steering', id: 'reply', verdict: 'delivered' } as const;
			completion.resolve(verdict);
			await expect(pending).resolves.toEqual(verdict);
			expect(
				route === 'harness'
					? steer
					: route === 'codex'
						? steerCodexAppServerTurn
						: sendSteeringRequest
			).toHaveBeenCalledOnce();
			(await reserve()).release();
		}
	);

	it.each(['throw', 'reject'] as const)(
		'releases steering %s and preserves failure',
		async (outcome) => {
			(Reflect.get(manager, 'processes') as Map<string, ManagedProcess>).set(
				config.sessionId,
				{} as ManagedProcess
			);
			const error = new Error('control failed');
			vi.mocked(sendSteeringRequest).mockImplementationOnce(() => {
				if (outcome === 'throw') throw error;
				return Promise.reject(error);
			});
			await expect(manager.steer(config.sessionId, 'text')).rejects.toBe(error);
			(await reserve()).release();
		}
	);

	it('keeps independent native activity after write and steering acknowledgements', async () => {
		const releaseNative = beginGlobalWorktreeActivity();
		releases.push(releaseNative);
		(Reflect.get(manager, 'processes') as Map<string, ManagedProcess>).set(config.sessionId, {
			childProcess: { stdin: { write: (_data: string, callback: () => void) => callback() } },
		} as unknown as ManagedProcess);
		vi.mocked(sendSteeringRequest).mockResolvedValue({
			type: 'steering',
			id: 'reply',
			verdict: 'unknown',
		});
		expect(manager.write(config.sessionId, 'text')).toBe(true);
		await manager.steer(config.sessionId, 'text');
		await blocked();
		releaseNative();
		(await reserve()).release();
	});

	it('preserves no-process and unsupported-input verdicts without retaining activity', async () => {
		expect(manager.write(config.sessionId, 'text')).toBe(false);
		expect(manager.resize(config.sessionId, 90, 30)).toBe(false);
		await expect(manager.steer(config.sessionId, 'text')).resolves.toMatchObject({
			verdict: 'refused',
			refusal: 'not-running',
		});
		(Reflect.get(manager, 'processes') as Map<string, ManagedProcess>).set(
			config.sessionId,
			{} as ManagedProcess
		);
		expect(manager.write(config.sessionId, 'text')).toBe(false);
		expect(manager.resize(config.sessionId, 90, 30)).toBe(false);
		(await reserve()).release();
	});
});
