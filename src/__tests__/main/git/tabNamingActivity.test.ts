import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { ipcMain } from 'electron';
import type { AgentConfig } from '../../../main/agents';
import type {
	TabNamingConfig,
	TabNamingHandlerDependencies,
} from '../../../main/ipc/handlers/tabNaming';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('fs/promises', () => ({ default: { realpath: vi.fn() } }));
vi.mock('child_process', async (original) => ({
	...(await original<typeof import('child_process')>()),
	spawn: vi.fn(),
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/prompt-manager', () => ({ getPrompt: vi.fn(() => 'Name the tab') }));
vi.mock('../../../main/parsers/parser-factory', () => ({ createOutputParser: () => null }));
vi.mock('../../../main/utils/agent-args', () => ({
	buildAgentArgs: vi.fn(() => []),
	applyAgentConfigOverrides: vi.fn((_agent, args) => ({ args })),
}));
vi.mock('../../../main/agents/resolveClaudeSpawnMode', () => ({
	resolveClaudeSpawnMode: () => ({ mode: 'api' }),
	buildRemoteInteractiveSpawn: () => null,
}));
vi.mock('../../../main/agents/probeRemoteMaestroP', () => ({
	ensureRemoteMaestroPProbed: vi.fn(async () => true),
}));
vi.mock('../../../main/utils/ssh-remote-resolver', () => ({
	getSshRemoteConfig: vi.fn(() => ({ config: null, source: 'none' })),
	createSshRemoteStoreAdapter: vi.fn(),
}));
vi.mock('../../../main/utils/ssh-command-builder', () => ({ buildSshCommand: vi.fn() }));
vi.mock('../../../shared/platformDetection', () => ({ isWindows: () => false }));

import { logger } from '../../../main/utils/logger';
import { buildAgentArgs } from '../../../main/utils/agent-args';
import { getSshRemoteConfig } from '../../../main/utils/ssh-remote-resolver';
import { buildSshCommand } from '../../../main/utils/ssh-command-builder';
import { ensureRemoteMaestroPProbed } from '../../../main/agents/probeRemoteMaestroP';

describe('shared tab naming request activity', () => {
	const target = path.resolve('naming-target');
	const config: TabNamingConfig = {
		userMessage: 'Repair login',
		agentType: 'codex',
		cwd: target,
		useUtilityAgent: false,
	};
	const agent = { id: 'codex', command: 'codex', args: [] } as unknown as AgentConfig;
	const drain = () => new Promise(setImmediate);
	let gate: typeof import('../../../main/git/worktreeActivity');
	let naming: typeof import('../../../main/ipc/handlers/tabNaming');
	let turns: typeof import('../../../main/git/worktreeTurnActivity');
	let bus: EventEmitter;
	let children: EventEmitter[];
	let releases: Array<() => void>;
	let controllers: AbortController[];
	let active: number;
	let deps: TabNamingHandlerDependencies;
	let detector: { getAgent: ReturnType<typeof vi.fn> };
	let manager: EventEmitter & {
		spawn: ReturnType<typeof vi.fn>;
		kill: ReturnType<typeof vi.fn>;
	};
	const id = (index = 0): string => manager.spawn.mock.calls[index][0].sessionId;
	const request = (overrides: Partial<TabNamingConfig> = {}) => {
		const controller = new AbortController();
		controllers.push(controller);
		return naming.generateTabName(deps, { ...config, ...overrides }, controller.signal);
	};
	const finish = (index = 0) => {
		bus.emit('data', id(index), 'Login Repair');
		bus.emit('exit', id(index), 0);
	};
	async function reserve(root = target) {
		const hold = await gate.reserveWorktreeCleanup(root);
		if (hold.status === 'reserved-partially') releases.push(hold.release);
		return hold;
	}
	async function idle() {
		const hold = await reserve();
		expect(hold.status).toBe('reserved-partially');
		if (hold.status !== 'reserved-partially') throw new Error('Expected partial reservation');
		expect(hold.blockers.map((b) => b.message).join(' ')).toMatch(/native.*registration.*OS/);
		hold.release();
	}
	const blocked = async () =>
		expect(await reserve()).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'mutation-busy' }],
		});
	beforeEach(async () => {
		vi.resetModules();
		vi.resetAllMocks();
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
		active = 0;
		releases = [];
		children = [];
		controllers = [];
		vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
		vi.mocked(getSshRemoteConfig).mockReturnValue({ config: null, source: 'none' });
		vi.mocked(buildSshCommand).mockResolvedValue({ command: 'ssh', args: [] });
		vi.mocked(ensureRemoteMaestroPProbed).mockResolvedValue(true);
		vi.mocked(buildAgentArgs).mockReturnValue([]);
		const { applyAgentConfigOverrides } = await import('../../../main/utils/agent-args');
		vi.mocked(applyAgentConfigOverrides).mockReturnValue({
			args: [],
			customArgsSource: 'none',
			customEnvSource: 'none',
			modelSource: 'default',
		});
		gate = await import('../../../main/git/worktreeActivity');
		const admit = gate.beginGlobalWorktreeActivity;
		vi.spyOn(gate, 'beginGlobalWorktreeActivity').mockImplementation(() => {
			const release = admit();
			active++;
			let released = false;
			return () => {
				if (!released) active--;
				released = true;
				release();
			};
		});
		naming = await import('../../../main/ipc/handlers/tabNaming');
		turns = await import('../../../main/git/worktreeTurnActivity');
		bus = new EventEmitter();
		manager = Object.assign(bus, {
			spawn: vi.fn(() => ({ success: true, pid: 123 })),
			kill: vi.fn(),
		});
		detector = { getAgent: vi.fn(async () => agent) };
		deps = {
			getProcessManager: vi.fn(() => manager),
			getAgentDetector: vi.fn(() => detector),
			agentConfigsStore: { get: vi.fn((_key, fallback) => fallback) },
			settingsStore: { get: vi.fn((_key, fallback) => fallback) },
		} as unknown as TabNamingHandlerDependencies;
	});
	afterEach(async () => {
		for (const release of releases) release();
		for (const controller of controllers) controller.abort();
		for (const child of children) child.emit('close');
		await drain();
		expect(active).toBe(0);
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it.each(['shared', 'ipc'] as const)('refuses %s entry before setup or recovery', async (mode) => {
		naming.registerTabNamingHandlers(deps);
		vi.mocked(logger.info).mockClear();
		const read = vi.fn(() => {
			throw new Error('Unexpected config read');
		});
		const input = new Proxy(config, { get: read });
		await reserve();
		const result =
			mode === 'shared'
				? naming.generateTabName(deps, input)
				: vi.mocked(ipcMain.handle).mock.calls[0][1]({} as never, input);
		await expect(result).rejects.toThrow(/reserved/);
		for (const work of [
			read,
			deps.getProcessManager,
			deps.getAgentDetector,
			deps.settingsStore.get,
			detector.getAgent,
			buildAgentArgs,
			getSshRemoteConfig,
			buildSshCommand,
			manager.spawn,
			manager.kill,
			logger.info,
		])
			expect(work).not.toHaveBeenCalled();
	});
	it.each([target, path.join(target, 'child'), path.resolve('other-repository')])(
		'refuses even aborted requests under %s and permits retry',
		async (root) => {
			const hold = await reserve(root);
			const signal = new AbortController();
			signal.abort();
			await expect(naming.generateTabName(deps, config, signal.signal)).rejects.toThrow(/reserved/);
			expect(deps.getProcessManager).not.toHaveBeenCalled();
			hold.status === 'reserved-partially' && hold.release();
			const result = request();
			await drain();
			finish();
			await expect(result).resolves.toBe('Login Repair');
			await idle();
		}
	);
	it('admits before dependency inspection and preserves dependency errors', async () => {
		const failure = new Error('manager lookup failed');
		const levels: number[] = [];
		vi.mocked(deps.getProcessManager).mockImplementation(() => {
			levels.push(active);
			throw failure;
		});
		await expect(request()).rejects.toThrow(failure);
		expect(levels).toEqual([1]);
		expect(manager.kill).not.toHaveBeenCalled();
		await idle();
	});
	it.each(['missing', 'error', 'aborted'] as const)(
		'holds pending provider detection through %s completion',
		async (mode) => {
			const pending = Promise.withResolvers<AgentConfig | null>();
			detector.getAgent.mockReturnValueOnce(pending.promise);
			const result = request();
			await blocked();
			if (mode === 'aborted') {
				controllers[0].abort();
				await blocked();
			}
			if (mode === 'error') pending.reject(new Error('detection failed'));
			else pending.resolve(mode === 'missing' ? null : agent);
			await expect(result).resolves.toBeNull();
			expect(manager.spawn).not.toHaveBeenCalled();
			await idle();
		}
	);
	it.each(['probe', 'command'] as const)('holds asynchronous SSH %s setup', async (stage) => {
		vi.mocked(getSshRemoteConfig).mockReturnValue({
			config: { id: 'remote', host: 'remote.example', port: 22 } as never,
			source: 'session',
		});
		detector.getAgent.mockResolvedValue({ ...agent, id: 'claude-code' });
		const pending = Promise.withResolvers<never>();
		if (stage === 'probe')
			vi.mocked(ensureRemoteMaestroPProbed).mockReturnValueOnce(pending.promise);
		else vi.mocked(buildSshCommand).mockReturnValueOnce(pending.promise);
		const result = request({
			agentType: 'claude-code',
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote' },
		});
		await drain();
		await blocked();
		pending.reject(new Error('SSH setup failed'));
		const levels: number[] = [];
		manager.kill.mockImplementation(() => {
			levels.push(active);
		});
		await expect(result).resolves.toBeNull();
		expect(manager.spawn).not.toHaveBeenCalled();
		expect(manager.kill).toHaveBeenCalledOnce();
		expect(levels).toEqual([1]);
		await idle();
	});
	it('blocks a pending reservation during asynchronous naming setup', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const hold = reserve();
		const result = request();
		canonical.resolve(target);
		expect(await hold).toMatchObject({ status: 'blocked' });
		await drain();
		finish();
		await result;
		await idle();
	});
	it.each(['early', 'exit', 'abort', 'timeout'] as const)(
		'retains independent native ownership after %s naming completion',
		async (mode) => {
			vi.mocked(spawn).mockImplementation(() => {
				const child = new EventEmitter();
				child.on('error', () => {});
				children.push(child);
				return child as ReturnType<typeof spawn>;
			});
			manager.spawn.mockImplementation(() =>
				turns.withWorktreeTurnActivity(
					(_start, _observe, nativeSpawn) => {
						nativeSpawn('provider', [], {});
						return { success: true, pid: 123 };
					},
					() => {}
				)
			);
			const levels: number[] = [];
			manager.kill.mockImplementation(() => {
				levels.push(active);
				throw new Error('kill incomplete');
			});
			const result = request();
			await drain();
			await blocked();
			if (mode === 'exit') finish();
			else if (mode === 'abort') controllers[0].abort();
			else if (mode === 'timeout') await vi.advanceTimersByTimeAsync(120000);
			else {
				bus.emit('data', id(), 'Login Repair');
				await vi.advanceTimersByTimeAsync(2000);
			}
			await expect(result).resolves.toBe(
				mode === 'exit' || mode === 'early' ? 'Login Repair' : null
			);
			expect(levels).toEqual([2]);
			expect(bus.eventNames()).toEqual([]);
			expect(vi.getTimerCount()).toBe(0);
			expect(active).toBe(1);
			await blocked();
			children[0].emit('error', new Error('not close'));
			await blocked();
			children[0].emit('close');
			await idle();
		}
	);
	it('holds the outer request across provider effort retry setup', async () => {
		const result = request({ agentType: 'claude-code' });
		await drain();
		const retry = Promise.withResolvers<AgentConfig | null>();
		detector.getAgent.mockReturnValueOnce(retry.promise);
		bus.emit(
			'data',
			id(),
			"Unsupported value: 'low' is not supported with the 'fixture' model. Supported values are: 'medium', 'high'. reasoning.effort"
		);
		bus.emit('exit', id(), 1);
		expect(manager.spawn).toHaveBeenCalledOnce();
		await blocked();
		expect(active).toBe(2);
		retry.resolve(agent);
		await drain();
		finish(1);
		await expect(result).resolves.toBe('Login Repair');
		await idle();
	});
	it('settles independent naming requests without releasing another request', async () => {
		const first = request();
		const second = request();
		await drain();
		finish();
		await first;
		await blocked();
		finish(1);
		await second;
		await idle();
	});
	it.each(['spawn', 'setup', 'aborted'] as const)(
		'releases after %s without native launch',
		async (mode) => {
			if (mode === 'spawn')
				manager.spawn.mockImplementation(() => {
					throw Object.assign(new Error('missing'), { code: 'ENOENT' });
				});
			if (mode === 'setup')
				vi.mocked(buildAgentArgs).mockImplementation(() => {
					throw new Error('arguments failed');
				});
			if (mode === 'aborted') {
				const controller = new AbortController();
				controller.abort();
				await expect(naming.generateTabName(deps, config, controller.signal)).resolves.toBeNull();
			} else await expect(request()).resolves.toBeNull();
			await idle();
		}
	);
});
