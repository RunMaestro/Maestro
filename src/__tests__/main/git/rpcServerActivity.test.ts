import fs from 'fs/promises';
import path from 'path';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	ManagedProcess,
	ProcessConfig,
	SpawnResult,
} from '../../../main/process-manager/types';
import type { DataBufferManager } from '../../../main/process-manager/handlers/DataBufferManager';
import type { NdJsonConnection } from '../../../shared/maestro-lib/harness/rpc/connection';

const probes = vi.hoisted(() => ({
	request: vi.fn(),
	close: vi.fn(),
	exit: vi.fn(),
	output: vi.fn(),
	interaction: vi.fn(),
	connected: vi.fn<(options: ConstructorParameters<typeof NdJsonConnection>[1]) => void>(),
}));
vi.mock('fs/promises', () => ({ default: { realpath: vi.fn() } }));
vi.mock('child_process', async (original) => ({
	...(await original<typeof import('child_process')>()),
	spawn: vi.fn(),
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/parsers', () => ({ createOutputParser: vi.fn() }));
vi.mock('../../../main/process-manager/handlers/StdoutHandler', () => ({
	StdoutHandler: class {
		handleData = probes.output;
	},
}));
vi.mock('../../../main/process-manager/handlers/StderrHandler', () => ({
	StderrHandler: class {
		handleData = vi.fn();
	},
}));
vi.mock('../../../main/process-manager/handlers/ExitHandler', () => ({
	ExitHandler: class {
		handleExit = probes.exit;
	},
}));
vi.mock('../../../main/process-manager/utils/envBuilder', () => ({
	buildChildProcessEnv: vi.fn(() => ({})),
}));
vi.mock('../../../main/process-manager/utils/windowsSpawnShell', () => ({
	planSpawnShell: vi.fn((command, args) => ({ command, args, shell: false })),
}));
vi.mock('../../../shared/maestro-lib/control/termination', () => ({
	stopProcess: vi.fn(),
	INTERACTIVE_STOP_GRACE_MS: 1000,
}));
vi.mock('../../../shared/maestro-lib/harness/rpc/connection', () => ({
	NdJsonConnection: class {
		request = probes.request;
		close = probes.close;
		constructor(_child: unknown, options: ConstructorParameters<typeof NdJsonConnection>[1]) {
			probes.connected(options);
		}
	},
}));
vi.mock('../../../main/harness-control/rpc-interactions', () => ({
	answerRpcExtensionRequest: probes.interaction,
}));

import { buildChildProcessEnv } from '../../../main/process-manager/utils/envBuilder';
import { planSpawnShell } from '../../../main/process-manager/utils/windowsSpawnShell';
import { createOutputParser } from '../../../main/parsers';
import { stopProcess } from '../../../shared/maestro-lib/control/termination';

const target = path.resolve('rpc-cleanup-target');
let gate: typeof import('../../../main/git/worktreeActivity');
let spawner: import('../../../main/process-manager/spawners/RpcServerSpawner').RpcServerSpawner;
let native: ReturnType<typeof makeNative>;
let processes: Map<string, ManagedProcess>;
let fallback: ReturnType<typeof vi.fn<(config: ProcessConfig) => SpawnResult>>;

function makeNative() {
	return Object.assign(new EventEmitter(), {
		pid: 12345,
		exitCode: null,
		stdin: Object.assign(new EventEmitter(), { end: vi.fn(), write: vi.fn() }),
		stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
		stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
	});
}
function config(overrides: Partial<ProcessConfig> = {}): ProcessConfig {
	return {
		sessionId: 'rpc-session',
		toolType: 'omp',
		cwd: target,
		command: 'omp',
		args: [],
		nativeRpcArgs: ['--mode', 'rpc-ui'],
		nativeRpcProtocol: 'omp-rpc',
		permissionMode: 'standard',
		prompt: 'fixture',
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
function connection() {
	return probes.connected.mock.calls.at(-1)![0];
}

beforeEach(async () => {
	vi.resetModules();
	vi.resetAllMocks();
	vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
	probes.exit.mockResolvedValue(undefined);
	probes.request.mockResolvedValue({});
	probes.interaction.mockResolvedValue({ kind: 'ignore' });
	native = makeNative();
	vi.mocked(spawn).mockImplementation(() => native as unknown as ReturnType<typeof spawn>);
	gate = await import('../../../main/git/worktreeActivity');
	const { RpcServerSpawner } =
		await import('../../../main/process-manager/spawners/RpcServerSpawner');
	processes = new Map();
	fallback = vi.fn(() => ({ success: true, pid: 999 }));
	spawner = new RpcServerSpawner(processes, new EventEmitter(), {} as DataBufferManager, fallback);
});
afterEach(() => vi.restoreAllMocks());

describe('standalone native RPC activity', () => {
	it.each([target, path.join(target, 'descendant'), path.resolve('unrelated')])(
		'refuses before protocol/parser/shell/env/native/fallback setup under %s',
		async (root) => {
			const hold = await reserve(root);
			vi.mocked(fs.realpath).mockClear();
			for (const input of [
				config(),
				config({ nativeRpcArgs: undefined }),
				config({ cwd: '/remote' }),
			])
				expect(spawner.spawn(input)).toMatchObject({
					success: false,
					error: expect.stringContaining('reserved'),
				});
			for (const probe of [
				createOutputParser,
				planSpawnShell,
				buildChildProcessEnv,
				spawn,
				fallback,
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
	it('registers synchronously while an earlier reservation is resolving', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const pending = gate.reserveWorktreeCleanup(target);
		spawner.spawn(config());
		canonical.resolve(target);
		expect(await pending).toMatchObject({ status: 'blocked' });
		await close();
		(await reserve()).release();
	});
	it('admits before shell/env setup and holds asynchronous RPC preparation after Stop', async () => {
		const setup = Promise.withResolvers<unknown>();
		probes.request.mockReturnValueOnce(setup.promise);
		let duringSetup!: Promise<void>;
		vi.mocked(planSpawnShell).mockImplementationOnce((command, args) => {
			duringSetup = blocked();
			return { command, args, shell: false };
		});
		spawner.spawn(config());
		await duringSetup;
		await processes.get('rpc-session')!.sdkController!.interrupt();
		await close();
		await blocked();
		setup.resolve({});
		await drain();
		expect(probes.request.mock.calls.some(([method]) => method === 'prompt')).toBe(false);
		expect(fallback).not.toHaveBeenCalled();
		(await reserve()).release();
	});
	it.each(['exit', 'error', 'result', 'kill'])(
		'retains native activity after %s until close',
		async (event) => {
			spawner.spawn(config());
			await drain();
			if (event === 'exit') native.emit('exit', 0, null);
			if (event === 'error') native.emit('error', new Error('transport failed'));
			if (event === 'result') connection().onNotification({ type: 'session_settled' });
			if (event === 'kill') await processes.get('rpc-session')!.sdkController!.kill();
			await drain();
			await blocked();
			await close();
			(await reserve()).release();
		}
	);
	it('holds through async exit reporting even when close was already observed', async () => {
		const reporting = Promise.withResolvers<void>();
		probes.exit.mockReturnValueOnce(reporting.promise);
		spawner.spawn(config());
		await drain();
		await close();
		await blocked();
		reporting.resolve();
		await drain();
		(await reserve()).release();
	});
	it('retains permission work after close and failed result reporting', async () => {
		const interaction = Promise.withResolvers<{ kind: 'ignore' }>();
		probes.interaction.mockReturnValueOnce(interaction.promise);
		probes.exit.mockRejectedValueOnce(new Error('report failed'));
		spawner.spawn(config());
		await drain();
		const response = connection().onServerRequest({ id: 'permission', method: 'confirm' });
		await close();
		await blocked();
		interaction.resolve({ kind: 'ignore' });
		await response;
		await drain();
		(await reserve()).release();
	});
	it.each(['steer', 'abort', 'pi-state'])(
		'holds pending %s work after native close',
		async (kind) => {
			spawner.spawn(config({ nativeRpcProtocol: 'pi-rpc' }));
			await drain();
			const pending = Promise.withResolvers<unknown>();
			probes.request.mockReturnValueOnce(pending.promise);
			const managed = processes.get('rpc-session')!;
			if (kind === 'steer') void managed.harnessControl!.steer({ id: 'steer', text: 'fixture' });
			if (kind === 'abort') await managed.sdkController!.interrupt();
			if (kind === 'pi-state') connection().onNotification({ type: 'agent_end' });
			await close();
			await blocked();
			pending.resolve({});
			await drain();
			(await reserve()).release();
		}
	);
	it.each(['shell', 'env', 'nonstart'])(
		'releases proven pre-native %s failure',
		async (failure) => {
			const fail = () => {
				throw new Error('setup failed');
			};
			if (failure === 'shell') vi.mocked(planSpawnShell).mockImplementationOnce(fail);
			if (failure === 'env') vi.mocked(buildChildProcessEnv).mockImplementationOnce(fail);
			if (failure === 'nonstart') vi.mocked(spawn).mockImplementationOnce(fail);
			expect(spawner.spawn(config()).success).toBe(false);
			(await reserve()).release();
		}
	);
	it.each(['lost-handle', 'observer'])(
		'keeps uncertain %s native lifetime blocked',
		async (failure) => {
			if (failure === 'lost-handle')
				vi.spyOn(native.stdin, 'on').mockImplementationOnce(() => {
					throw new Error('postspawn');
				});
			else {
				const on = native.on.bind(native);
				let closes = 0;
				vi.spyOn(native, 'on').mockImplementation((event, listener) => {
					if (event === 'close' && ++closes === 2) throw new Error('observer failed');
					return on(event, listener);
				});
			}
			expect(spawner.spawn(config()).success).toBe(false);
			await close();
			await blocked();
		}
	);
	it('keeps child activity after failed registration and reentrant close', async () => {
		const set = processes.set.bind(processes);
		vi.spyOn(processes, 'set').mockImplementationOnce((id, managed) => {
			native.emit('close', 0, null);
			set(id, managed);
			throw new Error('registration failed');
		});
		expect(spawner.spawn(config()).success).toBe(false);
		await drain();
		(await reserve()).release();
	});
	it('retains replaced and unregistered generations independently', async () => {
		spawner.spawn(config());
		await drain();
		const old = native;
		native = makeNative();
		spawner.spawn(config());
		await drain();
		processes.clear();
		await close();
		await blocked();
		await close(old);
		(await reserve()).release();
	});
	it('retains failed setup child through async fallback and composes successor activity', async () => {
		const setup = Promise.withResolvers<unknown>();
		probes.request.mockReturnValueOnce(setup.promise);
		let releaseFallback!: () => void;
		fallback.mockImplementationOnce(() => {
			releaseFallback = gate.beginGlobalWorktreeActivity();
			return { success: true, pid: 999 };
		});
		spawner.spawn(config({ permissionMode: 'full' }));
		setup.reject(new Error('setup failed'));
		await drain();
		expect(fallback).toHaveBeenCalledOnce();
		expect(stopProcess).toHaveBeenCalled();
		await blocked();
		await close();
		await blocked();
		releaseFallback();
		(await reserve()).release();
	});
	it('releases a failed direct fallback callback without starting a child', async () => {
		fallback.mockImplementationOnce(() => {
			throw new Error('fallback failed');
		});
		expect(spawner.spawn(config({ nativeRpcProtocol: undefined })).success).toBe(false);
		expect(fallback).toHaveBeenCalledOnce();
		expect(spawn).not.toHaveBeenCalled();
		(await reserve()).release();
	});
	it('keeps missing-pid error and throwing child-exit reporting until close', async () => {
		vi.mocked(spawn).mockReturnValueOnce(
			Object.assign(native, { pid: undefined }) as unknown as ReturnType<typeof spawn>
		);
		spawner.spawn(config());
		await drain();
		probes.close.mockImplementationOnce(() => {
			throw new Error('close reporter failed');
		});
		native.emit('error', new Error('spawn error'));
		await drain();
		await blocked();
		await close();
		(await reserve()).release();
	});
});
