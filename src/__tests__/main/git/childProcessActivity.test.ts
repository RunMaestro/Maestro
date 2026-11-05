import fs from 'fs/promises';
import path from 'path';
import { EventEmitter } from 'events';
import { execFile, spawn } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedProcess, ProcessConfig } from '../../../main/process-manager/types';
import type { DataBufferManager } from '../../../main/process-manager/handlers/DataBufferManager';

vi.mock('fs/promises', () => ({ default: { realpath: vi.fn() } }));
vi.mock('child_process', async (original) => ({
	...(await original<typeof import('child_process')>()),
	spawn: vi.fn(),
	execFile: vi.fn(),
}));
vi.mock('../../../shared/platformDetection', async (original) => ({
	...(await original<typeof import('../../../shared/platformDetection')>()),
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/agents', () => ({ getAgentCapabilities: vi.fn(() => ({})) }));
vi.mock('../../../main/agents/definitions', () => ({ getAgentDefinition: vi.fn() }));
vi.mock('../../../main/parsers', () => ({ createOutputParser: vi.fn() }));
vi.mock('../../../main/process-manager/handlers/StdoutHandler', () => ({
	StdoutHandler: class {
		handleData = vi.fn();
	},
}));
vi.mock('../../../main/process-manager/handlers/StderrHandler', () => ({
	StderrHandler: class {
		handleData = (...args: unknown[]) => reports.stderr(...args);
	},
}));
vi.mock('../../../main/process-manager/handlers/ExitHandler', () => ({
	ExitHandler: class {
		handleExit = (...args: unknown[]) => reports.exit(...args);
		handleError = (...args: unknown[]) => reports.error(...args);
	},
}));
vi.mock('../../../main/process-manager/utils/envBuilder', () => ({
	buildChildProcessEnv: vi.fn(() => ({})),
	collectMaestroEnvVars: vi.fn(() => ({})),
}));
vi.mock('../../../main/process-manager/utils/imageUtils', () => ({
	saveImageToTempFile: vi.fn(),
	savePromptToTempFile: vi.fn(),
	buildImagePromptPrefix: vi.fn(),
	cleanupTempFiles: vi.fn(),
}));
vi.mock('../../../main/process-manager/utils/windowsSpawnShell', () => ({
	planSpawnShell: vi.fn((command, args) => ({ command, args, shell: false })),
}));
vi.mock('../../../main/process-manager/utils/stdioCloseWatchdog', () => ({
	armStdioCloseWatchdog: vi.fn(),
}));
vi.mock('../../../shared/maestro-lib/control/agent-process-supervisor', () => ({
	superviseAgentProcess: vi.fn(() => ({ observe: vi.fn(), dispose: vi.fn() })),
}));
vi.mock('../../../shared/maestro-lib/control/termination', async (original) => ({
	...(await original<typeof import('../../../shared/maestro-lib/control/termination')>()),
	stopProcess: vi.fn(),
}));
vi.mock('../../../shared/maestro-lib/control/process-tree', () => ({
	snapshotProcessTree: vi.fn(() => ({
		owned: true,
		descendants: [{ pid: 45678, startedAt: 'fixture' }],
	})),
	refreshProcessTree: vi.fn(async (_pid, snapshot) => snapshot),
	killSurvivors: vi.fn(),
	killProcessTreeNow: vi.fn(),
}));

import { getAgentCapabilities } from '../../../main/agents';
import {
	buildChildProcessEnv,
	collectMaestroEnvVars,
} from '../../../main/process-manager/utils/envBuilder';
import { saveImageToTempFile } from '../../../main/process-manager/utils/imageUtils';
import { captureException } from '../../../main/utils/sentry';
import { logger } from '../../../main/utils/logger';
import { armStdioCloseWatchdog } from '../../../main/process-manager/utils/stdioCloseWatchdog';
import { stopProcess } from '../../../shared/maestro-lib/control/termination';
import {
	killProcessTreeNow,
	killSurvivors,
	refreshProcessTree,
} from '../../../shared/maestro-lib/control/process-tree';
import { superviseAgentProcess } from '../../../shared/maestro-lib/control/agent-process-supervisor';
import { armStdioCloseWatchdog as armSharedWatchdog } from '../../../shared/maestro-lib/control/stdio-close-watchdog';

const reports = vi.hoisted(() => ({
	exit: vi.fn(),
	error: vi.fn(),
	flush: vi.fn(),
	stderr: vi.fn(),
}));
const target = path.resolve('child-cleanup-target');
let gate: typeof import('../../../main/git/worktreeActivity');
let spawner: import('../../../main/process-manager/spawners/ChildProcessSpawner').ChildProcessSpawner;
let native: ReturnType<typeof makeNative>;
let processes: Map<string, ManagedProcess>;
let emitter: EventEmitter;

function makeNative(pid = 12345) {
	return Object.assign(new EventEmitter(), {
		pid,
		killed: false,
		exitCode: null,
		stdin: Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() }),
		stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
		stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
		kill: vi.fn(),
	});
}

function config(overrides: Partial<ProcessConfig> = {}): ProcessConfig {
	return {
		sessionId: 'child-session',
		toolType: 'claude-code',
		cwd: target,
		command: 'agent',
		args: [],
		...overrides,
	};
}

async function drain() {
	await new Promise<void>((resolve) => setImmediate(resolve));
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

async function close(child = native) {
	child.emit('close', 0, null);
	await drain();
}

beforeEach(async () => {
	vi.resetModules();
	vi.resetAllMocks();
	vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
	reports.exit.mockResolvedValue(undefined);
	native = makeNative();
	vi.mocked(spawn).mockImplementation(() => native as unknown as ReturnType<typeof spawn>);
	gate = await import('../../../main/git/worktreeActivity');
	const { ChildProcessSpawner } =
		await import('../../../main/process-manager/spawners/ChildProcessSpawner');
	processes = new Map();
	emitter = new EventEmitter();
	spawner = new ChildProcessSpawner(processes, emitter, {
		flushDataBuffer: reports.flush,
	} as unknown as DataBufferManager);
});
afterEach(() => vi.restoreAllMocks());

describe('standalone child-process activity', () => {
	it.each([target, path.join(target, 'descendant'), path.resolve('unrelated')])(
		'refuses before capability/prompt/image/environment/native setup under %s',
		async (root) => {
			const hold = await reserve(root);
			vi.mocked(fs.realpath).mockClear();
			expect(
				spawner.spawn(config({ prompt: 'fixture', images: ['fixture'], imageArgs: () => [] }))
			).toMatchObject({ success: false, error: expect.stringContaining('reserved') });
			for (const probe of [
				getAgentCapabilities,
				saveImageToTempFile,
				buildChildProcessEnv,
				spawn,
				fs.realpath,
				captureException,
			])
				expect(probe).not.toHaveBeenCalled();
			expect(processes.size).toBe(0);
			hold.release();
			expect(spawner.spawn(config()).success).toBe(true);
			await close();
			(await reserve()).release();
		}
	);

	it('registers before synchronous setup and blocks a pending reservation', async () => {
		let ready!: (value: string) => void;
		vi.mocked(fs.realpath).mockImplementationOnce(
			() =>
				new Promise((r) => {
					ready = r;
				})
		);
		const pending = gate.reserveWorktreeCleanup(target);
		let duringSetup!: Promise<void>;
		vi.mocked(getAgentCapabilities).mockImplementationOnce(() => {
			duringSetup = blocked();
			return {} as ReturnType<typeof getAgentCapabilities>;
		});
		expect(spawner.spawn(config()).success).toBe(true);
		ready(target);
		expect(await pending).toMatchObject({ status: 'blocked' });
		await duringSetup;
		await close();
		(await reserve()).release();
	});

	it.each(['exit', 'error', 'kill', 'unregister'])(
		'holds after %s until independently observed close',
		async (event) => {
			expect(spawner.spawn(config()).success).toBe(true);
			if (event === 'error') native.emit('error', new Error('late child error'));
			else if (event === 'exit') native.emit('exit', 1, null);
			else if (event === 'kill') {
				native.killed = true;
				native.kill();
			} else processes.clear();
			await drain();
			await blocked();
			await close();
			(await reserve()).release();
		}
	);

	it('covers the local SSH client without inspecting its remote cwd', async () => {
		expect(
			spawner.spawn(config({ cwd: '/remote/project', command: 'ssh', sshRemoteId: 'remote' }))
				.success
		).toBe(true);
		expect(fs.realpath).not.toHaveBeenCalled();
		await blocked();
		await close();
		(await reserve()).release();
	});

	it.each([getAgentCapabilities, buildChildProcessEnv, spawn])(
		'releases proven nonstart failure (%#)',
		async (setup) => {
			vi.mocked(setup).mockImplementationOnce(() => {
				throw new Error('setup failed');
			});
			expect(spawner.spawn(config()).success).toBe(false);
			(await reserve()).release();
		}
	);

	it('retains a post-start exception without a returned handle even after close', async () => {
		native.stdin.write.mockImplementationOnce(() => {
			throw new Error('write failed');
		});
		expect(spawner.spawn(config({ prompt: 'fixture', sendPromptViaStdinRaw: true })).success).toBe(
			false
		);
		await close();
		await blocked();
	});

	it('retains missing native-close observation even when the turn completes', async () => {
		const original = native.on;
		let closeListeners = 0;
		vi.spyOn(native, 'on').mockImplementation(function (this: typeof native, event, cb) {
			if (event === 'close' && ++closeListeners === 2) throw new Error('no close observer');
			return original.call(this, event, cb);
		});
		expect(spawner.spawn(config()).success).toBe(false);
		await close();
		await blocked();
	});

	it('holds after metadata failure with an observable child until close', async () => {
		vi.mocked(collectMaestroEnvVars).mockImplementationOnce(() => {
			throw new Error('metadata failed');
		});
		expect(spawner.spawn(config()).success).toBe(false);
		await blocked();
		await close();
		(await reserve()).release();
	});

	it('releases a synchronous close during failing metadata setup only after setup settles', async () => {
		vi.mocked(collectMaestroEnvVars).mockImplementationOnce(() => {
			native.emit('close', 0, null);
			throw new Error('metadata failed after close');
		});
		expect(spawner.spawn(config()).success).toBe(false);
		(await reserve()).release();
	});

	it('a missing pid and error result still require close', async () => {
		Object.assign(native, { pid: undefined });
		expect(spawner.spawn(config())).toMatchObject({ success: false, pid: -1 });
		native.emit('error', new Error('ENOENT'));
		await drain();
		await blocked();
		await close();
		(await reserve()).release();
	});

	it('waits for asynchronous completion handling after native close', async () => {
		let finish!: () => void;
		reports.exit.mockImplementationOnce(
			() =>
				new Promise<void>((r) => {
					finish = r;
				})
		);
		expect(spawner.spawn(config()).success).toBe(true);
		await close();
		await blocked();
		finish();
		await drain();
		(await reserve()).release();
	});

	it.each(['exit', 'error'])(
		'settles reporting failure on %s without releasing a live child',
		async (event) => {
			const failure = new Error('report failed');
			if (event === 'exit') reports.exit.mockRejectedValueOnce(failure);
			else
				reports.error.mockImplementationOnce(() => {
					throw failure;
				});
			expect(spawner.spawn(config()).success).toBe(true);
			if (event === 'error') {
				native.emit('error', new Error('child error'));
				await drain();
				await blocked();
			}
			await close();
			expect(captureException).toHaveBeenCalledWith(failure);
			(await reserve()).release();
		}
	);

	it('forced supervision completion cannot release before native close', async () => {
		let force!: () => void;
		vi.mocked(superviseAgentProcess).mockImplementationOnce((_child, options) => {
			force = options.onForcedStop!;
			return {
				observe: vi.fn(),
				dispose: vi.fn(),
				modelActivity: vi.fn(),
				processExited: Promise.resolve(),
			};
		});
		expect(spawner.spawn(config({ toolType: 'codex', prompt: 'fixture' })).success).toBe(true);
		force();
		await drain();
		expect(reports.exit).toHaveBeenCalled();
		await blocked();
		await close();
		(await reserve()).release();
	});

	it('late and duplicate predecessor close releases only its own generation', async () => {
		expect(spawner.spawn(config()).success).toBe(true);
		const old = native;
		native = makeNative(23456);
		expect(spawner.spawn(config()).success).toBe(true);
		await close(native);
		await blocked();
		await close(old);
		const hold = await reserve();
		old.emit('close', 0, null);
		expect(spawner.spawn(config()).success).toBe(false);
		hold.release();
	});

	it('holds a reentrant successor admitted during completion reporting', async () => {
		expect(spawner.spawn(config()).success).toBe(true);
		const old = native;
		reports.exit.mockImplementationOnce(async () => {
			native = makeNative(23456);
			expect(spawner.spawn(config()).success).toBe(true);
		});
		await close(old);
		await blocked();
		await close();
		(await reserve()).release();
	});
});

describe('child-process asynchronous diagnostics', () => {
	it.each(
		[getAgentCapabilities, buildChildProcessEnv, spawn, collectMaestroEnvVars].flatMap(
			(setup, phase) => ['resolve', 'reject'].map((outcome) => ({ setup, phase, outcome }))
		)
	)(
		'retains phase $phase diagnostics through $outcome after native close or nonstart',
		async ({ setup, phase, outcome }) => {
			const reporting = Promise.withResolvers<void>();
			const failure = new Error('original setup failure');
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			vi.mocked(setup).mockImplementationOnce(() => {
				throw failure;
			});
			expect(spawner.spawn(config())).toMatchObject({
				success: false,
				error: expect.stringContaining('original setup failure'),
			});
			if (phase === 3) await close();
			await drain();
			expect(captureException).toHaveBeenCalledWith(
				phase === 2 ? expect.objectContaining({ cause: failure }) : failure
			);
			await blocked();
			if (outcome === 'resolve') reporting.resolve();
			else reporting.reject(new Error('report rejected'));
			await drain();
			expect(captureException).toHaveBeenCalledTimes(1);
			(await reserve()).release();
		}
	);

	it.each(['resolve', 'reject', 'throw'])(
		'preserves a synchronous failed spawn when its reporter will %s',
		async (outcome) => {
			vi.mocked(buildChildProcessEnv).mockImplementationOnce(() => {
				throw new Error('setup');
			});
			vi.mocked(captureException).mockImplementationOnce(() => {
				if (outcome === 'throw') throw new Error('report threw');
				return outcome === 'reject'
					? Promise.reject(new Error('report rejected'))
					: Promise.resolve();
			});
			expect(spawner.spawn(config())).toMatchObject({ success: false, error: 'setup' });
			await drain();
			expect(captureException).toHaveBeenCalledTimes(1);
			(await reserve()).release();
		}
	);

	it.each(['exit', 'error', 'raw', 'supervised'])(
		'retains %s recovery diagnostics independently after completion',
		async (source) => {
			const reporting = Promise.withResolvers<void>();
			const failure = new Error('callback failed');
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			if (source === 'exit') reports.exit.mockRejectedValueOnce(failure);
			if (source === 'error')
				reports.error.mockImplementationOnce(() => {
					throw failure;
				});
			if (source === 'raw')
				emitter.on('raw-stdout', () => {
					throw failure;
				});
			if (source === 'supervised') {
				reports.flush.mockImplementationOnce(() => {
					throw failure;
				});
				reports.exit.mockImplementationOnce(async () => {
					emitter.emit('exit', 'child-session', 1);
				});
			}
			expect(
				spawner.spawn(
					config(source === 'supervised' ? { toolType: 'codex', prompt: 'fixture' } : {})
				).success
			).toBe(true);
			if (source === 'supervised') {
				const opts = vi.mocked(superviseAgentProcess).mock.calls[0][1];
				opts.onStop!('fixture timeout');
			}
			if (source === 'error') native.emit('error', new Error('native error'));
			if (source === 'raw') native.stdout.emit('data', 'fixture');
			await close();
			expect(captureException).toHaveBeenCalledWith(failure);
			await blocked();
			reporting.reject(new Error('report rejected'));
			await drain();
			expect(captureException).toHaveBeenCalledTimes(1);
			(await reserve()).release();
		}
	);

	it('keeps the native child when diagnostics settle first', async () => {
		const reporting = Promise.withResolvers<void>();
		vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
		vi.mocked(collectMaestroEnvVars).mockImplementationOnce(() => {
			throw new Error('metadata');
		});
		expect(spawner.spawn(config()).success).toBe(false);
		await drain();
		reporting.resolve();
		await drain();
		await blocked();
		await close();
		(await reserve()).release();
	});

	it.each(['setup', 'exit', 'completion', 'raw'])(
		'keeps prior diagnostics when the %s logger also throws',
		async (source) => {
			const reporting = Promise.withResolvers<void>();
			const failure = new Error('original failure');
			const logFailure = new Error('logger failed');
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			vi.mocked(logger.error).mockImplementation(() => {
				throw logFailure;
			});
			if (source === 'setup')
				vi.mocked(buildChildProcessEnv).mockImplementationOnce(() => {
					throw failure;
				});
			if (source === 'exit') reports.exit.mockRejectedValueOnce(failure);
			if (source === 'completion')
				reports.error.mockImplementationOnce(() => {
					throw failure;
				});
			if (source === 'raw')
				emitter.on('raw-stdout', () => {
					throw failure;
				});
			const result = spawner.spawn(config());
			if (source === 'setup')
				expect(result).toMatchObject({ success: false, error: 'logger failed' });
			else {
				expect(result.success).toBe(true);
				if (source === 'completion') native.emit('error', new Error('native error'));
				if (source === 'raw')
					expect(() => native.stdout.emit('data', 'fixture')).toThrow(logFailure);
				await close();
			}
			await drain();
			expect(captureException).toHaveBeenCalledWith(failure);
			expect(captureException).toHaveBeenCalledWith(logFailure);
			await blocked();
			reporting.resolve();
			await drain();
			(await reserve()).release();
		}
	);

	it('keeps multiple raw diagnostics and a same-session successor independent', async () => {
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		vi.mocked(captureException)
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		emitter.on('raw-stdout', () => {
			throw new Error('listener');
		});
		expect(spawner.spawn(config()).success).toBe(true);
		native.stdout.emit('data', 'one');
		native.stdout.emit('data', 'two');
		const old = native;
		native = makeNative(23456);
		expect(spawner.spawn(config()).success).toBe(true);
		await close(old);
		first.resolve();
		await drain();
		await blocked();
		await close();
		await blocked();
		second.reject(new Error('late report'));
		await drain();
		(await reserve()).release();
	});

	it.each([target, path.join(target, 'descendant'), path.resolve('unrelated')])(
		'refuses a retained raw-output callback before effects under %s',
		async (root) => {
			expect(spawner.spawn(config()).success).toBe(true);
			const callback = native.stdout.listeners('data')[0];
			await close();
			const raw = vi.fn(() => {
				throw new Error('listener');
			});
			emitter.on('raw-stdout', raw);
			const hold = await reserve(root);
			expect(() => callback('late')).toThrow(/reserved/);
			expect(raw).not.toHaveBeenCalled();
			expect(captureException).not.toHaveBeenCalled();
			hold.release();
		}
	);

	it('retained raw diagnostics block a pending canonical reservation after native close', async () => {
		expect(spawner.spawn(config()).success).toBe(true);
		const callback = native.stdout.listeners('data')[0];
		await close();
		const reporting = Promise.withResolvers<void>();
		vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
		emitter.on('raw-stdout', () => {
			throw new Error('late listener');
		});
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const pending = gate.reserveWorktreeCleanup(target);
		callback('late');
		canonical.resolve(target);
		expect(await pending).toMatchObject({ status: 'blocked' });
		await drain();
		await blocked();
		reporting.resolve();
		await drain();
		(await reserve()).release();
	});
});

it('retained supervised-exit diagnostics have their own admission after completion', async () => {
	let listener!: (...args: unknown[]) => void;
	expect(spawner.spawn(config({ toolType: 'codex', prompt: 'fixture' })).success).toBe(true);
	const opts = vi.mocked(superviseAgentProcess).mock.calls[0][1];
	opts.onStop!('fixture timeout');
	reports.exit.mockImplementationOnce(async () => {
		listener = emitter.listeners('exit')[0] as (...args: unknown[]) => void;
	});
	await close();
	const reporting = Promise.withResolvers<void>();
	const failure = new Error('flush failed');
	reports.flush.mockImplementationOnce(() => {
		throw failure;
	});
	vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
	const hold = await reserve();
	expect(() => listener('child-session')).toThrow(/reserved/);
	expect(reports.flush).not.toHaveBeenCalled();
	expect(captureException).not.toHaveBeenCalled();
	hold.release();
	listener('child-session');
	await drain();
	expect(captureException).toHaveBeenCalledWith(failure);
	await blocked();
	reporting.resolve();
	await drain();
	(await reserve()).release();
});

it.each(['reject', 'throw'])(
	'raw output keeps its recovery verdict when reporting will %s',
	async (outcome) => {
		emitter.on('raw-stdout', () => {
			throw new Error('listener failed');
		});
		vi.mocked(captureException).mockImplementationOnce(() => {
			if (outcome === 'throw') throw new Error('report failed');
			return Promise.reject(new Error('report rejected'));
		});
		expect(spawner.spawn(config()).success).toBe(true);
		expect(() => native.stdout.emit('data', 'fixture')).not.toThrow();
		await drain();
		expect(captureException).toHaveBeenCalledTimes(1);
		await blocked();
		await close();
		(await reserve()).release();
	}
);

describe('retained stderr and stream-error activity', () => {
	const sources = [
		'stderr-data',
		'stdin-EPIPE',
		'stdin-error',
		'stdout-error',
		'stderr-error',
	] as const;

	function retainCallback(source: (typeof sources)[number], error = new Error('stream error')) {
		if (source === 'stderr-data') {
			const callback = native.stderr.listeners('data')[0];
			return () => callback('fixture stderr');
		}
		const stream = source.startsWith('stdin')
			? native.stdin
			: source === 'stdout-error'
				? native.stdout
				: native.stderr;
		const callback = stream.listeners('error').at(-1)!;
		if (source === 'stdin-EPIPE') Object.assign(error, { code: 'EPIPE' });
		return () => callback(error);
	}

	function failCallback(source: (typeof sources)[number], failure: Error) {
		const effect =
			source === 'stderr-data'
				? reports.stderr
				: source === 'stdin-EPIPE'
					? logger.debug
					: logger.error;
		vi.mocked(effect).mockImplementationOnce(() => {
			throw failure;
		});
	}

	it.each(
		sources.flatMap((source) =>
			[target, path.join(target, 'child'), path.resolve('other')].map((root) => ({ source, root }))
		)
	)(
		'refuses $source before inspection, handler or logging under $root after close',
		async ({ source, root }) => {
			expect(spawner.spawn(config()).success).toBe(true);
			const error = new Error('late stream');
			const callback = retainCallback(source, error);
			await close();
			processes.clear();
			const inspect = vi.fn(() => 'EPIPE');
			Object.defineProperty(error, 'code', { get: inspect });
			error.toString = inspect;
			vi.mocked(logger.debug).mockClear();
			vi.mocked(logger.error).mockClear();
			const hold = await reserve(root);
			expect(() => callback()).toThrow(/reserved/);
			for (const probe of [inspect, reports.stderr, logger.debug, logger.error, captureException])
				expect(probe).not.toHaveBeenCalled();
			hold.release();
			callback();
			expect(
				source === 'stderr-data'
					? reports.stderr
					: source.startsWith('stdin')
						? logger.debug
						: logger.error
			).toHaveBeenCalled();
			(await reserve()).release();
		}
	);

	it.each(
		sources.flatMap((source) =>
			['resolve', 'reject', 'throw'].map((outcome) => ({ source, outcome }))
		)
	)(
		'preserves $source failure and owns its diagnostic through $outcome after close',
		async ({ source, outcome }) => {
			expect(spawner.spawn(config()).success).toBe(true);
			const callback = retainCallback(source);
			await close();
			processes.clear();
			const failure = new Error('callback failure');
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockImplementationOnce(() => {
				if (outcome === 'throw') throw new Error('reporter threw');
				return reporting.promise;
			});
			failCallback(source, failure);
			expect(() => callback()).toThrow(failure);
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			if (outcome !== 'throw') {
				await blocked();
				if (outcome === 'resolve') reporting.resolve();
				else reporting.reject(new Error('reporter rejected'));
				await drain();
			}
			expect(captureException).toHaveBeenCalledTimes(1);
			(await reserve()).release();
		}
	);

	it.each(sources)(
		'blocks pending canonicalization from $0 callback diagnostics',
		async (source) => {
			expect(spawner.spawn(config()).success).toBe(true);
			const callback = retainCallback(source);
			await close();
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			const canonical = Promise.withResolvers<string>();
			vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
			const pending = gate.reserveWorktreeCleanup(target);
			const failure = new Error('late callback failure');
			failCallback(source, failure);
			expect(() => callback()).toThrow(failure);
			canonical.resolve(target);
			expect(await pending).toMatchObject({ status: 'blocked' });
			await blocked();
			reporting.resolve();
			await drain();
			(await reserve()).release();
		}
	);

	it.each(sources)(
		'does not release the native child when $0 diagnostics settle first',
		async (source) => {
			expect(spawner.spawn(config()).success).toBe(true);
			const callback = retainCallback(source);
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			const failure = new Error('callback failure');
			failCallback(source, failure);
			expect(() => callback()).toThrow(failure);
			reporting.resolve();
			await drain();
			await blocked();
			await close();
			(await reserve()).release();
		}
	);

	it.each(sources)('preserves healthy $0 routing and a synchronous return', async (source) => {
		expect(spawner.spawn(config()).success).toBe(true);
		const error = new Error('stream error');
		const callback = retainCallback(source, error);
		vi.mocked(logger.debug).mockClear();
		vi.mocked(logger.error).mockClear();
		expect(callback()).toBeUndefined();
		if (source === 'stderr-data')
			expect(reports.stderr).toHaveBeenCalledExactlyOnceWith('child-session', 'fixture stderr');
		else if (source === 'stdin-EPIPE') {
			expect(logger.debug).toHaveBeenCalledWith(
				expect.stringContaining('stdin EPIPE'),
				'ProcessManager',
				{ sessionId: 'child-session' }
			);
			expect(logger.error).not.toHaveBeenCalled();
		} else {
			expect(logger.error).toHaveBeenCalledWith(
				expect.stringContaining(source.split('-')[0] + ' error'),
				'ProcessManager',
				expect.objectContaining({ sessionId: 'child-session', error: String(error) })
			);
		}
		expect(captureException).not.toHaveBeenCalled();
		await close();
		(await reserve()).release();
	});

	it('admits before filtering a superseded stderr callback and never routes it to the successor', async () => {
		expect(spawner.spawn(config()).success).toBe(true);
		const callback = retainCallback('stderr-data');
		const old = native;
		native = makeNative(23456);
		expect(spawner.spawn(config()).success).toBe(true);
		await close(old);
		await close();
		const hold = await reserve();
		expect(() => callback()).toThrow(/reserved/);
		expect(reports.stderr).not.toHaveBeenCalled();
		hold.release();
		expect(callback()).toBeUndefined();
		expect(reports.stderr).not.toHaveBeenCalled();
		(await reserve()).release();
	});

	it('keeps concurrent callback diagnostics and a successor independently owned', async () => {
		expect(spawner.spawn(config()).success).toBe(true);
		const stderr = retainCallback('stderr-data');
		const stream = retainCallback('stdout-error');
		const old = native;
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		vi.mocked(captureException)
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const failure = new Error('callback failure');
		failCallback('stderr-data', failure);
		expect(() => stderr()).toThrow(failure);
		failCallback('stdout-error', failure);
		expect(() => stream()).toThrow(failure);
		native = makeNative(23456);
		expect(spawner.spawn(config()).success).toBe(true);
		await close(old);
		first.resolve();
		await drain();
		await blocked();
		await close();
		await blocked();
		second.reject(new Error('late reporter rejection'));
		await drain();
		expect(captureException).toHaveBeenCalledTimes(2);
		(await reserve()).release();
	});
});

describe('retained child supervision adapters', () => {
	const sources = ['stop', 'forced', 'parsed', 'supersede', 'watchdog'] as const;
	const fallible = ['stop', 'parsed', 'supersede', 'watchdog'] as const;

	function retain(source: (typeof sources)[number]) {
		const supervision = {
			observe: vi.fn(),
			dispose: vi.fn(),
			modelActivity: vi.fn(),
			processExited: Promise.resolve(),
		};
		vi.mocked(superviseAgentProcess).mockReturnValueOnce(supervision);
		expect(
			spawner.spawn(
				config(
					source === 'watchdog'
						? {}
						: {
								toolType: 'codex',
								prompt: 'fixture',
							}
				)
			).success
		).toBe(true);
		const managed = processes.get('child-session')!;
		const options = vi.mocked(superviseAgentProcess).mock.calls.at(-1)?.[1];
		const parsed = emitter.listeners('parsed-event')[0];
		const supersede = spawner['supervisions'].get('child-session');
		const callback =
			source === 'stop'
				? () => options!.onStop('fixture timeout')
				: source === 'forced'
					? options!.onForcedStop
					: source === 'parsed'
						? () => parsed('child-session', { type: 'text', text: 'fixture' })
						: source === 'supersede'
							? supersede!
							: vi.mocked(armStdioCloseWatchdog).mock.calls.at(-1)![1]!.onForceClose!;
		const fail = (failure: Error) => {
			if (source === 'stop')
				Object.defineProperty(managed, 'errorEmitted', {
					configurable: true,
					set: () => {
						throw failure;
					},
				});
			else
				vi.mocked(
					source === 'parsed'
						? supervision.observe
						: source === 'supersede'
							? supervision.dispose
							: logger.warn
				).mockImplementationOnce(() => {
					throw failure;
				});
		};
		return { callback, supervision, options, managed, fail };
	}

	it.each(
		sources.flatMap((source) =>
			[target, path.join(target, 'child'), path.resolve('other')].map((root) => ({ source, root }))
		)
	)('refuses retained $source before effects under $root after close', async ({ source, root }) => {
		const { callback, supervision, managed } = retain(source);
		await close();
		processes.clear();
		// Admission must precede even generation/identity filtering or state writes.
		const generation = managed.spawnGeneration;
		const inspect = vi.fn(() => generation);
		const effect = vi.fn();
		Object.defineProperty(managed, 'spawnGeneration', { get: inspect });
		Object.defineProperty(managed, 'errorEmitted', { set: effect });
		supervision.dispose.mockClear();
		vi.mocked(logger.warn).mockClear();
		const off = vi.spyOn(emitter, 'off');
		const hold = await reserve(root);
		expect(() => callback()).toThrow(/reserved/);
		for (const probe of [
			inspect,
			effect,
			supervision.observe,
			supervision.dispose,
			off,
			logger.warn,
			captureException,
		])
			expect(probe).not.toHaveBeenCalled();
		hold.release();
		expect(callback()).toBeUndefined();
		await drain();
		if (source === 'stop') expect(effect).toHaveBeenCalledOnce();
		if (source === 'supersede') expect(supervision.dispose).toHaveBeenCalledOnce();
		if (source === 'watchdog') expect(logger.warn).toHaveBeenCalledOnce();
		(await reserve()).release();
	});

	it.each(
		fallible.flatMap((source) =>
			['resolve', 'reject', 'throw'].map((outcome) => ({ source, outcome }))
		)
	)(
		'owns late $source diagnostics through $outcome and preserves the thrown error',
		async ({ source, outcome }) => {
			const { callback, fail } = retain(source);
			await close();
			const failure = new Error('adapter failed');
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockImplementation(() => {
				if (outcome === 'throw') throw new Error('reporter threw');
				return reporting.promise;
			});
			fail(failure);
			expect(() => callback()).toThrow(failure);
			// Supersession and its nested disposal each observe the original error.
			const count = source === 'supersede' ? 2 : 1;
			expect(captureException).toHaveBeenCalledTimes(count);
			expect(captureException).toHaveBeenCalledWith(failure);
			processes.clear();
			if (outcome !== 'throw') {
				await blocked();
				if (outcome === 'resolve') reporting.resolve();
				else reporting.reject(new Error('reporter rejected'));
				await drain();
			}
			expect(captureException).toHaveBeenCalledTimes(count);
			(await reserve()).release();
		}
	);

	it.each(fallible)('blocks pending canonicalization with $0 diagnostics', async (source) => {
		const { callback, fail } = retain(source);
		await close();
		const reporting = Promise.withResolvers<void>();
		vi.mocked(captureException).mockReturnValue(reporting.promise);
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const pending = gate.reserveWorktreeCleanup(target);
		const failure = new Error('late adapter failure');
		fail(failure);
		expect(() => callback()).toThrow(failure);
		canonical.resolve(target);
		expect(await pending).toMatchObject({ status: 'blocked' });
		reporting.resolve();
		await drain();
		(await reserve()).release();
	});

	it.each(fallible)('keeps native ownership after $0 diagnostics settle first', async (source) => {
		const { callback, fail, managed } = retain(source);
		const reporting = Promise.withResolvers<void>();
		vi.mocked(captureException).mockReturnValue(reporting.promise);
		const failure = new Error('adapter failure');
		fail(failure);
		expect(() => callback()).toThrow(failure);
		reporting.resolve();
		await drain();
		await blocked();
		// Restore the fixture property before normal completion.
		if (source === 'stop') delete managed.errorEmitted;
		await close();
		(await reserve()).release();
	});

	it('owns nested disposal failure after forced completion until diagnostics settle', async () => {
		const { callback, supervision } = retain('forced');
		const reporting = Promise.withResolvers<void>();
		vi.mocked(captureException).mockReturnValue(reporting.promise);
		const failure = new Error('dispose failed');
		supervision.dispose.mockImplementationOnce(() => {
			throw failure;
		});
		expect(callback()).toBeUndefined();
		await close();
		processes.clear();
		await blocked();
		expect(captureException).toHaveBeenCalledWith(failure);
		reporting.reject(new Error('report rejected'));
		await drain();
		(await reserve()).release();
	});

	it('keeps concurrent predecessor diagnostics and a same-session successor independent', async () => {
		const { callback: parsed } = retain('parsed');
		const old = native;
		native = makeNative(23456);
		const watchdog = retain('watchdog').callback;
		await close(old);
		await close();
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		vi.mocked(captureException)
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const failure = new Error('concurrent adapter failure');
		// Use watchdog twice so both admitted callbacks can fail after map removal.
		for (let i = 0; i < 2; i++) {
			vi.mocked(logger.warn).mockImplementationOnce(() => {
				throw failure;
			});
			expect(() => watchdog()).toThrow(failure);
		}
		processes.clear();
		native = makeNative(45678);
		expect(spawner.spawn(config()).success).toBe(true);
		expect(parsed()).toBeUndefined();
		first.resolve();
		await drain();
		await blocked();
		await close();
		await blocked();
		second.reject(new Error('second reporter rejected'));
		await drain();
		(await reserve()).release();
	});

	it('refuses a failed predecessor supersession before termination and preserves retry', async () => {
		const { callback, options, supervision } = retain('supersede');
		options!.onStop('fixture timeout');
		await close();
		supervision.dispose.mockClear();
		const hold = await reserve();
		expect(() => callback()).toThrow(/reserved/);
		expect(stopProcess).not.toHaveBeenCalled();
		expect(supervision.dispose).not.toHaveBeenCalled();
		expect(captureException).not.toHaveBeenCalled();
		hold.release();
		expect(callback()).toBeUndefined();
		expect(stopProcess).toHaveBeenCalledExactlyOnceWith(
			{ child: native },
			{ from: 'terminate', graceMs: expect.any(Number), immediate: true },
			expect.any(Function)
		);
		expect(supervision.dispose).toHaveBeenCalledOnce();
		(await reserve()).release();
	});

	it('preserves parsed generation/identity routing and forced failure completion before close', async () => {
		const { callback: parsed, supervision, options, managed } = retain('parsed');
		expect(parsed()).toBeUndefined();
		expect(supervision.observe).toHaveBeenCalledOnce();
		processes.clear();
		parsed();
		expect(supervision.observe).toHaveBeenCalledOnce();
		options!.onStop('fixture timeout');
		expect(managed.errorEmitted).toBe(true);
		options!.onForcedStop();
		await drain();
		expect(reports.exit).toHaveBeenCalledWith('child-session', 1, managed, null, undefined);
		await blocked();
		await close();
		(await reserve()).release();
	});
});

describe('retained shared stdio watchdog callbacks', () => {
	const sources = ['exit', 'close', 'timer'] as const;
	beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
	afterEach(() => vi.useRealTimers());

	function retain(source: (typeof sources)[number]) {
		expect(spawner.spawn(config()).success).toBe(true);
		// Exercise the real portable core with the actual desktop activity adapter.
		const runActivity = vi.mocked(armStdioCloseWatchdog).mock.calls.at(-1)![2];
		expect(runActivity).toBeTypeOf('function');
		const child = makeNative(24680);
		const streams = [child.stdin, child.stdout, child.stderr].map((stream) =>
			Object.assign(stream, { destroyed: false, destroy: vi.fn() })
		);
		const force = vi.fn();
		const schedule = vi.spyOn(globalThis, 'setTimeout');
		const cancel = vi.spyOn(globalThis, 'clearTimeout');
		armSharedWatchdog(
			child as unknown as Parameters<typeof armSharedWatchdog>[0],
			{
				graceMs: 10,
				onForceClose: force,
			},
			runActivity
		);
		const exit = child.listeners('exit')[0] as () => void;
		const closed = child.listeners('close')[0] as () => void;
		if (source !== 'exit') exit();
		const scheduled = source === 'exit' ? undefined : schedule.mock.calls.at(-1)![0];
		const timer = () => ((scheduled ?? schedule.mock.calls.at(-1)![0]) as () => void)();
		const callback = source === 'exit' ? exit : source === 'close' ? closed : timer;
		const fail = (error: Error) => {
			const effect =
				source === 'exit' ? schedule : source === 'close' ? cancel : streams[0].destroy;
			effect.mockImplementationOnce(() => {
				throw error;
			});
		};
		return { child, streams, force, schedule, cancel, callback, exit, closed, timer, fail };
	}

	it.each(
		sources.flatMap((source) =>
			[target, path.join(target, 'child'), path.resolve('elsewhere')].map((root) => ({
				source,
				root,
			}))
		)
	)(
		'refuses $source before watchdog state, timers or stream effects under $root',
		async ({ source, root }) => {
			const retained = retain(source);
			await close();
			processes.clear();
			retained.schedule.mockClear();
			retained.cancel.mockClear();
			const inspect = vi.fn(() => retained.streams[0]);
			Object.defineProperty(retained.child, 'stdin', { get: inspect });
			const hold = await reserve(root);
			expect(() => retained.callback()).toThrow(/reserved/);
			for (const probe of [
				retained.schedule,
				retained.cancel,
				retained.force,
				inspect,
				captureException,
				...retained.streams.map((stream) => stream.destroy),
			])
				expect(probe).not.toHaveBeenCalled();
			hold.release();
			// Refusal leaves closed/timer state untouched, so the original drain still runs.
			if (source === 'exit') retained.exit();
			else if (source === 'timer') {
				retained.exit();
				expect(retained.schedule).not.toHaveBeenCalled();
			}
			if (source !== 'exit') {
				// The original timer callback was captured before clearing call history.
				retained.schedule.mockRestore();
				vi.advanceTimersByTime(10);
			} else retained.timer();
			expect(retained.force).toHaveBeenCalledOnce();
			for (const stream of retained.streams) expect(stream.destroy).toHaveBeenCalledOnce();
			(await reserve()).release();
		}
	);

	it.each(
		sources.flatMap((source) =>
			['resolve', 'reject', 'throw'].map((outcome) => ({ source, outcome }))
		)
	)('owns late $source diagnostics through reporter $outcome', async ({ source, outcome }) => {
		const retained = retain(source);
		await close();
		const failure = new Error('watchdog effect failed');
		const reporting = Promise.withResolvers<void>();
		vi.mocked(captureException).mockImplementation(() => {
			if (outcome === 'throw') throw new Error('reporter threw');
			return reporting.promise;
		});
		retained.fail(failure);
		expect(() => retained.callback()).toThrow(failure);
		expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
		if (outcome !== 'throw') {
			await blocked();
			if (outcome === 'resolve') reporting.resolve();
			else reporting.reject(new Error('reporter rejected'));
			await drain();
		}
		expect(captureException).toHaveBeenCalledOnce();
		(await reserve()).release();
	});

	it.each(sources)(
		'blocks pending canonicalization while $0 diagnostics remain',
		async (source) => {
			const retained = retain(source);
			await close();
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValue(reporting.promise);
			const canonical = Promise.withResolvers<string>();
			vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
			const pending = gate.reserveWorktreeCleanup(target);
			const failure = new Error('watchdog failed during canonicalization');
			retained.fail(failure);
			expect(() => retained.callback()).toThrow(failure);
			canonical.resolve(target);
			expect(await pending).toMatchObject({ status: 'blocked' });
			reporting.resolve();
			await drain();
			(await reserve()).release();
		}
	);

	it.each(sources.flatMap((source) => ['native', 'report'].map((first) => ({ source, first }))))(
		'keeps $source diagnostic and native ownership independent when $first finishes first',
		async ({ source, first }) => {
			const retained = retain(source);
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValue(reporting.promise);
			const failure = new Error('watchdog failed before native close');
			retained.fail(failure);
			expect(() => retained.callback()).toThrow(failure);
			if (first === 'native') await close();
			else {
				reporting.resolve();
				await drain();
			}
			await blocked();
			if (first === 'native') {
				reporting.reject(new Error('reporter rejected'));
				await drain();
			} else await close();
			(await reserve()).release();
		}
	);

	it.each(sources)(
		'admits even stale no-op $0 callbacks before closed-state checks',
		async (source) => {
			const retained = retain(source);
			retained.closed();
			await close();
			const hold = await reserve();
			expect(() => retained.callback()).toThrow(/reserved/);
			expect(retained.force).not.toHaveBeenCalled();
			expect(captureException).not.toHaveBeenCalled();
			hold.release();
			expect(retained.callback()).toBeUndefined();
			(await reserve()).release();
		}
	);

	it('keeps concurrent retained watchdog diagnostics independent of a successor', async () => {
		const retained = retain('timer');
		await close();
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		vi.mocked(captureException)
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		for (let i = 0; i < 2; i++) {
			const failure = new Error('retained stream destroy failed');
			retained.fail(failure);
			expect(() => retained.callback()).toThrow(failure);
		}
		native = makeNative(34567);
		expect(spawner.spawn(config()).success).toBe(true);
		first.resolve();
		await drain();
		await blocked();
		await close();
		processes.clear();
		await blocked();
		second.reject(new Error('late report rejected'));
		await drain();
		expect(captureException).toHaveBeenCalledTimes(2);
		(await reserve()).release();
	});

	it('preserves synchronous stream destruction and normal close cancellation', async () => {
		const retained = retain('timer');
		await close();
		expect(retained.callback()).toBeUndefined();
		expect(retained.force).toHaveBeenCalledOnce();
		for (const stream of retained.streams) expect(stream.destroy).toHaveBeenCalledOnce();
		retained.closed();
		vi.advanceTimersByTime(20);
		expect(retained.force).toHaveBeenCalledOnce();
		(await reserve()).release();
	});
});

describe('retained shared process supervisor callbacks', () => {
	const sources = [
		'exit',
		'close',
		'error',
		'abort',
		'startup',
		'lifetime',
		'warning',
		'silence',
		'drain',
		'force',
		'model',
		'observe',
		'dispose',
	] as const;
	const fallible = sources.filter((source) => source !== 'close');
	beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
	afterEach(() => vi.useRealTimers());

	async function retain(source: (typeof sources)[number]) {
		expect(spawner.spawn(config({ toolType: 'codex', prompt: 'fixture' })).success).toBe(true);
		const runActivity = vi.mocked(superviseAgentProcess).mock.calls.at(-1)![2];
		expect(runActivity).toBeTypeOf('function');
		const actual = await vi.importActual<
			typeof import('../../../shared/maestro-lib/control/agent-process-supervisor')
		>('../../../shared/maestro-lib/control/agent-process-supervisor');
		const child = makeNative(24680);
		const streams = [child.stdout, child.stderr].map((stream) =>
			Object.assign(stream, { destroy: vi.fn() })
		);
		const controller = new AbortController();
		const listen = vi.spyOn(controller.signal, 'addEventListener');
		const schedule = vi.spyOn(globalThis, 'setTimeout');
		const cancel = vi.spyOn(globalThis, 'clearTimeout');
		const status = vi.fn();
		const stopped = vi.fn();
		const forced = vi.fn();
		const remove = vi.spyOn(child, 'removeListener');
		const supervision = actual.superviseAgentProcess(
			child as unknown as Parameters<typeof actual.superviseAgentProcess>[0],
			{
				startupMs: 10,
				timeoutMs: 20,
				idle: { warnMs: 30, idleMs: 40, toolMs: 50 },
				signal: controller.signal,
				onStatus: status,
				onStop: stopped,
				onForcedStop: forced,
			},
			runActivity
		);
		const exit = child.listeners('exit')[0] as () => void;
		const closed = child.listeners('close')[0] as () => void;
		const error = child.listeners('error')[0] as () => void;
		const abort = listen.mock.calls[0][1] as () => void;
		const timers = schedule.mock.calls.map((call) => call[0] as () => void);
		if (source === 'drain') exit();
		if (source === 'force') abort();
		const event = { type: 'text' as const, text: 'new model output', raw: {} };
		const callback =
			source === 'exit'
				? exit
				: source === 'close'
					? closed
					: source === 'error'
						? error
						: source === 'abort'
							? abort
							: source === 'model'
								? supervision.modelActivity
								: source === 'observe'
									? () => supervision.observe(event)
									: source === 'dispose'
										? supervision.dispose
										: source === 'drain' || source === 'force'
											? (schedule.mock.calls.at(-1)![0] as () => void)
											: timers[['startup', 'lifetime', 'warning', 'silence'].indexOf(source)];
		const fail = (failure: Error) => {
			const throws = () => {
				throw failure;
			};
			if (source === 'error')
				Object.defineProperty(child, 'pid', { get: throws, configurable: true });
			else if (source === 'observe')
				Object.defineProperty(event, 'raw', { get: throws, configurable: true });
			else {
				const effect =
					source === 'exit'
						? schedule
						: source === 'dispose'
							? remove
							: source === 'force'
								? streams[0].destroy
								: source === 'warning'
									? status
									: cancel;
				effect.mockImplementationOnce(throws);
			}
		};
		return {
			callback,
			fail,
			supervision,
			child,
			streams,
			schedule,
			cancel,
			status,
			stopped,
			forced,
			remove,
			exit,
		};
	}

	it.each(
		sources.flatMap((source) =>
			[target, path.join(target, 'child'), path.resolve('elsewhere')].map((root) => ({
				source,
				root,
			}))
		)
	)('refuses $source before supervisor effects under $root', async ({ source, root }) => {
		const retained = await retain(source);
		await close();
		for (const probe of [
			retained.schedule,
			retained.cancel,
			retained.status,
			retained.stopped,
			retained.forced,
			retained.remove,
			stopProcess,
		])
			vi.mocked(probe).mockClear();
		const inspect = vi.fn(() => 24680);
		Object.defineProperty(retained.child, 'pid', { get: inspect, configurable: true });
		const hold = await reserve(root);
		expect(() => retained.callback()).toThrow(/reserved/);
		for (const probe of [
			retained.schedule,
			retained.cancel,
			retained.status,
			retained.stopped,
			retained.forced,
			retained.remove,
			stopProcess,
			inspect,
			captureException,
			...retained.streams.map((stream) => stream.destroy),
		])
			expect(probe).not.toHaveBeenCalled();
		hold.release();
		expect(retained.callback()).toBeUndefined();
		if (source === 'exit') expect(retained.schedule).toHaveBeenCalled();
		if (source === 'force' || source === 'drain')
			for (const stream of retained.streams) expect(stream.destroy).toHaveBeenCalledOnce();
		retained.supervision.dispose();
		const stale = await reserve(root);
		expect(() => retained.callback()).toThrow(/reserved/);
		stale.release();
		(await reserve()).release();
	});

	it.each(
		fallible.flatMap((source) =>
			['resolve', 'reject', 'throw'].map((outcome) => ({ source, outcome }))
		)
	)('owns late $source failure through diagnostic $outcome', async ({ source, outcome }) => {
		const retained = await retain(source);
		await close();
		const reporting = Promise.withResolvers<void>();
		vi.mocked(captureException).mockImplementation(() => {
			if (outcome === 'throw') throw new Error('reporter threw');
			return reporting.promise;
		});
		const failure = new Error('supervisor effect failed');
		retained.fail(failure);
		expect(() => retained.callback()).toThrow(failure);
		expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
		if (outcome !== 'throw') {
			await blocked();
			if (outcome === 'resolve') reporting.resolve();
			else reporting.reject(new Error('reporter rejected'));
			await drain();
		}
		(await reserve()).release();
	});

	it.each(fallible)('blocks pending canonicalization during $0 diagnostic', async (source) => {
		const retained = await retain(source);
		await close();
		const canonical = Promise.withResolvers<string>();
		const reporting = Promise.withResolvers<void>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		vi.mocked(captureException).mockReturnValue(reporting.promise);
		const pending = gate.reserveWorktreeCleanup(target);
		const failure = new Error('failed during canonicalization');
		retained.fail(failure);
		expect(() => retained.callback()).toThrow(failure);
		canonical.resolve(target);
		expect(await pending).toMatchObject({ status: 'blocked' });
		reporting.resolve();
		await drain();
		(await reserve()).release();
	});

	it.each(['native', 'report'])(
		'retains independent native and supervisor diagnostic ownership with %s first',
		async (first) => {
			const retained = await retain('observe');
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValue(reporting.promise);
			const failure = new Error('observation failed');
			retained.fail(failure);
			expect(() => retained.callback()).toThrow(failure);
			if (first === 'native') await close();
			else {
				reporting.resolve();
				await drain();
			}
			await blocked();
			if (first === 'native') {
				reporting.reject(new Error('late rejection'));
				await drain();
			} else await close();
			(await reserve()).release();
		}
	);

	it('retains concurrent predecessor diagnostics independently of a successor', async () => {
		const retained = await retain('observe');
		await close();
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		vi.mocked(captureException)
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const failure = new Error('retained observation failed');
		retained.fail(failure);
		for (let i = 0; i < 2; i++) expect(() => retained.callback()).toThrow(failure);
		native = makeNative(34567);
		expect(spawner.spawn(config()).success).toBe(true);
		first.resolve();
		await drain();
		await blocked();
		await close();
		await blocked();
		second.reject(new Error('late reporter rejection'));
		await drain();
		expect(captureException).toHaveBeenCalledTimes(2);
		(await reserve()).release();
	});

	it('does not confirm native exit from refused close/error callbacks', async () => {
		for (const source of ['close', 'error'] as const) {
			const retained = await retain(source);
			await close();
			Object.defineProperty(retained.child, 'pid', { value: undefined, configurable: true });
			const exited = vi.fn();
			void retained.supervision.processExited.then(exited);
			const hold = await reserve();
			expect(() => retained.callback()).toThrow(/reserved/);
			await drain();
			expect(exited).not.toHaveBeenCalled();
			hold.release();
			retained.callback();
			await drain();
			expect(exited).toHaveBeenCalledOnce();
			retained.supervision.dispose();
		}
	});
});

describe('retained shared synchronous stop-ladder callbacks', () => {
	const sources = ['request', 'timer', 'exit', 'stage', 'dispose'] as const;
	const fallible = sources.filter((source) => source !== 'stage');
	beforeEach(() =>
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
	);
	afterEach(() => vi.useRealTimers());

	async function retain(source: (typeof sources)[number], portableFirst = false, withTree = false) {
		expect(spawner.spawn(config({ toolType: 'codex', prompt: 'fixture' })).success).toBe(true);
		const activity = vi.mocked(superviseAgentProcess).mock.calls.at(-1)![2]!;
		const actual = await vi.importActual<
			typeof import('../../../shared/maestro-lib/control/termination')
		>('../../../shared/maestro-lib/control/termination');
		const child = Object.assign(makeNative(24680), { signalCode: null });
		const schedule = vi.spyOn(globalThis, 'setTimeout');
		const cancel = vi.spyOn(globalThis, 'clearTimeout');
		const remove = vi.spyOn(child, 'off');
		const requested = vi.fn();
		const options = {
			from: 'interrupt' as const,
			graceMs: 10,
			includeDescendants: withTree,
			onStopRequested: requested,
		};
		const targetChild = {
			child: child as unknown as Parameters<typeof actual.stopProcess>[0]['child'],
		};
		const handle = actual.stopProcess(targetChild, options, portableFirst ? undefined : activity);
		const exit = child.listeners('exit')[0] as () => void;
		const timer = schedule.mock.calls.at(-1)![0] as () => void;
		if (portableFirst) expect(actual.stopProcess(targetChild, options, activity)).toBe(handle);
		const request = () => actual.stopProcess(targetChild, { ...options, from: 'terminate' });
		const callback =
			source === 'request'
				? request
				: source === 'timer'
					? timer
					: source === 'exit'
						? exit
						: source === 'stage'
							? handle.stage
							: handle.dispose;
		const fail = (failure: Error) => {
			const throws = () => {
				throw failure;
			};
			if (source === 'exit' || source === 'dispose') remove.mockImplementationOnce(throws);
			else Object.defineProperty(child, 'exitCode', { get: throws, configurable: true });
		};
		return {
			activity,
			actual,
			callback,
			fail,
			child,
			handle,
			schedule,
			cancel,
			remove,
			requested,
			request,
			timer,
			exit,
		};
	}

	it.each(['stage', 'dispose'] as const)(
		'admits inert %s callbacks before returning',
		async (source) => {
			const retained = await retain('dispose');
			const handle = retained.actual.stopProcess(
				{},
				{ from: 'terminate', graceMs: 10 },
				retained.activity
			);
			await close();
			const hold = await reserve();
			expect(() => handle[source]()).toThrow(/reserved/);
			hold.release();
			expect(handle[source]()).toBeUndefined();
			retained.handle.dispose();
		}
	);

	it('refuses exit before the descendant sweep and preserves the record for retry', async () => {
		const retained = await retain('exit', false, true);
		await close();
		const hold = await reserve();
		expect(() => retained.exit()).toThrow(/reserved/);
		expect(killSurvivors).not.toHaveBeenCalled();
		hold.release();
		retained.exit();
		expect(killSurvivors).toHaveBeenCalledExactlyOnceWith(
			[{ pid: 45678, startedAt: 'fixture' }],
			expect.any(Object)
		);
		retained.exit();
		expect(killSurvivors).toHaveBeenCalledOnce();
		(await reserve()).release();
	});

	it.each(
		sources.flatMap((source) =>
			[target, path.join(target, 'child'), path.resolve('elsewhere')].map((root) => ({
				source,
				root,
			}))
		)
	)('refuses $source before stop-ladder effects under $root', async ({ source, root }) => {
		const retained = await retain(source);
		await close();
		processes.clear();
		const inspect = vi.fn(() => null);
		Object.defineProperty(retained.child, 'exitCode', { get: inspect, configurable: true });
		const probes = [
			retained.schedule,
			retained.cancel,
			retained.remove,
			retained.requested,
			retained.child.kill,
			inspect,
			captureException,
		];
		for (const probe of probes) vi.mocked(probe).mockClear();
		const hold = await reserve(root);
		expect(() => retained.callback()).toThrow(/reserved/);
		for (const probe of probes) expect(probe).not.toHaveBeenCalled();
		hold.release();
		retained.callback();
		if (source === 'request' || source === 'timer')
			expect(retained.child.kill).toHaveBeenCalledWith('SIGTERM');
		if (source === 'exit' || source === 'dispose') expect(retained.remove).toHaveBeenCalledOnce();
		retained.handle.dispose();
		const stale = await reserve(root);
		// An omitted injection inherits a live ladder's guard. Once disposed,
		// a fresh standalone request needs its own injection again.
		if (source !== 'request') expect(() => retained.callback()).toThrow(/reserved/);
		stale.release();
	});

	it('refuses injected setup before inspecting target or recording a stop', async () => {
		const retained = await retain('request');
		const actual = await vi.importActual<
			typeof import('../../../shared/maestro-lib/control/termination')
		>('../../../shared/maestro-lib/control/termination');
		await close();
		const inspect = vi.fn(() => retained.child);
		const targetChild = {
			get child() {
				return inspect() as unknown as Parameters<typeof actual.stopProcess>[0]['child'];
			},
		};
		const requested = vi.fn();
		const activity = vi.mocked(superviseAgentProcess).mock.calls.at(-1)![2];
		const hold = await reserve();
		expect(() =>
			actual.stopProcess(
				targetChild,
				{ from: 'kill', graceMs: 10, onStopRequested: requested },
				activity
			)
		).toThrow(/reserved/);
		expect(inspect).not.toHaveBeenCalled();
		expect(requested).not.toHaveBeenCalled();
		hold.release();
		retained.handle.dispose();
	});

	it.each(sources)(
		'upgrades a prior portable ladder including retained $0 callbacks',
		async (source) => {
			const retained = await retain(source, true);
			await close();
			const hold = await reserve();
			expect(() => retained.callback()).toThrow(/reserved/);
			hold.release();
			retained.callback();
			retained.handle.dispose();
		}
	);

	it.each(
		fallible.flatMap((source) =>
			['resolve', 'reject', 'throw'].map((outcome) => ({ source, outcome }))
		)
	)(
		'owns $source failure independently through diagnostic $outcome',
		async ({ source, outcome }) => {
			const retained = await retain(source);
			await close();
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockImplementation(() => {
				if (outcome === 'throw') throw new Error('reporter threw');
				return reporting.promise;
			});
			const failure = new Error('retained stop effect failed');
			retained.fail(failure);
			expect(() => retained.callback()).toThrow(failure);
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			if (outcome !== 'throw') {
				await blocked();
				if (outcome === 'resolve') reporting.resolve();
				else reporting.reject(new Error('reporter rejected'));
				await drain();
			}
			(await reserve()).release();
		}
	);

	it.each(fallible)('blocks pending canonicalization during $0 diagnostics', async (source) => {
		const retained = await retain(source);
		await close();
		const canonical = Promise.withResolvers<string>();
		const reporting = Promise.withResolvers<void>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		vi.mocked(captureException).mockReturnValue(reporting.promise);
		const pending = gate.reserveWorktreeCleanup(target);
		retained.fail(new Error('failure during canonicalization'));
		expect(() => retained.callback()).toThrow('failure during canonicalization');
		canonical.resolve(target);
		expect(await pending).toMatchObject({ status: 'blocked' });
		reporting.resolve();
		await drain();
		(await reserve()).release();
	});

	it.each(['native', 'report'])(
		'retains stop diagnostic and native ownership with %s first',
		async (first) => {
			const retained = await retain('timer');
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValue(reporting.promise);
			retained.fail(new Error('stop timer failed'));
			expect(() => retained.callback()).toThrow('stop timer failed');
			if (first === 'native') await close();
			else {
				reporting.resolve();
				await drain();
			}
			await blocked();
			if (first === 'native') {
				reporting.reject(new Error('late rejection'));
				await drain();
			} else await close();
			(await reserve()).release();
		}
	);

	it('retains concurrent old stop diagnostics independently of a successor', async () => {
		const retained = await retain('timer');
		await close();
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		vi.mocked(captureException)
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		retained.fail(new Error('retained timer failed'));
		for (let i = 0; i < 2; i++) expect(() => retained.callback()).toThrow('retained timer failed');
		native = makeNative(34567);
		expect(spawner.spawn(config()).success).toBe(true);
		first.resolve();
		await drain();
		await blocked();
		await close();
		await blocked();
		second.reject(new Error('late diagnostic rejected'));
		await drain();
		expect(captureException).toHaveBeenCalledTimes(2);
		(await reserve()).release();
	});

	it('does not let stale disposal unregister a replacement ladder on the same child', async () => {
		const retained = await retain('dispose');
		retained.handle.dispose();
		const next = retained.request();
		retained.handle.dispose();
		expect(retained.request()).toBe(next);
		next.dispose();
		await close();
		(await reserve()).release();
	});

	it('forwards desktop activity from the supervisor into its shared stop ladder', async () => {
		expect(spawner.spawn(config({ toolType: 'codex', prompt: 'fixture' })).success).toBe(true);
		const activity = vi.mocked(superviseAgentProcess).mock.calls.at(-1)![2];
		const actual = await vi.importActual<
			typeof import('../../../shared/maestro-lib/control/agent-process-supervisor')
		>('../../../shared/maestro-lib/control/agent-process-supervisor');
		const controller = new AbortController();
		const supervision = actual.superviseAgentProcess(
			native as unknown as Parameters<typeof actual.superviseAgentProcess>[0],
			{
				signal: controller.signal,
				onStop: vi.fn(),
				onForcedStop: vi.fn(),
			},
			activity
		);
		controller.abort();
		expect(vi.mocked(stopProcess).mock.calls.at(-1)![2]).toBe(activity);
		supervision.dispose();
		await close();
		(await reserve()).release();
	});
});

describe('retained stop-ladder process-tree refresh activity', () => {
	beforeEach(() =>
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
	);
	afterEach(() => vi.useRealTimers());

	async function retain(portableFirst = false) {
		expect(spawner.spawn(config({ toolType: 'codex', prompt: 'fixture' })).success).toBe(true);
		const activity = vi.mocked(superviseAgentProcess).mock.calls.at(-1)![2]!;
		const actual = await vi.importActual<
			typeof import('../../../shared/maestro-lib/control/termination')
		>('../../../shared/maestro-lib/control/termination');
		const child = Object.assign(makeNative(24680), { signalCode: null });
		const schedule = vi.spyOn(globalThis, 'setInterval');
		const options = { from: 'interrupt' as const, graceMs: 1000 };
		const targetChild = {
			child: child as unknown as Parameters<typeof actual.stopProcess>[0]['child'],
		};
		let failure: Error | undefined;
		const guarded: typeof activity = (operation) =>
			activity(() => {
				if (failure) throw failure;
				return operation();
			});
		const handle = actual.stopProcess(targetChild, options, portableFirst ? undefined : guarded);
		const callback = schedule.mock.calls.at(-1)![0] as () => void;
		if (portableFirst) expect(actual.stopProcess(targetChild, options, guarded)).toBe(handle);
		return {
			handle,
			callback,
			child,
			fail: (error?: Error) => (failure = error),
			exit: () => child.emit('exit', 0, null),
		};
	}

	it.each(
		[target, path.join(target, 'child'), path.resolve('elsewhere')].flatMap((root) =>
			[false, true].map((portableFirst) => ({ root, portableFirst }))
		)
	)('refuses refresh before state effects under $root, upgraded=$portableFirst', async (input) => {
		const retained = await retain(input.portableFirst);
		await close();
		processes.clear();
		const hold = await reserve(input.root);
		expect(() => retained.callback()).toThrow(/reserved/);
		expect(refreshProcessTree).not.toHaveBeenCalled();
		hold.release();
		retained.callback();
		expect(refreshProcessTree).toHaveBeenCalledOnce();
		await drain();
		retained.handle.dispose();
		const stale = await reserve(input.root);
		expect(() => retained.callback()).toThrow(/reserved/);
		stale.release();
	});

	it('blocks pending canonicalization until a refresh settles after disposal', async () => {
		const retained = await retain();
		await close();
		const refresh = Promise.withResolvers<Awaited<ReturnType<typeof refreshProcessTree>>>();
		vi.mocked(refreshProcessTree).mockReturnValueOnce(refresh.promise);
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const pending = gate.reserveWorktreeCleanup(target);
		retained.callback();
		retained.handle.dispose();
		canonical.resolve(target);
		expect(await pending).toMatchObject({ status: 'blocked' });
		await blocked();
		refresh.resolve({ owned: true, descendants: [] });
		await drain();
		(await reserve()).release();
	});

	it.each(
		['resolve', 'reject'].flatMap((outcome) =>
			['exit', 'dispose'].flatMap((finish) =>
				['native', 'refresh'].map((first) => ({ outcome, finish, first }))
			)
		)
	)('owns refresh $outcome after $finish with $first first', async ({ outcome, finish, first }) => {
		const retained = await retain();
		const refresh = Promise.withResolvers<Awaited<ReturnType<typeof refreshProcessTree>>>();
		vi.mocked(refreshProcessTree).mockReturnValueOnce(refresh.promise);
		retained.callback();
		retained.callback();
		expect(refreshProcessTree).toHaveBeenCalledOnce();
		if (finish === 'exit') retained.exit();
		else retained.handle.dispose();
		const settle = async () => {
			if (outcome === 'reject') refresh.reject(new Error('process table unavailable'));
			else refresh.resolve({ owned: true, descendants: [{ pid: 56789, startedAt: 'late' }] });
			await drain();
		};
		if (first === 'native') await close();
		else await settle();
		await blocked();
		if (first === 'native') await settle();
		else await close();
		(await reserve()).release();
		if (finish === 'exit') {
			retained.exit();
			expect(killSurvivors).toHaveBeenCalledExactlyOnceWith(
				[{ pid: 45678, startedAt: 'fixture' }],
				expect.any(Object)
			);
		}
		expect(captureException).not.toHaveBeenCalled();
	});

	it('retains refreshed descendants and permits retry after a failed table read', async () => {
		const retained = await retain();
		const refresh = Promise.withResolvers<Awaited<ReturnType<typeof refreshProcessTree>>>();
		vi.mocked(refreshProcessTree).mockReturnValueOnce(refresh.promise);
		retained.callback();
		refresh.reject(new Error('process table unavailable'));
		await drain();
		const descendants = [{ pid: 56789, startedAt: 'late' }];
		vi.mocked(refreshProcessTree).mockResolvedValueOnce({ owned: true, descendants });
		retained.callback();
		await drain();
		retained.exit();
		expect(killSurvivors).toHaveBeenCalledExactlyOnceWith(descendants, expect.any(Object));
		await close();
		(await reserve()).release();
	});

	it.each(
		['resolve', 'reject'].flatMap((outcome) =>
			['resolve', 'reject', 'throw'].map((report) => ({ outcome, report }))
		)
	)(
		'owns $outcome continuation failures through diagnostic $report',
		async ({ outcome, report }) => {
			const retained = await retain();
			const refresh = Promise.withResolvers<Awaited<ReturnType<typeof refreshProcessTree>>>();
			vi.mocked(refreshProcessTree).mockReturnValueOnce(refresh.promise);
			retained.callback();
			retained.handle.dispose();
			await close();
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockImplementation(() => {
				if (report === 'throw') throw new Error('reporter threw');
				return reporting.promise;
			});
			const failure = new Error('refresh continuation failed');
			retained.fail(failure);
			if (outcome === 'resolve') refresh.resolve({ owned: true, descendants: [] });
			else refresh.reject(new Error('process table unavailable'));
			await drain();
			expect(captureException).toHaveBeenCalledWith(failure);
			if (report !== 'throw') {
				await blocked();
				if (report === 'resolve') reporting.resolve();
				else reporting.reject(new Error('reporter rejected'));
				await drain();
			}
			retained.fail();
			(await reserve()).release();
		}
	);

	it.each(['native', 'report'])(
		'keeps refresh diagnostics and native ownership with %s first',
		async (first) => {
			const retained = await retain();
			const refresh = Promise.withResolvers<Awaited<ReturnType<typeof refreshProcessTree>>>();
			vi.mocked(refreshProcessTree).mockReturnValueOnce(refresh.promise);
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValue(reporting.promise);
			retained.callback();
			retained.handle.dispose();
			retained.fail(new Error('late refresh continuation failed'));
			refresh.resolve({ owned: true, descendants: [] });
			await drain();
			expect(captureException).toHaveBeenCalled();
			if (first === 'native') await close();
			else {
				reporting.resolve();
				await drain();
			}
			await blocked();
			if (first === 'native') {
				reporting.reject(new Error('late diagnostic rejected'));
				await drain();
			} else await close();
			retained.fail();
			(await reserve()).release();
		}
	);

	it('keeps predecessor refreshes and a successor native lifetime independent', async () => {
		const first = await retain();
		const second = await retain();
		const a = Promise.withResolvers<Awaited<ReturnType<typeof refreshProcessTree>>>();
		const b = Promise.withResolvers<Awaited<ReturnType<typeof refreshProcessTree>>>();
		vi.mocked(refreshProcessTree).mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
		first.callback();
		second.callback();
		first.handle.dispose();
		second.handle.dispose();
		await close();
		native = makeNative(34567);
		expect(spawner.spawn(config()).success).toBe(true);
		a.resolve({ owned: true, descendants: [] });
		await drain();
		await blocked();
		await close();
		await blocked();
		b.reject(new Error('late table failure'));
		await drain();
		(await reserve()).release();
	});
});

describe('Windows taskkill native and retained callback activity', () => {
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
		const platform = await import('../../../shared/platformDetection');
		vi.spyOn(platform, 'isWindows').mockReturnValue(true);
		const host = await import('../../../shared/maestro-lib/host');
		host.setMaestroLibLogger(logger);
		host.setMaestroLibErrorReporter({ captureException, captureMessage: vi.fn() });
	});
	afterEach(() => vi.useRealTimers());

	async function retain(portableFirst = false) {
		expect(spawner.spawn(config({ toolType: 'codex', prompt: 'fixture' })).success).toBe(true);
		const activity = vi.mocked(superviseAgentProcess).mock.calls.at(-1)![2]!;
		const actual = await vi.importActual<
			typeof import('../../../shared/maestro-lib/control/termination')
		>('../../../shared/maestro-lib/control/termination');
		const child = Object.assign(makeNative(24680), { signalCode: null });
		const targetChild = {
			child: child as unknown as Parameters<typeof actual.stopProcess>[0]['child'],
		};
		const options = { from: 'interrupt' as const, graceMs: 1000 };
		const handle = actual.stopProcess(targetChild, options, portableFirst ? undefined : activity);
		if (portableFirst) expect(actual.stopProcess(targetChild, options, activity)).toBe(handle);
		const killer = new EventEmitter();
		vi.mocked(execFile).mockReturnValueOnce(killer as ReturnType<typeof execFile>);
		return {
			handle,
			child,
			killer,
			stop: (extra = {}) =>
				actual.stopProcess(targetChild, { from: 'terminate', graceMs: 1000, ...extra }),
			result: () => vi.mocked(execFile).mock.calls.at(-1)![2] as (error: Error | null) => void,
			exit: () => {
				Object.assign(child, { exitCode: 0 });
				child.emit('exit', 0, null);
			},
		};
	}

	it.each(
		[target, path.join(target, 'child'), path.resolve('elsewhere')].flatMap((root) =>
			[false, true].map((portableFirst) => ({ root, portableFirst }))
		)
	)('refuses setup and retained recovery under $root upgraded=$portableFirst', async (input) => {
		const retained = await retain(input.portableFirst);
		await close();
		const hold = await reserve(input.root);
		expect(retained.stop).toThrow(/reserved/);
		expect(execFile).not.toHaveBeenCalled();
		hold.release();
		retained.stop();
		expect(execFile).toHaveBeenCalledExactlyOnceWith(
			'taskkill',
			['/pid', '24680', '/t', '/f'],
			expect.any(Function)
		);
		const result = retained.result();
		const onClose = retained.killer.listeners('close').at(-1)! as () => void;
		retained.handle.dispose();
		result(null);
		retained.killer.emit('exit', 0);
		await blocked();
		retained.killer.emit('close', 0);
		await drain();
		const stale = await reserve(input.root);
		vi.mocked(logger.warn).mockClear();
		expect(() => result(new Error('late failure'))).toThrow(/reserved/);
		expect(onClose).toThrow(/reserved/);
		expect(logger.warn).not.toHaveBeenCalled();
		expect(retained.child.kill).not.toHaveBeenCalled();
		stale.release();
		result(new Error('late failure'));
		expect(retained.child.kill).toHaveBeenCalledExactlyOnceWith();
		await drain();
		(await reserve()).release();
	});

	it('retains native work through pending canonicalization, target exit and error callback', async () => {
		const retained = await retain();
		await close();
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const pending = gate.reserveWorktreeCleanup(target);
		retained.stop({ immediate: true });
		retained.exit();
		retained.result()(new Error('spawn failed before native close'));
		canonical.resolve(target);
		expect(await pending).toMatchObject({ status: 'blocked' });
		await blocked();
		retained.killer.emit('exit', 1);
		await blocked();
		retained.killer.emit('close', 1);
		await drain();
		(await reserve()).release();
		expect(captureException).not.toHaveBeenCalled();
	});

	it.each(['native', 'target'])(
		'keeps taskkill and target ownership independent with %s first',
		async (first) => {
			const retained = await retain();
			retained.stop();
			retained.handle.dispose();
			if (first === 'native') retained.killer.emit('close', 0);
			else await close();
			await drain();
			await blocked();
			if (first === 'native') await close();
			else retained.killer.emit('close', 0);
			await drain();
			(await reserve()).release();
		}
	);

	it.each(
		['resolve', 'reject', 'throw'].flatMap((report) =>
			['native', 'diagnostic'].map((first) => ({ report, first }))
		)
	)(
		'retains taskkill/report $report independently with $first first',
		async ({ report, first }) => {
			const retained = await retain();
			retained.stop();
			retained.handle.dispose();
			await close();
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockImplementation(() => {
				if (report === 'throw') throw new Error('reporter threw');
				return reporting.promise;
			});
			const failure = new Error('taskkill failed');
			retained.result()(failure);
			expect(retained.child.kill).toHaveBeenCalledExactlyOnceWith();
			await drain();
			expect(captureException).toHaveBeenCalledWith(failure, {
				operation: 'termination:taskkill',
				pid: 24680,
			});
			const settle = async () => {
				if (report === 'reject') reporting.reject(new Error('reporter rejected'));
				else reporting.resolve();
				await drain();
			};
			if (first === 'native') retained.killer.emit('close', 1);
			else await settle();
			await drain();
			if (report !== 'throw' || first !== 'native') await blocked();
			if (first === 'native') await settle();
			else retained.killer.emit('close', 1);
			await drain();
			(await reserve()).release();
		}
	);

	it('owns a replayed callback diagnostic after native close during canonicalization', async () => {
		const retained = await retain();
		retained.stop();
		retained.handle.dispose();
		await close();
		retained.killer.emit('close', 0);
		await drain();
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const pending = gate.reserveWorktreeCleanup(target);
		const reporting = Promise.withResolvers<void>();
		vi.mocked(captureException).mockReturnValue(reporting.promise);
		retained.result()(new Error('late taskkill result'));
		canonical.resolve(target);
		expect(await pending).toMatchObject({ status: 'blocked' });
		await blocked();
		reporting.resolve();
		await drain();
		(await reserve()).release();
	});

	it('retains separate predecessor native children and a same-session successor', async () => {
		const first = await retain();
		first.stop();
		const a = first.result();
		const second = await retain();
		second.stop();
		const b = second.result();
		first.handle.dispose();
		second.handle.dispose();
		await close();
		native = makeNative(34567);
		expect(spawner.spawn(config()).success).toBe(true);
		a(null);
		first.killer.emit('close', 0);
		await drain();
		await blocked();
		await close();
		await blocked();
		b(null);
		second.killer.emit('close', 0);
		await drain();
		(await reserve()).release();
	});

	it.each(['warn', 'debug'] as const)(
		'owns synchronous %s callback failures and their diagnostics after native close',
		async (level) => {
			const retained = await retain();
			retained.stop();
			retained.handle.dispose();
			if (level === 'debug') retained.exit();
			await close();
			retained.killer.emit('close', 0);
			await drain();
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValue(reporting.promise);
			const failure = new Error('taskkill callback log failed');
			vi.mocked(logger[level]).mockImplementationOnce(() => {
				throw failure;
			});
			expect(() => retained.result()(new Error('taskkill failed'))).toThrow(failure);
			expect(captureException).toHaveBeenCalledWith(failure);
			expect(retained.child.kill).not.toHaveBeenCalled();
			await blocked();
			reporting.reject(new Error('reporter rejected'));
			await drain();
			(await reserve()).release();
		}
	);

	it('retains concurrent late diagnostics independently of a successor native child', async () => {
		const first = await retain();
		first.stop();
		const a = first.result();
		const second = await retain();
		second.stop();
		const b = second.result();
		first.handle.dispose();
		second.handle.dispose();
		await close();
		first.killer.emit('close', 0);
		second.killer.emit('close', 0);
		await drain();
		const one = Promise.withResolvers<void>();
		const two = Promise.withResolvers<void>();
		vi.mocked(captureException).mockReturnValueOnce(one.promise).mockReturnValueOnce(two.promise);
		a(new Error('first late failure'));
		b(new Error('second late failure'));
		await drain();
		native = makeNative(34567);
		expect(spawner.spawn(config()).success).toBe(true);
		one.resolve();
		await drain();
		await blocked();
		await close();
		await blocked();
		two.reject(new Error('second diagnostic rejected'));
		await drain();
		(await reserve()).release();
	});

	it('retains original reporting when the synchronous fallback also fails', async () => {
		const retained = await retain();
		retained.stop();
		retained.handle.dispose();
		await close();
		retained.killer.emit('close', 0);
		await drain();
		const original = Promise.withResolvers<void>();
		const recovery = Promise.withResolvers<void>();
		const failure = new Error('taskkill failed');
		const fallback = new Error('fallback log failed');
		vi.mocked(captureException).mockImplementation((error) =>
			error === failure ? original.promise : recovery.promise
		);
		retained.child.kill.mockImplementationOnce(() => {
			throw new Error('fallback signal failed');
		});
		vi.mocked(logger.debug).mockImplementationOnce(() => {
			throw fallback;
		});
		expect(() => retained.result()(failure)).toThrow(fallback);
		await drain();
		expect(captureException).toHaveBeenCalledWith(failure, expect.any(Object));
		expect(captureException).toHaveBeenCalledWith(fallback);
		recovery.resolve();
		await drain();
		await blocked();
		original.reject(new Error('original reporter rejected'));
		await drain();
		(await reserve()).release();
	});

	it('keeps unknown native close observation blocked after binding failure', async () => {
		const retained = await retain();
		await close();
		vi.spyOn(retained.killer, 'once').mockImplementationOnce(() => {
			throw new Error('close binding unavailable');
		});
		expect(retained.stop).toThrow('close binding unavailable');
		retained.result()(null);
		retained.killer.emit('close', 0);
		await drain();
		await blocked();
	});

	it('releases a synchronous launch failure after its diagnostics settle', async () => {
		const retained = await retain();
		await close();
		vi.mocked(execFile)
			.mockReset()
			.mockImplementationOnce(() => {
				throw new Error('taskkill launch failed');
			});
		const reporting = Promise.withResolvers<void>();
		vi.mocked(captureException).mockReturnValue(reporting.promise);
		expect(retained.stop).toThrow('taskkill launch failed');
		await blocked();
		reporting.resolve();
		await drain();
		(await reserve()).release();
	});
});

describe('direct failed-predecessor supersession stop activity', () => {
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
		const host = await import('../../../shared/maestro-lib/host');
		host.setMaestroLibLogger(logger);
		host.setMaestroLibErrorReporter({ captureException, captureMessage: vi.fn() });
	});
	afterEach(() => vi.useRealTimers());

	async function retain(upgrade = false, windows = true) {
		const platform = await import('../../../shared/platformDetection');
		vi.spyOn(platform, 'isWindows').mockReturnValue(windows);
		const actual = await vi.importActual<
			typeof import('../../../shared/maestro-lib/control/termination')
		>('../../../shared/maestro-lib/control/termination');
		vi.mocked(stopProcess).mockImplementation(actual.stopProcess);
		Object.assign(native, { signalCode: null });
		expect(spawner.spawn(config({ toolType: 'codex', prompt: 'fixture' })).success).toBe(true);
		const supervision = vi.mocked(superviseAgentProcess).mock.calls.at(-1)![1];
		const supersede = spawner['supervisions'].get('child-session')!;
		supervision.onStop('fixture timeout');
		const schedule = vi.spyOn(globalThis, 'setTimeout');
		const interval = vi.spyOn(globalThis, 'setInterval');
		if (upgrade)
			actual.stopProcess(
				{ child: native as unknown as Parameters<typeof actual.stopProcess>[0]['child'] },
				{ from: 'interrupt', graceMs: 1000 }
			);
		const exit = native.listeners('exit').at(-1) as () => void;
		const timer = schedule.mock.calls.at(-1)?.[0] as () => void;
		const refresh = interval.mock.calls.at(-1)?.[0] as () => void;
		const killer = new EventEmitter();
		vi.mocked(execFile).mockReturnValueOnce(killer as ReturnType<typeof execFile>);
		supersede();
		const handle = vi.mocked(stopProcess).mock.results.at(-1)!.value as ReturnType<
			typeof stopProcess
		>;
		return {
			handle,
			killer,
			exit,
			timer,
			refresh,
			result: vi.mocked(execFile).mock.calls.at(-1)?.[2] as (error: Error | null) => void,
			onClose: killer.listeners('close')[0] as () => void,
		};
	}

	it('injects callback observation without changing immediate stop options', async () => {
		const retained = await retain();
		expect(stopProcess).toHaveBeenLastCalledWith(
			{ child: native },
			{ from: 'terminate', graceMs: 2000, immediate: true },
			expect.any(Function)
		);
		await close();
		retained.killer.emit('close', 0);
		await drain();
		(await reserve()).release();
	});

	it.each(
		[false, true].flatMap((upgrade) =>
			['result', 'close', 'stage', 'dispose'].flatMap((source) =>
				[target, path.join(target, 'child'), path.resolve('elsewhere')].map((root) => ({
					upgrade,
					source,
					root,
				}))
			)
		)
	)(
		'refuses retained $source under $root after immediate stop (upgrade=$upgrade)',
		async ({ upgrade, source, root }) => {
			const retained = await retain(upgrade);
			await close();
			processes.clear();
			retained.killer.emit('close', 0);
			await drain();
			const inspect = vi.fn(() => null);
			Object.defineProperty(native, 'exitCode', { get: inspect, configurable: true });
			native.kill.mockClear();
			vi.mocked(logger.warn).mockClear();
			vi.mocked(logger.debug).mockClear();
			const callback =
				source === 'result'
					? () => retained.result(new Error('late taskkill failure'))
					: source === 'close'
						? retained.onClose
						: source === 'stage'
							? retained.handle.stage
							: retained.handle.dispose;
			const hold = await reserve(root);
			expect(callback).toThrow(/reserved/);
			for (const probe of [inspect, native.kill, logger.warn, logger.debug, captureException])
				expect(probe).not.toHaveBeenCalled();
			hold.release();
			callback();
			await drain();
			(await reserve()).release();
		}
	);

	it.each([false, true])(
		'keeps taskkill through predecessor close/removal and successor close (upgrade=%s)',
		async (upgrade) => {
			const retained = await retain(upgrade);
			expect(execFile).toHaveBeenCalledExactlyOnceWith(
				'taskkill',
				['/pid', '12345', '/t', '/f'],
				expect.any(Function)
			);
			await close();
			processes.clear();
			retained.result(null);
			retained.killer.emit('exit', 0);
			await blocked();
			native = makeNative(34567);
			expect(spawner.spawn(config()).success).toBe(true);
			retained.killer.emit('close', 0);
			await drain();
			await blocked();
			await close();
			(await reserve()).release();
		}
	);

	it('retains two generations of immediate taskkill independently', async () => {
		const first = await retain();
		await close();
		processes.clear();
		native = makeNative(34567);
		const second = await retain();
		await close();
		processes.clear();
		first.result(null);
		second.result(null);
		first.killer.emit('close', 0);
		await drain();
		await blocked();
		second.killer.emit('close', 0);
		await drain();
		(await reserve()).release();
	});

	it.each(['native', 'target'])(
		'owns immediate taskkill independently with %s closing first',
		async (first) => {
			const retained = await retain();
			if (first === 'native') retained.killer.emit('close', 0);
			else await close();
			await drain();
			await blocked();
			if (first === 'native') await close();
			else retained.killer.emit('close', 0);
			await drain();
			(await reserve()).release();
		}
	);

	it.each(
		['resolve', 'reject', 'throw'].flatMap((outcome) =>
			['native', 'report'].map((first) => ({ outcome, first }))
		)
	)(
		'owns taskkill and diagnostic $outcome with $first settling first',
		async ({ outcome, first }) => {
			const retained = await retain();
			await close();
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockImplementation(() => {
				if (outcome === 'throw') throw new Error('reporter threw');
				return reporting.promise;
			});
			const failure = new Error('taskkill failed');
			retained.result(failure);
			expect(native.kill).toHaveBeenCalledExactlyOnceWith();
			await drain();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure, {
				operation: 'termination:taskkill',
				pid: 12345,
			});
			const settle = async () => {
				if (outcome === 'reject') reporting.reject(new Error('report rejected'));
				else reporting.resolve();
				await drain();
			};
			if (first === 'native') retained.killer.emit('close', 1);
			else await settle();
			await drain();
			if (outcome !== 'throw' || first !== 'native') await blocked();
			if (first === 'native') await settle();
			else retained.killer.emit('close', 1);
			await drain();
			(await reserve()).release();
		}
	);

	it('blocks canonicalization racing a late taskkill diagnostic after native close', async () => {
		const retained = await retain();
		await close();
		processes.clear();
		retained.killer.emit('close', 0);
		await drain();
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const pending = gate.reserveWorktreeCleanup(target);
		const reporting = Promise.withResolvers<void>();
		vi.mocked(captureException).mockReturnValue(reporting.promise);
		retained.result(new Error('late diagnostic'));
		canonical.resolve(target);
		expect(await pending).toMatchObject({ status: 'blocked' });
		await blocked();
		reporting.resolve();
		await drain();
		(await reserve()).release();
	});

	it.each(['timer', 'exit', 'refresh', 'stage', 'dispose'] as const)(
		'upgrades portable retained %s before immediate POSIX disposal',
		async (source) => {
			const retained = await retain(true, false);
			expect(native.kill).toHaveBeenNthCalledWith(1, 'SIGINT');
			expect(native.kill).toHaveBeenNthCalledWith(2, 'SIGTERM');
			expect(killProcessTreeNow).toHaveBeenCalledExactlyOnceWith(12345, expect.any(Object));
			expect(vi.mocked(killProcessTreeNow).mock.invocationCallOrder[0]).toBeGreaterThan(
				native.kill.mock.invocationCallOrder[1]
			);
			expect(execFile).not.toHaveBeenCalled();
			await close();
			const callback =
				source === 'stage'
					? retained.handle.stage
					: source === 'dispose'
						? retained.handle.dispose
						: retained[source];
			const hold = await reserve();
			expect(callback).toThrow(/reserved/);
			hold.release();
			callback();
			await drain();
			(await reserve()).release();
		}
	);
});
