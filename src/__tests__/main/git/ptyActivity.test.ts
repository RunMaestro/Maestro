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
		onData: vi.fn(),
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
	expect(await gate.reserveWorktreeCleanup(target)).toMatchObject({
		status: 'blocked',
		blockers: [{ code: 'mutation-busy' }],
	});
}

beforeEach(async () => {
	vi.resetModules();
	vi.resetAllMocks();
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
		old.events.emit('native-exit', { exitCode: 0 });
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
