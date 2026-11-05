import fs from 'fs/promises';
import path from 'path';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedProcess, ProcessConfig } from '../../../main/process-manager/types';
import type { DataBufferManager } from '../../../main/process-manager/handlers/DataBufferManager';

vi.mock('fs/promises', () => ({ default: { realpath: vi.fn() } }));
vi.mock('child_process', async (original) => ({
	...(await original<typeof import('child_process')>()),
	spawn: vi.fn(),
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

import { getAgentCapabilities } from '../../../main/agents';
import {
	buildChildProcessEnv,
	collectMaestroEnvVars,
} from '../../../main/process-manager/utils/envBuilder';
import { saveImageToTempFile } from '../../../main/process-manager/utils/imageUtils';
import { captureException } from '../../../main/utils/sentry';
import { logger } from '../../../main/utils/logger';
import { superviseAgentProcess } from '../../../shared/maestro-lib/control/agent-process-supervisor';

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
