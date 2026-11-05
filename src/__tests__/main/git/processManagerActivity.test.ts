import fs from 'fs/promises';
import path from 'path';
import { EventEmitter } from 'events';
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
		closeSession = vi.fn(() => false);
		closeAgent = vi.fn();
		closeAll = vi.fn(async () => {});
	},
}));

import { ProcessManager } from '../../../main/process-manager/ProcessManager';
import { PtySpawner } from '../../../main/process-manager/spawners/PtySpawner';
import { ChildProcessSpawner } from '../../../main/process-manager/spawners/ChildProcessSpawner';
import { CopilotSdkSpawner } from '../../../main/process-manager/spawners/CopilotSdkSpawner';
import { opencodeServerManager } from '../../../main/opencode-server/OpencodeServerManager';
import { LocalCommandRunner } from '../../../main/process-manager/runners/LocalCommandRunner';
import { SshCommandRunner } from '../../../main/process-manager/runners/SshCommandRunner';
import { unusableCwdReason } from '../../../main/process-manager/utils/spawnCwd';
import { logger } from '../../../main/utils/logger';
import * as sentry from '../../../main/utils/sentry';
import { sendSteeringRequest } from '../../../main/process-manager/steering-client';
import { steerCodexAppServerTurn } from '../../../main/codex-app-server/steering';
import type { HarnessControlRegistry } from '../../../main/harness-control/HarnessControlRegistry';
import type { SteeringResultFrame } from '../../../shared/chatSteering';
import { INTERACTIVE_STOP_GRACE_MS } from '../../../shared/maestro-lib/control/termination';
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
	vi.spyOn(sentry, 'captureException').mockResolvedValue(undefined);
	vi.spyOn(PtySpawner.prototype, 'spawn').mockReturnValue({ success: true, pid: 123 });
	vi.spyOn(ChildProcessSpawner.prototype, 'spawn').mockReturnValue({ success: true, pid: 456 });
});

afterEach(() => {
	for (const release of releases) release();
	vi.restoreAllMocks();
});

describe('delayed remote termination activity', () => {
	let child: EventEmitter & { exitCode: number | null; signalCode: NodeJS.Signals | null };
	let proc: ManagedProcess;
	let schedule: () => void;
	let signal: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
		proc = { sessionId: config.sessionId, sshRemotePidFile: 'remote-agent.pid' } as ManagedProcess;
		const control = manager as unknown as {
			scheduleRemoteTerminate: (id: string, p: ManagedProcess, c: unknown) => void;
			signalRemote: (id: string, p: ManagedProcess, mode: string) => void;
		};
		schedule = () => control.scheduleRemoteTerminate(config.sessionId, proc, child);
		signal = vi.spyOn(control, 'signalRemote').mockImplementation(() => {});
		vi.spyOn(sentry, 'captureException').mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it.each([target, path.join(target, 'child'), path.resolve('other-repository')])(
		'refuses before target getters, timers or listeners under %s',
		async (root) => {
			const hold = await reserve(root);
			const getter = vi.fn(() => 'remote-agent.pid');
			Object.defineProperty(proc, 'sshRemotePidFile', { get: getter });
			const timers = vi.spyOn(globalThis, 'setTimeout');
			const listen = vi.spyOn(child, 'once');
			expect(schedule).toThrow(/reserved/);
			for (const probe of [getter, timers, listen, signal, sentry.captureException])
				expect(probe).not.toHaveBeenCalled();
			hold.release();
			schedule();
			child.emit('exit');
			await vi.advanceTimersByTimeAsync(0);
			(await reserve()).release();
		}
	);

	it('holds through registry replacement and close until the callback completes', async () => {
		schedule();
		const entries = Reflect.get(manager, 'processes') as Map<string, ManagedProcess>;
		entries.set(config.sessionId, proc);
		entries.delete(config.sessionId);
		entries.set(config.sessionId, { sessionId: config.sessionId } as ManagedProcess);
		manager.emit('exit', config.sessionId, 0);
		child.on('error', () => {});
		child.emit('error', new Error('transport failed'));
		child.emit('close');
		await blocked();
		await vi.advanceTimersByTimeAsync(INTERACTIVE_STOP_GRACE_MS - 1);
		expect(signal).not.toHaveBeenCalled();
		await blocked();
		await vi.advanceTimersByTimeAsync(1);
		expect(signal).toHaveBeenCalledExactlyOnceWith(config.sessionId, proc, 'terminate');
		expect(child.listenerCount('exit')).toBe(0);
		(await reserve()).release();
	});

	it('cancels on observed exit without waiting for close or delivering a late signal', async () => {
		schedule();
		child.exitCode = 0;
		child.emit('exit', 0, null);
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBe(0);
		expect(child.listenerCount('exit')).toBe(0);
		const hold = await reserve();
		await vi.advanceTimersByTimeAsync(INTERACTIVE_STOP_GRACE_MS);
		expect(signal).not.toHaveBeenCalled();
		hold.release();
	});

	it.each(['exitCode', 'signalCode'] as const)(
		'skips signalling on an observed %s even if the exit listener was missed',
		async (field) => {
			schedule();
			Object.assign(child, field === 'exitCode' ? { exitCode: 0 } : { signalCode: 'SIGTERM' });
			await blocked();
			await vi.advanceTimersByTimeAsync(INTERACTIVE_STOP_GRACE_MS);
			expect(signal).not.toHaveBeenCalled();
			expect(child.listenerCount('exit')).toBe(0);
			(await reserve()).release();
		}
	);

	it('keeps concurrent generations independent and refuses a new timer during reservation', async () => {
		schedule();
		const first = child;
		child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
		proc = { ...proc, sshRemotePidFile: 'replacement.pid' };
		schedule();
		first.emit('exit');
		await vi.advanceTimersByTimeAsync(0);
		await blocked();
		await vi.advanceTimersByTimeAsync(INTERACTIVE_STOP_GRACE_MS);
		expect(signal).toHaveBeenCalledExactlyOnceWith(config.sessionId, proc, 'terminate');
		const hold = await reserve();
		expect(schedule).toThrow(/reserved/);
		expect(vi.getTimerCount()).toBe(0);
		hold.release();
	});

	it.each(['cancel', 'callback'] as const)(
		'preserves an independently owned native hold after timer %s',
		async (outcome) => {
			let releaseNative = beginGlobalWorktreeActivity();
			releases.push(() => releaseNative());
			signal.mockImplementation(() => {
				releaseNative();
				releaseNative = beginGlobalWorktreeActivity();
			});
			schedule();
			if (outcome === 'cancel') child.emit('exit');
			await vi.advanceTimersByTimeAsync(INTERACTIVE_STOP_GRACE_MS);
			await blocked();
			releaseNative();
			(await reserve()).release();
		}
	);

	it.each(['timer', 'listener', 'registered-listener'] as const)(
		'cancels all scheduled work and reports a %s setup failure',
		async (stage) => {
			const error = new Error('scheduling failed');
			if (stage === 'timer')
				vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce(() => {
					throw error;
				});
			else {
				const once = child.once;
				vi.spyOn(child, 'once').mockImplementationOnce((event, listener) => {
					if (stage === 'registered-listener') once.call(child, event, listener);
					throw error;
				});
			}
			expect(schedule).toThrow(error);
			expect(sentry.captureException).toHaveBeenCalledWith(error);
			await vi.advanceTimersByTimeAsync(INTERACTIVE_STOP_GRACE_MS);
			expect(vi.getTimerCount()).toBe(0);
			expect(child.listenerCount('exit')).toBe(0);
			expect(signal).not.toHaveBeenCalled();
			(await reserve()).release();
		}
	);

	it('finishes timer bookkeeping while letting an unexpected callback exception propagate', async () => {
		const error = new Error('unexpected signal failure');
		signal.mockImplementation(() => {
			throw error;
		});
		schedule();
		expect(() => vi.advanceTimersByTime(INTERACTIVE_STOP_GRACE_MS)).toThrow(error);
		await vi.advanceTimersByTimeAsync(0);
		expect(child.listenerCount('exit')).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		(await reserve()).release();
	});

	it('stays busy if exit cancellation fails until the pending callback really finishes', async () => {
		schedule();
		child.exitCode = 0;
		const error = new Error('timer cancellation failed');
		vi.spyOn(globalThis, 'clearTimeout').mockImplementationOnce(() => {
			throw error;
		});
		expect(() => child.emit('exit')).toThrow(error);
		await blocked();
		await vi.advanceTimersByTimeAsync(INTERACTIVE_STOP_GRACE_MS);
		expect(signal).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		(await reserve()).release();
	});

	it('settles an exit delivered during listener registration without leaving a timer', async () => {
		const once = child.once;
		vi.spyOn(child, 'once').mockImplementationOnce((event, listener) => {
			once.call(child, event, listener);
			child.emit('exit');
			return child;
		});
		schedule();
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBe(0);
		expect(child.listenerCount('exit')).toBe(0);
		expect(signal).not.toHaveBeenCalled();
		(await reserve()).release();
	});

	it('admits while reservation canonicalization is pending and blocks that reservation', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const pending = reserveWorktreeCleanup(target);
		schedule();
		canonical.resolve(target);
		expect(await pending).toMatchObject({ status: 'blocked' });
		child.emit('exit');
		await vi.advanceTimersByTimeAsync(0);
		(await reserve()).release();
	});

	it('preserves no-op local targets and releases failed target lookup before timer creation', async () => {
		delete proc.sshRemotePidFile;
		schedule();
		(await reserve()).release();
		const error = new Error('target unavailable');
		Object.defineProperty(proc, 'sshRemotePidFile', {
			get: () => {
				throw error;
			},
		});
		expect(schedule).toThrow(error);
		expect(sentry.captureException).toHaveBeenCalledWith(error);
		expect(vi.getTimerCount()).toBe(0);
		(await reserve()).release();
	});
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
			for (const probe of [
				lookup,
				has,
				logger.error,
				sentry.captureException,
				sendSteeringRequest,
				steerCodexAppServerTurn,
			])
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
			await vi.waitFor(async () => (await reserve()).release());
			expect(capture).toHaveBeenCalledWith(error);
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

describe('direct manager stop and close activity', () => {
	it.each([target, path.join(target, 'child'), path.resolve('other-repository')])(
		'refuses every stop entry before lookup, options, state or recovery under %s',
		async (root) => {
			const entries = Reflect.get(manager, 'processes') as Map<string, ManagedProcess>;
			const proc = { sessionId: config.sessionId, interrupted: false } as ManagedProcess;
			entries.set(config.sessionId, proc);
			const probes = ['get', 'keys', 'values'].map((method) => vi.spyOn(entries, method as 'get'));
			const buffer = Reflect.get(manager, 'bufferManager') as { flushDataBuffer: () => void };
			const flush = vi.spyOn(buffer, 'flushDataBuffer');
			const shutdown = vi.spyOn(opencodeServerManager, 'shutdown').mockImplementation(() => {});
			const copilot = Reflect.get(manager, 'copilotSdkSpawner') as CopilotSdkSpawner;
			const option = vi.fn(() => true);
			const options = {
				get shutdown() {
					return option();
				},
			};
			const hold = await reserve(root);
			expect(() => manager.interrupt(config.sessionId)).toThrow(/reserved/);
			expect(() => manager.kill(config.sessionId, options)).toThrow(/reserved/);
			expect(() => manager.killAll(options)).toThrow(/reserved/);
			expect(() => manager.closeAgent('manager')).toThrow(/reserved/);
			for (const probe of [
				...probes,
				option,
				flush,
				shutdown,
				copilot.closeSession,
				copilot.closeAgent,
				copilot.closeAll,
				logger.error,
				sentry.captureException,
			])
				expect(probe).not.toHaveBeenCalled();
			expect(proc.interrupted).toBe(false);
			hold.release();
			expect(entries.get(config.sessionId)).toBe(proc);
		}
	);

	it.each(['interrupt', 'kill'] as const)(
		'holds both generations of pending harness %s after map removal and replacement',
		async (operation) => {
			const entries = Reflect.get(manager, 'processes') as Map<string, ManagedProcess>;
			const harness = Reflect.get(manager, 'harnessControls') as HarnessControlRegistry;
			vi.spyOn(harness, 'has').mockReturnValue(true);
			const first = Promise.withResolvers<boolean>();
			const second = Promise.withResolvers<boolean>();
			const control = vi
				.spyOn(harness, operation === 'kill' ? 'close' : 'interrupt')
				.mockReturnValueOnce(first.promise)
				.mockReturnValueOnce(second.promise);
			const proc = { sessionId: config.sessionId } as ManagedProcess;
			entries.set(config.sessionId, proc);
			expect(manager[operation](config.sessionId)).toBe(true);
			expect(proc.interrupted).toBe(true);
			if (operation === 'kill') expect(entries.has(config.sessionId)).toBe(false);
			else expect(entries.get(config.sessionId)).toBe(proc);
			entries.delete(config.sessionId);
			manager.emit('exit', config.sessionId, 0);
			await blocked();
			entries.set(config.sessionId, { ...proc });
			expect(manager[operation](config.sessionId)).toBe(true);
			second.resolve(true);
			await blocked();
			first.resolve(false); // A refused protocol request still has to settle.
			await vi.waitFor(async () => (await reserve()).release());
			expect(control).toHaveBeenCalledTimes(2);
		}
	);

	it.each(['interrupt', 'kill'] as const)(
		'observes rejected harness %s and preserves the synchronous accepted verdict',
		async (operation) => {
			const error = new Error('late control failure');
			const capture = vi.spyOn(sentry, 'captureException').mockResolvedValue(undefined);
			const harness = Reflect.get(manager, 'harnessControls') as HarnessControlRegistry;
			vi.spyOn(harness, 'has').mockReturnValue(true);
			const pending = Promise.withResolvers<boolean>();
			vi.spyOn(harness, operation === 'kill' ? 'close' : 'interrupt').mockReturnValue(
				pending.promise
			);
			(Reflect.get(manager, 'processes') as Map<string, ManagedProcess>).set(config.sessionId, {
				sessionId: config.sessionId,
			} as ManagedProcess);
			expect(manager[operation](config.sessionId)).toBe(true);
			await blocked();
			pending.reject(error);
			await vi.waitFor(async () => (await reserve()).release());
			expect(capture).toHaveBeenCalledWith(error);
		}
	);

	it.each(['interrupt', 'kill'] as const)(
		'reports synchronous SDK %s failure without leaking caller activity',
		async (operation) => {
			const error = new Error('control dispatch failed');
			const capture = vi.spyOn(sentry, 'captureException').mockResolvedValue(undefined);
			const fail = vi.fn(() => {
				throw error;
			});
			const proc = { sdkController: { interrupt: fail, kill: fail } } as unknown as ManagedProcess;
			(Reflect.get(manager, 'processes') as Map<string, ManagedProcess>).set(
				config.sessionId,
				proc
			);
			expect(manager[operation](config.sessionId)).toBe(false);
			expect(proc.interrupted).toBe(true);
			await vi.waitFor(async () => (await reserve()).release());
			expect(capture).toHaveBeenCalledWith(error);
		}
	);

	it.each(['interrupt', 'kill'] as const)(
		'keeps independently held native work after synchronous SDK %s dispatch',
		async (operation) => {
			const releaseNative = beginGlobalWorktreeActivity();
			releases.push(releaseNative);
			const dispatch = vi.fn();
			(Reflect.get(manager, 'processes') as Map<string, ManagedProcess>).set(config.sessionId, {
				sdkController: { interrupt: dispatch, kill: dispatch },
			} as unknown as ManagedProcess);
			expect(manager[operation](config.sessionId)).toBe(true);
			expect(dispatch).toHaveBeenCalledOnce();
			await blocked();
			releaseNative();
			(await reserve()).release();
		}
	);

	it('preserves PTY Ctrl+C and forwards kill sync/shutdown flags to native control', async () => {
		const entries = Reflect.get(manager, 'processes') as Map<string, ManagedProcess>;
		const write = vi.fn();
		entries.set(config.sessionId, {
			isTerminal: true,
			ptyProcess: { write },
		} as unknown as ManagedProcess);
		expect(manager.interrupt(config.sessionId)).toBe(true);
		expect(write).toHaveBeenCalledExactlyOnceWith('\x03');
		const kill = vi.fn();
		entries.set(config.sessionId, { sdkController: { kill } } as unknown as ManagedProcess);
		expect(manager.kill(config.sessionId, { sync: true, shutdown: true })).toBe(true);
		expect(kill).toHaveBeenCalledExactlyOnceWith({ sync: true, shutdown: true });
		expect(entries.size).toBe(0);
		(await reserve()).release();
	});

	it.each(['success', 'reject'])(
		'holds aggregate shutdown across empty registry and pending Copilot %s',
		async (outcome) => {
			const capture = vi.spyOn(sentry, 'captureException').mockResolvedValue(undefined);
			const shutdown = vi.spyOn(opencodeServerManager, 'shutdown').mockImplementation(() => {});
			const copilot = Reflect.get(manager, 'copilotSdkSpawner') as CopilotSdkSpawner;
			const pending = Promise.withResolvers<void>();
			vi.mocked(copilot.closeAll).mockReturnValueOnce(pending.promise);
			const dispatch = vi.fn();
			const entries = Reflect.get(manager, 'processes') as Map<string, ManagedProcess>;
			entries.set(config.sessionId, {
				sdkController: { kill: dispatch },
			} as unknown as ManagedProcess);
			expect(manager.killAll({ shutdown: true })).toBeUndefined();
			expect(entries.size).toBe(0);
			expect(dispatch).toHaveBeenCalledWith({ sync: true, shutdown: true });
			expect(shutdown).toHaveBeenCalledOnce();
			expect(copilot.closeAll).toHaveBeenCalledOnce();
			manager.emit('exit', config.sessionId, 0);
			await blocked();
			const error = new Error('shutdown failed');
			if (outcome === 'reject') pending.reject(error);
			else pending.resolve();
			await vi.waitFor(async () => (await reserve()).release());
			if (outcome === 'reject')
				expect(capture).toHaveBeenCalledWith(error, {
					context: 'Copilot native connection shutdown',
				});
		}
	);

	it('keeps nested harness close pending after closeAgent returns and filters other agents', async () => {
		const entries = Reflect.get(manager, 'processes') as Map<string, ManagedProcess>;
		const harness = Reflect.get(manager, 'harnessControls') as HarnessControlRegistry;
		vi.spyOn(harness, 'has').mockReturnValue(true);
		const pending = Promise.withResolvers<boolean>();
		vi.spyOn(harness, 'close').mockReturnValue(pending.promise);
		entries.set('manager-ai-tab', { sessionId: 'manager-ai-tab' } as ManagedProcess);
		const other = { sessionId: 'another-ai-tab' } as ManagedProcess;
		entries.set(other.sessionId, other);
		const copilot = Reflect.get(manager, 'copilotSdkSpawner') as CopilotSdkSpawner;
		manager.closeAgent('manager');
		expect(entries.has('manager-ai-tab')).toBe(false);
		expect(entries.get(other.sessionId)).toBe(other);
		expect(copilot.closeAgent).toHaveBeenCalledExactlyOnceWith('manager');
		await blocked();
		pending.resolve(true);
		await vi.waitFor(async () => (await reserve()).release());
	});

	it.each(['killAll', 'closeAgent'] as const)(
		'releases outer activity when %s throws during aggregate setup',
		async (operation) => {
			const error = new Error('shutdown setup failed');
			vi.spyOn(sentry, 'captureException').mockResolvedValue(undefined);
			const copilot = Reflect.get(manager, 'copilotSdkSpawner') as CopilotSdkSpawner;
			if (operation === 'killAll')
				vi.spyOn(opencodeServerManager, 'shutdown').mockImplementation(() => {
					throw error;
				});
			else
				vi.mocked(copilot.closeAgent).mockImplementation(() => {
					throw error;
				});
			expect(() =>
				operation === 'killAll' ? manager.killAll() : manager.closeAgent('manager')
			).toThrow(error);
			(await reserve()).release();
		}
	);

	it('preserves missing-process and retained-session close verdicts without a native hold', async () => {
		const copilot = Reflect.get(manager, 'copilotSdkSpawner') as CopilotSdkSpawner;
		expect(manager.interrupt('missing')).toBe(false);
		expect(manager.kill('missing')).toBe(false);
		vi.mocked(copilot.closeSession).mockReturnValue(true);
		expect(manager.kill('retained')).toBe(true);
		expect(copilot.closeSession).toHaveBeenLastCalledWith('retained');
		(await reserve()).release();
	});
});

describe('manager asynchronous control diagnostics', () => {
	it.each(
		(['write', 'resize', 'interrupt', 'kill'] as const).flatMap((operation) =>
			(['resolve', 'reject', 'throw'] as const).map((settlement) => ({ operation, settlement }))
		)
	)(
		'retains $operation failure diagnostics until $settlement with the original false verdict',
		async ({ operation, settlement }) => {
			const error = new Error('native control failed');
			const reporting = Promise.withResolvers<void>();
			const capture = vi.mocked(sentry.captureException).mockImplementation(() => {
				if (settlement === 'throw') throw new Error('reporter threw');
				return reporting.promise;
			});
			const fail = vi.fn(() => {
				throw error;
			});
			const entries = Reflect.get(manager, 'processes') as Map<string, ManagedProcess>;
			entries.set(config.sessionId, {
				sessionId: config.sessionId,
				isTerminal: true,
				ptyProcess: { write: fail, resize: fail },
				sdkController: { interrupt: fail, kill: fail },
			} as unknown as ManagedProcess);
			try {
				const result =
					operation === 'write'
						? manager.write(config.sessionId, 'text')
						: operation === 'resize'
							? manager.resize(config.sessionId, 80, 24)
							: manager[operation](config.sessionId);
				expect(result).toBe(false);
				await vi.waitFor(() => expect(capture).toHaveBeenCalledExactlyOnceWith(error));
				entries.delete(config.sessionId);
				manager.emit('exit', config.sessionId, 0);
				manager.emit('query-complete', config.sessionId);
				if (settlement !== 'throw') await blocked();
				if (settlement === 'reject') reporting.reject(new Error('reporter rejected'));
				else reporting.resolve();
				await vi.waitFor(async () => (await reserve()).release());
				expect(capture).toHaveBeenCalledOnce();
			} finally {
				reporting.resolve();
			}
		}
	);

	it.each(['write', 'resize', 'interrupt', 'kill'] as const)(
		'retains %s diagnostics when the synchronous logger also throws',
		async (operation) => {
			const original = new Error('control failed');
			const logging = new Error('logger failed');
			const reporting = Promise.withResolvers<void>();
			const capture = vi
				.mocked(sentry.captureException)
				.mockImplementation((error) =>
					error === original ? reporting.promise : Promise.resolve()
				);
			const fail = () => {
				throw original;
			};
			(Reflect.get(manager, 'processes') as Map<string, ManagedProcess>).set(config.sessionId, {
				isTerminal: true,
				ptyProcess: { write: fail, resize: fail },
				sdkController: { interrupt: fail, kill: fail },
			} as unknown as ManagedProcess);
			vi.mocked(logger.error).mockImplementationOnce(() => {
				throw logging;
			});
			try {
				expect(() =>
					operation === 'write'
						? manager.write(config.sessionId, 'text')
						: operation === 'resize'
							? manager.resize(config.sessionId, 80, 24)
							: manager[operation](config.sessionId)
				).toThrow(logging);
				await vi.waitFor(() => expect(capture).toHaveBeenCalledWith(original));
				expect(capture).toHaveBeenCalledWith(logging);
				await blocked();
				reporting.resolve();
				await vi.waitFor(async () => (await reserve()).release());
				expect(capture).toHaveBeenCalledTimes(2);
			} finally {
				reporting.resolve();
			}
		}
	);

	it.each(
		(['stdin', 'interrupt', 'kill'] as const).flatMap((operation) =>
			(['resolve', 'reject'] as const).map((settlement) => ({ operation, settlement }))
		)
	)(
		'retains late $operation failure diagnostics through $settlement independently of native close',
		async ({ operation, settlement }) => {
			const pending = Promise.withResolvers<boolean>();
			const reporting = Promise.withResolvers<void>();
			const error = new Error('late control rejection');
			const capture = vi.mocked(sentry.captureException).mockReturnValue(reporting.promise);
			const harness = Reflect.get(manager, 'harnessControls') as HarnessControlRegistry;
			vi.spyOn(harness, 'has').mockReturnValue(true);
			vi.spyOn(harness, 'interrupt').mockReturnValue(pending.promise);
			vi.spyOn(harness, 'close').mockReturnValue(pending.promise);
			let acknowledge!: (error: Error) => void;
			const entries = Reflect.get(manager, 'processes') as Map<string, ManagedProcess>;
			entries.set(config.sessionId, {
				childProcess: {
					stdin: {
						write: (_data: string, callback: (error: Error) => void) => {
							acknowledge = callback;
						},
					},
				},
			} as unknown as ManagedProcess);
			const nativeRelease = beginGlobalWorktreeActivity();
			releases.push(nativeRelease);
			try {
				expect(
					operation === 'stdin'
						? manager.write(config.sessionId, 'text')
						: manager[operation](config.sessionId)
				).toBe(true);
				entries.delete(config.sessionId);
				manager.emit('exit', config.sessionId, 0);
				if (operation === 'stdin') acknowledge(error);
				else pending.reject(error);
				await vi.waitFor(() => expect(capture).toHaveBeenCalledExactlyOnceWith(error));
				nativeRelease();
				await blocked();
				if (settlement === 'reject') reporting.reject(new Error('diagnostic failure'));
				else reporting.resolve();
				await vi.waitFor(async () => (await reserve()).release());
				expect(capture).toHaveBeenCalledOnce();
			} finally {
				pending.resolve(false);
				reporting.resolve();
			}
		}
	);

	it.each(['resolve', 'reject', 'throw'] as const)(
		'retains aggregate shutdown diagnostics through %s without recursively reporting',
		async (settlement) => {
			vi.spyOn(opencodeServerManager, 'shutdown').mockImplementation(() => {});
			const copilot = Reflect.get(manager, 'copilotSdkSpawner') as CopilotSdkSpawner;
			vi.mocked(copilot.closeAll).mockRejectedValueOnce('connection failed');
			const reporting = Promise.withResolvers<void>();
			const capture = vi.mocked(sentry.captureException).mockImplementation(() => {
				if (settlement === 'throw') throw new Error('reporter threw');
				return reporting.promise;
			});
			try {
				expect(manager.killAll()).toBeUndefined();
				await vi.waitFor(() =>
					expect(capture).toHaveBeenCalledExactlyOnceWith(
						expect.objectContaining({ message: 'connection failed' }),
						{ context: 'Copilot native connection shutdown' }
					)
				);
				if (settlement !== 'throw') await blocked();
				if (settlement === 'reject') reporting.reject(new Error('reporter rejected'));
				else reporting.resolve();
				await vi.waitFor(async () => (await reserve()).release());
				expect(capture).toHaveBeenCalledOnce();
			} finally {
				reporting.resolve();
			}
		}
	);

	it.each(['killAll', 'remote-timer'] as const)(
		'preserves %s setup exception while asynchronous diagnostics remain pending',
		async (operation) => {
			const error = new Error('setup failed');
			const reporting = Promise.withResolvers<void>();
			const capture = vi.mocked(sentry.captureException).mockReturnValue(reporting.promise);
			vi.spyOn(opencodeServerManager, 'shutdown').mockImplementation(() => {
				throw error;
			});
			const proc = {
				get sshRemotePidFile(): string {
					throw error;
				},
			} as ManagedProcess;
			const schedule = Reflect.get(manager, 'scheduleRemoteTerminate') as (
				...args: unknown[]
			) => void;
			try {
				expect(() =>
					operation === 'killAll'
						? manager.killAll()
						: schedule.call(manager, config.sessionId, proc, new EventEmitter())
				).toThrow(error);
				expect(capture).toHaveBeenCalledExactlyOnceWith(error);
				await blocked();
				reporting.resolve();
				await vi.waitFor(async () => (await reserve()).release());
			} finally {
				reporting.resolve();
			}
		}
	);

	it('retains independent native activity after diagnostics finish first', async () => {
		const reporting = Promise.withResolvers<void>();
		vi.mocked(sentry.captureException).mockReturnValue(reporting.promise);
		const nativeRelease = beginGlobalWorktreeActivity();
		releases.push(nativeRelease);
		(Reflect.get(manager, 'processes') as Map<string, ManagedProcess>).set(config.sessionId, {
			sdkController: {
				interrupt: () => {
					throw new Error('control failed');
				},
			},
		} as unknown as ManagedProcess);
		try {
			expect(manager.interrupt(config.sessionId)).toBe(false);
			await vi.waitFor(() => expect(sentry.captureException).toHaveBeenCalledOnce());
			reporting.resolve();
			await blocked();
			nativeRelease();
			await vi.waitFor(async () => (await reserve()).release());
		} finally {
			reporting.resolve();
		}
	});

	it('keeps concurrent diagnostics, pending canonicalization and successor stdin independently owned', async () => {
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		vi.mocked(sentry.captureException)
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const entries = Reflect.get(manager, 'processes') as Map<string, ManagedProcess>;
		const fail = () => {
			throw new Error('write failed');
		};
		entries.set(config.sessionId, {
			isTerminal: true,
			ptyProcess: { write: fail },
		} as unknown as ManagedProcess);
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const reservation = reserveWorktreeCleanup(target);
		let acknowledge!: () => void;
		try {
			expect(manager.write(config.sessionId, 'first')).toBe(false);
			expect(manager.write(config.sessionId, 'second')).toBe(false);
			canonical.resolve(target);
			const hold = await reservation;
			if (hold.status === 'reserved-partially') releases.push(hold.release);
			expect(hold).toMatchObject({ status: 'blocked' });
			entries.set(config.sessionId, {
				childProcess: {
					stdin: {
						write: (_data: string, callback: () => void) => {
							acknowledge = callback;
						},
					},
				},
			} as unknown as ManagedProcess);
			expect(manager.write(config.sessionId, 'successor')).toBe(true);
			first.resolve();
			await blocked();
			second.resolve();
			await blocked();
			acknowledge();
			await vi.waitFor(async () => (await reserve()).release());
			expect(sentry.captureException).toHaveBeenCalledTimes(2);
		} finally {
			canonical.resolve(target);
			first.resolve();
			second.resolve();
			acknowledge?.();
		}
	});
});
