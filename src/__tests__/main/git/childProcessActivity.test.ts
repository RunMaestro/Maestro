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
		handleData = vi.fn();
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
import { superviseAgentProcess } from '../../../shared/maestro-lib/control/agent-process-supervisor';

const reports = vi.hoisted(() => ({ exit: vi.fn(), error: vi.fn() }));
const target = path.resolve('child-cleanup-target');
let gate: typeof import('../../../main/git/worktreeActivity');
let spawner: import('../../../main/process-manager/spawners/ChildProcessSpawner').ChildProcessSpawner;
let native: ReturnType<typeof makeNative>;
let processes: Map<string, ManagedProcess>;

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
	spawner = new ChildProcessSpawner(processes, new EventEmitter(), {} as DataBufferManager);
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
