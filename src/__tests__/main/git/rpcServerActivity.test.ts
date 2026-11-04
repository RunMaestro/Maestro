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
	acpClient: vi.fn(),
	notify: vi.fn(),
	respond: vi.fn(),
}));
vi.mock('../../../main/codex-app-server/rpc-client', async (original) => ({
	...(await original<typeof import('../../../main/codex-app-server/rpc-client')>()),
	CodexAppServerRpc: class {
		request = probes.request;
		notify = probes.notify;
		close = probes.close;
		respond = probes.respond;
		isClosed = false;
	},
}));
vi.mock('@agentclientprotocol/sdk', () => ({
	PROTOCOL_VERSION: 1,
	ndJsonStream: vi.fn(),
	client: probes.acpClient,
	methods: {
		agent: {
			initialize: 'initialize',
			session: { new: 'new', load: 'load', prompt: 'prompt', cancel: 'cancel' },
		},
		client: { session: { requestPermission: 'permission', update: 'update' } },
	},
}));
vi.mock('../../../main/process-manager/spawners/acp-stdio', () => ({
	acpStdioStream: vi.fn(() => ({})),
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
	collectMaestroEnvVars: vi.fn(() => ({})),
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
vi.mock('../../../main/harness-control/integration', () => ({
	harnessInteractionBroker: { open: () => ({ completion: probes.interaction() }) },
}));

import { buildChildProcessEnv } from '../../../main/process-manager/utils/envBuilder';
import { planSpawnShell } from '../../../main/process-manager/utils/windowsSpawnShell';
import { createOutputParser } from '../../../main/parsers';
import { stopProcess } from '../../../shared/maestro-lib/control/termination';

const target = path.resolve('rpc-cleanup-target');
let gate: typeof import('../../../main/git/worktreeActivity');
let boundary: typeof import('../../../main/git/worktreeTurnActivity');
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
	boundary = await import('../../../main/git/worktreeTurnActivity');
	const { RpcServerSpawner } =
		await import('../../../main/process-manager/spawners/RpcServerSpawner');
	processes = new Map();
	fallback = vi.fn(() => ({ success: true, pid: 999 }));
	spawner = new RpcServerSpawner(processes, new EventEmitter(), {} as DataBufferManager, fallback);
});

describe('shared native turn activity boundary', () => {
	const spec = { command: 'fixture', args: [], cwd: target, env: {} };
	const options = { stopGraceMs: 1000, keepStdinOpen: true };
	it('refuses before caller setup, recovery or reporting', async () => {
		const hold = await reserve();
		try {
			const operation = vi.fn();
			const report = vi.fn();
			expect(() => boundary.withWorktreeTurnActivity(operation, report)).toThrow('reserved');
			expect(operation).not.toHaveBeenCalled();
			expect(report).not.toHaveBeenCalled();
			expect(spawn).not.toHaveBeenCalled();
		} finally {
			hold.release();
		}
	});
	it('retains observed setup without a native child until settlement', async () => {
		const setup = Promise.withResolvers<string>();
		const result = boundary.withWorktreeTurnActivity(
			(_start, observe) => observe(setup.promise),
			vi.fn()
		);
		expect(result).toBe(setup.promise);
		await blocked();
		setup.resolve('ready');
		await expect(result).resolves.toBe('ready');
		await drain();
		(await reserve()).release();
	});
	it('preserves synchronous errors when diagnostic reporting also throws', async () => {
		const original = new Error('setup failed');
		expect(() =>
			boundary.withWorktreeTurnActivity(
				() => {
					throw original;
				},
				() => {
					throw new Error('diagnostics failed');
				}
			)
		).toThrow(original);
		(await reserve()).release();
	});
	it('keeps every completion after close and preserves rejection despite failed diagnostics', async () => {
		const first = Promise.withResolvers<void>();
		const last = Promise.withResolvers<void>();
		const failure = new Error('report failed');
		const reporter = vi.fn(() => {
			throw new Error('diagnostics failed');
		});
		boundary.withWorktreeTurnActivity((start, observe) => {
			const turn = start(spec, {}, options);
			observe(turn.done);
			expect(observe(first.promise)).toBe(first.promise);
			observe(last.promise);
		}, reporter);
		await close();
		await blocked();
		const rejected = expect(first.promise).rejects.toBe(failure);
		first.reject(failure);
		await rejected;
		await drain();
		expect(reporter).toHaveBeenCalledWith(failure);
		await blocked();
		last.resolve();
		await drain();
		(await reserve()).release();
	});
	it.each([false, true])(
		'refuses escaped launch after setup (previous child: %s)',
		async (launch) => {
			const escaped = boundary.withWorktreeTurnActivity((start, observe) => {
				if (launch) observe(start(spec, {}, options).done);
				return start;
			}, vi.fn());
			if (launch) await close();
			const hold = await reserve();
			try {
				vi.mocked(spawn).mockClear();
				expect(() => escaped(spec, {}, options)).toThrow('one launch');
				expect(spawn).not.toHaveBeenCalled();
			} finally {
				hold.release();
			}
		}
	);
	it.each(['live', 'closed', 'nonstart'])(
		'refuses a second launch after %s without losing the first lifetime',
		async (state) => {
			if (state === 'nonstart')
				vi.mocked(spawn).mockImplementationOnce(() => {
					throw new Error('nonstart');
				});
			boundary.withWorktreeTurnActivity((start, observe) => {
				if (state === 'nonstart') expect(() => start(spec, {}, options)).toThrow();
				else observe(start(spec, {}, options).done);
				if (state === 'closed') native.emit('close', 0, null);
				expect(() => start(spec, {}, options)).toThrow('one launch');
			}, vi.fn());
			expect(spawn).toHaveBeenCalledOnce();
			if (state === 'live') {
				await blocked();
				await close();
			} else await drain();
			(await reserve()).release();
		}
	);
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

describe('standalone Antigravity SDK activity', () => {
	let antigravity: import('../../../main/process-manager/spawners/AntigravitySdkSpawner').AntigravitySdkSpawner;
	const input = (overrides: Partial<ProcessConfig> = {}) =>
		config({ toolType: 'antigravity', harnessControlMode: 'native', ...overrides });
	beforeEach(async () => {
		const { AntigravitySdkSpawner } =
			await import('../../../main/process-manager/spawners/AntigravitySdkSpawner');
		antigravity = new AntigravitySdkSpawner(
			processes,
			new EventEmitter(),
			{} as DataBufferManager,
			fallback
		);
	});
	it.each([target, path.join(target, 'descendant'), path.resolve('unrelated')])(
		'refuses validation/parser/shell/env/native/fallback setup under %s',
		async (root) => {
			const hold = await reserve(root);
			try {
				vi.mocked(fs.realpath).mockClear();
				for (const overrides of [
					{},
					{ toolType: 'terminal' },
					{ harnessControlMode: undefined },
					{ agentSessionId: 'unsupported', permissionMode: 'full' },
					{ cwd: path.resolve('remote-path') },
				] as Partial<ProcessConfig>[])
					expect(antigravity.spawn(input(overrides))).toMatchObject({
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
			} finally {
				hold.release();
			}
			antigravity.spawn(input());
			await close();
			(await reserve()).release();
		}
	);
	it('admits synchronously before shell/env setup and an earlier resolving reservation', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const pending = gate.reserveWorktreeCleanup(target);
		let duringSetup!: Promise<void>;
		vi.mocked(planSpawnShell).mockImplementationOnce((command, args) => {
			duringSetup = blocked();
			return { command, args, shell: false };
		});
		antigravity.spawn(input());
		canonical.resolve(target);
		expect(await pending).toMatchObject({ status: 'blocked' });
		await duringSetup;
		await close();
		(await reserve()).release();
	});
	it.each(['interrupt', 'kill'] as const)(
		'retains pending start after %s and native close',
		async (action) => {
			const setup = Promise.withResolvers<unknown>();
			probes.request.mockReturnValueOnce(setup.promise);
			antigravity.spawn(input());
			await processes.get('rpc-session')!.sdkController![action]();
			await close();
			await blocked();
			setup.resolve({});
			await drain();
			(await reserve()).release();
		}
	);
	it.each(['exit', 'error', 'complete', 'interrupt', 'kill'])(
		'retains native activity after %s until independent close',
		async (event) => {
			antigravity.spawn(input());
			await drain();
			if (event === 'exit') native.emit('exit', 0, null);
			if (event === 'error') native.emit('error', new Error('spawn failed'));
			if (event === 'complete')
				connection().onNotification({ method: 'complete', params: { code: 0 } });
			if (event === 'interrupt') await processes.get('rpc-session')!.sdkController!.interrupt();
			if (event === 'kill') await processes.get('rpc-session')!.sdkController!.kill();
			await drain();
			await blocked();
			await close();
			(await reserve()).release();
		}
	);
	it.each(['interrupt', 'close'])(
		'retains pending %s request after native close',
		async (method) => {
			antigravity.spawn(input());
			await drain();
			const pending = Promise.withResolvers<unknown>();
			probes.request.mockReturnValueOnce(pending.promise);
			const control = processes.get('rpc-session')!.harnessControl!;
			if (method === 'interrupt') await control.interrupt();
			else await control.close();
			expect(probes.request).toHaveBeenLastCalledWith(method);
			await close();
			await blocked();
			pending.reject(new Error('control failed'));
			await drain();
			(await reserve()).release();
		}
	);
	it('retains permission and exit reporting independently after native close', async () => {
		const permission = Promise.withResolvers<{ outcome: string; optionId: string }>();
		const reporting = Promise.withResolvers<void>();
		probes.interaction.mockReturnValueOnce(permission.promise);
		probes.exit.mockReturnValueOnce(reporting.promise);
		antigravity.spawn(input());
		const response = connection().onServerRequest({ id: 1, method: 'permission' });
		await close();
		await blocked();
		reporting.reject(new Error('report failed'));
		await drain();
		await blocked();
		permission.resolve({ outcome: 'selected', optionId: 'allow' });
		await expect(response).resolves.toEqual({ kind: 'result', value: { allow: true } });
		await drain();
		(await reserve()).release();
	});
	it('retains failed permission and throwing child-exit reporting until native close', async () => {
		probes.interaction.mockRejectedValueOnce(new Error('permission failed'));
		probes.close.mockImplementationOnce(() => {
			throw new Error('report failed');
		});
		antigravity.spawn(input());
		await expect(connection().onServerRequest({ id: 1, method: 'permission' })).rejects.toThrow(
			'permission failed'
		);
		native.emit('error', new Error('spawn failed'));
		await drain();
		await blocked();
		await close();
		(await reserve()).release();
	});
	it.each(['validation', 'shell', 'env', 'nonstart'])(
		'releases proven pre-native %s failure without fallback in Standard',
		async (failure) => {
			const fail = () => {
				throw new Error('setup failed');
			};
			if (failure === 'shell') vi.mocked(planSpawnShell).mockImplementationOnce(fail);
			if (failure === 'env') vi.mocked(buildChildProcessEnv).mockImplementationOnce(fail);
			if (failure === 'nonstart') vi.mocked(spawn).mockImplementationOnce(fail);
			expect(
				antigravity.spawn(input(failure === 'validation' ? { agentSessionId: 'unsupported' } : {}))
					.success
			).toBe(false);
			expect(fallback).not.toHaveBeenCalled();
			(await reserve()).release();
		}
	);
	it.each(['lost-handle', 'observer'])('retains uncertain %s native lifetime', async (failure) => {
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
		expect(antigravity.spawn(input()).success).toBe(false);
		await close();
		await blocked();
	});
	it('retains each replaced/unregistered generation and failed registration child', async () => {
		antigravity.spawn(input());
		const old = native;
		native = makeNative();
		antigravity.spawn(input());
		processes.clear();
		await close();
		await blocked();
		await close(old);
		(await reserve()).release();
		vi.spyOn(processes, 'set').mockImplementationOnce(() => {
			throw new Error('registration failed');
		});
		native = makeNative();
		expect(antigravity.spawn(input()).success).toBe(false);
		await blocked();
		await close();
		(await reserve()).release();
	});
	it('holds failed async setup to native close and composes independently admitted fallback', async () => {
		const setup = Promise.withResolvers<unknown>();
		probes.request.mockReturnValueOnce(setup.promise);
		antigravity.spawn(input());
		setup.reject(new Error('SDK start failed'));
		await drain();
		expect(stopProcess).toHaveBeenCalled();
		expect(probes.exit).toHaveBeenCalled();
		expect(fallback).not.toHaveBeenCalled();
		await blocked();
		await close();
		let releaseFallback!: () => void;
		fallback.mockImplementationOnce(() => {
			releaseFallback = gate.beginGlobalWorktreeActivity();
			return { success: true, pid: 999 };
		});
		expect(
			antigravity.spawn(input({ permissionMode: 'full', agentSessionId: 'unsupported' })).success
		).toBe(true);
		await blocked();
		releaseFallback();
		(await reserve()).release();
	});
	it('releases failed direct fallback without a native launch', async () => {
		fallback.mockImplementationOnce(() => {
			throw new Error('fallback failed');
		});
		expect(antigravity.spawn(input({ toolType: 'terminal' })).success).toBe(false);
		expect(fallback).toHaveBeenCalledOnce();
		expect(spawn).not.toHaveBeenCalled();
		(await reserve()).release();
	});
	it('retains the failed native child and its CLI fallback independently', async () => {
		vi.spyOn(processes, 'set').mockImplementationOnce(() => {
			throw new Error('registration failed');
		});
		let releaseFallback!: () => void;
		fallback.mockImplementationOnce(() => {
			releaseFallback = gate.beginGlobalWorktreeActivity();
			return { success: true, pid: 999 };
		});
		expect(antigravity.spawn(input({ permissionMode: 'full' })).success).toBe(true);
		await blocked();
		await close();
		await blocked();
		releaseFallback();
		(await reserve()).release();
	});
});

describe('standalone ACP activity', () => {
	let acp: import('../../../main/process-manager/spawners/AcpServerSpawner').AcpServerSpawner;
	const app = {
		onRequest: vi.fn(),
		onNotification: vi.fn(),
		connect: vi.fn(),
	};
	const replies: Record<string, unknown> = {
		initialize: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
		new: { sessionId: 'acp-session' },
		load: { sessionId: 'acp-session' },
		prompt: { stopReason: 'end_turn' },
	};
	const input = (overrides: Partial<ProcessConfig> = {}) =>
		config({
			toolType: 'gemini',
			harnessControlMode: 'native',
			nativeAcpArgs: ['--acp'],
			...overrides,
		});
	const permission = () =>
		app.onRequest.mock.calls.at(-1)![1]({
			params: {
				sessionId: 'acp-session',
				toolCall: { toolCallId: 'tool' },
				options: [],
			},
		});
	beforeEach(async () => {
		app.onRequest.mockReturnValue(app);
		app.onNotification.mockReturnValue(app);
		app.connect.mockReturnValue({
			agent: { request: probes.request, notify: probes.notify },
			close: probes.close,
		});
		probes.acpClient.mockReturnValue(app);
		probes.request.mockImplementation(async (method: string) => replies[method]);
		probes.notify.mockResolvedValue(undefined);
		const { AcpServerSpawner } =
			await import('../../../main/process-manager/spawners/AcpServerSpawner');
		acp = new AcpServerSpawner(processes, new EventEmitter(), {} as DataBufferManager, fallback);
	});
	it.each([target, path.join(target, 'descendant'), path.resolve('unrelated')])(
		'refuses setup and fallback before any local inspection under %s',
		async (root) => {
			const hold = await reserve(root);
			try {
				vi.mocked(fs.realpath).mockClear();
				for (const overrides of [
					{},
					{ nativeAcpArgs: undefined },
					{ permissionMode: 'full' },
					{ cwd: '/remote' },
				] as Partial<ProcessConfig>[])
					expect(acp.spawn(input(overrides))).toMatchObject({
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
					probes.acpClient,
				])
					expect(probe).not.toHaveBeenCalled();
				expect(processes.size).toBe(0);
			} finally {
				hold.release();
			}
			expect(acp.spawn(input()).success).toBe(true);
			await close();
			(await reserve()).release();
		}
	);
	it('admits before shell setup and an earlier resolving reservation', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const pending = gate.reserveWorktreeCleanup(target);
		let duringSetup!: Promise<void>;
		vi.mocked(planSpawnShell).mockImplementationOnce((command, args) => {
			duringSetup = blocked();
			return { command, args, shell: false };
		});
		acp.spawn(input());
		canonical.resolve(target);
		expect(await pending).toMatchObject({ status: 'blocked' });
		await duringSetup;
		await close();
		(await reserve()).release();
	});
	it.each(['initialize', 'new', 'load', 'prompt'])(
		'retains pending %s after Stop and native close',
		async (method) => {
			const setup = Promise.withResolvers<unknown>();
			probes.request.mockImplementation((name: string) =>
				name === method ? setup.promise : Promise.resolve(replies[name])
			);
			acp.spawn(input(method === 'load' ? { agentSessionId: 'acp-session' } : {}));
			await drain();
			expect(probes.request).toHaveBeenCalledWith(method, expect.anything());
			await processes.get('rpc-session')!.sdkController!.interrupt();
			await close();
			await blocked();
			setup.resolve(replies[method]);
			await drain();
			if (method !== 'prompt')
				expect(probes.request.mock.calls.some(([name]) => name === 'prompt')).toBe(false);
			expect(fallback).not.toHaveBeenCalled();
			(await reserve()).release();
		}
	);
	it.each(['exit', 'error', 'result', 'interrupt', 'kill'])(
		'retains native activity after %s until independent close',
		async (event) => {
			acp.spawn(input());
			await drain();
			if (event === 'exit') native.emit('exit', 0, null);
			if (event === 'error') native.emit('error', new Error('transport failed'));
			if (event === 'result') expect(probes.exit).toHaveBeenCalled();
			if (event === 'interrupt') await processes.get('rpc-session')!.sdkController!.interrupt();
			if (event === 'kill') await processes.get('rpc-session')!.sdkController!.kill();
			await drain();
			await blocked();
			await close();
			(await reserve()).release();
		}
	);
	it.each(['interrupt', 'kill'] as const)(
		'retains pending cancel notification from %s after close',
		async (action) => {
			acp.spawn(input());
			await drain();
			const pending = Promise.withResolvers<void>();
			probes.notify.mockReturnValueOnce(pending.promise);
			await processes.get('rpc-session')!.sdkController![action]();
			expect(probes.notify).toHaveBeenCalledWith('cancel', { sessionId: 'acp-session' });
			await close();
			await blocked();
			pending.reject(new Error('cancel failed'));
			await drain();
			(await reserve()).release();
		}
	);
	it('retains permission and exit reporting independently after native close', async () => {
		const interaction = Promise.withResolvers<unknown>();
		const reporting = Promise.withResolvers<void>();
		probes.interaction.mockReturnValueOnce(interaction.promise);
		probes.exit.mockReturnValueOnce(reporting.promise);
		acp.spawn(input());
		const response = permission();
		await close();
		await blocked();
		reporting.reject(new Error('report failed'));
		await drain();
		await blocked();
		interaction.resolve({ outcome: 'selected', optionId: 'allow' });
		await expect(response).resolves.toEqual({
			outcome: { outcome: 'selected', optionId: 'allow' },
		});
		await drain();
		(await reserve()).release();
	});
	it('retains failed permission and throwing child-exit reporting until close', async () => {
		probes.interaction.mockRejectedValueOnce(new Error('permission failed'));
		probes.close.mockImplementationOnce(() => {
			throw new Error('report failed');
		});
		acp.spawn(input());
		await expect(permission()).rejects.toThrow('permission failed');
		native.emit('error', new Error('spawn failed'));
		await drain();
		await blocked();
		await close();
		(await reserve()).release();
	});
	it.each(['parser', 'shell', 'env', 'nonstart'])(
		'releases proven pre-native %s failure without Standard fallback',
		async (failure) => {
			const fail = () => {
				throw new Error('setup failed');
			};
			if (failure === 'parser') vi.mocked(createOutputParser).mockImplementationOnce(fail);
			if (failure === 'shell') vi.mocked(planSpawnShell).mockImplementationOnce(fail);
			if (failure === 'env') vi.mocked(buildChildProcessEnv).mockImplementationOnce(fail);
			if (failure === 'nonstart') vi.mocked(spawn).mockImplementationOnce(fail);
			expect(acp.spawn(input()).success).toBe(false);
			expect(fallback).not.toHaveBeenCalled();
			(await reserve()).release();
		}
	);
	it.each(['lost-handle', 'observer'])('retains uncertain %s native lifetime', async (failure) => {
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
		expect(acp.spawn(input()).success).toBe(false);
		await close();
		await blocked();
	});
	it('retains replaced/unregistered generations and a failed registration child', async () => {
		acp.spawn(input());
		const old = native;
		native = makeNative();
		acp.spawn(input());
		processes.clear();
		await close();
		await blocked();
		await close(old);
		(await reserve()).release();
		vi.spyOn(processes, 'set').mockImplementationOnce(() => {
			throw new Error('registration failed');
		});
		native = makeNative();
		expect(acp.spawn(input()).success).toBe(false);
		await blocked();
		await close();
		(await reserve()).release();
	});
	it('retains failed asynchronous setup and independently admitted fallback', async () => {
		const setup = Promise.withResolvers<unknown>();
		probes.request.mockReturnValueOnce(setup.promise);
		let releaseFallback!: () => void;
		fallback.mockImplementationOnce(() => {
			releaseFallback = gate.beginGlobalWorktreeActivity();
			return { success: true, pid: 999 };
		});
		acp.spawn(input({ permissionMode: 'full' }));
		setup.reject(new Error('initialize failed'));
		await drain();
		expect(fallback).toHaveBeenCalledOnce();
		expect(stopProcess).toHaveBeenCalled();
		await blocked();
		await close();
		await blocked();
		releaseFallback();
		(await reserve()).release();
	});
	it('releases failed direct fallback without starting a child', async () => {
		fallback.mockImplementationOnce(() => {
			throw new Error('fallback failed');
		});
		expect(acp.spawn(input({ nativeAcpArgs: undefined })).success).toBe(false);
		expect(fallback).toHaveBeenCalledOnce();
		expect(spawn).not.toHaveBeenCalled();
		(await reserve()).release();
	});
	it('retains missing-pid native error until close and pending setup settle', async () => {
		Object.assign(native, { pid: undefined });
		const setup = Promise.withResolvers<unknown>();
		probes.request.mockReturnValueOnce(setup.promise);
		expect(acp.spawn(input())).toMatchObject({ success: true, pid: -1 });
		native.emit('error', new Error('native failed'));
		await drain();
		await blocked();
		await close();
		await blocked();
		setup.reject(new Error('initialization closed'));
		await drain();
		(await reserve()).release();
	});
	it('composes failed registration native child and synchronous CLI fallback independently', async () => {
		vi.spyOn(processes, 'set').mockImplementationOnce(() => {
			throw new Error('registration failed');
		});
		let releaseFallback!: () => void;
		fallback.mockImplementationOnce(() => {
			releaseFallback = gate.beginGlobalWorktreeActivity();
			return { success: true, pid: 999 };
		});
		expect(acp.spawn(input({ permissionMode: 'full' })).success).toBe(true);
		await blocked();
		await close();
		await blocked();
		releaseFallback();
		(await reserve()).release();
	});
});

describe('standalone Codex app-server activity', () => {
	let codex: import('../../../main/process-manager/spawners/CodexAppServerSpawner').CodexAppServerSpawner;
	const replies: Record<string, unknown> = {
		initialize: {},
		'thread/start': { thread: { id: 'thread' } },
		'thread/resume': { thread: { id: 'thread' } },
		'turn/start': { turn: { id: 'turn' } },
	};
	const input = (overrides: Partial<ProcessConfig> = {}) =>
		config({ toolType: 'codex', command: 'codex', args: ['exec', '--json'], ...overrides });
	const line = (method: string, params: unknown, id?: number) =>
		native.stdout.emit('data', JSON.stringify({ method, params, id }) + '\n');
	beforeEach(async () => {
		probes.request.mockImplementation(async (method: string) => replies[method]);
		const { CodexAppServerSpawner } =
			await import('../../../main/process-manager/spawners/CodexAppServerSpawner');
		codex = new CodexAppServerSpawner(
			processes,
			new EventEmitter(),
			{} as DataBufferManager,
			fallback
		);
	});
	it.each([target, path.join(target, 'descendant'), path.resolve('unrelated')])(
		'refuses before parsing, native setup or fallback under %s',
		async (root) => {
			const hold = await reserve(root);
			try {
				vi.mocked(fs.realpath).mockClear();
				const unparsed = input();
				Object.defineProperty(unparsed, 'prompt', {
					get: () => {
						throw new Error('parsed');
					},
				});
				for (const request of [
					unparsed,
					input({ images: ['fixture'], permissionMode: 'full' }),
					input({ cwd: '/remote', sshRemoteId: 'remote' }),
				])
					expect(codex.spawn(request)).toMatchObject({
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
					probes.request,
				])
					expect(probe).not.toHaveBeenCalled();
				expect(processes.size).toBe(0);
			} finally {
				hold.release();
			}
			codex.spawn(input());
			await drain();
			await close();
			(await reserve()).release();
		}
	);
	it('admits before environment setup and a pending reservation resolves', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const reservation = gate.reserveWorktreeCleanup(target);
		let during!: Promise<void>;
		vi.mocked(buildChildProcessEnv).mockImplementationOnce(() => {
			during = blocked();
			return {};
		});
		expect(codex.spawn(input()).success).toBe(true);
		canonical.resolve(target);
		expect(await reservation).toMatchObject({ status: 'blocked' });
		await during;
		await close();
		(await reserve()).release();
	});
	it.each(['initialize', 'thread/start', 'thread/resume', 'turn/start'])(
		'retains pending %s after Stop and native close',
		async (method) => {
			const pending = Promise.withResolvers<unknown>();
			probes.request.mockImplementation((name: string) =>
				name === method ? pending.promise : Promise.resolve(replies[name])
			);
			codex.spawn(
				input(method === 'thread/resume' ? { args: ['exec', 'resume', 'thread', '--json'] } : {})
			);
			await drain();
			expect(probes.request).toHaveBeenCalledWith(method, expect.anything(), expect.anything());
			processes.get('rpc-session')!.sdkController!.interrupt();
			await close();
			await blocked();
			pending.resolve(replies[method]);
			await drain();
			expect(fallback).not.toHaveBeenCalled();
			(await reserve()).release();
		}
	);
	it.each(['exit', 'error', 'result', 'interrupt', 'kill'])(
		'retains the native child after %s until independent close',
		async (event) => {
			codex.spawn(input());
			await drain();
			if (event === 'exit') native.emit('exit', 0, null);
			if (event === 'error') native.emit('error', new Error('transport failed'));
			if (event === 'result')
				line('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } });
			if (event === 'interrupt') processes.get('rpc-session')!.sdkController!.interrupt();
			if (event === 'kill') processes.get('rpc-session')!.sdkController!.kill();
			await drain();
			if (event === 'result') expect(probes.exit).toHaveBeenCalledOnce();
			await blocked();
			await close();
			(await reserve()).release();
		}
	);
	it.each(['request', 'steer', 'interrupt', 'kill'])(
		'retains pending %s control after native close',
		async (action) => {
			codex.spawn(input());
			await drain();
			const managed = processes.get('rpc-session')!;
			const pending = Promise.withResolvers<unknown>();
			probes.request.mockReturnValueOnce(pending.promise);
			let completion: Promise<unknown> | undefined;
			if (action === 'request') completion = managed.codexAppServer!.sendRequest('thread/read');
			if (action === 'steer')
				completion = managed.harnessControl!.steer!({ id: 'steer', text: 'follow up' });
			if (action === 'interrupt') managed.sdkController!.interrupt();
			if (action === 'kill') managed.sdkController!.kill();
			await close();
			await blocked();
			pending.resolve({});
			await completion;
			await drain();
			(await reserve()).release();
		}
	);
	it.each(['resolve', 'reject'] as const)(
		'retains interactive %s and failed exit reporting independently after close',
		async (outcome) => {
			const interaction = Promise.withResolvers<unknown>();
			const reporting = Promise.withResolvers<void>();
			probes.interaction.mockReturnValueOnce(interaction.promise);
			probes.exit.mockReturnValueOnce(reporting.promise);
			codex.spawn(input());
			await drain();
			line(
				'item/commandExecution/requestApproval',
				{ threadId: 'thread', turnId: 'turn', itemId: 'tool' },
				4
			);
			expect(probes.interaction).toHaveBeenCalledOnce();
			await close();
			await blocked();
			reporting.reject(new Error('report failed'));
			await drain();
			await blocked();
			if (outcome === 'resolve') interaction.resolve({ outcome: 'cancelled' });
			else interaction.reject(new Error('permission failed'));
			await drain();
			expect(probes.respond).toHaveBeenCalledWith(4, expect.anything());
			(await reserve()).release();
		}
	);
	it.each(['parser', 'shell', 'env', 'nonstart'])(
		'releases proven pre-native %s failure without Standard fallback',
		async (failure) => {
			const fail = () => {
				throw new Error('setup failed');
			};
			if (failure === 'parser') vi.mocked(createOutputParser).mockImplementationOnce(fail);
			if (failure === 'shell') vi.mocked(planSpawnShell).mockImplementationOnce(fail);
			if (failure === 'env') vi.mocked(buildChildProcessEnv).mockImplementationOnce(fail);
			if (failure === 'nonstart') vi.mocked(spawn).mockImplementationOnce(fail);
			expect(codex.spawn(input()).success).toBe(false);
			expect(fallback).not.toHaveBeenCalled();
			(await reserve()).release();
		}
	);
	it.each(['lost-handle', 'observer'])(
		'retains uncertain %s native state even after close',
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
			expect(codex.spawn(input()).success).toBe(false);
			await close();
			await blocked();
		}
	);
	it('retains superseded and unregistered children and a failed registration', async () => {
		codex.spawn(input());
		await drain();
		const old = native;
		native = makeNative();
		codex.spawn(input());
		await drain();
		processes.clear();
		await close();
		await blocked();
		await close(old);
		(await reserve()).release();
		vi.spyOn(processes, 'set').mockImplementationOnce(() => {
			throw new Error('registration failed');
		});
		native = makeNative();
		expect(codex.spawn(input()).success).toBe(false);
		await blocked();
		await close();
		(await reserve()).release();
	});
	it('retains failed asynchronous setup and independently admitted CLI fallback', async () => {
		const setup = Promise.withResolvers<unknown>();
		probes.request.mockReturnValueOnce(setup.promise);
		let releaseFallback!: () => void;
		fallback.mockImplementationOnce(() => {
			releaseFallback = gate.beginGlobalWorktreeActivity();
			return { success: true, pid: 999 };
		});
		codex.spawn(input({ permissionMode: 'full' }));
		setup.reject(new Error('initialize failed'));
		await drain();
		expect(fallback).toHaveBeenCalledOnce();
		expect(stopProcess).toHaveBeenCalled();
		await blocked();
		await close();
		await blocked();
		releaseFallback();
		(await reserve()).release();
	});
	it('releases a failing direct fallback before any native child', async () => {
		fallback.mockImplementationOnce(() => {
			throw new Error('fallback failed');
		});
		expect(codex.spawn(input({ images: ['fixture'], permissionMode: 'full' })).success).toBe(false);
		expect(fallback).toHaveBeenCalledOnce();
		expect(spawn).not.toHaveBeenCalled();
		(await reserve()).release();
	});
	it('retains a missing-pid error until close and pending initialization settle', async () => {
		Object.assign(native, { pid: undefined });
		const pending = Promise.withResolvers<unknown>();
		probes.request.mockReturnValueOnce(pending.promise);
		expect(codex.spawn(input())).toMatchObject({ success: true, pid: -1 });
		native.emit('error', new Error('native failed'));
		await close();
		await blocked();
		pending.reject(new Error('initialize failed'));
		await drain();
		(await reserve()).release();
	});
	it('retains a failed registration child independently of synchronous CLI fallback', async () => {
		vi.spyOn(processes, 'set').mockImplementationOnce(() => {
			throw new Error('registration failed');
		});
		let releaseFallback!: () => void;
		fallback.mockImplementationOnce(() => {
			releaseFallback = gate.beginGlobalWorktreeActivity();
			return { success: true, pid: 999 };
		});
		expect(codex.spawn(input({ permissionMode: 'full' })).success).toBe(true);
		await blocked();
		await close();
		await blocked();
		releaseFallback();
		(await reserve()).release();
	});
	it('contains throwing exit callbacks without releasing a still-live child', async () => {
		codex.spawn(input());
		await drain();
		probes.close.mockImplementationOnce(() => {
			throw new Error('exit failed');
		});
		native.emit('error', new Error('transport failed'));
		await drain();
		await blocked();
		await close();
		(await reserve()).release();
	});
});
