import fs from 'fs/promises';
import path from 'path';
import { EventEmitter } from 'events';
import * as pty from 'node-pty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessConfig, ManagedProcess } from '../../../main/process-manager/types';
import type { DataBufferManager } from '../../../main/process-manager/handlers/DataBufferManager';

vi.mock('fs/promises', () => ({ default: { realpath: vi.fn() } }));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/utils/terminalFilter', () => ({ stripControlSequences: vi.fn() }));
vi.mock('../../../main/process-manager/utils/envBuilder', () => ({
	buildPtyTerminalEnv: vi.fn(() => ({})),
	buildChildProcessEnv: vi.fn(() => ({})),
	collectMaestroEnvVars: vi.fn(() => ({})),
}));
vi.mock('../../../main/process-manager/utils/pathResolver', () => ({
	resolveShellPath: vi.fn(() => '/bin/bash'),
}));
vi.mock('../../../shared/platformDetection', () => ({ isWindows: vi.fn(() => false) }));

import { logger } from '../../../main/utils/logger';
import { captureException } from '../../../main/utils/sentry';
import { stripControlSequences } from '../../../main/utils/terminalFilter';
import { resolveShellPath } from '../../../main/process-manager/utils/pathResolver';
import { isWindows } from '../../../shared/platformDetection';
import {
	buildPtyTerminalEnv,
	buildChildProcessEnv,
	collectMaestroEnvVars,
} from '../../../main/process-manager/utils/envBuilder';

const target = path.resolve('pty-cleanup-target');
let gate: typeof import('../../../main/git/worktreeActivity');
let spawner: import('../../../main/process-manager/spawners/PtySpawner').PtySpawner;
let native: ReturnType<typeof makeNative>;
let processes: Map<string, ManagedProcess>;
let emitter: EventEmitter;
let buffer: {
	emitDataBuffered: ReturnType<typeof vi.fn>;
	flushDataBuffer: ReturnType<typeof vi.fn>;
};

function makeNative(pid = 12345) {
	const events = new EventEmitter();
	return {
		pid,
		events,
		onData: vi.fn((cb: (data: string) => void) => events.on('native-data', cb)),
		onExit: vi.fn((cb: (event: { exitCode: number; signal?: number }) => void) => {
			events.on('native-exit', cb);
		}),
		kill: vi.fn(),
	};
}

function config(overrides: Partial<ProcessConfig> = {}): ProcessConfig {
	return {
		sessionId: 'session-terminal-tab',
		toolType: 'terminal',
		cwd: target,
		command: 'bash',
		args: [],
		shell: 'bash',
		...overrides,
	};
}

async function reserve(root = target) {
	const hold = await gate.reserveWorktreeCleanup(root);
	expect(hold.status).toBe('reserved-partially');
	if (hold.status !== 'reserved-partially') throw new Error('Reservation failed');
	expect(hold.blockers.map((b) => b.message).join(' ')).toMatch(/native.*registration.*OS/);
	return hold;
}

async function blocked() {
	const hold = await gate.reserveWorktreeCleanup(target);
	if (hold.status === 'reserved-partially') hold.release();
	expect(hold).toMatchObject({
		status: 'blocked',
		blockers: [{ code: 'mutation-busy' }],
	});
}

beforeEach(async () => {
	vi.resetModules();
	vi.resetAllMocks();
	vi.mocked(stripControlSequences).mockImplementation((data) => data);
	vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
	vi.mocked(resolveShellPath).mockReturnValue('/bin/bash');
	vi.mocked(isWindows).mockReturnValue(false);
	native = makeNative();
	vi.mocked(pty.spawn).mockImplementation(() => native as unknown as pty.IPty);
	gate = await import('../../../main/git/worktreeActivity');
	const { PtySpawner } = await import('../../../main/process-manager/spawners/PtySpawner');
	processes = new Map();
	emitter = new EventEmitter();
	buffer = { emitDataBuffered: vi.fn(), flushDataBuffer: vi.fn() };
	spawner = new PtySpawner(processes, emitter, buffer as unknown as DataBufferManager);
});

afterEach(() => vi.restoreAllMocks());

describe('standalone PTY activity', () => {
	it.each([target, path.join(target, 'child'), path.resolve('unrelated')])(
		'refuses before shell/environment/native setup under reservation %s',
		async (root) => {
			const hold = await reserve(root);
			vi.mocked(fs.realpath).mockClear();
			expect(spawner.spawn(config())).toMatchObject({ success: false });
			for (const probe of [resolveShellPath, buildPtyTerminalEnv, collectMaestroEnvVars, pty.spawn])
				expect(probe).not.toHaveBeenCalled();
			expect(logger.error).not.toHaveBeenCalled();
			expect(captureException).not.toHaveBeenCalled();
			expect(fs.realpath).not.toHaveBeenCalled();
			expect(processes.size).toBe(0);
			hold.release();
			expect(spawner.spawn(config()).success).toBe(true);
			await blocked();
			native.events.emit('native-exit', { exitCode: 0 });
			(await reserve()).release();
		}
	);

	it('registers synchronously before shell setup and refuses a reservation already resolving', async () => {
		let ready!: (value: string) => void;
		vi.mocked(fs.realpath).mockImplementationOnce(() => new Promise((r) => (ready = r)));
		const pending = gate.reserveWorktreeCleanup(target);
		let duringSetup!: Promise<void>;
		vi.mocked(resolveShellPath).mockImplementation(() => {
			duringSetup = blocked();
			return '/bin/bash';
		});
		expect(spawner.spawn(config()).success).toBe(true);
		ready(target);
		expect(await pending).toMatchObject({ status: 'blocked' });
		await duringSetup;
		native.events.emit('native-exit', { exitCode: 0 });
		(await reserve()).release();
	});

	it.each([
		{ name: 'terminal', options: {} },
		{ name: 'AI', options: { toolType: 'claude-code', shell: undefined, requiresPty: true } },
		{ name: 'Windows terminal', options: {}, windows: true },
		{
			name: 'local SSH client',
			options: { shell: undefined, command: 'ssh', cwd: '/remote/path' },
		},
	])('holds $name through native exit without probing its cwd', async ({ options, windows }) => {
		vi.mocked(isWindows).mockReturnValue(!!windows);
		expect(spawner.spawn(config(options)).success).toBe(true);
		expect(fs.realpath).not.toHaveBeenCalled();
		await blocked();
		native.kill();
		processes.clear(); // A manager kill/unregister is not native completion.
		await blocked();
		native.events.emit('native-exit', { exitCode: 1, signal: 9 });
		(await reserve()).release();
	});

	it.each([resolveShellPath, buildPtyTerminalEnv, buildChildProcessEnv, pty.spawn])(
		'releases failure before a child exists (%#)',
		async (setup) => {
			vi.mocked(setup).mockImplementationOnce(() => {
				throw new Error('setup failed');
			});
			expect(
				spawner.spawn(config(setup === buildChildProcessEnv ? { toolType: 'claude-code' } : {}))
					.success
			).toBe(false);
			(await reserve()).release();
		}
	);

	it('retains listener-setup failure after spawn until observed exit', async () => {
		native.onData.mockImplementationOnce(() => {
			throw new Error('data listener failed');
		});
		expect(spawner.spawn(config()).success).toBe(false);
		await blocked();
		native.events.emit('native-exit', { exitCode: 1 });
		(await reserve()).release();
	});

	it('keeps an unobservable child blocked after exit-listener registration fails', async () => {
		native.onExit.mockImplementationOnce(() => {
			throw new Error('no exit observer');
		});
		expect(spawner.spawn(config()).success).toBe(false);
		native.kill();
		native.events.emit('native-exit', { exitCode: 0 });
		await blocked();
	});

	it('retains activity when registration fails after native creation', async () => {
		vi.mocked(collectMaestroEnvVars).mockImplementationOnce(() => {
			throw new Error('metadata failed');
		});
		expect(spawner.spawn(config()).success).toBe(false);
		await blocked();
		native.events.emit('native-exit', { exitCode: 1 });
		(await reserve()).release();
	});

	it('releases exit observed synchronously during a later setup failure', async () => {
		native.onData.mockImplementationOnce(() => {
			native.events.emit('native-exit', { exitCode: 1 });
			throw new Error('setup failed after exit');
		});
		expect(spawner.spawn(config()).success).toBe(false);
		(await reserve()).release();
	});

	it.each(['flush', 'report'])('releases observed completion when %s throws', async (stage) => {
		expect(spawner.spawn(config()).success).toBe(true);
		const fail = () => {
			throw new Error('report failed');
		};
		if (stage === 'flush') buffer.flushDataBuffer.mockImplementationOnce(fail);
		else emitter.on('exit', fail);
		expect(() => native.events.emit('native-exit', { exitCode: 0 })).toThrow('report failed');
		(await reserve()).release();
	});

	it('late and duplicate predecessor exits release only their own activity', async () => {
		expect(spawner.spawn(config()).success).toBe(true);
		const old = native;
		native = makeNative(23456);
		expect(spawner.spawn(config()).success).toBe(true);
		old.events.emit('native-exit', { exitCode: 0 });
		old.events.emit('native-exit', { exitCode: 0 });
		await blocked();
		expect(processes.get(config().sessionId)?.pid).toBe(native.pid);
		native.events.emit('native-exit', { exitCode: 0 });
		const hold = await reserve();
		expect(() => old.events.emit('native-exit', { exitCode: 0 })).toThrow('reserved');
		expect(spawner.spawn(config()).success).toBe(false);
		hold.release();
	});

	it('holds a new generation started reentrantly by completion reporting', async () => {
		expect(spawner.spawn(config()).success).toBe(true);
		const old = native;
		emitter.once('exit', () => {
			native = makeNative(23456);
			expect(spawner.spawn(config()).success).toBe(true);
		});
		old.events.emit('native-exit', { exitCode: 0 });
		await blocked();
		native.events.emit('native-exit', { exitCode: 0 });
		(await reserve()).release();
	});

	it.each(['raw data', 'filtered data', 'exit'])(
		'refuses retained %s before side effects and permits retry after release',
		async (stage) => {
			expect(
				spawner.spawn(config(stage === 'filtered data' ? { sessionId: 'agent-ai' } : {})).success
			).toBe(true);
			native.events.emit('native-exit', { exitCode: 0 });
			const callback = () =>
				native.events.emit(
					stage === 'exit' ? 'native-exit' : 'native-data',
					stage === 'exit' ? { exitCode: 0 } : 'late output'
				);
			for (const root of [target, path.join(target, 'child'), path.resolve('unrelated')]) {
				const hold = await reserve(root);
				for (const probe of [
					logger.debug,
					logger.warn,
					stripControlSequences,
					buffer.emitDataBuffered,
					buffer.flushDataBuffer,
					captureException,
				])
					vi.mocked(probe).mockClear();
				expect(callback).toThrow('reserved');
				for (const probe of [
					logger.debug,
					logger.warn,
					stripControlSequences,
					buffer.emitDataBuffered,
					buffer.flushDataBuffer,
					captureException,
				])
					expect(probe).not.toHaveBeenCalled();
				expect(processes.size).toBe(0);
				hold.release();
				expect(callback).not.toThrow();
			}
			(await reserve()).release();
		}
	);

	it.each(['setup', 'data', 'exit'])(
		'owns asynchronous %s diagnostics through resolution, rejection or throw',
		async (stage) => {
			for (const outcome of ['resolve', 'reject', 'throw']) {
				const failure = Error(`${stage} failure`);
				const reporting = Promise.withResolvers<void>();
				void reporting.promise.catch(() => {});
				vi.mocked(captureException).mockClear();
				vi.mocked(captureException).mockImplementationOnce(() => {
					if (outcome === 'throw') throw Error('reporter threw');
					return reporting.promise;
				});
				const fail = () => {
					throw failure;
				};
				if (stage === 'setup') {
					vi.mocked(resolveShellPath).mockImplementationOnce(fail);
					expect(spawner.spawn(config())).toEqual({ pid: -1, success: false });
				} else {
					expect(spawner.spawn(config()).success).toBe(true);
					if (stage === 'data') buffer.emitDataBuffered.mockImplementationOnce(fail);
					else buffer.flushDataBuffer.mockImplementationOnce(fail);
					expect(() =>
						native.events.emit(
							stage === 'data' ? 'native-data' : 'native-exit',
							stage === 'data' ? 'output' : { exitCode: 0 }
						)
					).toThrow(failure);
					if (stage === 'data') native.events.emit('native-exit', { exitCode: 0 });
				}
				await vi.waitFor(() => expect(captureException).toHaveBeenCalledExactlyOnceWith(failure));
				if (outcome !== 'throw') await blocked();
				if (outcome === 'reject') reporting.reject(Error('reporter rejected'));
				else reporting.resolve();
				await vi.waitFor(async () => (await reserve()).release());
				expect(captureException).toHaveBeenCalledOnce();
				// Retained callbacks are invoked explicitly above. Each iteration owns
				// one PTY and cannot accumulate another active native listener.
				native = makeNative();
				vi.mocked(pty.spawn).mockReturnValue(native as unknown as pty.IPty);
			}
		}
	);

	it.each([false, true])(
		'keeps independent native and diagnostic ownership (native first: %s)',
		async (nativeFirst) => {
			expect(spawner.spawn(config()).success).toBe(true);
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			buffer.emitDataBuffered.mockImplementationOnce(() => {
				throw Error('data consumer');
			});
			expect(() => native.events.emit('native-data', 'output')).toThrow('data consumer');
			if (nativeFirst) native.events.emit('native-exit', { exitCode: 0 });
			else {
				reporting.resolve();
				await Promise.resolve();
			}
			await blocked();
			if (nativeFirst) reporting.resolve();
			else native.events.emit('native-exit', { exitCode: 0 });
			await vi.waitFor(async () => (await reserve()).release());
		}
	);

	it('retains setup and logger diagnostics when failure logging throws', async () => {
		const failure = Error('shell setup');
		const logging = Error('logger failed');
		vi.mocked(resolveShellPath).mockImplementationOnce(() => {
			throw failure;
		});
		vi.mocked(logger.error).mockImplementationOnce(() => {
			throw logging;
		});
		const reporting = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		vi.mocked(captureException)
			.mockReturnValueOnce(reporting[0].promise)
			.mockReturnValueOnce(reporting[1].promise);
		expect(spawner.spawn(config())).toMatchObject({ pid: -1, success: false });
		await vi.waitFor(() => expect(captureException).toHaveBeenCalledTimes(2));
		expect(captureException).toHaveBeenCalledWith(failure);
		expect(captureException).toHaveBeenCalledWith(logging);
		reporting[0].resolve();
		await blocked();
		reporting[1].resolve();
		await vi.waitFor(async () => (await reserve()).release());
	});

	it('blocks a pending reservation when retained data begins reporting', async () => {
		expect(spawner.spawn(config()).success).toBe(true);
		native.events.emit('native-exit', { exitCode: 0 });
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const reservation = gate.reserveWorktreeCleanup(target);
		const reporting = Promise.withResolvers<void>();
		vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
		buffer.emitDataBuffered.mockImplementationOnce(() => {
			throw Error('late data');
		});
		expect(() => native.events.emit('native-data', 'output')).toThrow('late data');
		canonical.resolve(target);
		const result = await reservation;
		if (result.status === 'reserved-partially') result.release();
		expect(result.status).toBe('blocked');
		await blocked();
		reporting.resolve();
		await vi.waitFor(async () => (await reserve()).release());
	});

	it('retains concurrent diagnostics and a same-session successor independently', async () => {
		expect(spawner.spawn(config()).success).toBe(true);
		const old = native;
		const reporting = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		vi.mocked(captureException)
			.mockReturnValueOnce(reporting[0].promise)
			.mockReturnValueOnce(reporting[1].promise);
		buffer.emitDataBuffered.mockImplementation(() => {
			throw Error('consumer');
		});
		for (let i = 0; i < 2; i++)
			expect(() => old.events.emit('native-data', 'output')).toThrow('consumer');
		native = makeNative(23456);
		expect(spawner.spawn(config()).success).toBe(true);
		old.events.emit('native-exit', { exitCode: 0 });
		reporting[0].resolve();
		await blocked();
		native.events.emit('native-exit', { exitCode: 0 });
		await blocked();
		reporting[1].resolve();
		await vi.waitFor(async () => (await reserve()).release());
		expect(processes.size).toBe(0);
	});

	it('shares sync/async global admission with independent idempotent releases', async () => {
		const release = gate.beginGlobalWorktreeActivity();
		const pending = gate.beginWorktreeActivity([]);
		release();
		release();
		await blocked();
		(await pending)();
		const hold = await reserve();
		expect(() => gate.beginGlobalWorktreeActivity()).toThrow('reserved');
		await expect(gate.beginWorktreeActivity([])).rejects.toThrow('reserved');
		expect(logger.error).not.toHaveBeenCalled();
		hold.release();
		(await reserve()).release();
	});
});
