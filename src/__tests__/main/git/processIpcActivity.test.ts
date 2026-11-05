import fs from 'fs/promises';
import path from 'path';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { ipcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessHandlerDependencies } from '../../../main/ipc/handlers/process';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));
vi.mock('fs/promises', () => ({ default: { realpath: vi.fn() } }));
vi.mock('child_process', async (importOriginal) => ({
	...(await importOriginal<typeof import('child_process')>()),
	spawn: vi.fn(),
}));
vi.mock('../../../main/plugins/relay-conversations', () => ({}));
vi.mock('../../../main/permission-relay/registry', () => ({}));
vi.mock('../../../main/utils/headless-agent-activity', () => ({}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/utils/safe-send', () => ({}));
vi.mock('../../../main/process-manager/utils/childProcessInfo', () => ({}));
vi.mock('../../../main/concerto-html', () => ({}));
vi.mock('../../../main/ipc/handlers/process/handle-spawn', () => ({
	handleProcessSpawn: vi.fn(),
}));
vi.mock('../../../main/permission-relay', () => ({ initPermissionRelay: vi.fn() }));
vi.mock('../../../main/harness-control/integration', () => ({ initHarnessControl: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/utils/cliDetection', () => ({
	resolveSshPath: vi.fn(),
	getExpandedEnv: vi.fn(() => ({})),
}));
vi.mock('../../../main/process-manager/utils/commandKill', () => ({
	killProcessTreeNow: vi.fn(),
}));

import { resolveSshPath } from '../../../main/utils/cliDetection';
import { handleProcessSpawn } from '../../../main/ipc/handlers/process/handle-spawn';
import { logger } from '../../../main/utils/logger';

const target = path.resolve('ipc-cleanup-target');
const remote = {
	id: 'remote',
	name: 'Remote',
	enabled: true,
	host: 'remote-host',
	username: 'user',
	port: 22,
	privateKeyPath: '',
};
const operations = ['spawnTerminalTab', 'runCommand', 'spawn'] as const;
type Operation = (typeof operations)[number];
type Handler = (event: unknown, config: Record<string, unknown>) => Promise<unknown>;
let gate: typeof import('../../../main/git/worktreeActivity');
let handlers: Map<string, Handler>;
let manager: {
	spawn: ReturnType<typeof vi.fn>;
	spawnTerminalTab: ReturnType<typeof vi.fn>;
	runCommand: ReturnType<typeof vi.fn>;
	cancelCommand: ReturnType<typeof vi.fn>;
};
let settings: { get: ReturnType<typeof vi.fn> };
let deps: ProcessHandlerDependencies;

beforeEach(async () => {
	vi.resetModules();
	vi.resetAllMocks();
	vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
	vi.mocked(resolveSshPath).mockResolvedValue('ssh');
	vi.mocked(handleProcessSpawn).mockResolvedValue({ success: true, pid: 123 });
	manager = {
		spawn: vi.fn(() => ({ success: true, pid: 123 })),
		spawnTerminalTab: vi.fn(() => ({ success: true, pid: 123 })),
		runCommand: vi.fn(async () => ({ exitCode: 0 })),
		cancelCommand: vi.fn(() => false),
	};
	settings = { get: vi.fn((key, fallback) => (key === 'sshRemotes' ? [remote] : fallback)) };
	deps = {
		getProcessManager: vi.fn(() => manager),
		getAgentDetector: () => null,
		getMainWindow: () => null,
		settingsStore: settings,
		agentConfigsStore: { get: vi.fn((_key, fallback) => fallback) },
		sessionsStore: { get: vi.fn(() => []) },
	} as unknown as ProcessHandlerDependencies;
	handlers = new Map();
	vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
		handlers.set(channel, handler as Handler);
	});
	gate = await import('../../../main/git/worktreeActivity');
	const { registerProcessHandlers } = await import('../../../main/ipc/handlers/process');
	registerProcessHandlers(deps);
	vi.mocked(deps.getProcessManager).mockClear();
});

afterEach(() => vi.restoreAllMocks());

function run(operation: Operation, config: Record<string, unknown> = {}, event: unknown = null) {
	return handlers.get(`process:${operation}`)!(event, {
		sessionId: 'session',
		command: 'command',
		cwd: target,
		...config,
	});
}

async function reserve(root = target) {
	const hold = await gate.reserveWorktreeCleanup(root);
	expect(hold.status).toBe('reserved-partially');
	if (hold.status !== 'reserved-partially') throw new Error('Reservation failed');
	expect(hold.blockers.map((b) => b.message).join(' ')).toMatch(/native.*registration.*OS/);
	return hold;
}

async function blocked() {
	expect(await gate.reserveWorktreeCleanup(target)).toMatchObject({
		status: 'blocked',
		blockers: [{ code: 'mutation-busy' }],
	});
}

const sshConfig = { sessionSshRemoteConfig: { enabled: true, remoteId: remote.id } };

describe.each(['spawnTerminalTab', 'runCommand'] as const)('%s outer IPC activity', (operation) => {
	it.each([target, path.join(target, 'child'), path.resolve('ipc-unrelated')])(
		'refuses before settings, environment, SSH or manager setup for reservation %s',
		async (root) => {
			const hold = await reserve(root);
			await expect(run(operation, sshConfig)).rejects.toThrow('reserved');
			expect(settings.get).not.toHaveBeenCalled();
			expect(deps.getProcessManager).not.toHaveBeenCalled();
			expect(resolveSshPath).not.toHaveBeenCalled();
			expect(manager.spawn).not.toHaveBeenCalled();
			expect(manager.spawnTerminalTab).not.toHaveBeenCalled();
			expect(manager.runCommand).not.toHaveBeenCalled();
			hold.release();
			(await reserve()).release();
		}
	);

	it('admits before settings setup and holds until a later operation failure', async () => {
		let check!: Promise<void>;
		settings.get.mockImplementationOnce((_key, fallback) => {
			check = blocked();
			return fallback;
		});
		let fail!: (error: Error) => void;
		const setup = new Promise<never>((_r, reject) => {
			fail = reject;
		});
		if (operation === 'spawnTerminalTab') vi.mocked(resolveSshPath).mockReturnValueOnce(setup);
		else manager.runCommand.mockReturnValueOnce(setup);
		const pending = run(operation, sshConfig);
		await check;
		fail(Error('operation failed'));
		await expect(pending).rejects.toThrow('operation failed');
		(await reserve()).release();
	});

	it('releases when the manager is unavailable before any native start', async () => {
		vi.mocked(deps.getProcessManager).mockReturnValue(null);
		await expect(run(operation)).rejects.toThrow();
		(await reserve()).release();
	});

	it('releases synchronous settings failure before native dispatch', async () => {
		settings.get.mockImplementationOnce(() => {
			throw Error('settings failed');
		});
		await expect(run(operation)).rejects.toThrow('settings failed');
		expect(manager.spawn).not.toHaveBeenCalled();
		expect(manager.spawnTerminalTab).not.toHaveBeenCalled();
		expect(manager.runCommand).not.toHaveBeenCalled();
		(await reserve()).release();
	});

	it('shares admission with bridge invocations', async () => {
		const hold = await reserve();
		await expect(run(operation, {}, { clientId: 'web-client' })).rejects.toThrow('reserved');
		expect(settings.get).not.toHaveBeenCalled();
		hold.release();
	});
});

describe('AI spawn outer IPC activity', () => {
	let active: number;
	beforeEach(() => {
		active = 0;
		const begin = gate.beginGlobalWorktreeActivity;
		vi.spyOn(gate, 'beginGlobalWorktreeActivity').mockImplementation(() => {
			const release = begin();
			active++;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				active--;
				release();
			};
		});
	});
	it.each([target, path.join(target, 'child'), path.resolve('ipc-unrelated')])(
		'refuses before outer dependency setup or diagnostics for reservation %s',
		async (root) => {
			const dependency = vi.fn(() => {
				throw Error('dependency accessed');
			});
			Object.defineProperty(deps, 'sessionsStore', { get: dependency });
			const hold = await reserve(root);
			await expect(run('spawn', sshConfig)).rejects.toThrow('reserved');
			expect(dependency).not.toHaveBeenCalled();
			expect(handleProcessSpawn).not.toHaveBeenCalled();
			expect(logger.error).not.toHaveBeenCalled();
			hold.release();
			(await reserve()).release();
		}
	);

	it.each([null, { clientId: 'web-client' }])(
		'refuses before payload inspection for invocation %j',
		async (event) => {
			const payload = new Proxy(
				{},
				{
					get: vi.fn(() => {
						throw Error('payload accessed');
					}),
				}
			);
			const hold = await reserve();
			await expect(handlers.get('process:spawn')!(event, payload)).rejects.toThrow('reserved');
			expect(handleProcessSpawn).not.toHaveBeenCalled();
			expect(logger.error).not.toHaveBeenCalled();
			hold.release();
		}
	);

	it.each(['resolve', 'reject'] as const)(
		'owns pending setup through %s without relying on inner admission',
		async (outcome) => {
			const setup = Promise.withResolvers<Awaited<ReturnType<typeof handleProcessSpawn>>>();
			vi.mocked(handleProcessSpawn).mockReturnValueOnce(setup.promise);
			const pending = run('spawn', { cwd: '~/remote-only', ...sshConfig });
			await blocked();
			expect(handleProcessSpawn).toHaveBeenCalledWith(
				expect.objectContaining({ cwd: '~/remote-only', ...sshConfig }),
				expect.objectContaining({ sessionsStore: deps.sessionsStore })
			);
			expect(fs.realpath).toHaveBeenCalledExactlyOnceWith(target);
			await handlers.get('process:cancelCommand')!(null, { sessionId: 'session' });
			await blocked();
			if (outcome === 'resolve') {
				const result = { success: true, pid: 321 };
				setup.resolve(result);
				await expect(pending).resolves.toBe(result);
			} else {
				const error = Error('spawn failed');
				setup.reject(error);
				await expect(pending).rejects.toBe(error);
			}
			(await reserve()).release();
		}
	);

	it.each(['dependency', 'synchronous spawn', 'asynchronous spawn'] as const)(
		'owns serialization and logging after %s failure',
		async (site) => {
			const observed: number[] = [];
			const error = Error('original failure');
			Object.defineProperty(error, 'diagnostic', {
				enumerable: true,
				get: () => {
					observed.push(active);
					return 'detail';
				},
			});
			if (site === 'dependency') {
				Object.defineProperty(deps, 'sessionsStore', {
					get: () => {
						throw error;
					},
				});
			} else if (site === 'synchronous spawn') {
				vi.mocked(handleProcessSpawn).mockImplementationOnce(() => {
					throw error;
				});
			} else {
				vi.mocked(handleProcessSpawn).mockRejectedValueOnce(error);
			}
			vi.mocked(logger.error).mockImplementationOnce(() => {
				observed.push(active);
			});
			await expect(run('spawn')).rejects.toBe(error);
			expect(observed).toEqual([1, 1]);
			expect(active).toBe(0);
			(await reserve()).release();
		}
	);

	it.each(['serialization', 'logging'] as const)(
		'releases outer activity even when %s throws',
		async (site) => {
			const diagnosticError = Error('diagnostic failure');
			const original = Error('spawn failed');
			let observed: number | undefined;
			const fail = () => {
				observed = active;
				throw diagnosticError;
			};
			if (site === 'serialization')
				Object.defineProperty(original, 'diagnostic', { enumerable: true, get: fail });
			else vi.mocked(logger.error).mockImplementationOnce(fail);
			vi.mocked(handleProcessSpawn).mockRejectedValueOnce(original);
			await expect(run('spawn')).rejects.toBe(diagnosticError);
			expect(observed).toBe(1);
			expect(active).toBe(0);
			(await reserve()).release();
		}
	);

	it('retains a same-session successor started reentrantly during diagnostics', async () => {
		const setup = Promise.withResolvers<Awaited<ReturnType<typeof handleProcessSpawn>>>();
		const original = Error('first failed');
		vi.mocked(handleProcessSpawn)
			.mockRejectedValueOnce(original)
			.mockReturnValueOnce(setup.promise);
		let successor!: Promise<unknown>;
		vi.mocked(logger.error).mockImplementationOnce(() => {
			successor = run('spawn');
		});
		await expect(run('spawn')).rejects.toBe(original);
		await blocked();
		setup.resolve({ success: false, pid: -1, error: 'successor refused' });
		await expect(successor).resolves.toEqual({
			success: false,
			pid: -1,
			error: 'successor refused',
		});
		(await reserve()).release();
	});

	it('does not release another pending request when the first settles', async () => {
		const first = Promise.withResolvers<Awaited<ReturnType<typeof handleProcessSpawn>>>();
		const second = Promise.withResolvers<Awaited<ReturnType<typeof handleProcessSpawn>>>();
		vi.mocked(handleProcessSpawn)
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const a = run('spawn');
		const b = run('spawn', { sessionId: 'other-session' });
		await blocked();
		first.resolve({ success: true, pid: 123 });
		await a;
		await blocked();
		second.resolve({ success: true, pid: 456 });
		await b;
		(await reserve()).release();
	});

	it('preserves an independently admitted native lifetime after the IPC reply', async () => {
		let releaseNative!: () => void;
		vi.mocked(handleProcessSpawn).mockImplementationOnce(async () => {
			releaseNative = gate.beginGlobalWorktreeActivity();
			return { success: true, pid: 123 };
		});
		await run('spawn');
		await blocked();
		releaseNative();
		(await reserve()).release();
	});

	it('admits before a resolving reservation can exclude pending spawn setup', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const reservation = gate.reserveWorktreeCleanup(target);
		const setup = Promise.withResolvers<Awaited<ReturnType<typeof handleProcessSpawn>>>();
		vi.mocked(handleProcessSpawn).mockReturnValueOnce(setup.promise);
		const pending = run('spawn');
		canonical.resolve(target);
		expect(await reservation).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'mutation-busy' }],
		});
		setup.resolve({ success: true, pid: 123 });
		await pending;
		(await reserve()).release();
	});
});

describe('terminal-tab pending SSH setup', () => {
	it('holds across SSH resolution, new admissions and dispatch through setup settlement', async () => {
		let finish!: (binary: string) => void;
		vi.mocked(resolveSshPath).mockImplementationOnce(
			() =>
				new Promise((r) => {
					finish = r;
				})
		);
		const pending = run('spawnTerminalTab', { ...sshConfig, cwd: '~/remote-only' });
		await blocked();
		expect(manager.spawn).not.toHaveBeenCalled();
		expect(fs.realpath).toHaveBeenCalledExactlyOnceWith(target);
		let dispatchCheck!: Promise<void>;
		let releaseNative!: () => void;
		manager.spawn.mockImplementationOnce(() => {
			releaseNative = gate.beginGlobalWorktreeActivity();
			dispatchCheck = blocked();
			return { success: true, pid: 123 };
		});
		finish('ssh');
		await expect(pending).resolves.toMatchObject({ success: true });
		await dispatchCheck;
		expect(manager.spawn).toHaveBeenCalledWith(expect.objectContaining({ command: 'ssh' }));
		releaseNative();
		(await reserve()).release();
	});

	it('retains pending setup after an unrelated cancellation request and releases rejection', async () => {
		let fail!: (error: Error) => void;
		vi.mocked(resolveSshPath).mockImplementationOnce(
			() =>
				new Promise((_r, reject) => {
					fail = reject;
				})
		);
		const pending = run('spawnTerminalTab', sshConfig);
		await handlers.get('process:cancelCommand')!(null, { sessionId: 'session' });
		await blocked();
		fail(Error('SSH setup failed'));
		await expect(pending).rejects.toThrow('SSH setup failed');
		expect(manager.spawn).not.toHaveBeenCalled();
		(await reserve()).release();
	});

	it('wins admission while an earlier reservation is resolving its target', async () => {
		let finish!: (root: string) => void;
		vi.mocked(fs.realpath).mockImplementationOnce(
			() =>
				new Promise((r) => {
					finish = r;
				})
		);
		const reservation = gate.reserveWorktreeCleanup(target);
		let fail!: (error: Error) => void;
		vi.mocked(resolveSshPath).mockImplementationOnce(
			() =>
				new Promise((_r, reject) => {
					fail = reject;
				})
		);
		const pending = run('spawnTerminalTab', sshConfig);
		finish(target);
		expect(await reservation).toMatchObject({ status: 'blocked' });
		fail(Error('setup failed'));
		await expect(pending).rejects.toThrow('setup failed');
		(await reserve()).release();
	});

	it('does not release a second pending start when the first settles', async () => {
		let first!: (binary: string) => void;
		let second!: (binary: string) => void;
		vi.mocked(resolveSshPath)
			.mockImplementationOnce(
				() =>
					new Promise((r) => {
						first = r;
					})
			)
			.mockImplementationOnce(
				() =>
					new Promise((r) => {
						second = r;
					})
			);
		const a = run('spawnTerminalTab', sshConfig);
		const b = run('spawnTerminalTab', sshConfig);
		first('ssh');
		await a;
		await blocked();
		second('ssh');
		await b;
		(await reserve()).release();
	});
});

describe('one-shot command dispatch', () => {
	it.each([undefined, null, 'missing', 'disabled'])(
		'refuses enabled unresolved SSH id %s without local fallback',
		async (remoteId) => {
			settings.get.mockImplementation((key, fallback) =>
				key === 'sshRemotes' ? [{ ...remote, id: 'disabled', enabled: false }] : fallback
			);
			await expect(
				run('runCommand', { sessionSshRemoteConfig: { enabled: true, remoteId } })
			).rejects.toThrow('SSH config not found or disabled');
			expect(manager.runCommand).not.toHaveBeenCalled();
			expect(fs.realpath).not.toHaveBeenCalled();
			(await reserve()).release();
		}
	);

	it('preserves explicitly disabled SSH local execution', async () => {
		await run('runCommand', { sessionSshRemoteConfig: { enabled: false, remoteId: 'missing' } });
		expect(manager.runCommand).toHaveBeenCalledWith(
			'session',
			'command',
			target,
			expect.any(String),
			{},
			null
		);
		(await reserve()).release();
	});

	it('holds through the command promise and releases asynchronous failure', async () => {
		let fail!: (error: Error) => void;
		manager.runCommand.mockImplementationOnce(
			() =>
				new Promise((_r, reject) => {
					fail = reject;
				})
		);
		const pending = run('runCommand');
		await blocked();
		fail(Error('command failed'));
		await expect(pending).rejects.toThrow('command failed');
		(await reserve()).release();
	});

	it.each(['exit', 'error', 'cancel', 'close-first'])(
		'composes with the real SSH runner: %s does not release an unclosed native child',
		async (completion) => {
			const native = Object.assign(new EventEmitter(), {
				pid: 123,
				stdout: new EventEmitter(),
				stderr: new EventEmitter(),
				kill: vi.fn(),
			});
			vi.mocked(spawn).mockReturnValue(native as unknown as ReturnType<typeof spawn>);
			const { SshCommandRunner } =
				await import('../../../main/process-manager/runners/SshCommandRunner');
			const runner = new SshCommandRunner(new EventEmitter());
			manager.cancelCommand.mockImplementation((sessionId) => runner.cancel(sessionId));
			manager.runCommand.mockImplementation((...args) =>
				runner.run(args[0], args[1], args[2], args[5], args[4])
			);
			const pending = run('runCommand', { ...sshConfig, cwd: '~/remote-only' });
			await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
			await blocked();
			if (completion === 'close-first') {
				native.emit('close', 0);
				await blocked();
			}
			if (completion === 'cancel')
				await handlers.get('process:cancelCommand')!(null, { sessionId: 'session' });
			else if (completion === 'close-first') native.emit('exit', 0);
			else native.emit(completion, completion === 'exit' ? 0 : Error('child error'));
			await pending;
			if (completion !== 'close-first') await blocked();
			native.emit('close', 0);
			(await reserve()).release();
		}
	);
});
