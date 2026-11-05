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
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Event } from '@opencode-ai/sdk';
import type { SessionEvent } from '@github/copilot-sdk';
import { ndJsonStream as acpNdJsonStream } from '@agentclientprotocol/sdk';
import type {
	CopilotConnectionManager,
	CopilotConnectionLease,
} from '../../../main/process-manager/spawners/CopilotConnectionManager';
import type { OpencodeCurrentPermissionRequest } from '../../../main/opencode-server/permission-requests';
import type {
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionNotification,
} from '@agentclientprotocol/sdk';

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
	handleResponse: vi.fn(),
	query: vi.fn<typeof import('@anthropic-ai/claude-agent-sdk').query>(),
	stderr: vi.fn(),
	opencodeSdk: vi.fn(),
	opencodeClient: vi.fn(),
	http: vi.fn(),
	copilotClient: vi.fn(),
	copilotStdio: vi.fn(),
	copilotRuntime: vi.fn(),
}));
vi.mock('@github/copilot-sdk', () => ({
	approveAll: () => ({ kind: 'approve-once' }),
	CopilotClient: class {
		constructor(options: unknown) {
			return probes.copilotClient(options);
		}
	},
	RuntimeConnection: { forStdio: probes.copilotStdio },
}));
vi.mock('../../../shared/maestro-lib/providers/copilot-runtime', () => ({
	resolveCopilotRuntimeExecutable: probes.copilotRuntime,
}));
vi.mock('../../../main/utils/fetchWithTimeout', () => ({ fetchWithTimeout: probes.http }));
vi.mock('../../../main/opencode-server/sdk-loader', () => ({
	loadOpencodeSdk: probes.opencodeSdk,
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: probes.query }));
vi.mock('../../../main/codex-app-server/rpc-client', async (original) => ({
	...(await original<typeof import('../../../main/codex-app-server/rpc-client')>()),
	CodexAppServerRpc: class {
		request = probes.request;
		notify = probes.notify;
		close = probes.close;
		respond = probes.respond;
		handleResponse = probes.handleResponse;
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
		handleData = probes.stderr;
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
	harnessInteractionBroker: {
		open: () => ({ request: { requestId: 'broker' }, completion: probes.interaction() }),
		withdraw: vi.fn(),
	},
}));

import { buildChildProcessEnv } from '../../../main/process-manager/utils/envBuilder';
import { planSpawnShell } from '../../../main/process-manager/utils/windowsSpawnShell';
import { createOutputParser } from '../../../main/parsers';
import { stopProcess } from '../../../shared/maestro-lib/control/termination';
import { captureException } from '../../../main/utils/sentry';
import { logger } from '../../../main/utils/logger';
import { harnessInteractionBroker } from '../../../main/harness-control/integration';

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
	const result = await gate.reserveWorktreeCleanup(target);
	if (result.status === 'reserved-partially') result.release();
	expect(result).toMatchObject({
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
	it.each(['setup', 'completion'] as const)(
		'owns async diagnostic settlement after %s failure',
		async (stage) => {
			const failure = new Error('original failure');
			const reporting = Promise.withResolvers<void>();
			const report = vi.fn(() => reporting.promise);
			const operation = Promise.withResolvers<void>();
			if (stage === 'setup') {
				expect(() =>
					boundary.withWorktreeTurnActivity(() => {
						throw failure;
					}, report)
				).toThrow(failure);
			} else {
				const result = boundary.withWorktreeTurnActivity(
					(_start, observe) => observe(operation.promise),
					report
				);
				expect(result).toBe(operation.promise);
				const rejected = expect(result).rejects.toBe(failure);
				operation.reject(failure);
				await rejected;
			}
			await drain();
			expect(report).toHaveBeenCalledExactlyOnceWith(failure);
			for (const root of [target, path.join(target, 'child'), path.resolve('other')])
				expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
			reporting.reject(new Error('report failed'));
			await drain();
			expect(report).toHaveBeenCalledOnce();
			(await reserve()).release();
		}
	);
	it.each([false, true])(
		'owns async diagnostic and native close independently (report first: %s)',
		async (reportFirst) => {
			const reporting = Promise.withResolvers<void>();
			const report = vi.fn(() => reporting.promise);
			expect(() =>
				boundary.withWorktreeTurnActivity((_start, _observe, spawnChild) => {
					spawnChild('fixture', [], {});
					throw new Error('postspawn failure');
				}, report)
			).toThrow('postspawn failure');
			if (reportFirst) reporting.resolve();
			else await close();
			await drain();
			await blocked();
			if (reportFirst) await close();
			else reporting.resolve();
			await drain();
			(await reserve()).release();
		}
	);
	it.each([false, true])(
		'owns async concurrent diagnostics and successor (reverse: %s)',
		async (reverse) => {
			const reports = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
			const successor = Promise.withResolvers<void>();
			for (const reporting of reports)
				expect(() =>
					boundary.withWorktreeTurnActivity(
						() => {
							throw new Error('failed');
						},
						() => reporting.promise
					)
				).toThrow('failed');
			boundary.withWorktreeTurnActivity((_start, observe) => observe(successor.promise), vi.fn());
			reports[reverse ? 1 : 0].resolve();
			await drain();
			await blocked();
			successor.resolve();
			await drain();
			await blocked();
			reports[reverse ? 0 : 1].resolve();
			await drain();
			(await reserve()).release();
		}
	);
	it('owns async reporting while reentrant observed work is admitted', async () => {
		const reporting = Promise.withResolvers<void>();
		const successor = Promise.withResolvers<void>();
		expect(() =>
			boundary.withWorktreeTurnActivity(
				() => {
					throw new Error('failed');
				},
				() => {
					boundary.withWorktreeTurnActivity(
						(_start, observe) => observe(successor.promise),
						vi.fn()
					);
					return reporting.promise;
				}
			)
		).toThrow('failed');
		successor.resolve();
		await drain();
		await blocked();
		reporting.resolve();
		await drain();
		(await reserve()).release();
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

describe('RPC diagnostic activity', () => {
	it.each([false, true])(
		'preserves direct fallback failure while diagnostics settle (logger fails: %s)',
		async (loggerFails) => {
			const failure = new Error('fallback failed');
			const reporting = Promise.withResolvers<void>();
			fallback.mockImplementationOnce(() => {
				throw failure;
			});
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			if (loggerFails)
				vi.mocked(logger.error).mockImplementationOnce(() => {
					throw new Error('logger failed');
				});
			expect(spawner.spawn(config({ nativeRpcProtocol: undefined }))).toEqual({
				success: false,
				pid: -1,
				error: String(failure),
			});
			await drain();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			expect(spawn).not.toHaveBeenCalled();
			await blocked();
			reporting.reject(new Error('diagnostic failed'));
			await drain();
			expect(captureException).toHaveBeenCalledOnce();
			(await reserve()).release();
		}
	);
	it.each(['resolve', 'reject', 'throw'] as const)(
		'owns setup fallback diagnostics on %s without delaying fallback',
		async (outcome) => {
			const failure = new Error('setup failed');
			const reporting = Promise.withResolvers<void>();
			vi.mocked(planSpawnShell).mockImplementationOnce(() => {
				throw failure;
			});
			vi.mocked(captureException).mockImplementationOnce(() => {
				if (outcome === 'throw') throw new Error('diagnostic failed');
				return reporting.promise;
			});
			expect(spawner.spawn(config({ permissionMode: 'full' }))).toEqual({
				success: true,
				pid: 999,
			});
			expect(fallback).toHaveBeenCalledOnce();
			expect(spawn).not.toHaveBeenCalled();
			await drain();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			if (outcome !== 'throw') {
				await blocked();
				if (outcome === 'resolve') reporting.resolve();
				else reporting.reject(new Error('diagnostic failed'));
				await drain();
			}
			expect(captureException).toHaveBeenCalledOnce();
			(await reserve()).release();
		}
	);
	it.each([false, true])(
		'owns completion diagnostics after native close despite logger failure: %s',
		async (loggerFails) => {
			spawner.spawn(config());
			await drain();
			const failure = new Error('connection close failed');
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			probes.close.mockImplementationOnce(() => {
				throw failure;
			});
			if (loggerFails)
				vi.mocked(logger.error).mockImplementationOnce(() => {
					throw new Error('logger failed');
				});
			await close();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			await blocked();
			reporting.reject(new Error('diagnostic failed'));
			await drain();
			expect(captureException).toHaveBeenCalledOnce();
			(await reserve()).release();
		}
	);
	it.each([false, true])(
		'owns run-error diagnostics and native close independently (report first: %s)',
		async (reportFirst) => {
			const emitter = new EventEmitter();
			const agentError = vi.fn();
			emitter.on('agent-error', agentError);
			const { RpcServerSpawner } =
				await import('../../../main/process-manager/spawners/RpcServerSpawner');
			spawner = new RpcServerSpawner(processes, emitter, {} as DataBufferManager, fallback);
			const prompt = Promise.withResolvers<unknown>();
			probes.request.mockResolvedValueOnce({}).mockReturnValueOnce(prompt.promise);
			spawner.spawn(config());
			await drain();
			const failure = new Error('prompt failed');
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			prompt.reject(failure);
			await drain();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			expect(agentError).toHaveBeenCalledOnce();
			expect(probes.exit).toHaveBeenCalledWith('rpc-session', 1, expect.anything());
			expect(fallback).not.toHaveBeenCalled();
			if (reportFirst) reporting.resolve();
			else await close();
			await drain();
			await blocked();
			if (reportFirst) await close();
			else reporting.reject(new Error('diagnostic failed'));
			await drain();
			expect(captureException).toHaveBeenCalledOnce();
			(await reserve()).release();
		}
	);
	it.each(['extension', 'steer', 'interrupt', 'kill', 'notification'] as const)(
		'owns late %s diagnostics after startup releases, without recursive reporting',
		async (kind) => {
			spawner.spawn(config());
			await drain();
			const callbacks = connection();
			const managed = processes.get('rpc-session')!;
			await close();
			processes.clear();
			const failure = new Error('late failure');
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValue(reporting.promise);
			if (kind === 'notification')
				callbacks.onNotification!({
					get type() {
						throw failure;
					},
				});
			else {
				let result: Promise<unknown>;
				if (kind === 'extension') {
					probes.interaction.mockRejectedValueOnce(failure);
					result = callbacks.onServerRequest!({ method: 'confirm' });
				} else if (kind === 'steer')
					result = managed.harnessControl!.steer({
						get id(): string {
							throw failure;
						},
						text: 'late',
					});
				else {
					vi.mocked(stopProcess).mockImplementationOnce(() => {
						throw failure;
					});
					result = Promise.resolve(managed.sdkController![kind]());
				}
				await expect(result).rejects.toBe(failure);
			}
			await drain();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			await blocked();
			reporting.reject(new Error('diagnostic failed'));
			await drain();
			expect(captureException).toHaveBeenCalledOnce();
			expect(fallback).not.toHaveBeenCalled();
			(await reserve()).release();
		}
	);
	it('owns failed late exit logging diagnostics after native close', async () => {
		spawner.spawn(config());
		await drain();
		const callbacks = connection();
		probes.close.mockImplementationOnce(() => {
			throw new Error('close failed');
		});
		await close();
		vi.mocked(captureException).mockClear();
		const reporting = Promise.withResolvers<void>();
		const failure = new Error('exit logger failed');
		vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
		vi.mocked(logger.error).mockImplementationOnce(() => {
			throw failure;
		});
		probes.exit.mockRejectedValueOnce(new Error('exit failed'));
		callbacks.onNotification!({ type: 'session_settled' });
		await drain();
		expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
		await blocked();
		reporting.resolve();
		await drain();
		(await reserve()).release();
	});
	it.each([false, true])(
		'owns concurrent late notification diagnostics and successor (reverse: %s)',
		async (reverse) => {
			spawner.spawn(config());
			await drain();
			const callbacks = connection();
			await close();
			const reports = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
			for (const reporting of reports) {
				vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
				callbacks.onNotification!({
					get type() {
						throw new Error('notification failed');
					},
				});
				await drain();
			}
			native = makeNative();
			spawner.spawn(config());
			await drain();
			reports[reverse ? 1 : 0].resolve();
			await drain();
			await blocked();
			await close();
			await blocked();
			reports[reverse ? 0 : 1].reject(new Error('diagnostic failed'));
			await drain();
			expect(captureException).toHaveBeenCalledTimes(2);
			(await reserve()).release();
		}
	);
	it('blocks a pending reservation when a late notification starts diagnostics', async () => {
		spawner.spawn(config());
		await drain();
		const callbacks = connection();
		await close();
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const reservation = gate.reserveWorktreeCleanup(target);
		const reporting = Promise.withResolvers<void>();
		vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
		callbacks.onNotification!({
			get type() {
				throw new Error('notification failed');
			},
		});
		await drain();
		canonical.resolve(target);
		expect(await reservation).toMatchObject({ status: 'blocked' });
		await blocked();
		reporting.resolve();
		await drain();
		(await reserve()).release();
	});
});

describe('retained Pi/OMP RPC callback activity', () => {
	it.each([target, path.join(target, 'descendant'), path.resolve('unrelated')])(
		'refuses retained callbacks before lookup or recovery under %s',
		async (root) => {
			spawner.spawn(config());
			await drain();
			const callbacks = connection();
			const managed = processes.get('rpc-session')!;
			await close();
			processes.clear();
			vi.clearAllMocks();
			const lookup = vi.fn(() => 'session_settled');
			const hold = await reserve(root);
			try {
				await expect(
					managed.harnessControl!.steer({
						get id() {
							return lookup();
						},
						text: 'late',
					})
				).rejects.toThrow('reserved');
				await expect(
					callbacks.onServerRequest!({
						get type() {
							return lookup();
						},
					})
				).rejects.toThrow('reserved');
				callbacks.onNotification!({
					get type() {
						return lookup();
					},
				});
				await drain();
				expect(captureException).not.toHaveBeenCalled();
				for (const probe of [
					lookup,
					probes.request,
					probes.interaction,
					probes.output,
					probes.exit,
					probes.close,
					stopProcess,
					fallback,
				])
					expect(probe).not.toHaveBeenCalled();
			} finally {
				hold.release();
			}
			(await reserve()).release();
		}
	);
	it.each(['resolve', 'reject'] as const)(
		'owns concurrent late extension replies through replacement on %s',
		async (outcome) => {
			spawner.spawn(config());
			await drain();
			const callbacks = connection();
			await close();
			processes.clear();
			const first = Promise.withResolvers<{ kind: 'ignore' }>();
			const second = Promise.withResolvers<{ kind: 'ignore' }>();
			probes.interaction.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
			const a = callbacks.onServerRequest!({ type: 'extension_ui_request', method: 'confirm' });
			const b = callbacks.onServerRequest!({ type: 'extension_ui_request', method: 'input' });
			await blocked();
			native = makeNative();
			spawner.spawn(config());
			await drain();
			await close();
			processes.clear();
			await blocked();
			first.resolve({ kind: 'ignore' });
			await expect(a).resolves.toEqual({ kind: 'ignore' });
			await drain();
			await blocked();
			if (outcome === 'reject') {
				const failed = expect(b).rejects.toThrow('interaction failed');
				second.reject(new Error('interaction failed'));
				await failed;
			} else {
				second.resolve({ kind: 'ignore' });
				await expect(b).resolves.toEqual({ kind: 'ignore' });
			}
			await drain();
			(await reserve()).release();
		}
	);
	it.each(['resolve', 'reject'] as const)(
		'owns retained steering after failed close reporting on %s',
		async (outcome) => {
			spawner.spawn(config());
			await drain();
			const managed = processes.get('rpc-session')!;
			probes.close.mockImplementationOnce(() => {
				throw new Error('close failed');
			});
			await close();
			processes.clear();
			(await reserve()).release();
			const pending = Promise.withResolvers<unknown>();
			probes.request.mockReturnValueOnce(pending.promise);
			const steering = managed.harnessControl!.steer({ id: 'late', text: 'next' });
			expect(probes.request).toHaveBeenLastCalledWith('steer', { message: 'next' });
			await blocked();
			if (outcome === 'reject') pending.reject(new Error('steer failed'));
			else pending.resolve({});
			await expect(steering).resolves.toMatchObject({
				id: 'late',
				verdict: outcome === 'reject' ? 'unknown' : 'delivered',
			});
			await drain();
			(await reserve()).release();
		}
	);
	it.each(['ready', 'streaming', 'queued', 'failure'])(
		'owns late Pi state queries and subsequent reporting for %s',
		async (outcome) => {
			spawner.spawn(config({ toolType: 'pi', nativeRpcProtocol: 'pi-rpc' }));
			await drain();
			const callbacks = connection();
			probes.close.mockImplementationOnce(() => {
				throw new Error('close failed');
			});
			await close();
			(await reserve()).release();
			const state = Promise.withResolvers<unknown>();
			const reporting = Promise.withResolvers<void>();
			probes.request.mockReturnValueOnce(state.promise);
			probes.exit.mockReturnValueOnce(reporting.promise);
			callbacks.onNotification!({ type: 'agent_end' });
			callbacks.onNotification!({ type: 'agent_end' });
			expect(probes.request).toHaveBeenLastCalledWith('get_state');
			processes.clear();
			await blocked();
			if (outcome === 'failure') state.reject(new Error('state failed'));
			else
				state.resolve({
					isStreaming: outcome === 'streaming',
					pendingMessageCount: outcome === 'queued' ? 1 : 0,
				});
			await drain();
			if (outcome === 'ready' || outcome === 'failure') {
				await blocked();
				expect(probes.exit).toHaveBeenCalledOnce();
				expect(probes.exit.mock.calls[0][1]).toBe(outcome === 'ready' ? 0 : 1);
				reporting.reject(new Error('report failed'));
				await drain();
			} else expect(probes.exit).not.toHaveBeenCalled();
			(await reserve()).release();
		}
	);
	it('admits a late extension before an earlier reservation canonicalizes', async () => {
		spawner.spawn(config());
		await drain();
		const callbacks = connection();
		await close();
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const reservation = gate.reserveWorktreeCleanup(target);
		const pending = Promise.withResolvers<{ kind: 'ignore' }>();
		probes.interaction.mockReturnValueOnce(pending.promise);
		const reply = callbacks.onServerRequest!({ type: 'extension_ui_request', method: 'confirm' });
		canonical.resolve(target);
		expect(await reservation).toMatchObject({ status: 'blocked' });
		pending.resolve({ kind: 'ignore' });
		await reply;
		await drain();
		(await reserve()).release();
	});
	it('preserves synchronous notification order and absorbed/dropped steering', async () => {
		const emitter = new EventEmitter();
		const verdicts = vi.fn();
		emitter.on('steering-verdict', verdicts);
		const { RpcServerSpawner } =
			await import('../../../main/process-manager/spawners/RpcServerSpawner');
		spawner = new RpcServerSpawner(processes, emitter, {} as DataBufferManager, fallback);
		spawner.spawn(config());
		await drain();
		const control = processes.get('rpc-session')!.harnessControl!;
		await control.steer({ id: 'absorbed', text: 'next' });
		await control.steer({ id: 'dropped', text: 'later' });
		probes.output.mockClear();
		connection().onNotification!({
			type: 'message_start',
			message: { role: 'user', content: 'next' },
		});
		connection().onNotification!({ type: 'session_settled' });
		expect(probes.output.mock.calls.map((call) => JSON.parse(call[1]).type)).toEqual([
			'message_start',
			'session_settled',
		]);
		expect(verdicts.mock.calls.map((call) => call[1])).toEqual([
			{ type: 'steering', id: 'absorbed', verdict: 'absorbed' },
			{ type: 'steering', id: 'dropped', verdict: 'dropped' },
		]);
		await close();
		await expect(control.steer({ id: 'finished', text: 'late' })).resolves.toMatchObject({
			verdict: 'refused',
			refusal: 'not-running',
		});
		await drain();
		(await reserve()).release();
	});
	it.each(['lookup', 'output', 'diagnostic'])(
		'observes failed notification %s and releases without recovery',
		async (stage) => {
			spawner.spawn(config());
			await drain();
			const callbacks = connection();
			await close();
			vi.clearAllMocks();
			const fail = () => {
				throw new Error('notification failed');
			};
			if (stage === 'output') probes.output.mockImplementationOnce(fail);
			if (stage === 'diagnostic') vi.mocked(captureException).mockImplementation(fail);
			callbacks.onNotification!({
				get type() {
					return stage === 'output' ? 'message_start' : fail();
				},
			});
			await drain();
			expect(fallback).not.toHaveBeenCalled();
			expect(stopProcess).not.toHaveBeenCalled();
			(await reserve()).release();
		}
	);
	it.each(['sync', 'async'])('owns late exit reporting through %s failure', async (failure) => {
		spawner.spawn(config());
		await drain();
		const callbacks = connection();
		probes.close.mockImplementationOnce(() => {
			throw new Error('close failed');
		});
		await close();
		const reporting = Promise.withResolvers<void>();
		if (failure === 'sync')
			probes.exit.mockImplementationOnce(() => {
				throw new Error('report failed');
			});
		else probes.exit.mockReturnValueOnce(reporting.promise);
		callbacks.onNotification!({ type: 'session_settled' });
		if (failure === 'async') {
			await blocked();
			reporting.reject(new Error('report failed'));
		}
		await drain();
		expect(probes.exit).toHaveBeenCalledOnce();
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
					captureException,
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
	it.each([target, path.join(target, 'descendant'), path.resolve('unrelated')])(
		'refuses retained notification/permission before record lookup or recovery under %s',
		async (root) => {
			antigravity.spawn(input());
			const callbacks = connection();
			await close();
			processes.clear();
			vi.clearAllMocks();
			const hold = await reserve(root);
			try {
				const lookup = vi.fn(() => {
					throw new Error('record accessed');
				});
				const record = {
					get params() {
						return lookup();
					},
					get method() {
						return lookup();
					},
				};
				expect(() => callbacks.onNotification(record)).toThrow('reserved');
				await expect(callbacks.onServerRequest(record)).rejects.toThrow('reserved');
				for (const probe of [
					lookup,
					probes.output,
					probes.exit,
					probes.interaction,
					probes.request,
					probes.close,
					stopProcess,
					captureException,
					fallback,
				])
					expect(probe).not.toHaveBeenCalled();
			} finally {
				hold.release();
			}
		}
	);
	it.each(['resolve', 'reject'] as const)(
		'owns parallel late permissions through replacement and close until final %s',
		async (outcome) => {
			antigravity.spawn(input());
			const callbacks = connection();
			await close();
			processes.clear();
			const first = Promise.withResolvers<{ outcome: string; optionId: string }>();
			const last = Promise.withResolvers<{ outcome: string; optionId: string }>();
			probes.interaction.mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
			const one = callbacks.onServerRequest({
				id: 1,
				method: 'permission',
				params: { tool: 'read' },
			});
			const two = callbacks.onServerRequest({
				id: 2,
				method: 'permission',
				params: { tool: 'write', input: { path: 'fixture' } },
			});
			await blocked();
			native = makeNative();
			antigravity.spawn(input());
			processes.clear();
			await close();
			first.resolve({ outcome: 'selected', optionId: 'allow' });
			await expect(one).resolves.toEqual({ kind: 'result', value: { allow: true } });
			await drain();
			await blocked();
			if (outcome === 'reject') {
				const result = expect(two).rejects.toThrow('permission failed');
				last.reject(new Error('permission failed'));
				await result;
			} else {
				last.resolve({ outcome: 'selected', optionId: 'deny' });
				await expect(two).resolves.toEqual({ kind: 'result', value: { allow: false } });
			}
			await drain();
			(await reserve()).release();
		}
	);
	it('admits a late permission before an earlier reservation finishes canonicalizing', async () => {
		antigravity.spawn(input());
		const callbacks = connection();
		await close();
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const pending = gate.reserveWorktreeCleanup(target);
		const permission = Promise.withResolvers<{ outcome: string }>();
		probes.interaction.mockReturnValueOnce(permission.promise);
		const response = callbacks.onServerRequest({ id: 1, method: 'permission' });
		canonical.resolve(target);
		expect(await pending).toMatchObject({ status: 'blocked' });
		permission.resolve({ outcome: 'cancelled' });
		await expect(response).resolves.toEqual({ kind: 'result', value: { allow: false } });
		await drain();
		(await reserve()).release();
	});
	it.each(['params', 'broker', 'mapping'])(
		'releases late permission %s errors despite failed diagnostics',
		async (failure) => {
			antigravity.spawn(input());
			const callbacks = connection();
			await close();
			const fail = () => {
				throw new Error('permission failed');
			};
			vi.mocked(captureException).mockImplementationOnce(fail);
			if (failure === 'broker')
				vi.spyOn(harnessInteractionBroker, 'open').mockImplementationOnce(fail);
			if (failure === 'mapping')
				probes.interaction.mockResolvedValueOnce({
					get outcome() {
						return fail();
					},
				});
			await expect(
				callbacks.onServerRequest({
					id: 1,
					method: 'permission',
					get params() {
						if (failure === 'params') return fail();
						return {};
					},
				})
			).rejects.toThrow('permission failed');
			await drain();
			expect(captureException).toHaveBeenCalled();
			(await reserve()).release();
		}
	);
	it('preserves synchronous late notification order and suppresses replaced generation output', async () => {
		antigravity.spawn(input());
		const callbacks = connection();
		await close();
		processes.clear();
		probes.output.mockClear();
		for (const record of [
			{ method: 'text', params: { text: 'first' } },
			{ method: 'error', params: { message: 'second' } },
			{ method: 'custom', params: {} },
		])
			callbacks.onNotification(record);
		expect(probes.output.mock.calls.map(([, line]) => JSON.parse(line).type)).toEqual([
			'acp.text',
			'acp.error',
			'acp.system',
		]);
		native = makeNative();
		antigravity.spawn(input());
		callbacks.onNotification({ method: 'text', params: { text: 'superseded' } });
		expect(probes.output).toHaveBeenCalledTimes(3);
		await close();
		(await reserve()).release();
	});
	it.each(['params', 'output'])(
		'releases synchronous late notification %s failure and preserves the error',
		async (failure) => {
			antigravity.spawn(input());
			const callbacks = connection();
			await close();
			const fail = () => {
				throw new Error('notification failed');
			};
			vi.mocked(captureException).mockImplementationOnce(fail);
			if (failure === 'output') probes.output.mockImplementationOnce(fail);
			expect(() =>
				callbacks.onNotification({
					method: 'text',
					get params() {
						if (failure === 'params') return fail();
						return { text: 'fixture' };
					},
				})
			).toThrow('notification failed');
			expect(captureException).toHaveBeenCalled();
			(await reserve()).release();
		}
	);
	it.each(['resolve', 'reject', 'throw'] as const)(
		'owns late completion reporting after failed native-close handling until %s',
		async (outcome) => {
			antigravity.spawn(input());
			const callbacks = connection();
			// Native close is proven, but failed connection cleanup prevented finish.
			probes.close.mockImplementationOnce(() => {
				throw new Error('connection close failed');
			});
			await close();
			processes.clear();
			(await reserve()).release();
			const report = Promise.withResolvers<void>();
			if (outcome === 'throw')
				probes.exit.mockImplementationOnce(() => {
					throw new Error('report failed');
				});
			else probes.exit.mockReturnValueOnce(report.promise);
			if (outcome === 'throw') {
				expect(() => callbacks.onNotification({ method: 'complete', params: { code: 7 } })).toThrow(
					'report failed'
				);
			} else {
				callbacks.onNotification({ method: 'complete', params: { code: 7 } });
				expect(probes.exit).toHaveBeenLastCalledWith('rpc-session', 7, expect.any(Object));
				callbacks.onNotification({ method: 'complete' });
				expect(probes.exit).toHaveBeenCalledOnce();
				native = makeNative();
				antigravity.spawn(input());
				processes.clear();
				await close();
				await blocked();
				if (outcome === 'reject') report.reject(new Error('report failed'));
				else report.resolve();
			}
			await drain();
			(await reserve()).release();
		}
	);

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
	it.each(['resolve', 'reject', 'throw'] as const)(
		'owns async antigravity setup diagnostics on %s and preserves fallback',
		async (outcome) => {
			const failure = new Error('setup failed');
			const reporting = Promise.withResolvers<void>();
			vi.mocked(planSpawnShell).mockImplementationOnce(() => {
				throw failure;
			});
			vi.mocked(captureException).mockImplementationOnce(() => {
				if (outcome === 'throw') throw new Error('report failed');
				return reporting.promise;
			});
			expect(antigravity.spawn(input({ permissionMode: 'full' }))).toEqual({
				success: true,
				pid: 999,
			});
			expect(fallback).toHaveBeenCalledOnce();
			await drain();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			if (outcome !== 'throw') {
				await blocked();
				if (outcome === 'resolve') reporting.resolve();
				else reporting.reject(new Error('report failed'));
				await drain();
			}
			expect(captureException).toHaveBeenCalledOnce();
			(await reserve()).release();
		}
	);
	it.each([false, true])(
		'owns async antigravity outer failure diagnostics despite logger failure: %s',
		async (loggerFails) => {
			const failure = new Error('fallback failed');
			const reporting = Promise.withResolvers<void>();
			fallback.mockImplementationOnce(() => {
				throw failure;
			});
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			if (loggerFails)
				vi.mocked(logger.error).mockImplementationOnce(() => {
					throw new Error('logger');
				});
			expect(antigravity.spawn(input({ toolType: 'terminal' }))).toEqual({
				success: false,
				pid: -1,
				error: String(failure),
			});
			await drain();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			await blocked();
			reporting.reject(new Error('report failed'));
			await drain();
			expect(captureException).toHaveBeenCalledOnce();
			(await reserve()).release();
		}
	);
	it.each([false, true])(
		'owns async antigravity run diagnostics independently of native close (report first: %s)',
		async (reportFirst) => {
			const failure = new Error('request failed');
			const reporting = Promise.withResolvers<void>();
			probes.request.mockRejectedValueOnce(failure);
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			expect(antigravity.spawn(input()).success).toBe(true);
			await drain();
			expect(probes.exit).toHaveBeenCalledOnce();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			if (reportFirst) reporting.resolve();
			else await close();
			await drain();
			await blocked();
			if (reportFirst) await close();
			else reporting.reject(new Error('report failed'));
			await drain();
			expect(captureException).toHaveBeenCalledOnce();
			(await reserve()).release();
		}
	);
	it.each([false, true])(
		'owns async antigravity completion diagnostics despite logger failure: %s',
		async (loggerFails) => {
			antigravity.spawn(input());
			await drain();
			const failure = new Error('connection close failed');
			const reporting = Promise.withResolvers<void>();
			probes.close.mockImplementationOnce(() => {
				throw failure;
			});
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			if (loggerFails)
				vi.mocked(logger.error).mockImplementationOnce(() => {
					throw new Error('logger');
				});
			await close();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			await blocked();
			reporting.reject(new Error('report failed'));
			await drain();
			expect(captureException).toHaveBeenCalledOnce();
			(await reserve()).release();
		}
	);
	it.each(['permission', 'notification', 'interrupt', 'kill'] as const)(
		'owns async antigravity late %s diagnostics in fresh activity',
		async (action) => {
			antigravity.spawn(input());
			await drain();
			const managed = processes.get('rpc-session')!;
			await close();
			const canonical = Promise.withResolvers<string>();
			vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
			const reservation = gate.reserveWorktreeCleanup(target);
			const failure = new Error('callback failed');
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			if (action === 'permission') {
				probes.interaction.mockRejectedValueOnce(failure);
				vi.mocked(logger.error).mockImplementationOnce(() => {
					throw new Error('logger');
				});
				await expect(connection().onServerRequest({ id: 1, method: 'permission' })).rejects.toBe(
					failure
				);
			} else if (action === 'notification') {
				const record = {
					get params(): never {
						throw failure;
					},
				};
				expect(() => connection().onNotification(record)).toThrow(failure);
			} else {
				vi.mocked(stopProcess).mockImplementationOnce(() => {
					throw failure;
				});
				await expect(managed.sdkController![action]()).rejects.toBe(failure);
			}
			canonical.resolve(target);
			expect(await reservation).toMatchObject({ status: 'blocked' });
			await drain();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			processes.clear();
			const successor = Promise.withResolvers<void>();
			boundary.withWorktreeTurnActivity((_start, observe) => observe(successor.promise), vi.fn());
			reporting.reject(new Error('report failed'));
			await drain();
			await blocked();
			successor.resolve();
			await drain();
			expect(captureException).toHaveBeenCalledOnce();
			(await reserve()).release();
		}
	);
	it('owns async antigravity exit diagnostics when exit logging also throws', async () => {
		const failure = new Error('exit logger failed');
		const reporting = Promise.withResolvers<void>();
		probes.exit.mockRejectedValueOnce(new Error('exit failed'));
		vi.mocked(logger.error).mockImplementationOnce(() => {
			throw failure;
		});
		vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
		antigravity.spawn(input());
		connection().onNotification({ method: 'complete' });
		await close();
		expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
		await blocked();
		reporting.reject(new Error('report failed'));
		await drain();
		expect(captureException).toHaveBeenCalledOnce();
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
		app.connect.mockImplementation(() => {
			const closed = Promise.withResolvers<void>();
			return {
				agent: { request: probes.request, notify: probes.notify },
				closed: closed.promise,
				close: () => {
					closed.resolve();
					return probes.close();
				},
			};
		});
		probes.acpClient.mockReturnValue(app);
		probes.request.mockImplementation(async (method: string) => replies[method]);
		probes.notify.mockResolvedValue(undefined);
		const { AcpServerSpawner } =
			await import('../../../main/process-manager/spawners/AcpServerSpawner');
		acp = new AcpServerSpawner(processes, new EventEmitter(), {} as DataBufferManager, fallback);
	});
	describe('ACP protocol connection ownership', () => {
		let protocol: ReturnType<typeof Promise.withResolvers<void>>;
		beforeEach(() => {
			protocol = Promise.withResolvers<void>();
			// Fault-injected rejection must stay handled even on prior production.
			void protocol.promise.catch(() => {});
			app.connect.mockReturnValue({
				agent: { request: probes.request, notify: probes.notify },
				closed: protocol.promise,
				close: probes.close,
			});
		});
		it.each(['result', 'exit', 'error', 'interrupt', 'kill'] as const)(
			'keeps protocol ownership after %s and child close until protocol acknowledges closure',
			async (event) => {
				acp.spawn(input());
				await drain();
				if (event === 'exit') native.emit('exit', 0, null);
				if (event === 'error') native.emit('error', new Error('native failed'));
				if (event === 'interrupt' || event === 'kill')
					await processes.get('rpc-session')!.sdkController![event]();
				await close();
				expect(probes.close).toHaveBeenCalledOnce();
				processes.clear();
				await blocked();
				protocol.resolve();
				await drain();
				(await reserve()).release();
			}
		);
		it('keeps native ownership when protocol closes before its child', async () => {
			acp.spawn(input());
			protocol.resolve();
			await drain();
			await blocked();
			await close();
			(await reserve()).release();
		});
		it.each([
			'connect',
			'missing',
			'invalid',
			'getter',
			'then',
			'reentrant-throw',
			'rejected',
		] as const)(
			'keeps unknown protocol ownership after %s observer failure and settled reporting',
			async (failure) => {
				const error = new Error('protocol observer failed');
				const reporting = Promise.withResolvers<void>();
				vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
				const connection = {
					agent: { request: probes.request, notify: probes.notify },
					close: probes.close,
					get closed(): unknown {
						if (failure === 'getter') throw error;
						if (failure === 'missing') return undefined;
						if (failure === 'invalid') return 1;
						if (failure === 'then' || failure === 'reentrant-throw')
							return {
								then: (acknowledge: () => void) => {
									if (failure === 'reentrant-throw') acknowledge();
									throw error;
								},
							};
						return protocol.promise;
					},
				};
				app.connect.mockImplementationOnce(() => {
					if (failure === 'connect') throw error;
					return connection;
				});
				if (failure === 'rejected') protocol.reject(error);
				expect(acp.spawn(input()).success).toBe(true);
				await drain();
				await close();
				if (failure !== 'connect') {
					expect(probes.request).toHaveBeenCalledWith('prompt', expect.anything());
					expect(probes.exit).toHaveBeenCalledWith('rpc-session', 0, expect.anything());
				}
				expect(fallback).not.toHaveBeenCalled();
				expect(captureException).toHaveBeenCalledOnce();
				if (failure !== 'missing' && failure !== 'invalid')
					expect(captureException).toHaveBeenCalledWith(error);
				await blocked();
				reporting.reject(new Error('diagnostic failed'));
				await drain();
				expect(captureException).toHaveBeenCalledOnce();
				await blocked();
			}
		);
		it('keeps late acknowledgement blocked after observer registration throws', async () => {
			let acknowledge!: () => void;
			app.connect.mockReturnValueOnce({
				agent: { request: probes.request, notify: probes.notify },
				close: probes.close,
				closed: {
					then: (done: () => void) => {
						acknowledge = done;
						throw new Error('registration failed');
					},
				},
			});
			acp.spawn(input());
			await drain();
			await close();
			acknowledge();
			await drain();
			await blocked();
		});
		it.each(['ndjson', 'client', 'request-handler', 'notification-handler'] as const)(
			'keeps uncertain SDK setup after %s throws without changing fallback',
			async (stage) => {
				const error = new Error('SDK setup failed');
				const fail = () => {
					throw error;
				};
				if (stage === 'ndjson') vi.mocked(acpNdJsonStream).mockImplementationOnce(fail);
				if (stage === 'client') probes.acpClient.mockImplementationOnce(fail);
				if (stage === 'request-handler') app.onRequest.mockImplementationOnce(fail);
				if (stage === 'notification-handler') app.onNotification.mockImplementationOnce(fail);
				expect(acp.spawn(input({ permissionMode: 'full' })).success).toBe(true);
				await drain();
				expect(fallback).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd: target }));
				expect(app.connect).not.toHaveBeenCalled();
				await close();
				await blocked();
			}
		);
		it('keeps throw-before-close unknown until the independent protocol acknowledgement', async () => {
			const error = new Error('close failed');
			acp.spawn(input());
			await drain();
			probes.close.mockImplementationOnce(() => {
				throw error;
			});
			await close();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(error);
			await blocked();
			protocol.resolve();
			await drain();
			(await reserve()).release();
		});
		it.each([false, true])(
			'keeps protocol and async close diagnostics independent (report first: %s)',
			async (reportFirst) => {
				const error = new Error('close failed');
				const reporting = Promise.withResolvers<void>();
				acp.spawn(input());
				await drain();
				probes.close.mockImplementationOnce(() => {
					throw error;
				});
				vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
				await close();
				if (reportFirst) reporting.resolve();
				else protocol.resolve();
				await drain();
				await blocked();
				if (reportFirst) protocol.resolve();
				else reporting.reject(new Error('report failed'));
				await drain();
				expect(captureException).toHaveBeenCalledExactlyOnceWith(error);
				(await reserve()).release();
			}
		);
		it('composes independent protocol connections after both native children close', async () => {
			acp.spawn(input());
			await drain();
			const first = native;
			native = makeNative();
			const second = Promise.withResolvers<void>();
			app.connect.mockReturnValueOnce({
				agent: { request: probes.request, notify: probes.notify },
				closed: second.promise,
				close: probes.close,
			});
			acp.spawn(input());
			await drain();
			await close(first);
			await close();
			await blocked();
			protocol.resolve();
			await drain();
			await blocked();
			first.emit('close', 0, null);
			await drain();
			await blocked();
			second.resolve();
			await drain();
			(await reserve()).release();
		});
		it('blocks a pending canonical reservation while only the protocol remains active', async () => {
			acp.spawn(input());
			await drain();
			await close();
			const canonical = Promise.withResolvers<string>();
			vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
			const pending = gate.reserveWorktreeCleanup(target);
			canonical.resolve(target);
			expect(await pending).toMatchObject({ status: 'blocked' });
			protocol.resolve();
			await drain();
			(await reserve()).release();
		});
		it('refuses before SDK setup or recovery under a reservation and succeeds on retry', async () => {
			const hold = await reserve();
			try {
				expect(acp.spawn(input({ permissionMode: 'full' })).success).toBe(false);
				for (const probe of [
					acpNdJsonStream,
					probes.acpClient,
					app.connect,
					fallback,
					captureException,
				])
					expect(probe).not.toHaveBeenCalled();
			} finally {
				hold.release();
			}
			expect(acp.spawn(input()).success).toBe(true);
			await drain();
			await close();
			await blocked();
			protocol.resolve();
			await drain();
			(await reserve()).release();
		});
	});
	describe('retained ACP client callbacks', () => {
		let ask: (request: { params: RequestPermissionRequest }) => Promise<RequestPermissionResponse>;
		let update: (notification: { params: SessionNotification }) => void;
		const request: { params: RequestPermissionRequest } = {
			params: { sessionId: 'acp-session', toolCall: { toolCallId: 'tool' }, options: [] },
		};
		const notification: { params: SessionNotification } = {
			params: {
				sessionId: 'acp-session',
				update: {
					sessionUpdate: 'agent_message_chunk',
					content: { type: 'text', text: 'late' },
				},
			},
		};
		beforeEach(async () => {
			acp.spawn(input());
			await drain();
			ask = app.onRequest.mock.calls.at(-1)![1];
			update = app.onNotification.mock.calls.at(-1)![1];
			await close();
			processes.clear();
			vi.clearAllMocks();
		});
		it.each([target, path.join(target, 'descendant'), path.resolve('unrelated')])(
			'refuses late permission/update before request lookup or recovery under %s',
			async (root) => {
				const lookup = vi.fn();
				const hold = await reserve(root);
				try {
					await expect(
						ask({
							get params() {
								lookup();
								return request.params;
							},
						})
					).rejects.toThrow('reserved');
					expect(() =>
						update({
							get params() {
								lookup();
								return notification.params;
							},
						})
					).toThrow('reserved');
					for (const probe of [
						lookup,
						probes.interaction,
						probes.output,
						probes.exit,
						probes.close,
						probes.request,
						probes.notify,
						spawn,
						stopProcess,
						fallback,
						captureException,
					])
						expect(probe).not.toHaveBeenCalled();
				} finally {
					hold.release();
				}
			}
		);
		it.each(['resolve', 'reject'] as const)(
			'owns parallel late permission decisions through replacement and %s',
			async (outcome) => {
				const first = Promise.withResolvers<unknown>();
				const second = Promise.withResolvers<unknown>();
				probes.interaction.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
				const a = ask(request);
				const b = ask(request);
				await blocked();
				native = makeNative();
				acp.spawn(input());
				await drain();
				processes.clear();
				await close();
				await blocked();
				if (outcome === 'reject') {
					second.reject(new Error('permission failed'));
					await expect(b).rejects.toThrow('permission failed');
				} else {
					second.resolve({ outcome: 'cancelled' });
					await expect(b).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
				}
				await drain();
				await blocked();
				first.resolve({ outcome: 'selected', optionId: 'allow-once' });
				await expect(a).resolves.toEqual({
					outcome: { outcome: 'selected', optionId: 'allow-once' },
				});
				await drain();
				(await reserve()).release();
			}
		);
		it('admits late permission before an earlier pending reservation resolves', async () => {
			const canonical = Promise.withResolvers<string>();
			vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
			const reservation = gate.reserveWorktreeCleanup(target);
			const decision = Promise.withResolvers<unknown>();
			probes.interaction.mockReturnValueOnce(decision.promise);
			const response = ask(request);
			canonical.resolve(target);
			expect(await reservation).toMatchObject({ status: 'blocked' });
			decision.resolve({ outcome: 'cancelled' });
			await response;
			await drain();
			(await reserve()).release();
		});
		it.each(['params', 'session', 'broker', 'mapping'] as const)(
			'releases rejected late permission on %s failure even if diagnostics throw',
			async (failure) => {
				const error = new Error('callback failed');
				const fail = () => {
					throw error;
				};
				vi.mocked(captureException).mockImplementationOnce(fail);
				let value = request;
				if (failure === 'params')
					value = {
						get params() {
							return fail();
						},
					};
				if (failure === 'session')
					value = {
						params: {
							...request.params,
							get sessionId() {
								return fail();
							},
						},
					};
				if (failure === 'broker')
					vi.spyOn(harnessInteractionBroker, 'open').mockImplementationOnce(fail);
				if (failure === 'mapping')
					probes.interaction.mockResolvedValueOnce({
						get outcome() {
							return fail();
						},
					});
				await expect(ask(value)).rejects.toBe(error);
				await drain();
				expect(fallback).not.toHaveBeenCalled();
				expect(stopProcess).not.toHaveBeenCalled();
				(await reserve()).release();
			}
		);
		it('preserves synchronous late update output and session filtering', async () => {
			update(notification);
			update({ params: { ...notification.params, sessionId: 'different' } });
			update({
				params: {
					...notification.params,
					update: {
						sessionUpdate: 'agent_thought_chunk',
						content: { type: 'text', text: 'next' },
					},
				},
			});
			expect(probes.output.mock.calls.map(([, line]) => JSON.parse(line))).toEqual([
				{ type: 'acp.text', sessionId: 'acp-session', text: 'late' },
				{ type: 'acp.text', sessionId: 'acp-session', text: 'next', reasoning: true },
			]);
			await expect(ask({ params: { ...request.params, sessionId: 'different' } })).resolves.toEqual(
				{ outcome: { outcome: 'cancelled' } }
			);
			expect(probes.interaction).not.toHaveBeenCalled();
			(await reserve()).release();
		});
		it.each(['params', 'output'] as const)(
			'preserves synchronous update %s errors and releases even if reporting fails',
			async (failure) => {
				const error = new Error('update failed');
				const fail = () => {
					throw error;
				};
				vi.mocked(captureException).mockImplementationOnce(fail);
				if (failure === 'output') probes.output.mockImplementationOnce(fail);
				expect(() =>
					update(
						failure === 'params'
							? {
									get params() {
										return fail();
									},
								}
							: notification
					)
				).toThrow(error);
				expect(fallback).not.toHaveBeenCalled();
				expect(stopProcess).not.toHaveBeenCalled();
				(await reserve()).release();
			}
		);
		it('keeps independent native activity while a late permission settles', async () => {
			const decision = Promise.withResolvers<unknown>();
			probes.interaction.mockReturnValueOnce(decision.promise);
			const response = ask(request);
			native = makeNative();
			acp.spawn(input());
			await drain();
			native.emit('exit', 0, null);
			processes.clear();
			decision.resolve({ outcome: 'cancelled' });
			await response;
			await drain();
			await blocked();
			await close();
			(await reserve()).release();
		});
		it('filters updates before prompt and suppresses a replaced generation', async () => {
			native = makeNative();
			const initialized = Promise.withResolvers<unknown>();
			probes.request.mockReturnValueOnce(initialized.promise);
			acp.spawn(input());
			const nextUpdate = app.onNotification.mock.calls.at(-1)![1];
			probes.output.mockClear();
			nextUpdate(notification);
			update(notification);
			expect(probes.output).not.toHaveBeenCalled();
			await blocked();
			initialized.resolve(replies.initialize);
			await drain();
			probes.output.mockClear();
			nextUpdate(notification);
			expect(probes.output).toHaveBeenCalledOnce();
			await close();
			(await reserve()).release();
		});
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
					captureException,
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
	it.each(['resolve', 'reject', 'throw'] as const)(
		'owns async acp setup diagnostics on %s and preserves fallback',
		async (outcome) => {
			const failure = new Error('setup failed');
			const reporting = Promise.withResolvers<void>();
			vi.mocked(planSpawnShell).mockImplementationOnce(() => {
				throw failure;
			});
			vi.mocked(captureException).mockImplementationOnce(() => {
				if (outcome === 'throw') throw new Error('report failed');
				return reporting.promise;
			});
			expect(acp.spawn(input({ permissionMode: 'full' }))).toEqual({ success: true, pid: 999 });
			expect(fallback).toHaveBeenCalledOnce();
			await drain();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			if (outcome !== 'throw') {
				await blocked();
				if (outcome === 'resolve') reporting.resolve();
				else reporting.reject(new Error('report failed'));
				await drain();
			}
			expect(captureException).toHaveBeenCalledOnce();
			(await reserve()).release();
		}
	);
	it.each([false, true])(
		'owns async acp outer failure diagnostics despite logger failure: %s',
		async (loggerFails) => {
			const failure = new Error('fallback failed');
			const reporting = Promise.withResolvers<void>();
			fallback.mockImplementationOnce(() => {
				throw failure;
			});
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			if (loggerFails)
				vi.mocked(logger.error).mockImplementationOnce(() => {
					throw new Error('logger');
				});
			expect(acp.spawn(input({ nativeAcpArgs: undefined }))).toEqual({
				success: false,
				pid: -1,
				error: String(failure),
			});
			await drain();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			await blocked();
			reporting.reject(new Error('report failed'));
			await drain();
			expect(captureException).toHaveBeenCalledOnce();
			(await reserve()).release();
		}
	);
	it.each([false, true])(
		'owns async acp run diagnostics independently of native close (report first: %s)',
		async (reportFirst) => {
			const failure = new Error('request failed');
			const reporting = Promise.withResolvers<void>();
			probes.request.mockRejectedValueOnce(failure);
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			expect(acp.spawn(input()).success).toBe(true);
			await drain();
			expect(probes.exit).toHaveBeenCalledOnce();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			if (reportFirst) reporting.resolve();
			else await close();
			await drain();
			await blocked();
			if (reportFirst) await close();
			else reporting.reject(new Error('report failed'));
			await drain();
			expect(captureException).toHaveBeenCalledOnce();
			(await reserve()).release();
		}
	);
	it.each([false, true])(
		'owns async acp completion diagnostics despite logger failure: %s',
		async (loggerFails) => {
			acp.spawn(input());
			await drain();
			const failure = new Error('connection close failed');
			const reporting = Promise.withResolvers<void>();
			probes.close.mockImplementationOnce(() => {
				throw failure;
			});
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			if (loggerFails)
				vi.mocked(logger.error).mockImplementationOnce(() => {
					throw new Error('logger');
				});
			await close();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			await blocked();
			reporting.reject(new Error('report failed'));
			await drain();
			expect(captureException).toHaveBeenCalledOnce();
			(await reserve()).release();
		}
	);
	it.each(['permission', 'notification', 'interrupt', 'kill'] as const)(
		'owns async acp late %s diagnostics in fresh activity',
		async (action) => {
			acp.spawn(input());
			await drain();
			const managed = processes.get('rpc-session')!;
			await close();
			const canonical = Promise.withResolvers<string>();
			vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
			const reservation = gate.reserveWorktreeCleanup(target);
			const failure = new Error('callback failed');
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			if (action === 'permission') {
				probes.interaction.mockRejectedValueOnce(failure);
				vi.mocked(logger.error).mockImplementationOnce(() => {
					throw new Error('logger');
				});
				await expect(permission()).rejects.toBe(failure);
			} else if (action === 'notification') {
				const record = {
					get params(): never {
						throw failure;
					},
				};
				expect(() => app.onNotification.mock.calls.at(-1)![1](record)).toThrow(failure);
			} else {
				vi.mocked(stopProcess).mockImplementationOnce(() => {
					throw failure;
				});
				await expect(managed.sdkController![action]()).rejects.toBe(failure);
			}
			canonical.resolve(target);
			expect(await reservation).toMatchObject({ status: 'blocked' });
			await drain();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			processes.clear();
			const successor = Promise.withResolvers<void>();
			boundary.withWorktreeTurnActivity((_start, observe) => observe(successor.promise), vi.fn());
			reporting.reject(new Error('report failed'));
			await drain();
			await blocked();
			successor.resolve();
			await drain();
			expect(captureException).toHaveBeenCalledOnce();
			(await reserve()).release();
		}
	);
	it('owns async acp exit diagnostics when exit logging also throws', async () => {
		const failure = new Error('exit logger failed');
		const reporting = Promise.withResolvers<void>();
		probes.exit.mockRejectedValueOnce(new Error('exit failed'));
		vi.mocked(logger.error).mockImplementationOnce(() => {
			throw failure;
		});
		vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
		acp.spawn(input());
		await drain();
		await close();
		expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
		await blocked();
		reporting.reject(new Error('report failed'));
		await drain();
		expect(captureException).toHaveBeenCalledOnce();
		(await reserve()).release();
	});
});

describe('standalone Codex app-server activity', () => {
	let emitter: EventEmitter;
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
		emitter = new EventEmitter();
		codex = new CodexAppServerSpawner(processes, emitter, {} as DataBufferManager, fallback);
	});
	describe('Codex asynchronous diagnostics', () => {
		beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
		afterEach(() => vi.useRealTimers());
		it.each(['resolve', 'reject', 'throw'] as const)(
			'owns Codex setup diagnostics on %s without replacing fallback',
			async (outcome) => {
				const failure = new Error('setup failed');
				const reporting = Promise.withResolvers<void>();
				vi.mocked(planSpawnShell).mockImplementationOnce(() => {
					throw failure;
				});
				vi.mocked(captureException).mockImplementationOnce(() => {
					if (outcome === 'throw') throw new Error('report failed');
					return reporting.promise;
				});
				expect(codex.spawn(input({ permissionMode: 'full' }))).toEqual({ success: true, pid: 999 });
				expect(fallback).toHaveBeenCalledOnce();
				expect(spawn).not.toHaveBeenCalled();
				await drain();
				expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
				if (outcome !== 'throw') {
					await blocked();
					if (outcome === 'resolve') reporting.resolve();
					else reporting.reject(new Error('report failed'));
					await drain();
				}
				expect(captureException).toHaveBeenCalledOnce();
				(await reserve()).release();
			}
		);
		it.each([false, true])(
			'owns Codex outer reporting despite logger failure: %s',
			async (loggerFails) => {
				const failure = new Error('fallback failed');
				const reporting = Promise.withResolvers<void>();
				fallback.mockImplementationOnce(() => {
					throw failure;
				});
				vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
				if (loggerFails)
					vi.mocked(logger.error).mockImplementationOnce(() => {
						throw new Error('logger');
					});
				expect(codex.spawn(input({ images: ['fixture'], permissionMode: 'full' }))).toEqual({
					success: false,
					pid: -1,
					error: String(failure),
				});
				await drain();
				expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
				await blocked();
				reporting.reject(new Error('report failed'));
				await drain();
				expect(captureException).toHaveBeenCalledOnce();
				(await reserve()).release();
			}
		);
		it.each([false, true])(
			'owns Codex run reporting independently of native close (report first: %s)',
			async (reportFirst) => {
				const failure = new Error('turn failed');
				const reporting = Promise.withResolvers<void>();
				probes.request.mockImplementation(async (method: string) => {
					if (method === 'turn/start') throw failure;
					return replies[method];
				});
				vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
				expect(codex.spawn(input()).success).toBe(true);
				await drain();
				expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
				expect(probes.exit.mock.calls[0][1]).toBe(1);
				if (reportFirst) reporting.resolve();
				else await close();
				await drain();
				await blocked();
				if (reportFirst) await close();
				else reporting.reject(new Error('report failed'));
				await drain();
				expect(fallback).not.toHaveBeenCalled();
				expect(captureException).toHaveBeenCalledOnce();
				(await reserve()).release();
			}
		);
		it.each([false, true])(
			'owns Codex native completion reporting despite logger failure: %s',
			async (loggerFails) => {
				codex.spawn(input());
				await drain();
				const failure = new Error('close failed');
				const reporting = Promise.withResolvers<void>();
				probes.close.mockImplementationOnce(() => {
					throw failure;
				});
				vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
				if (loggerFails)
					vi.mocked(logger.error).mockImplementationOnce(() => {
						throw new Error('logger');
					});
				await close();
				expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
				await blocked();
				reporting.reject(new Error('report failed'));
				await drain();
				expect(captureException).toHaveBeenCalledOnce();
				(await reserve()).release();
			}
		);
		it.each(['fallback', 'output', 'listener', 'exit'] as const)(
			'owns Codex caught %s reporting after native close',
			async (stage) => {
				const failure = new Error('callback failed');
				const reporting = Promise.withResolvers<void>();
				vi.mocked(captureException).mockReturnValue(reporting.promise);
				if (stage === 'fallback') {
					probes.request.mockRejectedValueOnce(new Error('initialize failed'));
					fallback.mockImplementationOnce(() => {
						throw failure;
					});
				}
				codex.spawn(input({ permissionMode: 'full' }));
				await drain();
				if (stage === 'output') {
					emitter.on('raw-stdout', () => {
						throw failure;
					});
					line('item/completed', {
						threadId: 'thread',
						turnId: 'turn',
						item: { id: 'm', type: 'agentMessage', text: 'hello' },
					});
					expect(probes.output.mock.calls.at(-1)![1]).toContain('hello');
				}
				if (stage === 'listener')
					processes.get('rpc-session')!.codexAppServer!.onTurnEnd(() => {
						throw failure;
					});
				if (stage === 'exit') {
					probes.exit.mockRejectedValueOnce(new Error('exit failed'));
					vi.mocked(logger.error).mockImplementationOnce(() => {
						throw failure;
					});
				}
				await close();
				expect(captureException).toHaveBeenCalledWith(failure);
				const count = vi.mocked(captureException).mock.calls.length;
				await blocked();
				reporting.reject(new Error('report failed'));
				await drain();
				expect(captureException).toHaveBeenCalledTimes(count);
				(await reserve()).release();
			}
		);
		it.each([
			'request',
			'steering',
			'stdin',
			'stderr',
			'ended',
			'line',
			'message',
			'interrupt',
			'kill',
		] as const)(
			'owns Codex late %s diagnostics across pending reservation and successor',
			async (stage) => {
				codex.spawn(input());
				await drain();
				const managed = processes.get('rpc-session')!;
				Object.assign(native, { exitCode: 0 });
				await close();
				processes.clear();
				(await reserve()).release();
				const canonical = Promise.withResolvers<string>();
				vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
				const reservation = gate.reserveWorktreeCleanup(target);
				const failure = new Error('late failure');
				const reporting = Promise.withResolvers<void>();
				vi.mocked(captureException).mockReturnValue(reporting.promise);
				const fail = () => {
					throw failure;
				};
				if (stage === 'request') {
					probes.request.mockRejectedValueOnce(failure);
					await expect(managed.codexAppServer!.sendRequest('late')).rejects.toBe(failure);
				} else if (stage === 'steering') {
					vi.spyOn(
						await import('../../../main/codex-app-server/steering'),
						'steerCodexAppServerTurn'
					).mockRejectedValueOnce(failure);
					await expect(managed.harnessControl!.steer!({ id: 'late', text: 'more' })).rejects.toBe(
						failure
					);
				} else if (stage === 'stdin') {
					vi.mocked(logger.debug).mockImplementationOnce(fail);
					expect(() => native.stdin.emit('error', new Error('stdin'))).toThrow(failure);
				} else if (stage === 'stderr') {
					probes.stderr.mockImplementationOnce(fail);
					expect(() => native.stderr.emit('data', 'late')).toThrow(failure);
				} else if (stage === 'line') {
					vi.mocked(logger.debug).mockImplementationOnce(fail);
					expect(() => line('warning', {})).toThrow(failure);
				} else if (stage === 'message') {
					managed.codexAppServer!.onUserMessage(fail);
					expect(() =>
						line('item/completed', {
							threadId: 'thread',
							turnId: 'turn',
							item: {
								id: 'echo',
								type: 'userMessage',
								content: [{ type: 'inputText', text: 'more' }],
							},
						})
					).toThrow(failure);
				} else if (stage === 'interrupt') {
					vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce(fail);
					expect(() => managed.sdkController!.interrupt()).toThrow(failure);
				} else if (stage === 'kill') {
					vi.mocked(stopProcess).mockImplementationOnce(fail);
					expect(() => managed.sdkController!.kill()).toThrow(failure);
				} else expect(() => managed.codexAppServer!.onTurnEnd(fail)).toThrow(failure);
				await drain();
				canonical.resolve(target);
				expect(await reservation).toMatchObject({ status: 'blocked' });
				expect(captureException).toHaveBeenCalledWith(failure);
				const count = ['ended', 'message', 'interrupt'].includes(stage) ? 2 : 1;
				expect(captureException).toHaveBeenCalledTimes(count);
				await blocked();
				native = makeNative();
				codex.spawn(input());
				await drain();
				await close();
				processes.clear();
				await blocked();
				reporting.reject(new Error('report failed'));
				await drain();
				expect(captureException).toHaveBeenCalledTimes(count);
				(await reserve()).release();
			}
		);
		it('refuses Codex setup before recovery or diagnostics under a reservation', async () => {
			const hold = await reserve();
			try {
				const request = input();
				const setup = vi.fn(() => 'codex');
				Object.defineProperty(request, 'toolType', { get: setup });
				expect(codex.spawn(request).success).toBe(false);
				for (const probe of [setup, planSpawnShell, spawn, fallback, captureException])
					expect(probe).not.toHaveBeenCalled();
			} finally {
				hold.release();
			}
		});
	});
	describe('Codex SSH signal adapter ownership', () => {
		let signals: EventEmitter[];
		let releases: Array<() => void>;
		let libraryLogger: typeof import('../../../shared/maestro-lib/host').logger;
		function makeSignal() {
			const child = Object.assign(makeNative(), { kill: vi.fn(), unref: vi.fn() });
			signals.push(child);
			return child;
		}
		beforeEach(async () => {
			signals = [];
			releases = [];
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			({ logger: libraryLogger } = await import('../../../shared/maestro-lib/host'));
			vi.spyOn(libraryLogger, 'info').mockImplementation(() => {});
			vi.spyOn(libraryLogger, 'warn').mockImplementation(() => {});
		});
		afterEach(async () => {
			for (const release of releases) release();
			vi.restoreAllMocks();
			for (const child of signals) child.emit('close', 0, null);
			Object.assign(native, { exitCode: 0 });
			await close();
			vi.useRealTimers();
		});
		async function inspect(expected: 'blocked' | 'reserved-partially', root = target) {
			const result = await gate.reserveWorktreeCleanup(root);
			if (result.status === 'reserved-partially') releases.push(result.release);
			expect(result.status).toBe(expected);
			if (result.status === 'blocked') expect(result.blockers[0].code).toBe('mutation-busy');
			else
				expect(result.blockers.map((b) => b.message).join(' ')).toMatch(/native.*registration.*OS/);
			return result;
		}
		async function launch(
			action: 'kill' | 'interrupt' | 'fallback' = 'kill',
			child = makeSignal()
		) {
			vi.mocked(spawn)
				.mockReturnValueOnce(native as unknown as ReturnType<typeof spawn>)
				.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
			if (action === 'fallback') probes.request.mockRejectedValueOnce(new Error('setup failed'));
			expect(
				codex.spawn(
					input({
						permissionMode: action === 'fallback' ? 'full' : 'standard',
						sshRemoteId: 'remote',
						codexAppServerSsh: {
							command: '/fixture/ssh',
							args: ['-o', 'BatchMode=yes', 'me@host', '/bin/bash', '--norc', '--noprofile', '-s'],
							stdinScript: 'exec codex app-server\n',
							remoteCommandLine: 'codex app-server',
							execArgs: ['exec', '--json'],
							cwd: '/remote/project',
							prompt: 'fixture',
						},
					})
				).success
			).toBe(true);
			const managed = processes.get('rpc-session')!;
			await drain();
			if (action !== 'fallback') managed.sdkController![action]();
			if (action === 'interrupt') vi.advanceTimersByTime(1000);
			await drain();
			expect(spawn).toHaveBeenCalledTimes(2);
			return { managed, child };
		}
		async function finishServer() {
			Object.assign(native, { exitCode: 0 });
			await close();
			processes.clear();
		}
		it.each(['kill', 'interrupt', 'fallback'] as const)(
			'retains the independent signal child after %s and app-server close',
			async (action) => {
				const { child, managed } = await launch(action);
				expect(spawn).toHaveBeenLastCalledWith(
					'/fixture/ssh',
					['-o', 'BatchMode=yes', 'me@host', '/bin/bash', '--norc', '--noprofile', '-s'],
					{ detached: true, stdio: ['pipe', 'ignore', 'ignore'] }
				);
				const { buildRemoteSignalScript } = await import('../../../main/utils/ssh-remote-signal');
				expect(child.stdin.end).toHaveBeenCalledWith(
					buildRemoteSignalScript(managed.sshRemotePidFile!, 'terminate')
				);
				if (action === 'fallback') expect(fallback).toHaveBeenCalledOnce();
				else expect(fallback).not.toHaveBeenCalled();
				await finishServer();
				await inspect('blocked');
				await close(child);
				await inspect('reserved-partially');
			}
		);
		it.each(['exit', 'error', 'timeout'] as const)(
			'does not treat signal %s as native close',
			async (event) => {
				const { child } = await launch();
				await finishServer();
				if (event === 'timeout') vi.advanceTimersByTime(30_000);
				else child.emit(event, event === 'error' ? new Error('signal failed') : 0);
				await drain();
				await inspect('blocked');
				await close(child);
				await inspect('reserved-partially');
			}
		);
		it('keeps server ownership after the signal closes first', async () => {
			const { child } = await launch();
			await close(child);
			await inspect('blocked');
			await finishServer();
			await inspect('reserved-partially');
		});
		it.each(['resolve', 'reject'] as const)(
			'keeps a cancellation signal owned when pending app-server setup ends with %s',
			async (outcome) => {
				const setup = Promise.withResolvers<unknown>();
				probes.request.mockReturnValueOnce(setup.promise);
				const { child } = await launch('interrupt');
				await finishServer();
				if (outcome === 'reject') setup.reject(new Error('cancelled setup failed'));
				else setup.resolve({});
				await drain();
				expect(fallback).not.toHaveBeenCalled();
				await inspect('blocked');
				await close(child);
				await inspect('reserved-partially');
			}
		);
		it('retains a partially initialized signal child despite the false signal result', async () => {
			const child = makeSignal();
			child.stdin.end.mockImplementationOnce(() => {
				throw new Error('stdin setup failed');
			});
			await launch('kill', child);
			await finishServer();
			await inspect('blocked');
			await close(child);
			await inspect('reserved-partially');
		});
		it.each(['close', 'exit', 'error', 'stdin-error', 'timeout'] as const)(
			'refuses retained signal %s before native effects, bookkeeping or reporting',
			async (event) => {
				const timer = vi.spyOn(globalThis, 'setTimeout');
				const { child } = await launch();
				const timeout = timer.mock.calls.find((call) => call[1] === 30_000)![0] as () => void;
				await finishServer();
				await close(child);
				const hold = await inspect('reserved-partially', path.join(target, 'descendant'));
				vi.clearAllMocks();
				const clear = vi.spyOn(globalThis, 'clearTimeout');
				const callback = () => {
					if (event === 'timeout') timeout();
					else if (event === 'stdin-error') child.stdin.emit('error', new Error('late'));
					else child.emit(event, event === 'error' ? new Error('late') : 0);
				};
				expect(callback).toThrow('reserved');
				for (const probe of [
					clear,
					child.kill,
					libraryLogger.info,
					libraryLogger.warn,
					captureException,
					spawn,
					fallback,
				])
					expect(probe).not.toHaveBeenCalled();
				if (hold.status === 'reserved-partially') hold.release();
				callback();
				await drain();
				await inspect('reserved-partially');
			}
		);
		it.each(['resolve', 'reject'] as const)(
			'owns late asynchronous signal diagnostics through %s after native close',
			async (outcome) => {
				const { child } = await launch();
				await finishServer();
				await close(child);
				const original = new Error('signal diagnostic failed');
				vi.mocked(libraryLogger.info).mockImplementationOnce(() => {
					throw original;
				});
				const reporting = Promise.withResolvers<void>();
				vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
				expect(() => child.emit('exit', 0)).toThrow(original);
				await inspect('blocked');
				child.emit('close', 0);
				await drain();
				await inspect('blocked');
				if (outcome === 'reject') reporting.reject(new Error('report failed'));
				else reporting.resolve();
				await drain();
				expect(captureException).toHaveBeenCalledExactlyOnceWith(original);
				await inspect('reserved-partially');
			}
		);
		it('blocks an in-progress reservation when a retained signal diagnostic is admitted', async () => {
			const { child } = await launch();
			await finishServer();
			await close(child);
			const canonical = Promise.withResolvers<string>();
			vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
			const reservation = inspect('blocked');
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			vi.mocked(libraryLogger.info).mockImplementationOnce(() => {
				throw new Error('late');
			});
			expect(() => child.emit('exit', 0)).toThrow('late');
			canonical.resolve(target);
			await reservation;
			reporting.resolve();
			await drain();
			await inspect('reserved-partially');
		});
		it('keeps concurrent signals owned across a successor server and earlier closes', async () => {
			const { child, managed } = await launch();
			const second = makeSignal();
			vi.mocked(spawn).mockReturnValueOnce(second as unknown as ReturnType<typeof spawn>);
			managed.sdkController!.kill();
			await finishServer();
			await close(child);
			native = makeNative();
			vi.mocked(spawn).mockReturnValueOnce(native as unknown as ReturnType<typeof spawn>);
			codex.spawn(input());
			await drain();
			await finishServer();
			await inspect('blocked');
			await close(second);
			await inspect('reserved-partially');
		});
	});
	describe('retained Codex protocol callbacks', () => {
		beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
		afterEach(() => vi.useRealTimers());
		async function settledCallbacks(overrides: Partial<ProcessConfig> = {}, unfinished = false) {
			const request = input(overrides);
			codex.spawn(request);
			await drain();
			if (unfinished)
				probes.close.mockImplementationOnce(() => {
					throw new Error('exit callback failed');
				});
			Object.assign(native, { exitCode: 0 });
			await close();
			processes.clear();
			(await reserve()).release();
			return request;
		}
		it.each([target, path.join(target, 'descendant'), path.resolve('unrelated')])(
			'refuses late protocol/stderr/stdin-error before lookup or recovery under %s',
			async (root) => {
				const request = await settledCallbacks();
				const hold = await reserve(root);
				const lookup = vi.fn(() => 'standard');
				Object.defineProperty(request, 'permissionMode', { get: lookup });
				const generation = await import('../../../main/process-manager/generation');
				const generationLookup = vi.spyOn(generation, 'isSupersededGeneration');
				vi.clearAllMocks();
				try {
					expect(() => line('item/commandExecution/requestApproval', {}, 1)).toThrow('reserved');
					expect(() => native.stderr.emit('data', 'late')).toThrow('reserved');
					expect(() => native.stdin.emit('error', { toString: lookup })).toThrow('reserved');
					for (const probe of [
						lookup,
						generationLookup,
						probes.interaction,
						probes.respond,
						probes.output,
						probes.stderr,
						probes.exit,
						fallback,
						captureException,
						logger.debug,
					])
						expect(probe).not.toHaveBeenCalled();
				} finally {
					hold.release();
				}
			}
		);
		it.each(['resolve', 'reject'] as const)(
			'owns concurrent late permissions across replacement on %s',
			async (outcome) => {
				await settledCallbacks();
				const first = Promise.withResolvers<unknown>();
				const second = Promise.withResolvers<unknown>();
				probes.interaction.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
				line('item/commandExecution/requestApproval', {}, 1);
				line('item/fileChange/requestApproval', {}, 2);
				await blocked();
				native = makeNative();
				codex.spawn(input());
				await drain();
				await close();
				processes.clear();
				await blocked();
				first.resolve({ outcome: 'selected', optionId: 'decision-0' });
				await drain();
				expect(probes.respond).toHaveBeenCalledWith(1, { result: { decision: 'accept' } });
				await blocked();
				if (outcome === 'reject') second.reject(new Error('permission failed'));
				else second.resolve({ outcome: 'cancelled' });
				await drain();
				expect(probes.respond).toHaveBeenCalledWith(2, {
					result: {
						decision: outcome === 'reject' ? 'decline' : 'cancel',
					},
				});
				expect(logger.warn).toHaveBeenCalledTimes(outcome === 'reject' ? 1 : 0);
				expect(fallback).not.toHaveBeenCalled();
				(await reserve()).release();
			}
		);
		it('blocks pending canonicalization with newly admitted late permission work', async () => {
			await settledCallbacks();
			const canonical = Promise.withResolvers<string>();
			vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
			const reservation = gate.reserveWorktreeCleanup(target);
			const pending = Promise.withResolvers<unknown>();
			probes.interaction.mockReturnValueOnce(pending.promise);
			line('item/commandExecution/requestApproval', {}, 1);
			canonical.resolve(target);
			expect(await reservation).toMatchObject({ status: 'blocked' });
			await blocked();
			pending.resolve({ outcome: 'cancelled' });
			await drain();
			(await reserve()).release();
		});
		it.each(['permission', 'reporting'] as const)(
			'retains late reporting/permission independently when %s settles first',
			async (first) => {
				await settledCallbacks({}, true);
				const permission = Promise.withResolvers<unknown>();
				const reporting = Promise.withResolvers<void>();
				probes.interaction.mockReturnValueOnce(permission.promise);
				probes.exit.mockReturnValueOnce(reporting.promise);
				line('item/commandExecution/requestApproval', {}, 1);
				line('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } });
				line('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } });
				expect(probes.exit).toHaveBeenCalledOnce();
				await vi.advanceTimersByTimeAsync(1000);
				await blocked();
				native = makeNative();
				codex.spawn(input());
				await drain();
				await close();
				processes.clear();
				if (first === 'reporting') reporting.reject(new Error('report failed'));
				else permission.resolve({ outcome: 'selected', optionId: 'decision-1' });
				await drain();
				await blocked();
				if (first === 'reporting')
					permission.resolve({ outcome: 'selected', optionId: 'decision-1' });
				else reporting.reject(new Error('report failed'));
				await drain();
				expect(probes.respond).toHaveBeenCalledWith(1, { result: { decision: 'decline' } });
				(await reserve()).release();
			}
		);
		it.each(['full', 'readonly', 'standard'] as const)(
			'preserves late %s approval and question mappings',
			async (mode) => {
				await settledCallbacks({
					permissionMode: mode,
					...(mode === 'full'
						? {
								args: ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox'],
							}
						: {}),
				});
				probes.interaction.mockResolvedValueOnce({ outcome: 'selected', optionId: 'decision-0' });
				line('item/commandExecution/requestApproval', {}, 1);
				await drain();
				expect(probes.respond).toHaveBeenCalledWith(1, {
					result: {
						decision: mode === 'readonly' ? 'decline' : 'accept',
					},
				});
				probes.interaction.mockResolvedValueOnce({ outcome: 'answers', answers: { q: 'answer' } });
				line('item/tool/requestUserInput', { questions: [{ id: 'q', question: 'Which?' }] }, 2);
				await drain();
				expect(probes.respond).toHaveBeenCalledWith(2, {
					result: {
						answers: mode === 'standard' ? { q: { answers: ['answer'] } } : {},
					},
				});
				(await reserve()).release();
			}
		);
		it('preserves synchronous line/stderr order and suppresses superseded generation output', async () => {
			await settledCallbacks({}, true);
			const ordered: string[] = [];
			probes.output.mockImplementation((_session, chunk) => {
				ordered.push(chunk);
			});
			probes.stderr.mockImplementation((_session, chunk) => {
				ordered.push(chunk);
			});
			line('item/completed', { item: { id: 'text', type: 'agentMessage', text: 'one' } });
			native.stderr.emit('data', 'two');
			expect(ordered).toHaveLength(2);
			expect(ordered[0]).toContain('one');
			expect(ordered[1]).toBe('two');
			(await reserve()).release();
			const old = native;
			native = makeNative();
			codex.spawn(input());
			await drain();
			probes.output.mockClear();
			probes.stderr.mockClear();
			old.stdout.emit(
				'data',
				JSON.stringify({
					method: 'item/completed',
					params: { item: { id: 'old', type: 'agentMessage', text: 'old' } },
				}) + '\n'
			);
			old.stderr.emit('data', 'old');
			expect(probes.output).not.toHaveBeenCalled();
			expect(probes.stderr).not.toHaveBeenCalled();
			await close();
			(await reserve()).release();
		});
		it.each(['line', 'stderr', 'stdin-error', 'report'] as const)(
			'releases synchronous late %s failure and preserves the original error',
			async (stage) => {
				await settledCallbacks({}, true);
				const error = new Error('callback failed');
				const fail = () => {
					throw error;
				};
				vi.mocked(captureException).mockImplementation(fail);
				if (stage === 'line') probes.output.mockImplementationOnce(fail);
				if (stage === 'stderr') probes.stderr.mockImplementationOnce(fail);
				if (stage === 'stdin-error') vi.mocked(logger.debug).mockImplementationOnce(fail);
				if (stage === 'report') probes.exit.mockImplementationOnce(fail);
				expect(() => {
					if (stage === 'line')
						line('item/completed', { item: { id: 'text', type: 'agentMessage', text: 'fail' } });
					if (stage === 'stderr') native.stderr.emit('data', 'fail');
					if (stage === 'stdin-error') native.stdin.emit('error', error);
					if (stage === 'report')
						line('turn/completed', {
							threadId: 'thread',
							turn: { id: 'turn', status: 'completed' },
						});
				}).toThrow(error);
				await drain();
				expect(fallback).not.toHaveBeenCalled();
				(await reserve()).release();
			}
		);
		it('releases a failed late permission response even when decline diagnostics throw', async () => {
			await settledCallbacks();
			const pending = Promise.withResolvers<unknown>();
			probes.interaction.mockReturnValueOnce(pending.promise);
			vi.mocked(logger.warn).mockImplementationOnce(() => {
				throw new Error('diagnostic failed');
			});
			vi.mocked(captureException).mockImplementation(() => {
				throw new Error('capture failed');
			});
			line('item/commandExecution/requestApproval', {}, 1);
			await blocked();
			pending.reject(new Error('permission failed'));
			await drain();
			expect(probes.respond).not.toHaveBeenCalled();
			expect(fallback).not.toHaveBeenCalled();
			(await reserve()).release();
		});
		it('preserves synchronous response routing and best-effort response-write failure', async () => {
			await settledCallbacks({ permissionMode: 'readonly' });
			native.stdout.emit('data', JSON.stringify({ id: 8, result: 'late' }) + '\n');
			expect(probes.handleResponse).toHaveBeenCalledWith({ id: 8, result: 'late' });
			probes.respond.mockImplementationOnce(() => {
				throw new Error('write failed');
			});
			expect(() => line('unknown-method', {}, 1)).not.toThrow();
			expect(probes.respond).toHaveBeenCalledWith(1, {
				error: {
					code: -32601,
					message: 'Maestro does not handle unknown-method',
				},
			});
			expect(logger.debug).toHaveBeenCalledWith(
				expect.stringContaining('Could not answer'),
				expect.any(String),
				expect.objectContaining({ error: 'Error: write failed' })
			);
			(await reserve()).release();
		});
		it('releases a late config lookup failure before broker work even if reporting fails', async () => {
			const request = await settledCallbacks();
			const error = new Error('config failed');
			Object.defineProperty(request, 'permissionMode', {
				get: () => {
					throw error;
				},
			});
			vi.mocked(captureException).mockImplementationOnce(() => {
				throw new Error('capture failed');
			});
			expect(() => line('item/commandExecution/requestApproval', {}, 1)).toThrow(error);
			expect(probes.interaction).not.toHaveBeenCalled();
			expect(fallback).not.toHaveBeenCalled();
			(await reserve()).release();
		});
	});
	describe('delayed exit grace and retained direct controls', () => {
		beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
		afterEach(() => vi.useRealTimers());
		async function finishedControls() {
			codex.spawn(input());
			await drain();
			line('turn/started', { threadId: 'thread', turn: { id: 'turn' } });
			const managed = processes.get('rpc-session')!;
			Object.assign(native, { exitCode: 0 });
			await close();
			processes.clear();
			(await reserve()).release();
			return managed;
		}
		it.each([target, path.join(target, 'descendant'), path.resolve('unrelated')])(
			'refuses retained SDK/harness controls before lookup or recovery under %s',
			async (root) => {
				const managed = await finishedControls();
				const hold = await reserve(root);
				const lookup = vi.fn(() => null);
				Object.defineProperty(native, 'exitCode', { get: lookup, configurable: true });
				const timer = vi.spyOn(globalThis, 'setTimeout');
				const cancellation = vi.spyOn(globalThis, 'clearTimeout');
				probes.request.mockClear();
				vi.mocked(captureException).mockClear();
				try {
					expect(() => managed.sdkController!.interrupt()).toThrow('reserved');
					expect(() => managed.sdkController!.kill()).toThrow('reserved');
					await expect(managed.harnessControl!.interrupt!()).rejects.toThrow('reserved');
					await expect(managed.harnessControl!.close!({ sync: true })).rejects.toThrow('reserved');
					for (const probe of [
						lookup,
						timer,
						cancellation,
						probes.request,
						stopProcess,
						captureException,
					])
						expect(probe).not.toHaveBeenCalled();
				} finally {
					hold.release();
				}
			}
		);
		describe('retained Codex direct handles', () => {
			it.each([target, path.join(target, 'descendant'), path.resolve('unrelated')])(
				'refuses requests, steering, subscriptions and removal before lookup under %s',
				async (root) => {
					const managed = await finishedControls();
					const handle = managed.codexAppServer!;
					const listener = vi.fn();
					const offMessage = handle.onUserMessage(listener);
					const offEnd = handle.onTurnEnd(listener);
					const lookup = vi.fn(() => 'late');
					const request = {
						get id() {
							return lookup();
						},
						text: 'late',
					};
					const hold = await reserve(root);
					vi.clearAllMocks();
					try {
						expect(() => handle.sendRequest('late', request)).toThrow('reserved');
						expect(() => managed.harnessControl!.steer!(request)).toThrow('reserved');
						expect(() => handle.onUserMessage(listener)).toThrow('reserved');
						expect(() => handle.onTurnEnd(listener)).toThrow('reserved');
						expect(offMessage).toThrow('reserved');
						expect(offEnd).toThrow('reserved');
						for (const probe of [lookup, listener, probes.request, fallback, captureException])
							expect(probe).not.toHaveBeenCalled();
					} finally {
						hold.release();
					}
					offMessage();
					offEnd();
				}
			);
			it.each(['resolve', 'reject'] as const)(
				'owns parallel late requests independently across replacement on %s',
				async (outcome) => {
					const { codexAppServer: handle } = await finishedControls();
					const first = Promise.withResolvers<string>();
					const second = Promise.withResolvers<string>();
					probes.request.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
					const a = handle!.sendRequest<string>('one', { value: 1 }, { timeoutMs: 42 });
					const b = handle!.sendRequest<string>('two');
					await blocked();
					native = makeNative();
					codex.spawn(input());
					await drain();
					await close();
					processes.clear();
					first.resolve('first');
					expect(await a).toBe('first');
					await drain();
					await blocked();
					if (outcome === 'reject') {
						const result = expect(b).rejects.toThrow('late failure');
						second.reject(new Error('late failure'));
						await result;
					} else {
						second.resolve('second');
						expect(await b).toBe('second');
					}
					await drain();
					expect(probes.request).toHaveBeenCalledWith('one', { value: 1 }, { timeoutMs: 42 });
					expect(fallback).not.toHaveBeenCalled();
					(await reserve()).release();
				}
			);
			it.each(['request', 'steering'] as const)(
				'owns late request and steering independently when %s settles first',
				async (first) => {
					const managed = await finishedControls();
					const steering = await import('../../../main/codex-app-server/steering');
					const steer =
						Promise.withResolvers<import('../../../shared/chatSteering').SteeringResultFrame>();
					const request = Promise.withResolvers<unknown>();
					vi.spyOn(steering, 'steerCodexAppServerTurn').mockReturnValueOnce(steer.promise);
					probes.request.mockReturnValueOnce(request.promise);
					const a = managed.codexAppServer!.sendRequest('late');
					const b = managed.harnessControl!.steer!({ id: 'late', text: 'more' });
					await blocked();
					if (first === 'request') request.resolve({ ok: true });
					else steer.resolve({ type: 'steering', id: 'late', verdict: 'delivered' });
					await drain();
					await blocked();
					if (first === 'request')
						steer.resolve({ type: 'steering', id: 'late', verdict: 'delivered' });
					else request.resolve({ ok: true });
					expect(await a).toEqual({ ok: true });
					expect(await b).toMatchObject({ verdict: 'delivered' });
					await drain();
					(await reserve()).release();
				}
			);
			it('admits a late request ahead of pending reservation canonicalization', async () => {
				const managed = await finishedControls();
				const canonical = Promise.withResolvers<string>();
				vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
				const reservation = gate.reserveWorktreeCleanup(target);
				const pending = Promise.withResolvers<unknown>();
				probes.request.mockReturnValueOnce(pending.promise);
				const response = managed.codexAppServer!.sendRequest('late');
				canonical.resolve(target);
				expect(await reservation).toMatchObject({ status: 'blocked' });
				pending.resolve('done');
				await response;
				await drain();
				(await reserve()).release();
			});
			it.each(['request', 'steering'] as const)(
				'preserves synchronous %s failure even if diagnostics throw',
				async (operation) => {
					const managed = await finishedControls();
					const error = new Error('direct failure');
					const fail = () => {
						throw error;
					};
					vi.mocked(captureException).mockImplementation(() => {
						throw new Error('capture failed');
					});
					if (operation === 'request') probes.request.mockImplementationOnce(fail);
					else
						vi.spyOn(
							await import('../../../main/codex-app-server/steering'),
							'steerCodexAppServerTurn'
						).mockImplementationOnce(fail);
					expect(() =>
						operation === 'request'
							? managed.codexAppServer!.sendRequest('late')
							: managed.harnessControl!.steer!({ id: 'late', text: 'more' })
					).toThrow(error);
					(await reserve()).release();
				}
			);
			it('admits retained message callbacks and unsubscribe without changing synchronous delivery', async () => {
				const managed = await finishedControls();
				const { CodexAppServerEventTranslator } =
					await import('../../../main/codex-app-server/event-translator');
				const subscribe = vi.spyOn(CodexAppServerEventTranslator.prototype, 'onUserMessage');
				const received: string[] = [];
				const listener = vi.fn((message: { text: string }) => {
					received.push(message.text);
				});
				const off = managed.codexAppServer!.onUserMessage(listener);
				const callback = subscribe.mock.calls[0][0];
				const message = { turnId: 'turn', itemId: 'late', text: 'one' };
				const hold = await reserve();
				try {
					expect(() => callback(message)).toThrow('reserved');
					expect(off).toThrow('reserved');
					expect(listener).not.toHaveBeenCalled();
				} finally {
					hold.release();
				}
				callback(message);
				callback({ ...message, text: 'two' });
				expect(received).toEqual(['one', 'two']);
				listener.mockImplementationOnce(() => {
					throw new Error('listener failed');
				});
				expect(() => callback(message)).toThrow('listener failed');
				off();
				off();
				(await reserve()).release();
			});
			it('preserves duplicate listener identity, removal during delivery and old unsubscribes', async () => {
				codex.spawn(input());
				await drain();
				line('turn/started', { threadId: 'thread', turn: { id: 'turn' } });
				const handle = processes.get('rpc-session')!.codexAppServer!;
				const received: string[] = [];
				const listener = () => {
					received.push('message');
				};
				const end = () => {
					received.push('end');
				};
				const off = handle.onUserMessage(listener);
				handle.onUserMessage(listener);
				const offEnd = handle.onTurnEnd(end);
				handle.onTurnEnd(end);
				const message = {
					threadId: 'thread',
					turnId: 'turn',
					item: { id: 'echo', type: 'userMessage', content: [{ type: 'inputText', text: 'more' }] },
				};
				line('item/completed', message);
				expect(received).toEqual(['message']);
				off();
				handle.onUserMessage(listener);
				off();
				line('item/completed', message);
				expect(received).toEqual(['message']);
				offEnd();
				handle.onTurnEnd(end);
				offEnd();
				const later = vi.fn();
				let offLater = () => {};
				handle.onUserMessage(() => {
					received.push('first');
					offLater();
				});
				offLater = handle.onUserMessage(later);
				handle.onTurnEnd(end);
				handle.onTurnEnd(end);
				line('item/completed', message);
				expect(received).toEqual(['message', 'first']);
				expect(later).not.toHaveBeenCalled();
				await close();
				expect(received).toEqual(['message', 'first', 'end']);
				(await reserve()).release();
			});
			it('retains a rejected late steering promise without masking the error', async () => {
				const managed = await finishedControls();
				const pending =
					Promise.withResolvers<import('../../../shared/chatSteering').SteeringResultFrame>();
				vi.spyOn(
					await import('../../../main/codex-app-server/steering'),
					'steerCodexAppServerTurn'
				).mockReturnValueOnce(pending.promise);
				const response = managed.harnessControl!.steer!({ id: 'late', text: 'more' });
				await blocked();
				vi.mocked(captureException).mockImplementation(() => {
					throw new Error('capture failed');
				});
				const result = expect(response).rejects.toThrow('steering failed');
				pending.reject(new Error('steering failed'));
				await result;
				await drain();
				(await reserve()).release();
			});
			it('preserves immediate ended-turn delivery, unsubscribe and listener errors', async () => {
				const managed = await finishedControls();
				const received: string[] = [];
				const off = managed.codexAppServer!.onTurnEnd(() => {
					received.push('ended');
				});
				received.push('returned');
				expect(received).toEqual(['ended', 'returned']);
				off();
				off();
				expect(() =>
					managed.codexAppServer!.onTurnEnd(() => {
						throw new Error('listener failed');
					})
				).toThrow('listener failed');
				(await reserve()).release();
			});
			it('admits a retained steering verdict before emitter lookup and preserves failures', async () => {
				const managed = await finishedControls();
				const steering = await import('../../../main/codex-app-server/steering');
				const spy = vi
					.spyOn(steering, 'steerCodexAppServerTurn')
					.mockResolvedValueOnce({ type: 'steering', id: 'late', verdict: 'delivered' });
				await managed.harnessControl!.steer!({ id: 'late', text: 'more' });
				await drain();
				const verdict = spy.mock.calls[0][2];
				const emit = vi.spyOn(emitter, 'emit');
				const frame = { type: 'steering', id: 'late', verdict: 'absorbed' } as const;
				const hold = await reserve();
				try {
					expect(() => verdict(frame)).toThrow('reserved');
					expect(emit).not.toHaveBeenCalled();
				} finally {
					hold.release();
				}
				verdict(frame);
				expect(emit).toHaveBeenCalledWith('steering-verdict', 'rpc-session', frame);
				emit.mockImplementationOnce(() => {
					throw new Error('emit failed');
				});
				expect(() => verdict(frame)).toThrow('emit failed');
				(await reserve()).release();
			});
		});
		it('retains one deduplicated timer after native close and registration removal', async () => {
			const managed = await finishedControls();
			const timer = vi.spyOn(globalThis, 'setTimeout');
			managed.sdkController!.interrupt();
			managed.sdkController!.interrupt();
			expect(timer).toHaveBeenCalledOnce();
			expect(timer).toHaveBeenCalledWith(expect.any(Function), 1000);
			await blocked();
			await vi.advanceTimersByTimeAsync(999);
			await blocked();
			await vi.advanceTimersByTimeAsync(1);
			expect(stopProcess).not.toHaveBeenCalled();
			(await reserve()).release();
		});
		it('releases confirmed cancellation and preserves shutdown options', async () => {
			const managed = await finishedControls();
			managed.sdkController!.interrupt();
			await blocked();
			managed.sdkController!.kill({ sync: true, shutdown: true });
			await drain();
			(await reserve()).release();
			expect(stopProcess).toHaveBeenCalledWith(
				{ child: native },
				expect.objectContaining({
					immediate: true,
					blocking: true,
					upTo: 'terminate',
					includeDescendants: false,
				})
			);
			await vi.advanceTimersByTimeAsync(1000);
			expect(stopProcess).toHaveBeenCalledOnce();
		});
		it.each(['return', 'throw'] as const)(
			'retains a running callback through %s and permits reentrant rescheduling',
			async (outcome) => {
				const managed = await finishedControls();
				managed.sdkController!.interrupt();
				Object.assign(native, { exitCode: null });
				let during!: Promise<void>;
				vi.mocked(stopProcess).mockImplementationOnce(() => {
					Object.assign(native, { exitCode: 0 });
					managed.sdkController!.interrupt();
					during = blocked();
					if (outcome === 'throw') throw new Error('stop callback failed');
					return { stage: () => undefined, dispose: () => {} };
				});
				if (outcome === 'throw')
					expect(() => vi.advanceTimersByTime(1000)).toThrow('stop callback failed');
				else vi.advanceTimersByTime(1000);
				await during;
				await drain();
				await blocked();
				await vi.advanceTimersByTimeAsync(1000);
				(await reserve()).release();
			}
		);
		it('retains failed cancellation until the callback settles', async () => {
			const managed = await finishedControls();
			managed.sdkController!.interrupt();
			vi.spyOn(globalThis, 'clearTimeout').mockImplementationOnce(() => {
				throw new Error('cancel failed');
			});
			expect(() => managed.sdkController!.kill()).toThrow('cancel failed');
			await blocked();
			await vi.advanceTimersByTimeAsync(1000);
			(await reserve()).release();
		});
		it('releases a failed scheduling attempt without running stop recovery', async () => {
			const managed = await finishedControls();
			vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce(() => {
				throw new Error('timer failed');
			});
			expect(() => managed.sdkController!.interrupt()).toThrow('timer failed');
			await drain();
			(await reserve()).release();
			expect(stopProcess).not.toHaveBeenCalled();
		});
		it('retains newly requested interrupt RPC after the original lifetime settled', async () => {
			codex.spawn(input());
			await drain();
			line('turn/started', { threadId: 'thread', turn: { id: 'turn' } });
			const managed = processes.get('rpc-session')!;
			probes.close.mockImplementationOnce(() => {
				throw new Error('close reporting failed');
			});
			await close();
			(await reserve()).release();
			const pending = Promise.withResolvers<unknown>();
			probes.request.mockReturnValueOnce(pending.promise);
			managed.sdkController!.interrupt();
			managed.sdkController!.kill();
			await drain();
			await blocked();
			pending.reject(new Error('interrupt failed'));
			await drain();
			(await reserve()).release();
		});
		it('admits timer setup ahead of a pending reservation canonicalization', async () => {
			const managed = await finishedControls();
			const canonical = Promise.withResolvers<string>();
			vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
			const reservation = gate.reserveWorktreeCleanup(target);
			managed.sdkController!.interrupt();
			canonical.resolve(target);
			expect(await reservation).toMatchObject({ status: 'blocked' });
			await vi.advanceTimersByTimeAsync(1000);
			(await reserve()).release();
		});
		it('retains the old timer after a replacement registration and child close', async () => {
			const managed = await finishedControls();
			managed.sdkController!.interrupt();
			native = makeNative();
			codex.spawn(input());
			await drain();
			await close();
			await blocked();
			await vi.advanceTimersByTimeAsync(1000);
			(await reserve()).release();
		});
		it.each(['exit', 'error', 'close'] as const)(
			'preserves independent native ownership and timer cancellation on %s',
			async (event) => {
				codex.spawn(input());
				await drain();
				line('turn/started', { threadId: 'thread', turn: { id: 'turn' } });
				processes.get('rpc-session')!.sdkController!.interrupt();
				native.emit(event, event === 'error' ? new Error('native error') : 0, null);
				await drain();
				expect(vi.getTimerCount()).toBe(event === 'exit' ? 1 : 0);
				if (event !== 'close') {
					await blocked();
					await close();
				}
				(await reserve()).release();
			}
		);
		it('keeps uncertain callback cancellation blocked after a failed clear', async () => {
			const managed = await finishedControls();
			managed.sdkController!.interrupt();
			vi.spyOn(globalThis, 'clearTimeout').mockImplementationOnce(() => {
				throw new Error('clear failed');
			});
			expect(() => vi.advanceTimersByTime(1000)).toThrow('clear failed');
			await drain();
			await blocked();
		});
		it('keeps the independent child hold after timer cancellation', async () => {
			codex.spawn(input());
			await drain();
			line('turn/started', { threadId: 'thread', turn: { id: 'turn' } });
			const managed = processes.get('rpc-session')!;
			managed.sdkController!.interrupt();
			managed.sdkController!.kill();
			await vi.advanceTimersByTimeAsync(1000);
			await blocked();
			await close();
			(await reserve()).release();
		});
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

describe('standalone Hermes gateway activity', () => {
	let hermes: import('../../../main/process-manager/spawners/HermesApiSpawner').HermesApiSpawner;
	const input = (overrides: Partial<ProcessConfig> = {}) =>
		config({
			toolType: 'hermes',
			command: 'python',
			args: ['-m', 'tui_gateway.entry'],
			harnessControlMode: 'native',
			...overrides,
		});
	const notify = (method: string, params: unknown = {}) =>
		connection().onNotification!({ method, params });
	beforeEach(async () => {
		probes.request.mockImplementation(async (method: string) =>
			method === 'session.create' ? { session_id: 'session' } : {}
		);
		const { HermesApiSpawner } =
			await import('../../../main/process-manager/spawners/HermesApiSpawner');
		hermes = new HermesApiSpawner(processes, new EventEmitter(), {} as DataBufferManager, fallback);
	});
	it.each([target, path.join(target, 'descendant'), path.resolve('unrelated')])(
		'refuses retained notifications before record lookup or effects under %s',
		async (root) => {
			hermes.spawn(input());
			await drain();
			const callbacks = connection();
			await close();
			processes.clear();
			const hold = await reserve(root);
			const lookup = vi.fn();
			vi.clearAllMocks();
			try {
				for (const method of [
					'event',
					'request.cancel',
					'tool.start',
					'tool.complete',
					'approval.expire',
					'clarify.expire',
					'secret.expire',
					'sudo.expire',
					'message.delta',
					'message.interim',
					'session.usage',
					'message.complete',
					'message.error',
					'run.failed',
					'run.cancelled',
					'run.interrupted',
					'unknown',
				]) {
					callbacks.onNotification!({
						get method() {
							lookup();
							return method;
						},
						params: { type: 'message.delta', payload: { text: 'late' } },
					});
				}
				await drain();
				for (const probe of [
					lookup,
					probes.output,
					probes.request,
					probes.exit,
					probes.interaction,
					harnessInteractionBroker.withdraw,
					native.stdin.end,
					fallback,
					stopProcess,
					logger.warn,
				])
					expect(probe).not.toHaveBeenCalled();
				expect(captureException).toHaveBeenCalledWith(
					expect.objectContaining({ message: expect.stringContaining('reserved') })
				);
			} finally {
				hold.release();
			}
			(await reserve()).release();
		}
	);
	it.each([
		['message.delta', 'acp.text'],
		['event', 'acp.text'],
		['tool.start', 'acp.tool'],
		['session.usage', 'acp.usage'],
		['unknown', 'acp.system'],
	])('preserves synchronous retained %s output after native close', async (method, type) => {
		hermes.spawn(input());
		await drain();
		await close();
		processes.clear();
		(await reserve()).release();
		probes.output.mockClear();
		notify(method, { type: 'message.delta', payload: { text: 'late' }, usage: { input: 3 } });
		expect(probes.output).toHaveBeenCalledOnce();
		expect(JSON.parse(probes.output.mock.calls[0][1])).toMatchObject({ type });
		await drain();
		(await reserve()).release();
	});
	it.each(['request.cancel', 'approval.expire', 'clarify.expire', 'secret.expire', 'sudo.expire'])(
		'preserves %s withdrawal while an interaction remains pending',
		async (method) => {
			hermes.spawn(input());
			await drain();
			const interaction = Promise.withResolvers<unknown>();
			probes.interaction.mockReturnValueOnce(interaction.promise);
			const answer = connection().onServerRequest!({ id: 'cancel-me', method: 'secret' });
			notify(method, { id: 'cancel-me', request_id: 'cancel-me' });
			expect(harnessInteractionBroker.withdraw).toHaveBeenCalledWith('broker');
			await close();
			await blocked();
			interaction.resolve({ outcome: 'dismissed' });
			await answer;
			await drain();
			(await reserve()).release();
		}
	);
	it.each(['message.error', 'run.failed', 'run.cancelled', 'run.interrupted', 'message.complete'])(
		'owns %s exit reporting without releasing independent native activity',
		async (method) => {
			hermes.spawn(input());
			await drain();
			const reporting = Promise.withResolvers<void>();
			probes.exit.mockReturnValueOnce(reporting.promise);
			notify(method, { status: 'error', error: 'failed', output: 'partial' });
			expect(probes.exit).toHaveBeenCalledWith('rpc-session', 1, processes.get('rpc-session'));
			expect(native.stdin.end).toHaveBeenCalledOnce();
			expect(probes.output.mock.calls.map((call) => JSON.parse(call[1]))).toContainEqual({
				type: 'acp.error',
				message: 'failed',
			});
			processes.clear();
			reporting.resolve();
			await drain();
			await blocked();
			await close();
			expect(probes.exit).toHaveBeenCalledOnce();
			(await reserve()).release();
		}
	);
	it.each(['ready', 'running', 'queued', 'steer', '4007', '4009', 'failure'])(
		'retains completion query and exit reporting independently for %s',
		async (outcome) => {
			hermes.spawn(input());
			await drain();
			const state = Promise.withResolvers<unknown>();
			const reporting = Promise.withResolvers<void>();
			probes.request.mockReturnValueOnce(state.promise);
			probes.exit.mockReturnValueOnce(reporting.promise);
			notify('message.complete', { output: 'done', pending_steer: outcome === 'steer' });
			expect(probes.request).toHaveBeenLastCalledWith('session.resume', { session_id: 'session' });
			await close();
			processes.clear();
			await blocked();
			if (['4007', '4009', 'failure'].includes(outcome)) state.reject(new Error(outcome));
			else state.resolve({ running: outcome === 'running', queued: outcome === 'queued' });
			await drain();
			await blocked();
			const frames = probes.output.mock.calls.map((call) => JSON.parse(call[1]));
			const result = frames.find((frame) => frame.type === 'acp.result');
			expect(Boolean(result)).toBe(['ready', '4007'].includes(outcome));
			if (result) expect(result).toMatchObject({ text: 'done', stopReason: 'end_turn' });
			expect(frames.some((frame) => frame.type === 'acp.error')).toBe(false);
			expect(probes.exit).toHaveBeenCalledOnce();
			reporting.reject(new Error('report failed'));
			await drain();
			(await reserve()).release();
		}
	);
	it.each(['resolve', 'reject'] as const)(
		'keeps concurrent completion queries after reporting and replacement on %s',
		async (outcome) => {
			hermes.spawn(input());
			await drain();
			const first = Promise.withResolvers<unknown>();
			const second = Promise.withResolvers<unknown>();
			probes.request.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
			notify('message.complete', { output: 'first' });
			notify('message.complete', { output: 'second' });
			await close();
			processes.clear();
			native = makeNative();
			hermes.spawn(input());
			await drain();
			await close();
			processes.clear();
			await blocked();
			first.resolve({ running: true });
			await drain();
			await blocked();
			if (outcome === 'resolve') second.resolve({ queued: true });
			else second.reject(new Error('4009 session busy'));
			await drain();
			(await reserve()).release();
		}
	);
	it.each(['lookup', 'output', 'diagnostic'])(
		'releases failed retained notification %s without fallback',
		async (stage) => {
			hermes.spawn(input());
			await drain();
			const callbacks = connection();
			await close();
			vi.clearAllMocks();
			const fail = () => {
				throw new Error('notification failed');
			};
			if (stage === 'output') probes.output.mockImplementationOnce(fail);
			if (stage === 'diagnostic') vi.mocked(captureException).mockImplementation(fail);
			callbacks.onNotification!({
				get method() {
					return stage === 'lookup' || stage === 'diagnostic' ? fail() : 'message.delta';
				},
				params: { text: 'late' },
			});
			await drain();
			expect(fallback).not.toHaveBeenCalled();
			expect(stopProcess).not.toHaveBeenCalled();
			(await reserve()).release();
		}
	);
	it.each([target, path.join(target, 'descendant'), path.resolve('unrelated')])(
		'refuses late gateway setup before request lookup or acknowledgement under %s',
		async (root) => {
			hermes.spawn(input());
			await drain();
			await close();
			processes.clear();
			const hold = await reserve(root);
			const lookup = vi.fn(() => 'late');
			const callbacks = connection();
			vi.clearAllMocks();
			try {
				for (const method of ['approval', 'clarify', 'secret', 'sudo']) {
					callbacks.onNotification!({
						method: `${method}.request`,
						params: {
							get request_id() {
								return lookup();
							},
						},
					});
				}
				await drain();
				for (const probe of [
					lookup,
					probes.request,
					probes.interaction,
					probes.output,
					probes.exit,
					fallback,
					logger.warn,
				])
					expect(probe).not.toHaveBeenCalled();
				// The existing notification caller reports rejected callbacks.
				expect(captureException).toHaveBeenCalledWith(
					expect.objectContaining({ message: expect.stringContaining('reserved') })
				);
			} finally {
				hold.release();
			}
			(await reserve()).release();
		}
	);
	it.each(['resolve', 'reject'] as const)(
		'owns late approval acknowledgement independently after response on %s',
		async (outcome) => {
			hermes.spawn(input());
			await drain();
			await close();
			processes.clear();
			(await reserve()).release();
			const ack = Promise.withResolvers<unknown>();
			probes.request.mockReturnValueOnce(ack.promise);
			notify('approval.request', { request_id: 'late' });
			await drain();
			expect(probes.request).toHaveBeenLastCalledWith('approval.respond', {
				session_id: 'session',
				request_id: 'late',
				choice: 'deny',
			});
			await blocked();
			if (outcome === 'reject') ack.reject(new Error('ack failed'));
			else ack.resolve({});
			await drain();
			(await reserve()).release();
			expect(logger.warn).not.toHaveBeenCalled();
		}
	);
	it.each(['approval', 'clarify', 'secret', 'sudo'] as const)(
		'owns late %s response after original close and replacement',
		async (method) => {
			hermes.spawn(input());
			await drain();
			await close();
			processes.clear();
			(await reserve()).release();
			const reply = Promise.withResolvers<unknown>();
			probes.request.mockImplementation((name) =>
				name === `${method}.respond` ? reply.promise : Promise.resolve({})
			);
			notify(`${method}.request`, { request_id: 'late' });
			await drain();
			expect(probes.request).toHaveBeenCalledWith(`${method}.respond`, {
				session_id: 'session',
				request_id: 'late',
				...(method === 'approval'
					? { choice: 'deny' }
					: method === 'clarify'
						? { answers: {} }
						: method === 'sudo'
							? { password: '' }
							: { value: '' }),
			});
			await blocked();
			native = makeNative();
			hermes.spawn(input());
			await drain();
			await close();
			processes.clear();
			await blocked();
			reply.resolve({});
			await drain();
			(await reserve()).release();
		}
	);
	it.each(['resolve', 'reject'] as const)(
		'owns concurrent late gateway responses independently on %s',
		async (outcome) => {
			hermes.spawn(input());
			await drain();
			await close();
			const first = Promise.withResolvers<unknown>();
			const second = Promise.withResolvers<unknown>();
			probes.request.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
			notify('secret.request', { request_id: 'first' });
			notify('clarify.request', { request_id: 'second' });
			await drain();
			await blocked();
			first.resolve({});
			await drain();
			await blocked();
			if (outcome === 'reject') second.reject(new Error('late reply failed'));
			else second.resolve({});
			await drain();
			expect(logger.warn).toHaveBeenCalledTimes(outcome === 'reject' ? 1 : 0);
			(await reserve()).release();
		}
	);
	it('blocks earlier pending canonicalization with newly admitted acknowledgement', async () => {
		hermes.spawn(input());
		await drain();
		await close();
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const reservation = gate.reserveWorktreeCleanup(target);
		const ack = Promise.withResolvers<unknown>();
		probes.request.mockReturnValueOnce(ack.promise);
		notify('approval.request', { request_id: 'late' });
		await drain();
		canonical.resolve(target);
		expect(await reservation).toMatchObject({ status: 'blocked' });
		await blocked();
		ack.resolve({});
		await drain();
		(await reserve()).release();
	});
	it.each(['lookup', 'ack', 'reply', 'report'] as const)(
		'releases failed late gateway %s setup without changing failure handling',
		async (stage) => {
			hermes.spawn(input());
			await drain();
			await close();
			const callbacks = connection();
			vi.clearAllMocks();
			const fail = () => {
				throw new Error('gateway failed');
			};
			if (stage === 'ack' || stage === 'reply') probes.request.mockImplementationOnce(fail);
			if (stage === 'report') {
				probes.request.mockRejectedValueOnce(new Error('reply failed'));
				vi.mocked(logger.warn).mockImplementationOnce(fail);
				vi.mocked(captureException).mockImplementation(fail);
			}
			callbacks.onNotification!({
				method: stage === 'ack' ? 'approval.request' : 'secret.request',
				params: {
					get request_id() {
						return stage === 'lookup' ? fail() : 'late';
					},
				},
			});
			await drain();
			if (stage === 'lookup' || stage === 'ack') {
				expect(probes.interaction).not.toHaveBeenCalled();
				expect(logger.warn).not.toHaveBeenCalled();
			} else expect(logger.warn).toHaveBeenCalledOnce();
			expect(fallback).not.toHaveBeenCalled();
			(await reserve()).release();
		}
	);
	it.each([target, path.join(target, 'descendant'), path.resolve('unrelated')])(
		'refuses late steering and direct interactions before lookup under %s',
		async (root) => {
			hermes.spawn(input());
			await drain();
			const managed = processes.get('rpc-session')!;
			const callbacks = connection();
			await close();
			processes.clear();
			const hold = await reserve(root);
			const lookup = vi.fn(() => 'approval');
			const record = {
				id: 'late',
				get method() {
					return lookup();
				},
			};
			const request = {
				text: 'next',
				get id() {
					return lookup();
				},
			};
			vi.clearAllMocks();
			try {
				await expect(managed.harnessControl!.steer(request)).rejects.toThrow('reserved');
				await expect(callbacks.onServerRequest!(record)).rejects.toThrow('reserved');
				for (const probe of [
					lookup,
					probes.request,
					probes.interaction,
					probes.exit,
					probes.output,
					fallback,
					captureException,
				])
					expect(probe).not.toHaveBeenCalled();
			} finally {
				hold.release();
			}
			await expect(
				managed.harnessControl!.steer({ id: 'late', text: 'next' })
			).resolves.toMatchObject({ verdict: 'refused', refusal: 'not-running' });
			await expect(
				callbacks.onServerRequest!({ id: 'late', method: 'approval' })
			).resolves.toMatchObject({ kind: 'result', value: { choice: 'deny' } });
			await drain();
			(await reserve()).release();
		}
	);
	it.each(['approval', 'clarify', 'secret'] as const)(
		'owns late %s interaction work after original close/removal through replacement',
		async (method) => {
			hermes.spawn(input());
			await drain();
			const callbacks = connection();
			await close();
			processes.clear();
			(await reserve()).release();
			const pending = Promise.withResolvers<unknown>();
			probes.interaction.mockReturnValueOnce(pending.promise);
			const response = callbacks.onServerRequest!({
				id: 'late',
				method,
				params: { questions: [{ id: 'answer', question: 'fixture' }] },
			});
			await blocked();
			native = makeNative();
			hermes.spawn(input());
			await drain();
			await close();
			processes.clear();
			await blocked();
			pending.resolve(
				method === 'approval'
					? { outcome: 'selected', optionId: 'once' }
					: { outcome: 'answers', answers: { answer: 'fixture' } }
			);
			await expect(response).resolves.toEqual({
				kind: 'result',
				value:
					method === 'approval'
						? { choice: 'once' }
						: method === 'clarify'
							? { answers: { answer: 'fixture' } }
							: { value: 'fixture' },
			});
			await drain();
			(await reserve()).release();
		}
	);
	it.each(['resolve', 'reject'] as const)(
		'holds each concurrent late request independently on %s',
		async (outcome) => {
			hermes.spawn(input());
			await drain();
			const callbacks = connection();
			await close();
			const first = Promise.withResolvers<unknown>();
			const second = Promise.withResolvers<unknown>();
			probes.interaction.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
			const a = callbacks.onServerRequest!({ id: 'first', method: 'approval' });
			const b = callbacks.onServerRequest!({ id: 'second', method: 'secret' });
			await blocked();
			first.resolve({ outcome: 'cancelled' });
			await a;
			await drain();
			await blocked();
			if (outcome === 'resolve') {
				second.resolve({ outcome: 'cancelled' });
				await expect(b).resolves.toMatchObject({ kind: 'error', code: -32601 });
			} else {
				const failed = expect(b).rejects.toThrow('late interaction failed');
				second.reject(new Error('late interaction failed'));
				await failed;
				expect(captureException).toHaveBeenCalledWith(
					expect.objectContaining({
						message: 'late interaction failed',
					})
				);
			}
			await drain();
			(await reserve()).release();
		}
	);
	it.each(['steer', 'request'] as const)(
		'blocks an earlier pending reservation while a newly admitted %s is pending',
		async (action) => {
			hermes.spawn(input());
			await drain();
			const managed = processes.get('rpc-session')!;
			const callbacks = connection();
			if (action === 'request') await close();
			const canonical = Promise.withResolvers<string>();
			vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
			const reservation = gate.reserveWorktreeCleanup(target);
			const pending = Promise.withResolvers<unknown>();
			if (action === 'steer') probes.request.mockReturnValueOnce(pending.promise);
			else probes.interaction.mockReturnValueOnce(pending.promise);
			const result =
				action === 'steer'
					? managed.harnessControl!.steer({ id: 'late', text: 'next' })
					: callbacks.onServerRequest!({ id: 'late', method: 'approval' });
			if (action === 'steer') await close();
			canonical.resolve(target);
			expect(await reservation).toMatchObject({ status: 'blocked' });
			pending.resolve(action === 'steer' ? { status: 'queued' } : { outcome: 'cancelled' });
			await result;
			await drain();
			(await reserve()).release();
		}
	);
	it.each(['queued', 'rejected', 'failure'] as const)(
		'holds steering through native close and preserves the %s verdict',
		async (outcome) => {
			hermes.spawn(input());
			await drain();
			const managed = processes.get('rpc-session')!;
			const pending = Promise.withResolvers<unknown>();
			probes.request.mockReturnValueOnce(pending.promise);
			const response = managed.harnessControl!.steer({ id: 'steer', text: 'next' });
			expect(probes.request).toHaveBeenLastCalledWith('session.steer', {
				session_id: 'session',
				text: 'next',
			});
			processes.clear();
			await close();
			await blocked();
			if (outcome === 'failure') pending.reject(new Error('steer failed'));
			else pending.resolve({ status: outcome });
			await expect(response).resolves.toMatchObject({
				id: 'steer',
				verdict: outcome === 'queued' ? 'queued' : outcome === 'failure' ? 'unknown' : 'refused',
			});
			await drain();
			(await reserve()).release();
		}
	);
	it('releases failed late request setup even if diagnostics throw', async () => {
		hermes.spawn(input());
		await drain();
		const callbacks = connection();
		await close();
		vi.mocked(captureException).mockImplementationOnce(() => {
			throw new Error('diagnostic');
		});
		const record = {
			id: 'late',
			get method(): string {
				throw new Error('record failed');
			},
		};
		await expect(callbacks.onServerRequest!(record)).rejects.toThrow('record failed');
		await drain();
		(await reserve()).release();
	});
	it.each([target, path.join(target, 'descendant'), path.resolve('unrelated')])(
		'refuses before gateway/setup/fallback under %s',
		async (root) => {
			const hold = await reserve(root);
			try {
				const unresolved = input();
				Object.defineProperty(unresolved, 'args', {
					get: () => {
						throw new Error('gateway resolution');
					},
				});
				for (const request of [
					unresolved,
					input({ permissionMode: 'readonly' }),
					input({ toolType: 'terminal' }),
					input({ cwd: '/remote', sshRemoteId: 'remote' }),
				])
					expect(hermes.spawn(request)).toMatchObject({
						success: false,
						error: expect.stringContaining('reserved'),
					});
				expect(createOutputParser).not.toHaveBeenCalled();
				expect(planSpawnShell).not.toHaveBeenCalled();
				expect(buildChildProcessEnv).not.toHaveBeenCalled();
				expect(spawn).not.toHaveBeenCalled();
				expect(fallback).not.toHaveBeenCalled();
				expect(stopProcess).not.toHaveBeenCalled();
			} finally {
				hold.release();
			}
		}
	);
	it('blocks a pending reservation and an attempt during shell preparation', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const pending = gate.reserveWorktreeCleanup(target);
		let duringSetup!: Promise<void>;
		vi.mocked(planSpawnShell).mockImplementationOnce((command, args) => {
			duringSetup = blocked();
			return { command, args, shell: false };
		});
		hermes.spawn(input());
		await duringSetup;
		canonical.resolve(target);
		expect(await pending).toMatchObject({ status: 'blocked' });
		await close();
		(await reserve()).release();
	});
	it.each(['session.create', 'session.resume', 'prompt.submit'])(
		'retains pending %s after Stop and native close',
		async (method) => {
			const pending = Promise.withResolvers<unknown>();
			const request = probes.request.getMockImplementation()!;
			probes.request.mockImplementation((name: string, ...args: unknown[]) =>
				name === method ? pending.promise : request(name, ...args)
			);
			hermes.spawn(input({ agentSessionId: method === 'session.resume' ? 'resume' : undefined }));
			await drain();
			await processes.get('rpc-session')!.harnessControl!.interrupt();
			await close();
			await blocked();
			pending.resolve({ session_id: 'session' });
			await drain();
			(await reserve()).release();
			if (method !== 'prompt.submit')
				expect(probes.request).not.toHaveBeenCalledWith('prompt.submit', expect.anything());
			expect(fallback).not.toHaveBeenCalled();
		}
	);
	it.each(['result', 'error', 'exit', 'interrupt', 'kill'])(
		'retains %s without independent close',
		async (event) => {
			hermes.spawn(input());
			await drain();
			const managed = processes.get('rpc-session')!;
			if (event === 'result') notify('message.complete', { status: 'completed', output: 'done' });
			if (event === 'error') native.emit('error', new Error('native failed'));
			if (event === 'exit') native.emit('exit', 0, null);
			if (event === 'interrupt') await managed.sdkController!.interrupt();
			if (event === 'kill') await managed.sdkController!.kill();
			await drain();
			processes.clear();
			await blocked();
			await close();
			(await reserve()).release();
		}
	);
	it('retains completion-state query after native close and reporting settlement', async () => {
		hermes.spawn(input());
		await drain();
		const state = Promise.withResolvers<unknown>();
		probes.request.mockReturnValueOnce(state.promise);
		notify('message.complete', { output: 'done' });
		await close();
		await blocked();
		state.reject(new Error('4007 not found'));
		await drain();
		(await reserve()).release();
	});
	it.each(['steer', 'interrupt', 'kill'])(
		'retains pending %s RPC after close',
		async (operation) => {
			hermes.spawn(input());
			await drain();
			const pending = Promise.withResolvers<unknown>();
			probes.request.mockReturnValueOnce(pending.promise);
			const managed = processes.get('rpc-session')!;
			const control =
				operation === 'steer'
					? managed.harnessControl!.steer({ id: 'steer', text: 'next' })
					: operation === 'kill'
						? managed.sdkController!.kill()
						: managed.harnessControl!.interrupt();
			await close();
			await blocked();
			pending.reject(new Error('control failed'));
			await control;
			await drain();
			(await reserve()).release();
		}
	);
	it('holds gateway acknowledgement, permission response and reporting independently', async () => {
		hermes.spawn(input());
		await drain();
		const ack = Promise.withResolvers<unknown>();
		const interaction = Promise.withResolvers<unknown>();
		const reply = Promise.withResolvers<unknown>();
		const reporting = Promise.withResolvers<void>();
		probes.request.mockReturnValueOnce(ack.promise).mockReturnValueOnce(reply.promise);
		probes.interaction.mockReturnValueOnce(interaction.promise);
		probes.exit.mockReturnValueOnce(reporting.promise);
		notify('approval.request', { request_id: 'approval' });
		await close();
		await blocked();
		interaction.resolve({ outcome: 'selected', optionId: 'once' });
		await drain();
		expect(probes.request).toHaveBeenCalledWith(
			'approval.respond',
			expect.objectContaining({ choice: 'once' })
		);
		reply.resolve({});
		reporting.reject(new Error('report failed'));
		await drain();
		await blocked();
		ack.reject(new Error('ack failed'));
		await drain();
		(await reserve()).release();
	});
	it.each(['direct', 'notification', 'resume-approval', 'resume-clarify'])(
		'retains %s interaction beyond close through callback or gateway reply',
		async (mode) => {
			const interaction = Promise.withResolvers<unknown>();
			const reply = Promise.withResolvers<unknown>();
			probes.interaction.mockReturnValueOnce(interaction.promise);
			if (mode.startsWith('resume'))
				probes.request.mockResolvedValueOnce({
					session_id: 'session',
					[mode === 'resume-approval' ? 'pending_approval' : 'pending_clarify']: {
						request_id: 'permission',
					},
				});
			hermes.spawn(input({ agentSessionId: mode.startsWith('resume') ? 'resume' : undefined }));
			await drain();
			const response =
				mode === 'direct'
					? connection().onServerRequest!({ id: 'permission', method: 'approval', params: {} })
					: undefined;
			if (mode === 'notification') notify('secret.request', { request_id: 'permission' });
			await close();
			await blocked();
			if (mode !== 'direct') probes.request.mockReturnValueOnce(reply.promise);
			interaction.resolve({ outcome: 'answers', answers: { answer: 'fixture' } });
			await response;
			await drain();
			if (mode !== 'direct') {
				await blocked();
				reply.reject(new Error('reply failed'));
			}
			await drain();
			(await reserve()).release();
		}
	);
	it.each(['gateway', 'parser', 'shell', 'env', 'nonstart'])(
		'releases proven pre-native %s failure without recovery',
		async (failure) => {
			const fail = () => {
				throw new Error('setup failed');
			};
			const request = input();
			if (failure === 'gateway') Object.defineProperty(request, 'args', { get: fail });
			if (failure === 'parser') vi.mocked(createOutputParser).mockImplementationOnce(fail);
			if (failure === 'shell') vi.mocked(planSpawnShell).mockImplementationOnce(fail);
			if (failure === 'env') vi.mocked(buildChildProcessEnv).mockImplementationOnce(fail);
			if (failure === 'nonstart') vi.mocked(spawn).mockImplementationOnce(fail);
			expect(hermes.spawn(request).success).toBe(false);
			expect(fallback).not.toHaveBeenCalled();
			(await reserve()).release();
		}
	);
	it.each(['lost-handle', 'observer'])(
		'keeps uncertain %s native state blocked',
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
			expect(hermes.spawn(input()).success).toBe(false);
			await close();
			await blocked();
		}
	);
	it('retains superseded/unregistered generations and a failed registration child', async () => {
		hermes.spawn(input());
		await drain();
		const old = native;
		native = makeNative();
		hermes.spawn(input());
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
		expect(hermes.spawn(input()).success).toBe(false);
		await blocked();
		await close();
		(await reserve()).release();
	});
	it('composes failed asynchronous setup with independently admitted CLI fallback', async () => {
		const pending = Promise.withResolvers<unknown>();
		probes.request.mockReturnValueOnce(pending.promise);
		let releaseFallback!: () => void;
		fallback.mockImplementationOnce(() => {
			releaseFallback = gate.beginGlobalWorktreeActivity();
			return { success: true, pid: 999 };
		});
		hermes.spawn(input({ permissionMode: 'full' }));
		pending.reject(new Error('create failed'));
		await drain();
		expect(fallback).toHaveBeenCalledWith(input({ permissionMode: 'full' }));
		await close();
		await blocked();
		releaseFallback();
		(await reserve()).release();
	});
	it('releases failed direct fallback without starting a child', async () => {
		fallback.mockImplementationOnce(() => {
			throw new Error('fallback failed');
		});
		expect(hermes.spawn(input({ permissionMode: 'readonly' })).success).toBe(false);
		expect(fallback).toHaveBeenCalledOnce();
		expect(spawn).not.toHaveBeenCalled();
		(await reserve()).release();
	});
	it('retains missing-pid error through close and pending creation settlement', async () => {
		Object.assign(native, { pid: undefined });
		const pending = Promise.withResolvers<unknown>();
		probes.request.mockReturnValueOnce(pending.promise);
		expect(hermes.spawn(input())).toMatchObject({ success: true, pid: -1 });
		native.emit('error', new Error('spawn failed'));
		await close();
		await blocked();
		pending.reject(new Error('creation failed'));
		await drain();
		(await reserve()).release();
	});
	it('retains failed registration and synchronous CLI fallback independently', async () => {
		vi.spyOn(processes, 'set').mockImplementationOnce(() => {
			throw new Error('registration failed');
		});
		let releaseFallback!: () => void;
		fallback.mockImplementationOnce(() => {
			releaseFallback = gate.beginGlobalWorktreeActivity();
			return { success: true, pid: 999 };
		});
		expect(hermes.spawn(input({ permissionMode: 'full' })).success).toBe(true);
		await close();
		await blocked();
		releaseFallback();
		(await reserve()).release();
	});
	it('contains failed permission and throwing child-exit callbacks until close', async () => {
		hermes.spawn(input());
		await drain();
		probes.interaction.mockRejectedValueOnce(new Error('permission failed'));
		await expect(
			connection().onServerRequest!({ id: 'permission', method: 'approval' })
		).rejects.toThrow('permission failed');
		probes.close.mockImplementationOnce(() => {
			throw new Error('exit failed');
		});
		native.emit('error', new Error('native failed'));
		await drain();
		await blocked();
		await close();
		(await reserve()).release();
	});
	it.each(['resolve', 'reject', 'throw'] as const)(
		'owns async Hermes setup diagnostics on %s and preserves CLI fallback',
		async (outcome) => {
			const failure = new Error('Hermes setup failed');
			const reporting = Promise.withResolvers<void>();
			vi.mocked(planSpawnShell).mockImplementationOnce(() => {
				throw failure;
			});
			vi.mocked(captureException).mockImplementationOnce(() => {
				if (outcome === 'throw') throw new Error('report failed');
				return reporting.promise;
			});
			expect(hermes.spawn(input({ permissionMode: 'full' }))).toEqual({ success: true, pid: 999 });
			expect(fallback).toHaveBeenCalledOnce();
			expect(spawn).not.toHaveBeenCalled();
			await drain();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			if (outcome !== 'throw') {
				await blocked();
				if (outcome === 'resolve') reporting.resolve();
				else reporting.reject(new Error('report failed'));
				await drain();
			}
			expect(captureException).toHaveBeenCalledOnce();
			(await reserve()).release();
		}
	);
	it.each([false, true])(
		'owns async Hermes outer diagnostics despite logger failure: %s',
		async (loggerFails) => {
			const failure = new Error('fallback failed');
			const reporting = Promise.withResolvers<void>();
			fallback.mockImplementationOnce(() => {
				throw failure;
			});
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			if (loggerFails)
				vi.mocked(logger.error).mockImplementationOnce(() => {
					throw new Error('logger');
				});
			expect(hermes.spawn(input({ permissionMode: 'readonly' }))).toEqual({
				success: false,
				pid: -1,
				error: String(failure),
			});
			await drain();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			await blocked();
			reporting.reject(new Error('report failed'));
			await drain();
			expect(captureException).toHaveBeenCalledOnce();
			(await reserve()).release();
		}
	);
	it.each([false, true])(
		'owns async Hermes run diagnostics independently of native close (report first: %s)',
		async (reportFirst) => {
			const failure = new Error('session creation failed');
			const reporting = Promise.withResolvers<void>();
			probes.request.mockRejectedValueOnce(failure);
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			expect(hermes.spawn(input()).success).toBe(true);
			await drain();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			expect(probes.exit).toHaveBeenCalledOnce();
			expect(probes.exit.mock.calls[0][1]).toBe(1);
			if (reportFirst) reporting.resolve();
			else await close();
			await drain();
			await blocked();
			if (reportFirst) await close();
			else reporting.reject(new Error('report failed'));
			await drain();
			expect(captureException).toHaveBeenCalledOnce();
			(await reserve()).release();
		}
	);
	it.each([false, true])(
		'owns async Hermes native completion diagnostics despite logger failure: %s',
		async (loggerFails) => {
			hermes.spawn(input());
			await drain();
			const failure = new Error('connection close failed');
			const reporting = Promise.withResolvers<void>();
			probes.close.mockImplementationOnce(() => {
				throw failure;
			});
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			if (loggerFails)
				vi.mocked(logger.error).mockImplementationOnce(() => {
					throw new Error('logger');
				});
			await close();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			await blocked();
			reporting.reject(new Error('report failed'));
			await drain();
			expect(captureException).toHaveBeenCalledOnce();
			(await reserve()).release();
		}
	);
	it.each(['notification', 'request', 'steer', 'interrupt', 'kill'] as const)(
		'owns async Hermes late %s diagnostics across pending reservation and successor activity',
		async (action) => {
			hermes.spawn(input());
			await drain();
			const managed = processes.get('rpc-session')!;
			const callbacks = connection();
			await close();
			const canonical = Promise.withResolvers<string>();
			vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
			const reservation = gate.reserveWorktreeCleanup(target);
			const failure = new Error('Hermes callback failed');
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			if (action === 'notification') {
				callbacks.onNotification!({
					get method(): never {
						throw failure;
					},
				});
			} else if (action === 'request') {
				await expect(
					callbacks.onServerRequest!({
						get method(): never {
							throw failure;
						},
					})
				).rejects.toBe(failure);
			} else if (action === 'steer') {
				await expect(
					managed.harnessControl!.steer({
						get id(): never {
							throw failure;
						},
						text: 'late',
					})
				).rejects.toBe(failure);
			} else {
				vi.mocked(stopProcess).mockImplementationOnce(() => {
					throw failure;
				});
				await expect(managed.sdkController![action]()).rejects.toBe(failure);
			}
			canonical.resolve(target);
			expect(await reservation).toMatchObject({ status: 'blocked' });
			await drain();
			expect(captureException).toHaveBeenCalledWith(failure);
			const reports = vi.mocked(captureException).mock.calls.length;
			await blocked();
			processes.clear();
			const successor = Promise.withResolvers<void>();
			boundary.withWorktreeTurnActivity((_start, observe) => observe(successor.promise), vi.fn());
			reporting.reject(new Error('report failed'));
			await drain();
			await blocked();
			successor.resolve();
			await drain();
			expect(captureException).toHaveBeenCalledTimes(reports);
			(await reserve()).release();
		}
	);
	it.each(['resolve', 'reject', 'throw'] as const)(
		'preserves Hermes run failure and exit when its diagnostic reporter will %s',
		async (outcome) => {
			const failure = new Error('session failed');
			const reporting = Promise.withResolvers<void>();
			probes.request.mockRejectedValueOnce(failure);
			vi.mocked(captureException).mockImplementationOnce(() => {
				if (outcome === 'throw') throw new Error('report failed');
				return reporting.promise;
			});
			hermes.spawn(input());
			await drain();
			expect(probes.exit).toHaveBeenCalledOnce();
			expect(probes.exit.mock.calls[0][1]).toBe(1);
			await close();
			if (outcome !== 'throw') {
				await blocked();
				if (outcome === 'resolve') reporting.resolve();
				else reporting.reject(new Error('report failed'));
				await drain();
			}
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			(await reserve()).release();
		}
	);
	it.each(['resolve', 'reject', 'throw'] as const)(
		'owns async Hermes gateway diagnostics until reporters %s',
		async (outcome) => {
			hermes.spawn(input());
			await drain();
			const callbacks = connection();
			await close();
			const failure = new Error('gateway params failed');
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockImplementationOnce(() => {
				if (outcome === 'throw') throw new Error('report failed');
				return reporting.promise;
			});
			callbacks.onNotification!({
				method: 'approval.request',
				params: {
					get request_id(): never {
						throw failure;
					},
				},
			});
			await drain();
			expect(captureException).toHaveBeenCalledWith(failure);
			const reports = vi.mocked(captureException).mock.calls.length;
			if (outcome !== 'throw') {
				await blocked();
				if (outcome === 'resolve') reporting.resolve();
				else reporting.reject(new Error('report failed'));
				await drain();
			}
			expect(captureException).toHaveBeenCalledTimes(reports);
			(await reserve()).release();
		}
	);
	it('owns async Hermes exit diagnostics when exit logging throws after native close', async () => {
		hermes.spawn(input());
		await drain();
		const failure = new Error('exit logger failed');
		const reporting = Promise.withResolvers<void>();
		probes.exit.mockRejectedValueOnce(new Error('exit failed'));
		vi.mocked(logger.error).mockImplementationOnce(() => {
			throw failure;
		});
		vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
		await close();
		expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
		await blocked();
		reporting.reject(new Error('report failed'));
		await drain();
		expect(captureException).toHaveBeenCalledOnce();
		(await reserve()).release();
	});
	it('refuses Hermes setup before lookup, recovery and async reporting under reservation', async () => {
		const hold = await reserve(path.join(target, 'descendant'));
		const lookup = vi.fn(() => 'hermes' as const);
		const request = Object.defineProperty(input(), 'toolType', { get: lookup });
		vi.mocked(captureException).mockReturnValue(Promise.resolve());
		try {
			expect(hermes.spawn(request).success).toBe(false);
			expect(lookup).not.toHaveBeenCalled();
			expect(fallback).not.toHaveBeenCalled();
			expect(captureException).not.toHaveBeenCalled();
		} finally {
			hold.release();
		}
	});
});

describe('Claude SDK native activity', () => {
	let claude: import('../../../main/process-manager/spawners/ClaudeSdkSpawner').ClaudeSdkSpawner;
	let input: ProcessConfig;
	let next: ReturnType<typeof Promise.withResolvers<IteratorResult<SDKMessage>>>;
	let sdk: Query;
	const signal = new AbortController().signal;
	beforeEach(async () => {
		const { ClaudeSdkSpawner } =
			await import('../../../main/process-manager/spawners/ClaudeSdkSpawner');
		claude = new ClaudeSdkSpawner(processes, new EventEmitter(), {} as DataBufferManager, fallback);
		input = config({ toolType: 'claude-code', harnessControlMode: 'native' });
		next = Promise.withResolvers<IteratorResult<SDKMessage>>();
		sdk = {
			[Symbol.asyncIterator]: () => ({ next: () => next.promise }),
			interrupt: vi.fn().mockResolvedValue(undefined),
			close: vi.fn(),
		} as unknown as Query;
		native.on('error', vi.fn());
		probes.query.mockImplementation(({ options }) => {
			options!.spawnClaudeCodeProcess!({
				command: 'sdk-command',
				args: ['sdk-arg'],
				cwd: target,
				env: { SDK_ENV: 'sdk-env' },
				signal,
			});
			return sdk;
		});
	});
	it.each(['setup', 'stream', 'completion', 'control', 'stderr'] as const)(
		'owns async Claude %s diagnostics until settlement',
		async (stage) => {
			const failure = new Error('diagnostic trigger');
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			if (stage === 'setup') {
				vi.mocked(createOutputParser).mockImplementationOnce(() => {
					throw failure;
				});
				expect(claude.spawn({ ...input, permissionMode: 'full' })).toMatchObject({
					success: true,
					pid: 999,
				});
				expect(fallback).toHaveBeenCalledOnce();
			} else {
				if (stage === 'completion') probes.exit.mockRejectedValueOnce(failure);
				claude.spawn(input);
				const managed = processes.get(input.sessionId)!;
				if (stage === 'stream') next.reject(failure);
				else next.resolve({ done: true, value: undefined });
				await close();
				processes.clear();
				if (stage === 'control') {
					vi.mocked(sdk.close).mockImplementationOnce(() => {
						throw failure;
					});
					await expect(managed.sdkController!.kill()).rejects.toBe(failure);
				} else if (stage === 'stderr') {
					probes.stderr.mockImplementationOnce(() => {
						throw failure;
					});
					expect(() => native.stderr.emit('data', 'late failure')).toThrow(failure);
				}
			}
			await drain();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			await blocked();
			reporting.resolve();
			await drain();
			(await reserve()).release();
		}
	);
	it.each(['setup', 'stream', 'completion', 'control', 'stderr'] as const)(
		'owns async Claude %s reporter rejection without recursion',
		async (stage) => {
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			const fail = () => {
				throw new Error('original');
			};
			if (stage === 'setup') {
				vi.mocked(createOutputParser).mockImplementationOnce(fail);
				claude.spawn({ ...input, permissionMode: 'full' });
			} else {
				if (stage === 'completion') probes.exit.mockRejectedValueOnce(new Error('original'));
				claude.spawn(input);
				const control = processes.get(input.sessionId)!.harnessControl!;
				if (stage === 'stream') next.reject(new Error('original'));
				else next.resolve({ done: true, value: undefined });
				await close();
				if (stage === 'control') {
					vi.mocked(sdk.close).mockImplementationOnce(fail);
					await expect(control.close()).rejects.toThrow('original');
				} else if (stage === 'stderr') {
					probes.stderr.mockImplementationOnce(fail);
					expect(() => native.stderr.emit('data', 'failure')).toThrow('original');
				}
			}
			await drain();
			await blocked();
			reporting.reject(new Error('diagnostics rejected'));
			await drain();
			expect(captureException).toHaveBeenCalledOnce();
			(await reserve()).release();
		}
	);
	it('owns async Claude reporting despite synchronous logger failure', async () => {
		const reporting = Promise.withResolvers<void>();
		vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
		probes.exit.mockRejectedValueOnce(new Error('completion'));
		vi.mocked(logger.error).mockImplementation(() => {
			throw new Error('logger');
		});
		claude.spawn(input);
		next.resolve({ done: true, value: undefined });
		await close();
		await blocked();
		reporting.resolve();
		await drain();
		(await reserve()).release();
	});
	it.each([target, path.join(target, 'nested'), path.resolve('unrelated')])(
		'refuses every setup and fallback under reservation %s',
		async (root) => {
			const hold = await reserve(root);
			try {
				for (const overrides of [{}, { harnessControlMode: undefined }, { cwd: '/remote' }])
					expect(claude.spawn({ ...input, ...overrides })).toMatchObject({
						success: false,
						error: expect.stringContaining('reserved'),
					});
				for (const probe of [
					createOutputParser,
					buildChildProcessEnv,
					captureException,
					logger.error,
					probes.query,
					spawn,
					fallback,
				])
					expect(probe).not.toHaveBeenCalled();
				expect(processes.size).toBe(0);
			} finally {
				hold.release();
			}
		}
	);
	it('admission precedes pending canonicalization and environment setup', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const pending = gate.reserveWorktreeCleanup(target);
		let duringSetup!: Promise<void>;
		vi.mocked(buildChildProcessEnv).mockImplementationOnce(() => {
			duringSetup = blocked();
			return {};
		});
		expect(claude.spawn(input).success).toBe(true);
		canonical.resolve(target);
		expect(await pending).toMatchObject({ status: 'blocked' });
		await duringSetup;
		next.resolve({ done: true, value: undefined });
		await drain();
		await blocked();
		await close();
		(await reserve()).release();
	});
	it('preserves SDK native options and stderr without a second stdout reader', async () => {
		claude.spawn(input);
		expect(spawn).toHaveBeenCalledWith('sdk-command', ['sdk-arg'], {
			cwd: target,
			env: { SDK_ENV: 'sdk-env' },
			signal,
			windowsHide: true,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		expect(native.stdout.listenerCount('data')).toBe(0);
		native.stderr.emit('data', 'diagnostic');
		expect(probes.stderr).toHaveBeenCalledWith(input.sessionId, 'diagnostic');
		next.resolve({ done: true, value: undefined });
		await close();
		(await reserve()).release();
	});
	it.each(['exit', 'error', 'interrupt', 'kill', 'result'])(
		'%s does not prove independent child close',
		async (event) => {
			claude.spawn(input);
			const managed = processes.get(input.sessionId)!;
			if (event === 'exit') native.emit('exit', 0, null);
			if (event === 'error') native.emit('error', new Error('native error'));
			if (event === 'interrupt') await managed.sdkController!.interrupt();
			if (event === 'kill') await managed.sdkController!.kill();
			if (event === 'result') {
				const result = next;
				next = Promise.withResolvers<IteratorResult<SDKMessage>>();
				result.resolve({
					done: false,
					value: { type: 'result', subtype: 'success', result: 'fixture' } as SDKMessage,
				});
				await drain();
			}
			next.resolve({ done: true, value: undefined });
			await drain();
			await blocked();
			await close();
			(await reserve()).release();
		}
	);
	it('holds pending query iteration after Stop, unregister and native close', async () => {
		claude.spawn(input);
		await processes.get(input.sessionId)!.sdkController!.interrupt();
		processes.clear();
		await close();
		await blocked();
		next.resolve({ done: true, value: undefined });
		await drain();
		(await reserve()).release();
	});
	it.each(['interrupt', 'close'] as const)(
		'tracks harness %s completion and failure after query and child close',
		async (method) => {
			const pending = Promise.withResolvers<Awaited<ReturnType<Query['interrupt']>>>();
			if (method === 'interrupt') vi.mocked(sdk.interrupt).mockReturnValueOnce(pending.promise);
			else
				vi.mocked(sdk.close).mockImplementationOnce(() => {
					throw new Error('close failure');
				});
			claude.spawn(input);
			const control = processes.get(input.sessionId)!.harnessControl!;
			if (method === 'close') {
				await expect(control.close()).rejects.toThrow('close failure');
			} else {
				const completion = control.interrupt();
				next.resolve({ done: true, value: undefined });
				await close();
				await blocked();
				pending.reject(new Error('interrupt failure'));
				await completion;
			}
			next.resolve({ done: true, value: undefined });
			await close();
			(await reserve()).release();
		}
	);
	it.each([target, path.join(target, 'descendant'), path.resolve('unrelated')])(
		'refuses retained Claude controls before query, queue or recovery under %s',
		async (root) => {
			claude.spawn(input);
			const managed = processes.get(input.sessionId)!;
			next.resolve({ done: true, value: undefined });
			await close();
			processes.clear();
			const hold = await reserve(root);
			for (const probe of [
				sdk.interrupt,
				sdk.close,
				captureException,
				fallback,
				spawn,
				fs.realpath,
			])
				vi.mocked(probe).mockClear();
			try {
				await expect(managed.sdkController!.interrupt()).rejects.toThrow('reserved');
				await expect(managed.sdkController!.kill()).rejects.toThrow('reserved');
				await expect(managed.harnessControl!.interrupt()).rejects.toThrow('reserved');
				await expect(managed.harnessControl!.close()).rejects.toThrow('reserved');
				await expect(
					managed.harnessControl!.steer({ id: 'late', text: 'follow up' })
				).rejects.toThrow('reserved');
				for (const probe of [
					sdk.interrupt,
					sdk.close,
					captureException,
					fallback,
					spawn,
					fs.realpath,
				])
					expect(probe).not.toHaveBeenCalled();
			} finally {
				hold.release();
			}
		}
	);
	it.each([
		['sdk', false],
		['sdk', true],
		['harness', false],
		['harness', true],
	] as const)(
		'owns retained Claude %s interrupt after original settlement (rejected: %s)',
		async (entry, rejected) => {
			claude.spawn(input);
			const managed = processes.get(input.sessionId)!;
			next.resolve({ done: true, value: undefined });
			await close();
			processes.clear();
			(await reserve()).release();
			const pending = Promise.withResolvers<Awaited<ReturnType<Query['interrupt']>>>();
			vi.mocked(sdk.interrupt).mockReturnValueOnce(pending.promise);
			vi.mocked(sdk.close).mockClear();
			const completion =
				entry === 'sdk' ? managed.sdkController!.interrupt() : managed.harnessControl!.interrupt();
			expect(completion).toBeInstanceOf(Promise);
			await blocked();
			expect(sdk.close).not.toHaveBeenCalled();
			if (rejected) pending.reject(new Error('interrupt transport failed'));
			else pending.resolve(undefined);
			await expect(completion).resolves.toBeUndefined();
			expect(sdk.close).toHaveBeenCalledOnce();
			await drain();
			(await reserve()).release();
		}
	);
	it.each(['sdk', 'harness'] as const)(
		'preserves retained Claude %s close failures after original settlement',
		async (entry) => {
			claude.spawn(input);
			const managed = processes.get(input.sessionId)!;
			next.resolve({ done: true, value: undefined });
			await close();
			processes.clear();
			const error = new Error('close threw');
			vi.mocked(sdk.close).mockImplementationOnce(() => {
				throw error;
			});
			vi.mocked(captureException).mockImplementationOnce(() => {
				throw new Error('diagnostics failed');
			});
			const completion =
				entry === 'sdk' ? managed.sdkController!.kill() : managed.harnessControl!.close();
			await expect(completion).rejects.toBe(error);
			await drain();
			expect(captureException).toHaveBeenCalledWith(error);
			(await reserve()).release();
		}
	);
	it('observes ignored Claude SDK close failure after original settlement', async () => {
		claude.spawn(input);
		const managed = processes.get(input.sessionId)!;
		next.resolve({ done: true, value: undefined });
		await close();
		processes.clear();
		const error = new Error('ignored SDK close failed');
		vi.mocked(sdk.close).mockImplementationOnce(() => {
			throw error;
		});
		void managed.sdkController!.kill();
		await drain();
		expect(captureException).toHaveBeenCalledWith(error);
		(await reserve()).release();
	});
	it('retains concurrent Claude controls independently of replacement and native close', async () => {
		claude.spawn(input);
		const managed = processes.get(input.sessionId)!;
		next.resolve({ done: true, value: undefined });
		await close();
		const first = Promise.withResolvers<Awaited<ReturnType<Query['interrupt']>>>();
		const last = Promise.withResolvers<Awaited<ReturnType<Query['interrupt']>>>();
		vi.mocked(sdk.interrupt).mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
		const firstControl = managed.sdkController!.interrupt();
		const lastControl = managed.harnessControl!.interrupt();
		native = makeNative();
		next = Promise.withResolvers<IteratorResult<SDKMessage>>();
		expect(claude.spawn(input).success).toBe(true);
		processes.clear();
		next.resolve({ done: true, value: undefined });
		await close();
		await blocked();
		last.reject(new Error('second interrupt failed'));
		await lastControl;
		await drain();
		await blocked();
		first.resolve(undefined);
		await firstControl;
		await drain();
		(await reserve()).release();
	});
	it('admits retained Claude interrupt before an earlier pending reservation resolves', async () => {
		claude.spawn(input);
		const managed = processes.get(input.sessionId)!;
		next.resolve({ done: true, value: undefined });
		await close();
		processes.clear();
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const reservation = gate.reserveWorktreeCleanup(target);
		const pending = Promise.withResolvers<Awaited<ReturnType<Query['interrupt']>>>();
		vi.mocked(sdk.interrupt).mockReturnValueOnce(pending.promise);
		const completion = managed.sdkController!.interrupt();
		canonical.resolve(target);
		expect(await reservation).toMatchObject({ status: 'blocked' });
		await blocked();
		pending.resolve(undefined);
		await completion;
		await drain();
		(await reserve()).release();
	});
	it('preserves Claude follow-up queueing and the finished steering verdict', async () => {
		claude.spawn(input);
		const managed = processes.get(input.sessionId)!;
		const prompt = probes.query.mock.calls[0][0].prompt;
		if (typeof prompt === 'string') throw new Error('Expected streaming input');
		const messages = prompt[Symbol.asyncIterator]();
		await messages.next();
		const waiting = messages.next();
		await expect(
			managed.harnessControl!.steer({ id: 'follow-up', text: 'continue' })
		).resolves.toEqual({
			type: 'steering',
			id: 'follow-up',
			verdict: 'queued',
		});
		expect((await waiting).value).toMatchObject({ message: { role: 'user', content: 'continue' } });
		next.resolve({ done: true, value: undefined });
		await close();
		processes.clear();
		await expect(
			managed.harnessControl!.steer({ id: 'late', text: 'continue' })
		).resolves.toMatchObject({
			type: 'steering',
			id: 'late',
			verdict: 'refused',
			refusal: 'not-running',
		});
		await drain();
		(await reserve()).release();
	});
	it.each([target, path.join(target, 'descendant'), path.resolve('unrelated')])(
		'refuses retained Claude callbacks before lookup or recovery under %s',
		async (root) => {
			claude.spawn(input);
			const managed = processes.get(input.sessionId)!;
			const { prompt, options } = probes.query.mock.calls[0][0];
			if (typeof prompt === 'string') throw new Error('Expected streaming input');
			const messages = prompt[Symbol.asyncIterator]();
			next.resolve({ done: true, value: undefined });
			await close();
			processes.clear();
			const hold = await reserve(root);
			const lookup = vi.fn(() => {
				throw new Error('lookup before admission');
			});
			Object.defineProperty(input, 'prompt', { get: lookup });
			Object.defineProperty(managed, 'spawnGeneration', { get: lookup });
			const permissionOptions = {
				get signal() {
					return lookup();
				},
			};
			vi.mocked(captureException).mockClear();
			probes.stderr.mockClear();
			try {
				await expect(options!.canUseTool!('Bash', {}, permissionOptions as never)).rejects.toThrow(
					'reserved'
				);
				await expect(messages.next()).rejects.toThrow('reserved');
				await expect(messages.return!()).rejects.toThrow('reserved');
				await expect(messages.throw!(new Error('input throw'))).rejects.toThrow('reserved');
				expect(() => native.stderr.emit('data', 'late diagnostic')).toThrow('reserved');
				expect(lookup).not.toHaveBeenCalled();
				expect(probes.interaction).not.toHaveBeenCalled();
				expect(probes.stderr).not.toHaveBeenCalled();
				expect(captureException).not.toHaveBeenCalled();
				expect(fallback).not.toHaveBeenCalled();
			} finally {
				hold.release();
			}
		}
	);
	it.each(['standard', 'full', 'readonly'] as const)(
		'preserves late Claude %s permission decisions and refuses policy lookup under reservation',
		async (permissionMode) => {
			claude.spawn({ ...input, permissionMode });
			const approve = probes.query.mock.calls[0][0].options!.canUseTool!;
			next.resolve({ done: true, value: undefined });
			await close();
			probes.interaction.mockResolvedValue({ outcome: 'selected', optionId: 'allow' });
			const opts = { signal, toolUseID: 'tool', requestId: 'request' };
			await expect(approve('Read', {}, opts)).resolves.toMatchObject({ behavior: 'allow' });
			await expect(approve('Bash', {}, opts)).resolves.toMatchObject({
				behavior: permissionMode === 'readonly' ? 'deny' : 'allow',
			});
			const hold = await reserve();
			try {
				await expect(approve('Read', {}, opts)).rejects.toThrow('reserved');
			} finally {
				hold.release();
			}
		}
	);
	it.each([false, true])(
		'owns parallel late Claude permissions through replacement (rejected: %s)',
		async (rejected) => {
			claude.spawn(input);
			const approve = probes.query.mock.calls[0][0].options!.canUseTool!;
			next.resolve({ done: true, value: undefined });
			await close();
			processes.clear();
			const first = Promise.withResolvers<unknown>();
			const last = Promise.withResolvers<unknown>();
			probes.interaction.mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
			const opts = { signal, toolUseID: 'tool', requestId: 'request' };
			const firstDecision = approve('Bash', { command: 'fixture' }, opts);
			const lastDecision = approve('Read', {}, opts);
			await blocked();
			native = makeNative();
			next = Promise.withResolvers<IteratorResult<SDKMessage>>();
			claude.spawn(input);
			processes.clear();
			next.resolve({ done: true, value: undefined });
			await close();
			last.resolve({ outcome: 'cancelled' });
			await expect(lastDecision).resolves.toMatchObject({ behavior: 'deny' });
			await drain();
			await blocked();
			if (rejected) {
				const error = new Error('late permission failed');
				const checked = expect(firstDecision).rejects.toBe(error);
				first.reject(error);
				await checked;
				expect(captureException).toHaveBeenCalledWith(error);
			} else {
				first.resolve({ outcome: 'selected', optionId: 'allow' });
				await expect(firstDecision).resolves.toMatchObject({ behavior: 'allow' });
			}
			await drain();
			(await reserve()).release();
		}
	);
	it('admits a late Claude permission before pending reservation canonicalization', async () => {
		claude.spawn(input);
		const approve = probes.query.mock.calls[0][0].options!.canUseTool!;
		next.resolve({ done: true, value: undefined });
		await close();
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const reservation = gate.reserveWorktreeCleanup(target);
		const permission = Promise.withResolvers<unknown>();
		probes.interaction.mockReturnValueOnce(permission.promise);
		const decision = approve('Bash', {}, { signal, toolUseID: 'tool', requestId: 'request' });
		canonical.resolve(target);
		expect(await reservation).toMatchObject({ status: 'blocked' });
		await blocked();
		permission.resolve({ outcome: 'selected', optionId: 'allow' });
		await decision;
		await drain();
		(await reserve()).release();
	});
	it.each([false, true])(
		'owns late Claude input return/queued calls (rejected: %s)',
		async (rejected) => {
			claude.spawn(input);
			const prompt = probes.query.mock.calls[0][0].prompt;
			if (typeof prompt === 'string') throw new Error('Expected streaming input');
			const messages = prompt[Symbol.asyncIterator]();
			next.resolve({ done: true, value: undefined });
			await close();
			processes.clear();
			const returning = Promise.withResolvers<undefined>();
			const result = messages.return!(returning.promise);
			const queued = messages.next();
			const error = new Error('queued input throw');
			const thrown = expect(messages.throw!(error)).rejects.toBe(error);
			const checked = rejected
				? expect(result).rejects.toThrow('return failed')
				: expect(result).resolves.toMatchObject({ done: true });
			await blocked();
			native = makeNative();
			next = Promise.withResolvers<IteratorResult<SDKMessage>>();
			claude.spawn(input);
			processes.clear();
			next.resolve({ done: true, value: undefined });
			await close();
			await blocked();
			if (rejected) returning.reject(new Error('return failed'));
			else returning.resolve(undefined);
			await checked;
			await expect(queued).resolves.toMatchObject({ done: true });
			await thrown;
			await drain();
			(await reserve()).release();
		}
	);
	it('preserves admitted late Claude input order and question mapping', async () => {
		claude.spawn(input);
		const { prompt, options } = probes.query.mock.calls[0][0];
		if (typeof prompt === 'string') throw new Error('Expected streaming input');
		const messages = prompt[Symbol.asyncIterator]();
		next.resolve({ done: true, value: undefined });
		await close();
		await expect(messages.next()).resolves.toMatchObject({
			value: { message: { content: 'fixture' } },
		});
		await expect(messages.next()).resolves.toMatchObject({ done: true });
		probes.interaction.mockResolvedValueOnce({
			outcome: 'answers',
			answers: { 'question-0': ['Yes'] },
		});
		await expect(
			options!.canUseTool!(
				'AskUserQuestion',
				{
					questions: [
						{
							question: 'Continue?',
							header: 'Next',
							options: [{ label: 'Yes', description: 'Continue' }],
						},
					],
				},
				{ signal, toolUseID: 'tool', requestId: 'request' }
			)
		).resolves.toMatchObject({ behavior: 'deny', message: expect.stringContaining('Yes') });
		const aborted = new AbortController();
		aborted.abort();
		await expect(
			options!.canUseTool!(
				'Bash',
				{},
				{ signal: aborted.signal, toolUseID: 'tool', requestId: 'request' }
			)
		).resolves.toMatchObject({ behavior: 'deny', message: 'Permission request was interrupted.' });
		await drain();
		(await reserve()).release();
	});
	it.each(['input', 'permission'] as const)(
		'observes late Claude %s lookup failures even when diagnostics fail',
		async (kind) => {
			claude.spawn(input);
			const { prompt, options } = probes.query.mock.calls[0][0];
			if (typeof prompt === 'string') throw new Error('Expected streaming input');
			const messages = prompt[Symbol.asyncIterator]();
			next.resolve({ done: true, value: undefined });
			await close();
			processes.clear();
			const error = new Error('late lookup failed');
			const lookup = () => {
				throw error;
			};
			Object.defineProperty(input, 'prompt', { get: lookup });
			vi.mocked(captureException).mockImplementationOnce(() => {
				throw new Error('diagnostics failed');
			});
			const pending =
				kind === 'input'
					? messages.next()
					: options!.canUseTool!('Bash', {}, {
							get signal() {
								return lookup();
							},
						} as never);
			await expect(pending).rejects.toBe(error);
			await drain();
			expect(captureException).toHaveBeenCalledWith(error);
			expect(probes.interaction).not.toHaveBeenCalled();
			(await reserve()).release();
		}
	);
	it('preserves synchronous late Claude stderr ordering, errors and replacement filtering', async () => {
		claude.spawn(input);
		const old = native;
		next.resolve({ done: true, value: undefined });
		await close();
		processes.clear();
		probes.stderr.mockClear();
		old.stderr.emit('data', 'first');
		old.stderr.emit('data', 'second');
		expect(probes.stderr.mock.calls).toEqual([
			[input.sessionId, 'first'],
			[input.sessionId, 'second'],
		]);
		const error = new Error('stderr output failed');
		probes.stderr.mockImplementationOnce(() => {
			throw error;
		});
		vi.mocked(captureException).mockImplementationOnce(() => {
			throw new Error('diagnostics failed');
		});
		expect(() => old.stderr.emit('data', 'bad')).toThrow(error);
		(await reserve()).release();
		native = makeNative();
		next = Promise.withResolvers<IteratorResult<SDKMessage>>();
		claude.spawn(input);
		next.resolve({ done: true, value: undefined });
		await close();
		probes.stderr.mockClear();
		old.stderr.emit('data', 'superseded');
		expect(probes.stderr).not.toHaveBeenCalled();
		(await reserve()).release();
	});
	it.each([false, true])(
		'retains permission completion and failure after query and native close (failure: %s)',
		async (fail) => {
			const permission = Promise.withResolvers<unknown>();
			probes.interaction.mockReturnValueOnce(permission.promise);
			claude.spawn(input);
			const decision = probes.query.mock.calls[0][0].options!.canUseTool!(
				'Bash',
				{},
				{ signal, toolUseID: 'tool', requestId: 'request' }
			);
			next.resolve({ done: true, value: undefined });
			await close();
			await blocked();
			if (fail) {
				const rejected = expect(decision).rejects.toThrow('permission failed');
				permission.reject(new Error('permission failed'));
				await rejected;
			} else {
				permission.resolve({ outcome: 'selected', optionId: 'allow' });
				await expect(decision).resolves.toMatchObject({ behavior: 'allow' });
			}
			await drain();
			(await reserve()).release();
		}
	);
	it('holds an outstanding input pull through SDK error and pending exit reporting', async () => {
		const reporting = Promise.withResolvers<void>();
		probes.exit.mockReturnValueOnce(reporting.promise);
		claude.spawn(input);
		const prompt = probes.query.mock.calls[0][0].prompt;
		if (typeof prompt === 'string') throw new Error('Expected streaming input');
		const messages = prompt[Symbol.asyncIterator]();
		await messages.next();
		const waiting = messages.next();
		next.reject(new Error('SDK failed'));
		await close();
		await waiting;
		await blocked();
		reporting.reject(new Error('report failed'));
		await drain();
		(await reserve()).release();
	});
	it.each(['parser', 'env', 'query', 'nonstart'])(
		'releases proven prestart %s failures without invoking recovery',
		async (stage) => {
			const fail = () => {
				throw new Error('prestart');
			};
			if (stage === 'parser') vi.mocked(createOutputParser).mockImplementationOnce(fail);
			if (stage === 'env') vi.mocked(buildChildProcessEnv).mockImplementationOnce(fail);
			if (stage === 'query') probes.query.mockImplementationOnce(fail);
			if (stage === 'nonstart') vi.mocked(spawn).mockImplementationOnce(fail);
			claude.spawn(input);
			await drain();
			expect(fallback).not.toHaveBeenCalled();
			(await reserve()).release();
		}
	);
	it.each(['lost-handle', 'observer', 'postspawn'])(
		'keeps uncertain %s state blocked',
		async (stage) => {
			if (stage === 'lost-handle') vi.mocked(spawn).mockReturnValueOnce(undefined as never);
			if (stage === 'observer')
				vi.spyOn(native, 'on').mockImplementationOnce(() => {
					throw new Error('observer failed');
				});
			if (stage === 'postspawn')
				native.stderr.setEncoding.mockImplementationOnce(() => {
					throw new Error('decoder failed');
				});
			claude.spawn(input);
			await drain();
			expect(fallback).not.toHaveBeenCalled();
			if (stage !== 'postspawn') await close();
			await blocked();
		}
	);
	it('retains every replaced generation even after its process registration is removed', async () => {
		claude.spawn(input);
		const old = native;
		native = makeNative();
		next.resolve({ done: true, value: undefined });
		next = Promise.withResolvers<IteratorResult<SDKMessage>>();
		claude.spawn(input);
		old.stderr.emit('data', 'superseded diagnostic');
		expect(probes.stderr).not.toHaveBeenCalled();
		processes.clear();
		next.resolve({ done: true, value: undefined });
		await close();
		await blocked();
		await close(old);
		(await reserve()).release();
	});
	it.each([false, true])(
		'composes CLI fallback lifetime (setup failure: %s)',
		async (failSetup) => {
			fallback.mockImplementationOnce((fallbackInput) =>
				spawner.spawn(
					config({
						...fallbackInput,
						nativeRpcArgs: ['--mode', 'rpc-ui'],
						nativeRpcProtocol: 'omp-rpc',
					})
				)
			);
			if (failSetup)
				vi.mocked(createOutputParser).mockImplementationOnce(() => {
					throw new Error('parser failed');
				});
			claude.spawn({
				...input,
				permissionMode: 'full',
				harnessControlMode: failSetup ? 'native' : undefined,
			});
			expect(fallback).toHaveBeenCalledOnce();
			await blocked();
			await close();
			(await reserve()).release();
		}
	);
	it.each([false, true])('rejects an escaped SDK launch (previous launch: %s)', async (launch) => {
		if (!launch) probes.query.mockImplementationOnce(() => sdk);
		claude.spawn(input);
		const escaped = probes.query.mock.calls[0][0].options!.spawnClaudeCodeProcess!;
		next.resolve({ done: true, value: undefined });
		await close();
		const hold = await reserve();
		try {
			vi.mocked(spawn).mockClear();
			expect(() => escaped({ command: 'late', args: [], env: {}, signal })).toThrow('one launch');
			expect(spawn).not.toHaveBeenCalled();
		} finally {
			hold.release();
		}
	});
	it.each(['sdk', 'turn'])('shares the one-launch limit after %s launch', async (first) => {
		boundary.withWorktreeTurnActivity((start, observe, spawnChild) => {
			if (first === 'sdk') spawnChild('sdk', [], {});
			else
				observe(
					start({ command: 'first', args: [], cwd: target, env: {} }, {}, { stopGraceMs: 1 }).done
				);
			expect(() => spawnChild('second-sdk', [], {})).toThrow('one launch');
			expect(() =>
				start({ command: 'second', args: [], cwd: target, env: {} }, {}, { stopGraceMs: 1 })
			).toThrow('one launch');
			observe(Promise.resolve());
		}, vi.fn());
		expect(spawn).toHaveBeenCalledOnce();
		await close();
		(await reserve()).release();
	});
	it('verifies the lockfile SDK invokes its custom spawn hook synchronously', async () => {
		const actual = await vi.importActual<typeof import('@anthropic-ai/claude-agent-sdk')>(
			'@anthropic-ai/claude-agent-sdk'
		);
		const sentinel = new Error('hook reached');
		const hook = vi.fn(() => {
			throw sentinel;
		});
		expect(() =>
			actual.query({
				prompt: 'fixture',
				options: { pathToClaudeCodeExecutable: 'owned-fixture', spawnClaudeCodeProcess: hook },
			})
		).toThrow(sentinel);
		expect(hook).toHaveBeenCalledOnce();
		expect(spawn).not.toHaveBeenCalled();
	});
});

describe('shared OpenCode server activity', () => {
	let manager: typeof import('../../../main/opencode-server/OpencodeServerManager').opencodeServerManager;
	const opts = { binaryPath: 'opencode-fixture', cwd: target, permissionMode: 'standard' as const };
	const sdk = { createOpencodeClient: probes.opencodeClient };
	beforeEach(async () => {
		Object.assign(native, { kill: vi.fn() });
		Object.assign(native.stdout, { resume: vi.fn() });
		Object.assign(native.stderr, { resume: vi.fn() });
		vi.mocked(captureException).mockResolvedValue(undefined);
		probes.opencodeSdk.mockResolvedValue(sdk);
		probes.opencodeClient.mockReturnValue({ fixture: true });
		({ opencodeServerManager: manager } =
			await import('../../../main/opencode-server/OpencodeServerManager'));
	});
	afterEach(() => {
		manager.shutdown();
		vi.useRealTimers();
	});
	const ready = () =>
		native.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4321\n');
	async function start() {
		const result = manager.ensureServer(opts);
		ready();
		return result;
	}
	it.each([target, path.join(target, 'descendant'), path.resolve('unrelated')])(
		'refuses standalone shutdown before any registry access under %s',
		async (root) => {
			await start();
			await close();
			const hold = await reserve(root);
			const reads = ['servers', 'startupChildren', 'starting'].map((key) => {
				const descriptor = Object.getOwnPropertyDescriptor(manager, key)!;
				const read = vi.fn(() => descriptor.value);
				Object.defineProperty(manager, key, { configurable: true, get: read });
				return { read, restore: () => Object.defineProperty(manager, key, descriptor) };
			});
			try {
				expect(() => manager.shutdown()).toThrow('reserved');
				for (const { read } of reads) expect(read).not.toHaveBeenCalled();
				expect((native as typeof native & { kill: unknown }).kill).not.toHaveBeenCalled();
				expect(captureException).not.toHaveBeenCalled();
				expect(logger.error).not.toHaveBeenCalled();
			} finally {
				for (const { restore } of reads) restore();
				hold.release();
			}
			manager.shutdown();
			expect((native as typeof native & { kill: unknown }).kill).toHaveBeenCalledOnce();
		}
	);
	it('admits an empty shutdown before reading registries and preserves its void return', async () => {
		const hold = await reserve();
		try {
			expect(() => manager.shutdown()).toThrow('reserved');
		} finally {
			hold.release();
		}
		expect(manager.shutdown()).toBeUndefined();
		(await reserve()).release();
	});
	it.each(['resolve', 'reject'] as const)(
		'holds pending shutdown diagnostics until they %s after cache clearing and child close',
		async (outcome) => {
			await start();
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			const failure = new Error('kill failed');
			vi.spyOn(native as typeof native & { kill(): void }, 'kill').mockImplementation(() => {
				throw failure;
			});
			expect(manager.shutdown()).toBeUndefined();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			await close();
			await blocked();
			manager.shutdown();
			expect(captureException).toHaveBeenCalledOnce();
			await blocked();
			if (outcome === 'resolve') reporting.resolve();
			else reporting.reject(new Error('report failed'));
			await drain();
			(await reserve()).release();
			expect(logger.error).toHaveBeenCalledTimes(outcome === 'reject' ? 1 : 0);
		}
	);
	it('keeps a canonicalizing reservation blocked during reentrant kill and reporting', async () => {
		await start();
		await close();
		const resolving = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(resolving.promise);
		const reservation = gate.reserveWorktreeCleanup(target);
		const reporting = Promise.withResolvers<void>();
		vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
		let nested: ReturnType<typeof gate.reserveWorktreeCleanup> | undefined;
		vi.spyOn(native as typeof native & { kill(): void }, 'kill').mockImplementation(() => {
			nested = gate.reserveWorktreeCleanup(target);
			throw new Error('kill failed');
		});
		manager.shutdown();
		resolving.resolve(target);
		expect(await reservation).toMatchObject({ status: 'blocked' });
		expect(await nested).toMatchObject({ status: 'blocked' });
		reporting.resolve();
		await drain();
		(await reserve()).release();
	});
	it.each([true, false])(
		'does not release native ownership after kill returns %s',
		async (sent) => {
			await start();
			const kill = vi
				.spyOn(native as typeof native & { kill(): boolean }, 'kill')
				.mockReturnValue(sent);
			manager.shutdown();
			expect(kill).toHaveBeenCalledExactlyOnceWith();
			native.emit('exit', 0, null);
			await drain();
			await blocked();
			manager.shutdown();
			expect(kill).toHaveBeenCalledOnce();
			await close();
			(await reserve()).release();
		}
	);
	it('retains startup and failure reporting separately after shutdown and child close', async () => {
		const result = manager.ensureServer(opts);
		const rejected = expect(result).rejects.toThrow('before becoming ready');
		const reporting = Promise.withResolvers<void>();
		vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
		vi.spyOn(native as typeof native & { kill(): void }, 'kill').mockImplementation(() => {
			throw new Error('startup kill failed');
		});
		manager.shutdown();
		await close();
		await blocked();
		native.emit('exit', 1, null);
		await rejected;
		await drain();
		await blocked();
		reporting.resolve();
		await drain();
		(await reserve()).release();
	});
	it('retains separate reports for ready and starting children across shutdown generations', async () => {
		await start();
		const old = native;
		const oldReport = Promise.withResolvers<void>();
		const nextReport = Promise.withResolvers<void>();
		vi.spyOn(old as typeof old & { kill(): void }, 'kill').mockImplementation(() => {
			throw new Error('old kill failed');
		});
		vi.mocked(captureException).mockReturnValueOnce(oldReport.promise);
		manager.shutdown();
		native = makeNative();
		Object.assign(native, {
			kill: vi.fn(() => {
				throw new Error('new kill failed');
			}),
		});
		const result = manager.ensureServer(opts);
		const rejected = expect(result).rejects.toThrow('before becoming ready');
		vi.mocked(captureException).mockReturnValueOnce(nextReport.promise);
		manager.shutdown();
		await close(old);
		await close();
		native.emit('exit', 1, null);
		await rejected;
		nextReport.resolve();
		await drain();
		await blocked();
		oldReport.resolve();
		await drain();
		(await reserve()).release();
	});
	it.each(['key', 'env'])('releases failed %s setup before any native launch', async (stage) => {
		const fail = () => {
			throw new Error('setup failed');
		};
		if (stage === 'env') vi.mocked(buildChildProcessEnv).mockImplementationOnce(fail);
		await expect(
			manager.ensureServer({
				...opts,
				get binaryPath() {
					return stage === 'key' ? fail() : opts.binaryPath;
				},
			})
		).rejects.toThrow('setup failed');
		expect(spawn).not.toHaveBeenCalled();
		expect(probes.opencodeSdk).not.toHaveBeenCalled();
		await drain();
		(await reserve()).release();
	});
	it.each([target, path.join(target, 'descendant'), path.resolve('unrelated')])(
		'refuses before manager setup under reservation %s',
		async (root) => {
			const hold = await reserve(root);
			const read = vi.fn(() => opts.binaryPath);
			try {
				await expect(
					manager.ensureServer({
						...opts,
						get binaryPath() {
							return read();
						},
					})
				).rejects.toThrow('reserved');
				expect(read).not.toHaveBeenCalled();
				expect(buildChildProcessEnv).not.toHaveBeenCalled();
				expect(spawn).not.toHaveBeenCalled();
				expect(probes.opencodeSdk).not.toHaveBeenCalled();
			} finally {
				hold.release();
			}
		}
	);
	it('blocks an earlier reservation still canonicalizing when server setup starts', async () => {
		const resolving = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockImplementationOnce(() => resolving.promise);
		const reservation = gate.reserveWorktreeCleanup(target);
		const result = start();
		resolving.resolve(target);
		expect(await reservation).toMatchObject({ status: 'blocked' });
		await result;
		await close();
		(await reserve()).release();
	});
	it('blocks reentrant environment setup and preserves native launch options', async () => {
		let reservation: ReturnType<typeof gate.reserveWorktreeCleanup> | undefined;
		vi.mocked(buildChildProcessEnv).mockImplementationOnce(() => {
			reservation = gate.reserveWorktreeCleanup(target);
			return { FIXTURE_ENV: 'present' };
		});
		const result = manager.ensureServer({
			...opts,
			customEnvVars: { A: 'one' },
			shellEnvVars: { B: 'two' },
			extraPathDirs: ['bin'],
		});
		expect(await reservation).toMatchObject({ status: 'blocked' });
		expect(buildChildProcessEnv).toHaveBeenCalledWith({ A: 'one' }, false, { B: 'two' }, ['bin']);
		expect(spawn).toHaveBeenCalledWith(
			opts.binaryPath,
			['serve', '--hostname=127.0.0.1', '--port=0'],
			{
				cwd: target,
				env: {
					FIXTURE_ENV: 'present',
					OPENCODE_CONFIG_CONTENT: JSON.stringify({
						permission: { '*': 'ask', external_directory: 'ask', question: 'deny' },
						tools: { question: false },
					}),
				},
				stdio: ['ignore', 'pipe', 'pipe'],
				shell: false,
			}
		);
		ready();
		await expect(result).resolves.toMatchObject({ url: 'http://127.0.0.1:4321' });
		await blocked();
		await close();
		(await reserve()).release();
	});
	it('waits for a complete readiness line and SDK publication even after native close', async () => {
		const loading = Promise.withResolvers<typeof sdk>();
		probes.opencodeSdk.mockReturnValueOnce(loading.promise);
		const result = manager.ensureServer(opts);
		native.stdout.emit('data', 'opencode server listening on http://127.0.0.1:');
		await drain();
		expect(probes.opencodeSdk).not.toHaveBeenCalled();
		native.stdout.emit('data', '4321\n');
		await drain();
		expect(probes.opencodeSdk).toHaveBeenCalledOnce();
		expect(
			(native.stdout as typeof native.stdout & { resume: unknown }).resume
		).toHaveBeenCalledOnce();
		expect(
			(native.stderr as typeof native.stderr & { resume: unknown }).resume
		).toHaveBeenCalledOnce();
		await close();
		await blocked();
		loading.resolve(sdk);
		await expect(result).resolves.toMatchObject({ client: { fixture: true } });
		await drain();
		(await reserve()).release();
	});
	it.each(['error', 'exit', 'shutdown'])(
		'does not treat %s as independent native close',
		async (event) => {
			await start();
			if (event === 'shutdown') manager.shutdown();
			else if (event === 'error') native.emit('error', new Error('after readiness'));
			else native.emit('exit', 0, null);
			await drain();
			await blocked();
			await close();
			(await reserve()).release();
		}
	);
	it.each(['error', 'exit', 'timeout'])(
		'retains failed %s startup until native close',
		async (failure) => {
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			const result = manager.ensureServer(opts);
			const rejected = expect(result).rejects.toThrow();
			if (failure === 'error') native.emit('error', new Error('start failure'));
			else if (failure === 'exit') native.emit('exit', 1, null);
			else await vi.advanceTimersByTimeAsync(15000);
			await rejected;
			await blocked();
			await close();
			(await reserve()).release();
		}
	);
	it('holds shutdown during readiness until readiness rejection and child close', async () => {
		const result = manager.ensureServer(opts);
		const rejected = expect(result).rejects.toThrow('before becoming ready');
		manager.shutdown();
		await blocked();
		await close();
		await blocked();
		native.emit('exit', 1, null);
		await rejected;
		await drain();
		(await reserve()).release();
	});
	it.each(['load', 'client'])(
		'keeps a failed SDK %s blocked until native close',
		async (failure) => {
			if (failure === 'load') probes.opencodeSdk.mockRejectedValueOnce(new Error('load failed'));
			else
				probes.opencodeClient.mockImplementationOnce(() => {
					throw new Error('client failed');
				});
			await expect(start()).rejects.toThrow('failed');
			await blocked();
			await close();
			(await reserve()).release();
		}
	);
	it('releases proven synchronous nonstart without entering readiness or SDK setup', async () => {
		vi.mocked(spawn).mockImplementationOnce(() => {
			throw new Error('nonstart');
		});
		await expect(manager.ensureServer(opts)).rejects.toThrow();
		expect(probes.opencodeSdk).not.toHaveBeenCalled();
		await drain();
		(await reserve()).release();
	});
	it.each(['handle', 'observer'])(
		'keeps missing native %s uncertainty blocked',
		async (failure) => {
			if (failure === 'handle')
				vi.spyOn(native.stdin, 'on').mockImplementationOnce(() => {
					throw new Error('postspawn handle lost');
				});
			else {
				const original = native.on.bind(native);
				let observers = 0;
				vi.spyOn(native, 'on').mockImplementation((event, listener) => {
					if (event === 'close' && ++observers === 2) throw new Error('observer unavailable');
					return original(event, listener);
				});
			}
			await expect(manager.ensureServer(opts)).rejects.toThrow();
			await close();
			await blocked();
		}
	);
	it('shares one startup and retains pending reuse through SDK work after shutdown/close', async () => {
		const loading = Promise.withResolvers<typeof sdk>();
		probes.opencodeSdk.mockReturnValueOnce(loading.promise);
		const first = manager.ensureServer(opts);
		const second = manager.ensureServer(opts);
		expect(spawn).toHaveBeenCalledOnce();
		ready();
		await drain();
		manager.shutdown();
		await close();
		await blocked();
		loading.resolve(sdk);
		expect(await first).toEqual(await second);
		await drain();
		(await reserve()).release();
	});
	it('admits cached reuse and refuses it under a reservation even without another launch', async () => {
		const first = await start();
		expect(await manager.ensureServer({ ...opts, cwd: path.resolve('another-project') })).toEqual(
			first
		);
		expect(spawn).toHaveBeenCalledOnce();
		expect(buildChildProcessEnv).toHaveBeenCalledOnce();
		await close();
		const hold = await reserve();
		try {
			await expect(manager.ensureServer(opts)).rejects.toThrow('reserved');
		} finally {
			hold.release();
		}
	});
	it('retains old and replacement native children independently after exit/cache eviction', async () => {
		await start();
		const old = native;
		old.emit('exit', 0, null);
		native = makeNative();
		Object.assign(native, { kill: vi.fn() });
		Object.assign(native.stdout, { resume: vi.fn() });
		Object.assign(native.stderr, { resume: vi.fn() });
		await start();
		await close(old);
		await blocked();
		await close();
		(await reserve()).release();
	});
	it('holds a child without pid despite a throwing shutdown kill', async () => {
		native.pid = undefined as never;
		await start();
		vi.spyOn(native as typeof native & { kill(): void }, 'kill').mockImplementation(() => {
			throw new Error('kill failed');
		});
		manager.shutdown();
		await blocked();
		await close();
		(await reserve()).release();
	});
});

describe('OpenCode per-turn activity', () => {
	let oc: import('../../../main/process-manager/spawners/OpencodeServerSpawner').OpencodeServerSpawner;
	let manager: typeof import('../../../main/opencode-server/OpencodeServerManager').opencodeServerManager;
	let client: ReturnType<typeof makeClient>;
	let ending: ReturnType<typeof Promise.withResolvers<void>>;
	let events: Array<
		Event | { type: 'permission.asked'; properties: OpencodeCurrentPermissionRequest }
	>;
	const idle: Event = { type: 'session.idle', properties: { sessionID: 'oc-turn' } };
	function stream() {
		return (async function* () {
			for (const event of events) yield event;
			await ending.promise;
		})();
	}
	function makeClient() {
		return {
			session: {
				create: vi.fn().mockResolvedValue({ data: { id: 'oc-turn' } }),
				promptAsync: vi.fn().mockResolvedValue({}),
				abort: vi.fn().mockResolvedValue({}),
			},
			event: { subscribe: vi.fn().mockImplementation(async () => ({ stream: stream() })) },
			postSessionIdPermissionsPermissionId: vi.fn().mockResolvedValue({ data: true }),
		};
	}
	beforeEach(async () => {
		ending = Promise.withResolvers<void>();
		events = [];
		client = makeClient();
		Object.assign(native, { kill: vi.fn() });
		Object.assign(native.stdout, { resume: vi.fn() });
		Object.assign(native.stderr, { resume: vi.fn() });
		probes.opencodeSdk.mockResolvedValue({ createOpencodeClient: probes.opencodeClient });
		probes.opencodeClient.mockReturnValue(client);
		probes.http.mockResolvedValue({ ok: true });
		({ opencodeServerManager: manager } =
			await import('../../../main/opencode-server/OpencodeServerManager'));
		const { OpencodeServerSpawner } =
			await import('../../../main/process-manager/spawners/OpencodeServerSpawner');
		oc = new OpencodeServerSpawner(
			processes,
			new EventEmitter(),
			{} as DataBufferManager,
			fallback
		);
	});
	afterEach(() => manager.shutdown());
	const cfg = (overrides: Partial<ProcessConfig> = {}) =>
		config({ toolType: 'opencode', command: 'oc-fixture', permissionMode: 'full', ...overrides });
	async function start(overrides: Partial<ProcessConfig> = {}) {
		expect(oc.spawn(cfg(overrides))).toMatchObject({ success: true });
		const managed = processes.get('rpc-session')!;
		native.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4321\n');
		await drain();
		return managed;
	}
	async function end() {
		ending.resolve();
		await close();
	}

	it.each(
		(['setup', 'run', 'completion', 'fallback', 'control'] as const).flatMap((stage) =>
			(['resolve', 'reject', 'throw'] as const).map((outcome) => ({ stage, outcome }))
		)
	)(
		'owns OpenCode $stage diagnostics when the reporter will $outcome',
		async ({ stage, outcome }) => {
			const failure = new Error(`OpenCode ${stage} ${outcome}`);
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockImplementationOnce(() => {
				if (outcome === 'throw') throw new Error('reporter failed');
				return reporting.promise;
			});
			if (stage === 'setup') {
				vi.mocked(createOutputParser).mockImplementationOnce(() => {
					throw failure;
				});
				expect(oc.spawn(cfg())).toMatchObject({ success: false, error: String(failure) });
				expect(fallback).not.toHaveBeenCalled();
			} else if (stage === 'run') {
				const args: string[] = [];
				vi.spyOn(args, 'indexOf').mockImplementation(() => {
					throw failure;
				});
				expect(oc.spawn(cfg({ args }))).toMatchObject({ success: true });
			} else if (stage === 'fallback') {
				client.session.create.mockRejectedValueOnce(new Error('setup failed'));
				fallback.mockImplementationOnce(() => {
					throw failure;
				});
				await start();
				expect(fallback).toHaveBeenLastCalledWith(cfg());
				await close();
			} else {
				if (stage === 'completion') {
					probes.exit.mockRejectedValueOnce(new Error('exit reporting failed'));
					vi.mocked(logger.error).mockImplementationOnce(() => {
						throw failure;
					});
				}
				const managed = await start();
				await end();
				if (stage === 'control') {
					Object.defineProperty(managed, 'opencodeClient', {
						get: () => {
							throw failure;
						},
					});
					expect(() => managed.sdkController!.interrupt()).toThrow(failure);
				}
			}
			await drain();
			expect(captureException).toHaveBeenLastCalledWith(failure);
			if (outcome !== 'throw') {
				await blocked();
				if (outcome === 'resolve') reporting.resolve();
				else reporting.reject(new Error('reporter rejected'));
				await drain();
			}
			expect(captureException).toHaveBeenCalledOnce();
			(await reserve()).release();
		}
	);
	it.each([false, true])(
		'keeps OpenCode fallback diagnostics independent of server close (report first: %s)',
		async (reportFirst) => {
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			client.session.create.mockRejectedValueOnce(new Error('setup'));
			fallback.mockImplementationOnce(() => {
				throw new Error('fallback');
			});
			await start();
			if (reportFirst) reporting.resolve();
			else await close();
			await drain();
			await blocked();
			if (reportFirst) await close();
			else reporting.resolve();
			await drain();
			(await reserve()).release();
		}
	);
	it.each(['sdk-interrupt', 'sdk-kill', 'harness-interrupt', 'harness-close'] as const)(
		'owns OpenCode late %s diagnostics and refuses before client lookup/reporting',
		async (action) => {
			const managed = await start();
			await end();
			const failure = new Error('late client lookup');
			const lookup = vi.fn(() => {
				throw failure;
			});
			Object.defineProperty(managed, 'opencodeClient', { get: lookup });
			const call = () => {
				switch (action) {
					case 'sdk-interrupt':
						return managed.sdkController!.interrupt();
					case 'sdk-kill':
						return managed.sdkController!.kill();
					case 'harness-interrupt':
						return managed.harnessControl!.interrupt();
					case 'harness-close':
						return managed.harnessControl!.close();
				}
			};
			const hold = await reserve(path.join(target, 'descendant'));
			try {
				await expect(Promise.resolve().then(call)).rejects.toThrow('reserved');
				expect(lookup).not.toHaveBeenCalled();
				expect(captureException).not.toHaveBeenCalled();
			} finally {
				hold.release();
			}
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			await expect(Promise.resolve().then(call)).rejects.toBe(failure);
			await blocked();
			reporting.reject(new Error('diagnostics failed'));
			await drain();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			(await reserve()).release();
		}
	);
	it('keeps OpenCode concurrent reports and successor activity independently owned', async () => {
		const managed = await start();
		await end();
		Object.defineProperty(managed, 'opencodeClient', {
			get: () => {
				throw new Error('lookup');
			},
		});
		const reports = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		vi.mocked(captureException)
			.mockReturnValueOnce(reports[0].promise)
			.mockReturnValueOnce(reports[1].promise);
		expect(() => managed.sdkController!.interrupt()).toThrow('lookup');
		expect(() => managed.sdkController!.kill()).toThrow('lookup');
		reports[0].resolve();
		await drain();
		await blocked();
		const releaseSuccessor = gate.beginGlobalWorktreeActivity();
		reports[1].reject(new Error('diagnostics failed'));
		await drain();
		await blocked();
		releaseSuccessor();
		(await reserve()).release();
		expect(captureException).toHaveBeenCalledTimes(2);
	});
	it('blocks pending canonicalization when OpenCode late diagnostics acquire admission', async () => {
		const managed = await start();
		await end();
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const pending = gate.reserveWorktreeCleanup(target);
		const reporting = Promise.withResolvers<void>();
		vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
		Object.defineProperty(managed, 'opencodeClient', {
			get: () => {
				throw new Error('lookup');
			},
		});
		expect(() => managed.sdkController!.interrupt()).toThrow('lookup');
		canonical.resolve(target);
		const result = await pending;
		if (result.status === 'reserved-partially') result.release();
		expect(result.status).toBe('blocked');
		reporting.resolve();
		await drain();
		(await reserve()).release();
	});
	it.each([target, path.join(target, 'descendant'), path.resolve('unrelated')])(
		'refuses standalone setup before parser/map/server/fallback under %s reservation',
		async (root) => {
			const hold = await reserve(root);
			try {
				expect(oc.spawn(cfg())).toMatchObject({
					success: false,
					error: expect.stringContaining('reserved'),
				});
				expect(createOutputParser).not.toHaveBeenCalled();
				expect(processes.size).toBe(0);
				expect(spawn).not.toHaveBeenCalled();
				expect(probes.opencodeSdk).not.toHaveBeenCalled();
				expect(fallback).not.toHaveBeenCalled();
			} finally {
				hold.release();
			}
		}
	);
	it('admits before reentrant parser setup and preserves scoped HTTP arguments', async () => {
		let pending: ReturnType<typeof gate.reserveWorktreeCleanup> | undefined;
		vi.mocked(createOutputParser).mockImplementationOnce(() => {
			pending = gate.reserveWorktreeCleanup(target);
			return null;
		});
		await start({ args: ['--model', 'provider/model', '--agent', 'plan'] });
		expect(await pending).toMatchObject({ status: 'blocked' });
		expect(client.session.create).toHaveBeenCalledWith({ query: { directory: target } });
		expect(client.session.promptAsync).toHaveBeenCalledWith({
			path: { id: 'oc-turn' },
			query: { directory: target },
			body: {
				parts: [{ type: 'text', text: 'fixture' }],
				model: { providerID: 'provider', modelID: 'model' },
				agent: 'plan',
			},
		});
		await end();
		(await reserve()).release();
	});
	it('releases synchronous prestart parser failure without recovery', async () => {
		vi.mocked(createOutputParser).mockImplementationOnce(() => {
			throw new Error('parser');
		});
		expect(oc.spawn(cfg())).toMatchObject({ success: false });
		expect(spawn).not.toHaveBeenCalled();
		expect(fallback).not.toHaveBeenCalled();
		(await reserve()).release();
	});
	it.each(['create', 'subscribe', 'promptAsync'] as const)(
		'holds pending %s after stream/native completion',
		async (stage) => {
			const pending = Promise.withResolvers<unknown>();
			const fn = stage === 'subscribe' ? client.event.subscribe : client.session[stage];
			fn.mockReturnValueOnce(pending.promise);
			await start();
			await end();
			await blocked();
			pending.resolve(
				stage === 'create'
					? { data: { id: 'oc-turn' } }
					: stage === 'subscribe'
						? { stream: stream() }
						: {}
			);
			await drain();
			(await reserve()).release();
		}
	);
	it.each(['create', 'subscribe', 'promptAsync'] as const)(
		'holds killed/deleted setup until %s settles without restarting it',
		async (stage) => {
			const pending = Promise.withResolvers<unknown>();
			(stage === 'subscribe' ? client.event.subscribe : client.session[stage]).mockReturnValueOnce(
				pending.promise
			);
			const managed = await start();
			managed.sdkController!.kill();
			processes.clear();
			await end();
			await blocked();
			pending.resolve(
				stage === 'create'
					? { data: { id: 'oc-turn' } }
					: stage === 'subscribe'
						? { stream: stream() }
						: {}
			);
			await drain();
			expect(client.session.promptAsync).toHaveBeenCalledTimes(stage === 'promptAsync' ? 1 : 0);
			expect(fallback).not.toHaveBeenCalled();
			(await reserve()).release();
		}
	);
	it('holds SSE independently after server close and HTTP completion', async () => {
		await start({ agentSessionId: 'oc-turn' });
		expect(client.session.create).not.toHaveBeenCalled();
		await close();
		await blocked();
		ending.resolve();
		await drain();
		(await reserve()).release();
	});
	it('holds prompt acknowledgement after idle and independent server close', async () => {
		events.push(idle);
		const prompt = Promise.withResolvers<unknown>();
		client.session.promptAsync.mockReturnValueOnce(prompt.promise);
		await start();
		await close();
		expect(probes.exit).toHaveBeenCalledOnce();
		await blocked();
		prompt.resolve({});
		await drain();
		(await reserve()).release();
	});
	it.each(['resolve', 'reject'] as const)(
		'holds pending exit reporting through %s',
		async (outcome) => {
			const reporting = Promise.withResolvers<void>();
			probes.exit.mockReturnValueOnce(reporting.promise);
			await start();
			await end();
			await blocked();
			if (outcome === 'resolve') reporting.resolve();
			else reporting.reject(new Error('reporting'));
			await drain();
			(await reserve()).release();
		}
	);
	it.each(['legacy', 'current'] as const)(
		'holds %s broker decision and HTTP reply after native/turn end',
		async (protocol) => {
			const properties = {
				id: 'permission',
				sessionID: 'oc-turn',
				permission: 'bash',
				patterns: ['fixture'],
				always: [],
				type: 'shell',
				title: 'fixture',
				messageID: 'fixture-message',
				time: { created: 1 },
				metadata: {},
			};
			events.push(
				protocol === 'legacy'
					? { type: 'permission.updated', properties }
					: { type: 'permission.asked', properties }
			);
			const decision = Promise.withResolvers<unknown>();
			const reply = Promise.withResolvers<unknown>();
			probes.interaction.mockReturnValueOnce(decision.promise);
			const request =
				protocol === 'legacy' ? client.postSessionIdPermissionsPermissionId : probes.http;
			request.mockReturnValueOnce(reply.promise);
			await start();
			expect(probes.interaction).toHaveBeenCalledOnce();
			await end();
			await blocked();
			decision.resolve({ outcome: 'selected', optionId: 'once' });
			await drain();
			expect(request).toHaveBeenCalledOnce();
			if (protocol === 'current')
				expect(request.mock.calls[0][0]).toContain('/permission/permission/reply?directory=');
			else
				expect(request).toHaveBeenCalledWith({
					path: { id: 'oc-turn', permissionID: 'permission' },
					query: { directory: target },
					body: { response: 'once' },
				});
			await blocked();
			reply.resolve(protocol === 'legacy' ? { data: true } : { ok: true });
			await drain();
			(await reserve()).release();
		}
	);
	it('retains recovery abort after permission decision rejection', async () => {
		events.push({
			type: 'permission.asked',
			properties: {
				id: 'permission',
				sessionID: 'oc-turn',
				permission: 'bash',
				patterns: [],
				always: [],
				metadata: {},
			},
		});
		const decision = Promise.withResolvers<unknown>();
		const abort = Promise.withResolvers<unknown>();
		probes.interaction.mockReturnValueOnce(decision.promise);
		client.session.abort.mockReturnValueOnce(abort.promise);
		await start();
		await end();
		decision.reject(new Error('broker'));
		await drain();
		expect(client.session.abort).toHaveBeenCalledOnce();
		await blocked();
		abort.resolve({});
		await drain();
		(await reserve()).release();
	});
	it.each(['sdk-interrupt', 'sdk-kill', 'harness-interrupt', 'harness-close'] as const)(
		'admits late %s afresh before SDK access and holds its HTTP work',
		async (action) => {
			const managed = await start();
			await end();
			processes.clear();
			const call = () => {
				switch (action) {
					case 'sdk-interrupt':
						return managed.sdkController!.interrupt();
					case 'sdk-kill':
						return managed.sdkController!.kill();
					case 'harness-interrupt':
						return managed.harnessControl!.interrupt();
					case 'harness-close':
						return managed.harnessControl!.close();
				}
			};
			const hold = await reserve();
			try {
				await expect(Promise.resolve().then(call)).rejects.toThrow('reserved');
				expect(client.session.abort).not.toHaveBeenCalled();
			} finally {
				hold.release();
			}
			const abort = Promise.withResolvers<unknown>();
			client.session.abort.mockReturnValueOnce(abort.promise);
			await call();
			await blocked();
			abort.reject(new Error('abort failed'));
			await drain();
			(await reserve()).release();
		}
	);
	it('retains independent pump if prompt error reporting throws out of run', async () => {
		client.session.promptAsync.mockRejectedValueOnce(new Error('prompt'));
		oc = new (
			await import('../../../main/process-manager/spawners/OpencodeServerSpawner')
		).OpencodeServerSpawner(
			processes,
			{
				emit: () => {
					throw new Error('listener');
				},
			} as unknown as EventEmitter,
			{} as DataBufferManager,
			fallback
		);
		await start();
		await close();
		await blocked();
		ending.resolve();
		await drain();
		(await reserve()).release();
	});
	it.each(['fallback', 'throw', 'standard', 'replaced'] as const)(
		'holds setup failure/recovery boundary: %s',
		async (mode) => {
			client.session.create.mockRejectedValueOnce(new Error('setup'));
			let reservation: ReturnType<typeof gate.reserveWorktreeCleanup> | undefined;
			let releaseFallback: (() => void) | undefined;
			fallback.mockImplementationOnce(() => {
				reservation = gate.reserveWorktreeCleanup(target);
				if (mode === 'throw') throw new Error('fallback');
				releaseFallback = gate.beginGlobalWorktreeActivity();
				return { pid: 999, success: true };
			});
			const replacing = Promise.withResolvers<unknown>();
			if (mode === 'replaced')
				client.session.create.mockReset().mockReturnValueOnce(replacing.promise);
			await start({ permissionMode: mode === 'standard' ? 'standard' : 'full' });
			if (mode === 'replaced') {
				const replacement = { pid: 777 } as ManagedProcess;
				processes.set('rpc-session', replacement);
				replacing.reject(new Error('old setup'));
				await drain();
				expect(processes.get('rpc-session')).toBe(replacement);
			}
			expect(fallback).toHaveBeenCalledTimes(mode === 'standard' || mode === 'replaced' ? 0 : 1);
			if (reservation) expect(await reservation).toMatchObject({ status: 'blocked' });
			await close();
			if (releaseFallback) {
				await blocked();
				releaseFallback();
			}
			(await reserve()).release();
		}
	);
	it('retains no-prompt exit reporting without starting a server', async () => {
		const reporting = Promise.withResolvers<void>();
		probes.exit.mockReturnValueOnce(reporting.promise);
		expect(oc.spawn(cfg({ prompt: '' }))).toMatchObject({ success: true });
		expect(spawn).not.toHaveBeenCalled();
		await blocked();
		reporting.resolve();
		await drain();
		(await reserve()).release();
	});
});

describe('Copilot connection manager activity with unavailable native observer', () => {
	let manager: import('../../../main/process-manager/spawners/CopilotConnectionManager').CopilotConnectionManager;
	let client: {
		start: ReturnType<typeof vi.fn<() => Promise<void>>>;
		createSession: ReturnType<typeof vi.fn<(options: unknown) => Promise<{ sessionId: string }>>>;
		resumeSession: ReturnType<
			typeof vi.fn<(id: string, options: unknown) => Promise<{ sessionId: string }>>
		>;
		forceStop: ReturnType<typeof vi.fn<() => Promise<void>>>;
	};
	const copilotConfig = (overrides: Partial<ProcessConfig> = {}) =>
		config({ toolType: 'copilot-cli', command: 'copilot', tabId: 'copilot-tab', ...overrides });
	const handlers = () => ({
		onPermissionRequest: vi.fn(),
		onUserInputRequest: vi.fn(),
		onElicitationRequest: vi.fn(),
	});

	beforeEach(async () => {
		const { CopilotConnectionManager } =
			await import('../../../main/process-manager/spawners/CopilotConnectionManager');
		manager = new CopilotConnectionManager();
		client = {
			start: vi.fn().mockResolvedValue(undefined),
			createSession: vi.fn().mockResolvedValue({ sessionId: 'copilot-provider' }),
			resumeSession: vi.fn().mockResolvedValue({ sessionId: 'resumed-provider' }),
			forceStop: vi.fn().mockResolvedValue(undefined),
		};
		probes.copilotClient.mockReturnValue(client);
		probes.copilotStdio.mockReturnValue({ kind: 'stdio' });
		probes.copilotRuntime.mockReturnValue('/fixture/copilot-runtime');
	});

	it.each([target, path.join(target, 'child'), path.resolve('unrelated')])(
		'refuses acquisition before identity/env/SDK setup under reservation %s',
		async (root) => {
			const hold = await reserve(root);
			const input = copilotConfig();
			const identity = vi.fn(() => 'copilot-tab');
			Object.defineProperty(input, 'tabId', { get: identity });
			try {
				await expect(manager.acquire(input, handlers())).rejects.toThrow('reserved');
				expect(identity).not.toHaveBeenCalled();
				expect(buildChildProcessEnv).not.toHaveBeenCalled();
				expect(probes.copilotClient).not.toHaveBeenCalled();
				expect(probes.copilotStdio).not.toHaveBeenCalled();
				expect(probes.copilotRuntime).not.toHaveBeenCalled();
				expect(client.forceStop).not.toHaveBeenCalled();
			} finally {
				hold.release();
			}
		}
	);

	it.each(['close', 'closeAll', 'closeAgent'] as const)(
		'refuses %s before touching lease/SDK state or recovery',
		async (method) => {
			const hold = await reserve();
			try {
				const lease =
					{} as import('../../../main/process-manager/spawners/CopilotConnectionManager').CopilotConnectionLease;
				const access = vi.fn(() => false);
				Object.defineProperty(lease, 'closed', { get: access });
				const result =
					method === 'close'
						? manager.close(lease)
						: method === 'closeAgent'
							? manager.closeAgent('rpc-session')
							: manager.closeAll();
				await expect(result).rejects.toThrow('reserved');
				expect(access).not.toHaveBeenCalled();
				expect(client.forceStop).not.toHaveBeenCalled();
			} finally {
				hold.release();
			}
		}
	);

	it.each(['identity', 'close'] as const)(
		'retains standalone manager %s diagnostics without replacing the failure',
		async (stage) => {
			const failure = new Error(`${stage} failure`);
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			const input = copilotConfig();
			Object.defineProperty(input, 'tabId', {
				get: () => {
					throw failure;
				},
			});
			client.forceStop.mockRejectedValueOnce(failure);
			const result =
				stage === 'identity'
					? manager.acquire(input, handlers())
					: manager.close({ client, closed: false } as unknown as CopilotConnectionLease);
			await expect(result).rejects.toBe(failure);
			await drain();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			await blocked();
			reporting.reject(new Error('report failed'));
			await drain();
			(await reserve()).release();
		}
	);

	it.each(['identity', 'runtime', 'env', 'constructor'])(
		'releases a proven pre-start %s failure without SDK recovery',
		async (stage) => {
			const input = copilotConfig();
			const fail = () => {
				throw new Error(`${stage} failed`);
			};
			if (stage === 'identity') Object.defineProperty(input, 'tabId', { get: fail });
			if (stage === 'runtime') probes.copilotRuntime.mockImplementation(fail);
			if (stage === 'env') vi.mocked(buildChildProcessEnv).mockImplementation(fail);
			if (stage === 'constructor') probes.copilotClient.mockImplementation(fail);
			await expect(manager.acquire(input, handlers())).rejects.toThrow(`${stage} failed`);
			expect(client.start).not.toHaveBeenCalled();
			expect(client.forceStop).not.toHaveBeenCalled();
			await drain();
			(await reserve()).release();
		}
	);

	it('admits before reentrant setup and preserves stdio, environment and session payloads', async () => {
		let duringSetup: ReturnType<typeof gate.reserveWorktreeCleanup> | undefined;
		vi.mocked(buildChildProcessEnv).mockImplementation(() => {
			duringSetup = gate.reserveWorktreeCleanup(target);
			return { FIXTURE: 'value' };
		});
		const nextHandlers = handlers();
		const lease = await manager.acquire(
			copilotConfig({
				modelId: 'model',
				effort: 'high',
				appendSystemPrompt: 'system',
				customEnvVars: { CUSTOM: 'yes' },
				shellEnvVars: { SHELL_ENV: 'yes' },
			}),
			nextHandlers
		);
		expect(await duringSetup).toMatchObject({ status: 'blocked' });
		expect(probes.copilotStdio).toHaveBeenCalledWith({ path: '/fixture/copilot-runtime' });
		expect(probes.copilotClient).toHaveBeenCalledWith({
			connection: { kind: 'stdio' },
			workingDirectory: target,
			env: { FIXTURE: 'value' },
			logLevel: 'error',
		});
		expect(buildChildProcessEnv).toHaveBeenCalledWith({ CUSTOM: 'yes' }, false, {
			SHELL_ENV: 'yes',
		});
		const payload = client.createSession.mock.calls[0][0] as typeof nextHandlers;
		expect(payload).toMatchObject({
			model: 'model',
			reasoningEffort: 'high',
			workingDirectory: target,
			streaming: true,
			systemMessage: { mode: 'append', content: 'system' },
		});
		expect(lease.refs).toBe(1);
		payload.onUserInputRequest({ question: 'fixture' });
		expect(nextHandlers.onUserInputRequest).toHaveBeenCalledWith({ question: 'fixture' });
		manager.release(lease);
		await manager.closeAll();
		await drain();
		await blocked();
	});

	it('retains pending start and uncertainty after shutdown resolves before startup', async () => {
		const start = Promise.withResolvers<void>();
		client.start.mockReturnValue(start.promise);
		const acquiring = manager.acquire(copilotConfig(), handlers());
		await blocked();
		await expect(manager.acquire(copilotConfig(), handlers())).rejects.toThrow('still running');
		await manager.closeAll();
		await blocked();
		start.resolve();
		const lease = await acquiring;
		manager.release(lease);
		await manager.close(lease);
		await drain();
		await blocked();
	});

	it.each(['start', 'createSession', 'resumeSession'] as const)(
		'retains uncertainty after rejected %s and successful forceStop',
		async (stage) => {
			client[stage].mockRejectedValue(new Error('SDK failure'));
			await expect(
				manager.acquire(
					copilotConfig({
						agentSessionId: stage === 'resumeSession' ? 'resume-me' : undefined,
					}),
					handlers()
				)
			).rejects.toThrow('SDK failure');
			expect(client.forceStop).toHaveBeenCalledTimes(1);
			await drain();
			await blocked();
		}
	);

	it('retains pending resume and forceStop work, even after failed shutdown and cache removal', async () => {
		const session = Promise.withResolvers<{ sessionId: string }>();
		client.resumeSession.mockReturnValue(session.promise);
		const acquiring = manager.acquire(copilotConfig({ agentSessionId: 'resume-me' }), handlers());
		await drain();
		expect(client.resumeSession).toHaveBeenCalledWith(
			'resume-me',
			expect.objectContaining({ streaming: true })
		);
		await blocked();
		session.resolve({ sessionId: 'resume-me' });
		const lease = await acquiring;
		const stop = Promise.withResolvers<void>();
		client.forceStop.mockReturnValue(stop.promise);
		const closing = manager.close(lease);
		const rejected = expect(closing).rejects.toThrow('stop failed');
		await blocked();
		stop.reject(new Error('stop failed'));
		await rejected;
		await manager.closeAll();
		await drain();
		await blocked();
	});

	it('preserves cached reuse and dispatches session callbacks to the current handlers', async () => {
		const first = await manager.acquire(copilotConfig(), handlers());
		const payload = client.createSession.mock.calls[0][0] as ReturnType<typeof handlers>;
		manager.release(first);
		const nextHandlers = handlers();
		const reused = await manager.acquire(copilotConfig(), nextHandlers);
		expect(reused).toBe(first);
		expect(reused.refs).toBe(1);
		expect(probes.copilotClient).toHaveBeenCalledTimes(1);
		payload.onElicitationRequest({ fixture: true });
		payload.onPermissionRequest({ fixture: true }, { sessionId: 'copilot-provider' });
		expect(nextHandlers.onElicitationRequest).toHaveBeenCalledWith({ fixture: true });
		expect(nextHandlers.onPermissionRequest).toHaveBeenCalledWith(
			{ fixture: true },
			{ sessionId: 'copilot-provider' }
		);
		await manager.closeAgent('rpc-session');
		await drain();
		await blocked();
	});

	it('excludes overlapping replacement and never releases the old runtime uncertainty', async () => {
		const first = await manager.acquire(copilotConfig(), handlers());
		manager.release(first);
		const nextClient = { ...client, start: vi.fn().mockResolvedValue(undefined) };
		const stop = Promise.withResolvers<void>();
		client.forceStop.mockReturnValueOnce(stop.promise);
		probes.copilotClient.mockReturnValueOnce(nextClient);
		const replacing = manager.acquire(copilotConfig({ modelId: 'different' }), handlers());
		await expect(manager.acquire(copilotConfig(), handlers())).rejects.toThrow('still running');
		await blocked();
		stop.resolve();
		const replacement = await replacing;
		expect(replacement).not.toBe(first);
		expect(nextClient.start).toHaveBeenCalledTimes(1);
		manager.release(replacement);
		await manager.closeAll();
		await close(); // An unrelated/old local child cannot prove this SDK runtime ended.
		await blocked();
	});

	it('keeps unknown native ownership when startup and its recovery both reject', async () => {
		client.start.mockRejectedValue(new Error('start failed'));
		client.forceStop.mockRejectedValue(new Error('recovery failed'));
		await expect(manager.acquire(copilotConfig(), handlers())).rejects.toThrow('recovery failed');
		await drain();
		await blocked();
	});

	it('does not accept a synchronous SDK exception as authoritative nonstart proof', async () => {
		const { TurnNotStartedError } = await import('../../../shared/maestro-lib/run/start-turn');
		client.start.mockImplementation(() => {
			throw new TurnNotStartedError(new Error('unobserved SDK start'));
		});
		await expect(manager.acquire(copilotConfig(), handlers())).rejects.toThrow(
			'unobserved SDK start'
		);
		expect(client.forceStop).toHaveBeenCalledTimes(1);
		await drain();
		await blocked();
	});

	it('retains pending create work after closeAgent clears the lease', async () => {
		const session = Promise.withResolvers<{ sessionId: string }>();
		client.createSession.mockReturnValue(session.promise);
		const acquiring = manager.acquire(copilotConfig(), handlers());
		await drain();
		await manager.closeAgent('rpc-session');
		expect(client.forceStop).toHaveBeenCalledTimes(1);
		await blocked();
		session.resolve({ sessionId: 'late-session' });
		const lease = await acquiring;
		expect(lease.closed).toBe(true);
		await drain();
		await blocked();
	});
});

describe('Copilot per-turn activity', () => {
	let copilot: import('../../../main/process-manager/spawners/CopilotSdkSpawner').CopilotSdkSpawner;
	let listener: (event: SessionEvent) => void;
	let lease: CopilotConnectionLease;
	const session = {
		sessionId: 'copilot-provider',
		on: vi.fn<(callback: (event: SessionEvent) => void) => () => void>(),
		send: vi.fn<() => Promise<string>>(),
		abort: vi.fn<() => Promise<void>>(),
	};
	const connections = {
		acquire: vi.fn<CopilotConnectionManager['acquire']>(),
		close: vi.fn<CopilotConnectionManager['close']>(),
		closeAll: vi.fn<CopilotConnectionManager['closeAll']>(),
		closeAgent: vi.fn<CopilotConnectionManager['closeAgent']>(),
		release: vi.fn<CopilotConnectionManager['release']>(),
	};
	const input = (overrides: Partial<ProcessConfig> = {}) =>
		config({
			toolType: 'copilot-cli',
			command: 'copilot',
			harnessControlMode: 'native',
			...overrides,
		});
	async function start(overrides: Partial<ProcessConfig> = {}) {
		expect(copilot.spawn(input(overrides))).toMatchObject({ success: true });
		await drain();
		return processes.get('rpc-session')!;
	}
	async function idle() {
		listener({ type: 'session.idle' } as SessionEvent);
		await drain();
	}
	beforeEach(async () => {
		session.on.mockImplementation((callback) => {
			listener = callback;
			return vi.fn();
		});
		session.send.mockResolvedValue('message-id');
		session.abort.mockResolvedValue(undefined);
		lease = {
			key: 'owner',
			identity: 'identity',
			client: {} as never,
			session: session as unknown as CopilotConnectionLease['session'],
			handlers: {} as never,
			refs: 1,
			initializing: false,
			closed: false,
			agentId: 'agent',
			replacing: false,
		};
		connections.acquire.mockResolvedValue(lease);
		connections.close.mockResolvedValue(undefined);
		connections.closeAll.mockResolvedValue(undefined);
		connections.closeAgent.mockResolvedValue(undefined);
		connections.release.mockImplementation((current) => {
			current.refs--;
		});
		const { CopilotSdkSpawner } =
			await import('../../../main/process-manager/spawners/CopilotSdkSpawner');
		copilot = new CopilotSdkSpawner(
			processes,
			new EventEmitter(),
			{} as DataBufferManager,
			fallback,
			connections as unknown as CopilotConnectionManager
		);
	});
	it.each([target, path.join(target, 'child'), path.resolve('unrelated')])(
		'refuses parser/map/acquisition and all fallback routing under %s',
		async (root) => {
			const hold = await reserve(root);
			try {
				for (const overrides of [
					{},
					{ permissionMode: 'full' as const },
					{ harnessControlMode: 'current' as const },
				]) {
					expect(copilot.spawn(input(overrides))).toMatchObject({
						success: false,
						error: expect.stringContaining('reserved'),
					});
				}
				expect(createOutputParser).not.toHaveBeenCalled();
				expect(processes.size).toBe(0);
				expect(connections.acquire).not.toHaveBeenCalled();
				expect(fallback).not.toHaveBeenCalled();
				expect(captureException).not.toHaveBeenCalled();
			} finally {
				hold.release();
			}
		}
	);
	it('admits before pending canonicalization and reentrant parser setup', async () => {
		const resolving = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(resolving.promise);
		const earlier = gate.reserveWorktreeCleanup(target);
		let reentrant: ReturnType<typeof gate.reserveWorktreeCleanup> | undefined;
		vi.mocked(createOutputParser).mockImplementationOnce(() => {
			reentrant = gate.reserveWorktreeCleanup(target);
			return null;
		});
		await start();
		resolving.resolve(target);
		expect(await earlier).toMatchObject({ status: 'blocked' });
		expect(await reentrant).toMatchObject({ status: 'blocked' });
		expect(session.send).toHaveBeenCalledWith({ prompt: 'fixture', mode: 'enqueue' });
		await idle();
		(await reserve()).release();
	});
	it.each([false, true])('holds reporting through settlement (rejected: %s)', async (rejected) => {
		await start();
		await blocked();
		const reporting = Promise.withResolvers<void>();
		probes.exit.mockReturnValueOnce(reporting.promise);
		await idle();
		await blocked();
		if (rejected) reporting.reject(new Error('reporting'));
		else reporting.resolve();
		await drain();
		(await reserve()).release();
	});
	it('holds pending send even after idle and reporting', async () => {
		const send = Promise.withResolvers<string>();
		session.send.mockReturnValueOnce(send.promise);
		await start();
		await idle();
		await blocked();
		send.resolve('ack');
		await drain();
		(await reserve()).release();
	});
	it.each(['resolve', 'reject'] as const)(
		'holds cancelled/deleted acquisition until %s and cleanup settle',
		async (outcome) => {
			const acquiring = Promise.withResolvers<CopilotConnectionLease>();
			connections.acquire.mockReturnValueOnce(acquiring.promise);
			const managed = await start();
			await managed.harnessControl!.close();
			processes.clear();
			await blocked();
			const closing = Promise.withResolvers<void>();
			connections.close.mockReturnValueOnce(closing.promise);
			if (outcome === 'resolve') acquiring.resolve(lease);
			else acquiring.reject(new Error('acquire'));
			await drain();
			if (outcome === 'resolve') {
				await blocked();
				closing.resolve();
				await drain();
			}
			expect(session.send).not.toHaveBeenCalled();
			expect(fallback).not.toHaveBeenCalled();
			(await reserve()).release();
		}
	);
	it.each(['permission', 'question', 'elicitation'] as const)(
		'holds pending %s after idle and refuses its late callback',
		async (kind) => {
			await start();
			const handlers = connections.acquire.mock.calls[0][1];
			const pending = Promise.withResolvers<unknown>();
			probes.interaction.mockReturnValueOnce(pending.promise);
			const invoke = () =>
				kind === 'permission'
					? handlers.onPermissionRequest({ kind: 'read' } as never, {
							sessionId: 'copilot-provider',
						})
					: kind === 'question'
						? handlers.onUserInputRequest({ question: 'Question', choices: ['yes'] })
						: handlers.onElicitationRequest({
								message: 'Question',
								requestedSchema: { type: 'object', properties: {} },
							} as never);
			const answer = invoke();
			await idle();
			await blocked();
			pending.resolve({ outcome: 'answers', answers: { answer: 'yes' } });
			await answer;
			await drain();
			const hold = await reserve();
			try {
				const before = probes.interaction.mock.calls.length;
				await expect(invoke()).rejects.toThrow('reserved');
				expect(probes.interaction).toHaveBeenCalledTimes(before);
			} finally {
				hold.release();
			}
		}
	);
	it.each(['full', 'readonly'] as const)(
		'preserves %s permission decisions with fresh callback admission',
		async (permissionMode) => {
			await start({ permissionMode });
			const approve = connections.acquire.mock.calls[0][1].onPermissionRequest;
			expect(
				await approve({ kind: 'read' } as never, { sessionId: 'copilot-provider' })
			).toMatchObject({ kind: 'approve-once' });
			expect(
				await approve({ kind: 'write' } as never, { sessionId: 'copilot-provider' })
			).toMatchObject({ kind: permissionMode === 'full' ? 'approve-once' : 'reject' });
			await idle();
			const hold = await reserve();
			try {
				await expect(
					approve({ kind: 'read' } as never, { sessionId: 'copilot-provider' })
				).rejects.toThrow('reserved');
			} finally {
				hold.release();
			}
		}
	);
	it.each([
		['steer', false],
		['interrupt', false],
		['close', false],
		['interrupt', true],
		['close', true],
	] as const)(
		'holds pending %s independently of idle and reporting (late: %s)',
		async (method, late) => {
			const managed = await start();
			if (late) await idle();
			const pending = Promise.withResolvers<never>();
			if (method === 'steer') session.send.mockReturnValueOnce(pending.promise);
			else session.abort.mockReturnValueOnce(pending.promise);
			const control =
				method === 'steer'
					? managed.harnessControl!.steer({ id: 'steer', text: 'next' })
					: managed.harnessControl![method]();
			await idle();
			await blocked();
			pending.resolve(undefined as never);
			await control;
			await drain();
			(await reserve()).release();
		}
	);
	it('refuses retained harness and SDK controls before SDK access after idle', async () => {
		const managed = await start();
		await idle();
		const hold = await reserve();
		try {
			await expect(managed.harnessControl!.steer({ id: 'late', text: 'next' })).rejects.toThrow(
				'reserved'
			);
			await expect(managed.harnessControl!.interrupt()).rejects.toThrow('reserved');
			await expect(managed.harnessControl!.close()).rejects.toThrow('reserved');
			await expect(managed.sdkController!.interrupt()).resolves.toBeUndefined();
			await expect(managed.sdkController!.kill()).resolves.toBeUndefined();
			expect(session.send).toHaveBeenCalledTimes(1);
			expect(session.abort).not.toHaveBeenCalled();
			expect(connections.close).not.toHaveBeenCalled();
			listener({ type: 'session.idle' } as SessionEvent);
			await drain();
			expect(captureException).not.toHaveBeenCalled();
		} finally {
			hold.release();
		}
	});
	it.each(['closeAll', 'closeAgent', 'closeSession'] as const)(
		'admits %s before lease mutation and holds pending shutdown',
		async (method) => {
			await start();
			await idle();
			const hold = await reserve();
			try {
				const run = () =>
					method === 'closeAll'
						? copilot.closeAll()
						: method === 'closeAgent'
							? copilot.closeAgent('agent')
							: copilot.closeSession('rpc-session');
				if (method === 'closeAll') await expect(run()).rejects.toThrow('reserved');
				else expect(run).toThrow('reserved');
				expect(connections.closeAll).not.toHaveBeenCalled();
				expect(connections.closeAgent).not.toHaveBeenCalled();
				expect(connections.close).not.toHaveBeenCalled();
			} finally {
				hold.release();
			}
			const pending = Promise.withResolvers<void>();
			const fn = method === 'closeSession' ? connections.close : connections[method];
			fn.mockReturnValueOnce(pending.promise);
			if (method === 'closeAll') void copilot.closeAll();
			else if (method === 'closeAgent') copilot.closeAgent('agent');
			else expect(copilot.closeSession('rpc-session')).toBe(true);
			await blocked();
			pending.resolve();
			await drain();
			(await reserve()).release();
		}
	);
	it('composes asynchronous setup failure with independently held fallback', async () => {
		connections.acquire.mockRejectedValueOnce(new Error('setup'));
		fallback.mockImplementationOnce(() =>
			boundary.withWorktreeTurnActivity((start, observe) => {
				observe(
					start(
						{ command: 'fallback', args: [], cwd: target, env: {} },
						{},
						{ keepStdinOpen: true, stopGraceMs: 1000 }
					).done
				);
				return { success: true, pid: 12345 };
			}, vi.fn())
		);
		await start({ permissionMode: 'full' });
		expect(fallback).toHaveBeenCalledTimes(1);
		await blocked();
		await close();
		(await reserve()).release();
	});
	it('retains a replaced generation until its own close', async () => {
		const first = await start();
		const oldListener = listener;
		await start();
		oldListener({ type: 'session.idle' } as SessionEvent);
		await idle();
		await blocked();
		await first.harnessControl!.close();
		await drain();
		(await reserve()).release();
	});
	it.each(['setup', 'run'] as const)(
		'retains %s diagnostics after fallback or turn completion for every reporter outcome',
		async (stage) => {
			for (const outcome of ['resolve', 'reject', 'throw'] as const) {
				const failure = new Error(`${stage} failure`);
				const reporting = Promise.withResolvers<void>();
				vi.mocked(captureException).mockImplementationOnce(() => {
					if (outcome === 'throw') throw new Error('report failed');
					return reporting.promise;
				});
				if (stage === 'setup') {
					vi.mocked(createOutputParser).mockImplementationOnce(() => {
						throw failure;
					});
					expect(copilot.spawn(input({ permissionMode: 'full' }))).toMatchObject({
						success: true,
						pid: 999,
					});
					expect(fallback).toHaveBeenCalledTimes(1);
					fallback.mockClear();
				} else {
					session.send.mockRejectedValueOnce(failure);
					await start();
					expect(probes.exit).toHaveBeenLastCalledWith('rpc-session', 1, expect.any(Object));
				}
				await drain();
				expect(captureException).toHaveBeenLastCalledWith(failure);
				if (outcome !== 'throw') {
					await blocked();
					if (outcome === 'resolve') reporting.resolve();
					else reporting.reject(new Error('report failed'));
				}
				await drain();
				(await reserve()).release();
			}
		}
	);
	it.each(['closeAll', 'closeAgent', 'closeSession'] as const)(
		'retains %s diagnostics after the original shutdown outcome',
		async (method) => {
			await start();
			await idle();
			const failure = new Error('shutdown failed');
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			const fn = method === 'closeSession' ? connections.close : connections[method];
			fn.mockRejectedValueOnce(failure);
			if (method === 'closeAll') await expect(copilot.closeAll()).rejects.toBe(failure);
			else if (method === 'closeAgent') expect(copilot.closeAgent('agent')).toBeUndefined();
			else expect(copilot.closeSession('rpc-session')).toBe(true);
			await drain();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			await blocked();
			reporting.resolve();
			await drain();
			(await reserve()).release();
		}
	);
	it.each(['permission', 'question', 'elicitation', 'event', 'sdkKill', 'harnessClose'] as const)(
		'retains admitted %s diagnostics and consumes reporter rejection exactly once',
		async (kind) => {
			const managed = await start();
			const handlers = connections.acquire.mock.calls[0][1];
			const failure = new Error('callback failed');
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			if (kind === 'event') {
				probes.output.mockImplementationOnce(() => {
					throw failure;
				});
				listener({
					type: 'assistant.message_delta',
					data: { deltaContent: 'text' },
				} as SessionEvent);
			}
			await idle();
			if (kind === 'sdkKill' || kind === 'harnessClose') {
				connections.close.mockRejectedValueOnce(failure);
				if (kind === 'sdkKill')
					await expect(managed.sdkController!.kill()).resolves.toBeUndefined();
				else await expect(managed.harnessControl!.close()).rejects.toBe(failure);
			} else if (kind !== 'event') {
				probes.interaction.mockRejectedValueOnce(failure);
				const answer =
					kind === 'permission'
						? handlers.onPermissionRequest({ kind: 'read' } as never, {
								sessionId: 'copilot-provider',
							})
						: kind === 'question'
							? handlers.onUserInputRequest({ question: 'Question' })
							: handlers.onElicitationRequest({
									message: 'Question',
									requestedSchema: { type: 'object', properties: {} },
								} as never);
				await expect(answer).rejects.toBe(failure);
			}
			await drain();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			await blocked();
			reporting.reject(new Error('report failed'));
			await drain();
			expect(captureException).toHaveBeenCalledTimes(1);
			(await reserve()).release();
		}
	);
	it.each(['report', 'native'] as const)(
		'keeps fallback native close independent when %s completes first',
		async (first) => {
			vi.mocked(createOutputParser).mockImplementationOnce(() => {
				throw new Error('setup');
			});
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			fallback.mockImplementationOnce(() =>
				boundary.withWorktreeTurnActivity((start, observe) => {
					observe(
						start(
							{ command: 'fallback', args: [], cwd: target, env: {} },
							{},
							{ keepStdinOpen: true, stopGraceMs: 1000 }
						).done
					);
					return { success: true, pid: 12345 };
				}, vi.fn())
			);
			expect(copilot.spawn(input({ permissionMode: 'full' }))).toMatchObject({
				success: true,
				pid: 12345,
			});
			await drain();
			if (first === 'report') reporting.resolve();
			else await close();
			await drain();
			await blocked();
			if (first === 'report') await close();
			else reporting.resolve();
			await drain();
			(await reserve()).release();
		}
	);
	it('preserves a failed fallback verdict and independently retains both failure reports', async () => {
		const original = new Error('setup');
		const failure = new Error('fallback');
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		vi.mocked(createOutputParser).mockImplementationOnce(() => {
			throw original;
		});
		vi.mocked(captureException)
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		fallback.mockImplementationOnce(() => {
			throw failure;
		});
		expect(copilot.spawn(input({ permissionMode: 'full' }))).toMatchObject({
			success: false,
			error: String(failure),
		});
		await drain();
		expect(vi.mocked(captureException).mock.calls.map(([error]) => error)).toEqual(
			expect.arrayContaining([original, failure])
		);
		first.resolve();
		await drain();
		await blocked();
		second.reject(new Error('report failed'));
		await drain();
		(await reserve()).release();
	});

	it('keeps pending canonicalization blocked until setup diagnostics settle', async () => {
		const resolving = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(resolving.promise);
		const earlier = gate.reserveWorktreeCleanup(target);
		const reporting = Promise.withResolvers<void>();
		vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
		vi.mocked(createOutputParser).mockImplementationOnce(() => {
			throw new Error('setup');
		});
		expect(copilot.spawn(input({ permissionMode: 'full' }))).toMatchObject({ success: true });
		await drain();
		resolving.resolve(target);
		expect(await earlier).toMatchObject({ status: 'blocked' });
		await blocked();
		reporting.resolve();
		await drain();
		(await reserve()).release();
	});
	it('retains independent concurrent reports across a same-session successor', async () => {
		await start();
		const handlers = connections.acquire.mock.calls[0][1];
		await idle();
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		vi.mocked(captureException)
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		probes.interaction
			.mockRejectedValueOnce(new Error('first'))
			.mockRejectedValueOnce(new Error('second'));
		await expect(handlers.onUserInputRequest({ question: 'First' })).rejects.toThrow('first');
		await expect(handlers.onUserInputRequest({ question: 'Second' })).rejects.toThrow('second');
		const successor = await start();
		await idle();
		first.resolve();
		await drain();
		await blocked();
		expect(processes.get('rpc-session')).toBe(successor);
		second.resolve();
		await drain();
		(await reserve()).release();
	});
	it('keeps failed logger recovery blocked without replacing or recursively reporting its error', async () => {
		const failure = new Error('logger failed');
		connections.acquire.mockRejectedValueOnce(new Error('setup failed'));
		vi.mocked(logger.warn).mockImplementationOnce(() => {
			throw failure;
		});
		const reporting = Promise.withResolvers<void>();
		vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
		const managed = await start({ permissionMode: 'full' });
		expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
		expect(fallback).not.toHaveBeenCalled();
		await blocked();
		reporting.reject(new Error('report failed'));
		await drain();
		// Failed recovery has no completion proof; reporter settlement cannot end it.
		await blocked();
		expect(processes.get('rpc-session')).toBe(managed);
		expect(captureException).toHaveBeenCalledTimes(1);
	});

	it('preserves actual manager unknown native ownership after idle and shutdown', async () => {
		const { CopilotSdkSpawner } =
			await import('../../../main/process-manager/spawners/CopilotSdkSpawner');
		probes.copilotClient.mockReturnValue({
			start: vi.fn().mockResolvedValue(undefined),
			createSession: vi.fn().mockResolvedValue(session),
			forceStop: vi.fn().mockResolvedValue(undefined),
		});
		copilot = new CopilotSdkSpawner(
			processes,
			new EventEmitter(),
			{} as DataBufferManager,
			fallback
		);
		await start();
		await idle();
		await copilot.closeAll();
		await drain();
		await blocked();
	});
});

const retainedStopTransports = ['rpc', 'acp', 'antigravity', 'hermes'] as const;
describe.each(retainedStopTransports)('retained %s stop controller activity', (transport) => {
	let managed: ManagedProcess;
	let active: Pick<typeof spawner, 'spawn'>;
	const cancel = transport === 'acp' ? probes.notify : probes.request;
	const input = () =>
		config({
			nativeAcpArgs: ['--acp'],
			...(transport === 'antigravity' || transport === 'hermes'
				? {
						toolType: transport,
						harnessControlMode: 'native' as const,
						...(transport === 'hermes'
							? { command: 'python', args: ['-m', 'tui_gateway.entry'] }
							: {}),
					}
				: {}),
		});
	beforeEach(async () => {
		active = spawner;
		if (transport === 'acp') {
			const app = { onRequest: vi.fn(), onNotification: vi.fn(), connect: vi.fn() };
			app.onRequest.mockReturnValue(app);
			app.onNotification.mockReturnValue(app);
			app.connect.mockImplementation(() => {
				const closed = Promise.withResolvers<void>();
				return {
					agent: { request: probes.request, notify: probes.notify },
					closed: closed.promise,
					close: () => {
						closed.resolve();
						return probes.close();
					},
				};
			});
			probes.acpClient.mockReturnValue(app);
			const replies: Record<string, unknown> = {
				initialize: { protocolVersion: 1 },
				new: { sessionId: 'acp-session' },
				prompt: { stopReason: 'end_turn' },
			};
			probes.request.mockImplementation(async (method: string) => replies[method]);
			probes.notify.mockResolvedValue(undefined);
			const { AcpServerSpawner } =
				await import('../../../main/process-manager/spawners/AcpServerSpawner');
			active = new AcpServerSpawner(
				processes,
				new EventEmitter(),
				{} as DataBufferManager,
				fallback
			);
		}
		if (transport === 'antigravity') {
			const { AntigravitySdkSpawner } =
				await import('../../../main/process-manager/spawners/AntigravitySdkSpawner');
			active = new AntigravitySdkSpawner(
				processes,
				new EventEmitter(),
				{} as DataBufferManager,
				fallback
			);
		}
		if (transport === 'hermes') {
			probes.request.mockImplementation(async (method: string) =>
				method === 'session.create' ? { session_id: 'hermes-session' } : {}
			);
			const { HermesApiSpawner } =
				await import('../../../main/process-manager/spawners/HermesApiSpawner');
			active = new HermesApiSpawner(
				processes,
				new EventEmitter(),
				{} as DataBufferManager,
				fallback
			);
		}
		expect(active.spawn(input()).success).toBe(true);
		await drain();
		managed = processes.get('rpc-session')!;
	});
	it.each([target, path.join(target, 'descendant'), path.resolve('unrelated')])(
		'refuses retained SDK/harness stops before transport, signalling or recovery under %s',
		async (root) => {
			await close();
			processes.clear();
			const hold = await reserve(root);
			for (const probe of [
				probes.request,
				probes.notify,
				stopProcess,
				captureException,
				fallback,
				spawn,
				fs.realpath,
			])
				vi.mocked(probe).mockClear();
			try {
				await expect(managed.sdkController!.interrupt()).rejects.toThrow('reserved');
				await expect(managed.sdkController!.kill()).rejects.toThrow('reserved');
				await expect(managed.harnessControl!.interrupt!()).rejects.toThrow('reserved');
				await expect(
					managed.harnessControl!.close!({ sync: true, shutdown: true })
				).rejects.toThrow('reserved');
				for (const probe of [
					probes.request,
					probes.notify,
					stopProcess,
					captureException,
					fallback,
					spawn,
					fs.realpath,
				])
					expect(probe).not.toHaveBeenCalled();
			} finally {
				hold.release();
			}
		}
	);
	it.each(['sdk-interrupt', 'sdk-kill', 'harness-interrupt', 'harness-close'] as const)(
		'owns a late pending cancellation independently after close/removal via %s',
		async (action) => {
			await close();
			processes.clear();
			(await reserve()).release();
			const pending = Promise.withResolvers<void>();
			cancel.mockReturnValueOnce(pending.promise);
			const options = { sync: true, shutdown: true };
			if (action === 'sdk-interrupt') await managed.sdkController!.interrupt();
			if (action === 'sdk-kill') await managed.sdkController!.kill(options);
			if (action === 'harness-interrupt') await managed.harnessControl!.interrupt!();
			if (action === 'harness-close') await managed.harnessControl!.close!(options);
			expect(cancel).toHaveBeenLastCalledWith(
				...(transport === 'rpc'
					? ['abort']
					: transport === 'acp'
						? ['cancel', { sessionId: 'acp-session' }]
						: transport === 'hermes'
							? ['session.interrupt', { session_id: 'hermes-session' }]
							: [action.endsWith('interrupt') ? 'interrupt' : 'close'])
			);
			expect(stopProcess).toHaveBeenLastCalledWith(
				{ child: native },
				action.endsWith('interrupt')
					? {
							from: 'interrupt',
							graceMs: 1000,
							sessionId: 'rpc-session',
							label: 'interrupt',
						}
					: transport === 'antigravity'
						? {
								from: 'terminate',
								graceMs: 1000,
								sessionId: 'rpc-session',
								label: 'close',
							}
						: {
								from: 'terminate',
								upTo: 'terminate',
								graceMs: 1000,
								immediate: true,
								blocking: true,
								sessionId: 'rpc-session',
								label: 'kill',
							}
			);
			await blocked();
			if (action.startsWith('sdk')) pending.resolve();
			else pending.reject(new Error('cancel transport closed'));
			await drain();
			(await reserve()).release();
		}
	);
	it.each(['exit', 'error'] as const)(
		'keeps the independent child hold after stop and %s',
		async (event) => {
			const pending = Promise.withResolvers<void>();
			cancel.mockReturnValueOnce(pending.promise);
			await managed.harnessControl!.close!();
			if (event === 'exit') native.emit('exit', 0, null);
			else native.emit('error', new Error('native error'));
			processes.clear();
			pending.resolve();
			await drain();
			await blocked();
			await close();
			(await reserve()).release();
		}
	);
	it('retains concurrent old controls and a replacement generation independently', async () => {
		await close();
		const first = Promise.withResolvers<void>();
		const last = Promise.withResolvers<void>();
		cancel.mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
		await managed.harnessControl!.interrupt!();
		await managed.sdkController!.kill();
		native = makeNative();
		expect(active.spawn(input()).success).toBe(true);
		await drain();
		processes.clear();
		await close();
		await blocked();
		last.reject(new Error('second cancel failed'));
		await drain();
		await blocked();
		first.resolve();
		await drain();
		(await reserve()).release();
	});
	it('admits before an earlier resolving reservation and holds its cancel RPC', async () => {
		await close();
		processes.clear();
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const reservation = gate.reserveWorktreeCleanup(target);
		const pending = Promise.withResolvers<void>();
		cancel.mockReturnValueOnce(pending.promise);
		await managed.sdkController!.interrupt();
		canonical.resolve(target);
		expect(await reservation).toMatchObject({ status: 'blocked' });
		await blocked();
		pending.resolve();
		await drain();
		(await reserve()).release();
	});
	it('preserves synchronous transport failure handling and releases settled control work', async () => {
		await close();
		processes.clear();
		const error = new Error('cancel threw synchronously');
		cancel.mockImplementationOnce(() => {
			throw error;
		});
		vi.mocked(stopProcess).mockClear();
		if (transport !== 'acp') {
			await expect(managed.sdkController!.interrupt()).rejects.toBe(error);
			expect(stopProcess).not.toHaveBeenCalled();
			expect(captureException).toHaveBeenCalledWith(error);
		} else {
			await expect(managed.sdkController!.interrupt()).resolves.toBeUndefined();
			expect(stopProcess).toHaveBeenCalledOnce();
		}
		await drain();
		(await reserve()).release();
	});
	it('retains pending cancellation after stop and diagnostic failures', async () => {
		await close();
		processes.clear();
		const pending = Promise.withResolvers<void>();
		cancel.mockReturnValueOnce(pending.promise);
		vi.mocked(stopProcess).mockImplementationOnce(() => {
			throw new Error('stop failed');
		});
		vi.mocked(captureException).mockImplementationOnce(() => {
			throw new Error('report failed');
		});
		await expect(managed.sdkController!.kill()).rejects.toThrow('stop failed');
		await blocked();
		pending.reject(new Error('cancel failed'));
		await drain();
		(await reserve()).release();
	});
});

describe('Codex steering helper activity', () => {
	let steer: typeof import('../../../main/codex-app-server/steering').steerCodexAppServerTurn;
	let handle: import('../../../main/codex-app-server/protocol').CodexAppServerProcessHandle;
	let messages: Parameters<typeof handle.onUserMessage>[0][];
	let endings: Array<() => void>;
	let offMessage: ReturnType<typeof vi.fn<() => void>>;
	let offEnd: ReturnType<typeof vi.fn<() => void>>;
	const request = { id: 'steer', text: 'adjust' };
	const echo = (index = 0) => messages[index]({ turnId: 'turn', itemId: 'echo', text: 'adjust' });
	beforeEach(async () => {
		({ steerCodexAppServerTurn: steer } = await import('../../../main/codex-app-server/steering'));
		messages = [];
		endings = [];
		offMessage = vi.fn();
		offEnd = vi.fn();
		handle = {
			threadId: 'thread',
			activeTurnId: 'turn',
			sendRequest: probes.request,
			onUserMessage: vi.fn<typeof handle.onUserMessage>((listener) => {
				messages.push(listener);
				return offMessage;
			}),
			onTurnEnd: vi.fn<typeof handle.onTurnEnd>((listener) => {
				endings.push(listener);
				return offEnd;
			}),
		};
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});
	it.each([target, path.join(target, 'descendant'), path.resolve('unrelated')])(
		'refuses standalone steering before request or handle lookup under %s',
		async (root) => {
			const lookup = vi.fn(() => 'steer');
			const input = {
				get id() {
					return lookup();
				},
				text: 'adjust',
			};
			Object.defineProperty(handle, 'threadId', { get: lookup });
			const hold = await reserve(root);
			try {
				await expect(steer(handle, input, probes.output)).rejects.toThrow('reserved');
				for (const probe of [
					lookup,
					handle.onUserMessage,
					probes.request,
					probes.output,
					captureException,
				])
					expect(probe).not.toHaveBeenCalled();
			} finally {
				hold.release();
			}
		}
	);
	it.each([true, false])(
		'retains concurrent steering requests independently, reject=%s',
		async (reject) => {
			const first = Promise.withResolvers<unknown>();
			const second = Promise.withResolvers<unknown>();
			probes.request.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
			const a = steer(handle, request, probes.output);
			const b = steer(handle, { ...request, id: 'second' }, probes.output);
			await blocked();
			first.resolve({});
			expect(await a).toMatchObject({ verdict: 'delivered' });
			await drain();
			await blocked();
			if (reject) second.reject(new Error('lost transport'));
			else second.resolve({});
			expect(await b).toMatchObject({ verdict: reject ? 'unknown' : 'delivered' });
			await drain();
			(await reserve()).release();
		}
	);
	it('blocks a pending reservation when standalone steering is freshly admitted', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const reservation = gate.reserveWorktreeCleanup(target);
		const response = Promise.withResolvers<unknown>();
		probes.request.mockReturnValueOnce(response.promise);
		const pending = steer(handle, request, probes.output);
		canonical.resolve(target);
		expect(await reservation).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'mutation-busy' }],
		});
		response.reject(new Error('cancelled'));
		expect(await pending).toMatchObject({ verdict: 'unknown' });
		await drain();
		(await reserve()).release();
	});
	it('retains an early-echo timer after native close and replacement, with delivered before verdict', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		boundary.withWorktreeTurnActivity(
			(start) =>
				start(
					{ command: 'fixture', args: [], cwd: target, env: {} },
					{},
					{ keepStdinOpen: true, stopGraceMs: 1000 }
				),
			vi.fn()
		);
		const response = Promise.withResolvers<unknown>();
		probes.request.mockReturnValueOnce(response.promise);
		const order: string[] = [];
		const pending = steer(handle, request, () => {
			order.push('verdict');
		});
		echo();
		response.resolve({});
		expect(await pending).toMatchObject({ verdict: 'delivered' });
		order.push('delivered');
		await close();
		processes.clear();
		processes.set('rpc-session', { pid: 67890 } as ManagedProcess);
		await blocked();
		expect(order).toEqual(['delivered']);
		vi.runOnlyPendingTimers();
		await drain();
		expect(order).toEqual(['delivered', 'verdict']);
		expect(offMessage).toHaveBeenCalledOnce();
		expect(offEnd).toHaveBeenCalledOnce();
		(await reserve()).release();
	});
	it('retains two deferred verdicts until each timer runs', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const timers = vi.spyOn(globalThis, 'setTimeout');
		const response = Promise.withResolvers<unknown>();
		probes.request.mockReturnValue(response.promise);
		const a = steer(handle, request, probes.output);
		const other = { ...handle, onUserMessage: handle.onUserMessage, onTurnEnd: handle.onTurnEnd };
		const b = steer(other, { ...request, id: 'second' }, probes.output);
		echo(0);
		echo(1);
		response.resolve({});
		await Promise.all([a, b]);
		await blocked();
		(timers.mock.calls[0][0] as () => void)();
		await drain();
		expect(probes.output).toHaveBeenCalledTimes(1);
		await blocked();
		(timers.mock.calls[1][0] as () => void)();
		vi.clearAllTimers();
		await drain();
		expect(probes.output).toHaveBeenCalledTimes(2);
		(await reserve()).release();
	});
	it.each(['message', 'end'] as const)(
		'refuses a retained %s callback before state lookup or recovery',
		async (kind) => {
			await steer(handle, request, probes.output);
			await drain();
			const lookup = vi.fn(() => 'turn');
			const hold = await reserve();
			try {
				const callback =
					kind === 'message'
						? () =>
								messages[0]({
									get turnId() {
										return lookup();
									},
									itemId: 'echo',
									text: 'adjust',
								})
						: endings[0];
				expect(callback).toThrow('reserved');
				for (const probe of [lookup, offMessage, offEnd, probes.output, captureException])
					expect(probe).not.toHaveBeenCalled();
			} finally {
				hold.release();
			}
			if (kind === 'message') echo();
			else endings[0]();
			expect(probes.output).toHaveBeenCalledWith(
				expect.objectContaining({ verdict: kind === 'message' ? 'absorbed' : 'dropped' })
			);
		}
	);
	it.each(['message', 'end'] as const)(
		'allows reservation after a synchronous late %s callback completes',
		async (kind) => {
			await steer(handle, request, probes.output);
			await drain();
			const canonical = Promise.withResolvers<string>();
			vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
			const pending = gate.reserveWorktreeCleanup(target);
			probes.output.mockImplementationOnce(() => {
				canonical.resolve(target);
			});
			if (kind === 'message') echo();
			else endings[0]();
			// Canonicalization resumes after the synchronous callback has completed.
			const hold = await pending;
			expect(hold.status).toBe('reserved-partially');
			if (hold.status === 'reserved-partially') hold.release();
		}
	);
	it('credits one echo once for identical concurrent steers', async () => {
		await steer(handle, request, probes.output);
		await steer(handle, { ...request, id: 'second' }, probes.output);
		echo(0);
		echo(1);
		endings[1]();
		expect(probes.output.mock.calls.map(([v]) => v.verdict)).toEqual(['absorbed', 'dropped']);
		echo(0);
		endings[0]();
		expect(probes.output).toHaveBeenCalledTimes(2);
	});
	it('returns immediate not-running when subscription reports the turn already ended', async () => {
		vi.mocked(handle.onTurnEnd).mockImplementationOnce((listener) => {
			listener();
			return offEnd;
		});
		expect(await steer(handle, request, probes.output)).toMatchObject({
			verdict: 'refused',
			refusal: 'not-running',
		});
		expect(probes.request).not.toHaveBeenCalled();
		expect(probes.output).not.toHaveBeenCalled();
		expect(offMessage).toHaveBeenCalledOnce();
		expect(offEnd).toHaveBeenCalledOnce();
		await drain();
		(await reserve()).release();
	});
	it.each(['verdict', 'unsubscribe'] as const)(
		'preserves deferred %s failure and releases its timer hold despite failed diagnostics',
		async (kind) => {
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			const response = Promise.withResolvers<unknown>();
			probes.request.mockReturnValueOnce(response.promise);
			const pending = steer(handle, request, probes.output);
			echo();
			response.resolve({});
			await pending;
			const failure = new Error(`${kind} failed`);
			(kind === 'verdict' ? probes.output : offMessage).mockImplementationOnce(() => {
				throw failure;
			});
			vi.mocked(captureException).mockImplementationOnce(() => {
				throw new Error('diagnostic failed');
			});
			expect(() => vi.runOnlyPendingTimers()).toThrow(failure);
			await drain();
			(await reserve()).release();
		}
	);
	it('releases an unscheduled timer hold and preserves scheduler failure', async () => {
		const response = Promise.withResolvers<unknown>();
		probes.request.mockReturnValueOnce(response.promise);
		const pending = steer(handle, request, probes.output);
		echo();
		const failure = new Error('schedule failed');
		vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce(() => {
			throw failure;
		});
		response.resolve({});
		await expect(pending).rejects.toBe(failure);
		await drain();
		(await reserve()).release();
	});
	it('releases setup failure without replacing it when diagnostics throw', async () => {
		const failure = new Error('handle failed');
		Object.defineProperty(handle, 'threadId', {
			get() {
				throw failure;
			},
		});
		vi.mocked(captureException).mockImplementationOnce(() => {
			throw new Error('diagnostic failed');
		});
		await expect(steer(handle, request, probes.output)).rejects.toBe(failure);
		await drain();
		(await reserve()).release();
	});
});
