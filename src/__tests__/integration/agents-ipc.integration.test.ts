import fs from 'fs/promises';
import path from 'path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshRemoteConfig } from '../../shared/types';

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
type StoreLike<T extends Record<string, unknown>> = {
	data: T;
	get: ReturnType<typeof vi.fn>;
	set: ReturnType<typeof vi.fn>;
};

const handlers = new Map<string, IpcHandler>();

let tempRoot: string;
let execFileNoThrow: ReturnType<typeof vi.fn>;
let buildSshCommand: ReturnType<typeof vi.fn>;
let detector: {
	clearCache: ReturnType<typeof vi.fn>;
	detectAgents: ReturnType<typeof vi.fn>;
	discoverModels: ReturnType<typeof vi.fn>;
	getAgent: ReturnType<typeof vi.fn>;
	setCustomPaths: ReturnType<typeof vi.fn>;
};

function createStore<T extends Record<string, unknown>>(initialData: T): StoreLike<T> {
	const store: StoreLike<T> = {
		data: initialData,
		get: vi.fn((key: string, defaultValue?: unknown) => store.data[key] ?? defaultValue),
		set: vi.fn((key: string, value: unknown) => {
			store.data[key as keyof T] = value as T[keyof T];
		}),
	};
	return store;
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
	const handler = handlers.get(channel);
	expect(handler, `Expected ${channel} to be registered`).toBeDefined();
	return (await handler!({}, ...args)) as T;
}

async function registerAgents(deps: Record<string, unknown>) {
	const { registerAgentsHandlers } = await import('../../main/ipc/handlers/agents');
	registerAgentsHandlers(deps as never);
}

function createAgent(overrides: Record<string, unknown> = {}) {
	return {
		id: 'codex',
		name: 'Codex',
		binaryName: 'codex',
		command: '/usr/local/bin/codex',
		path: '/usr/local/bin/codex',
		available: true,
		configOptions: [
			{
				key: 'model',
				label: 'Model',
				type: 'string',
				default: 'gpt-5',
				argBuilder: vi.fn(),
			},
		],
		resumeArgs: vi.fn(),
		modelArgs: vi.fn(),
		workingDirArgs: vi.fn(),
		imageArgs: vi.fn(),
		promptArgs: vi.fn(),
		...overrides,
	};
}

const remote: SshRemoteConfig = {
	id: 'remote-1',
	name: 'Remote 1',
	host: 'remote.test',
	port: 22,
	username: 'tester',
	privateKeyPath: '/tmp/no-key',
	enabled: true,
};

describe('agents IPC integration', () => {
	beforeEach(async () => {
		vi.resetModules();
		handlers.clear();
		tempRoot = await fs.mkdtemp(path.join(tmpdir(), 'maestro-agents-ipc-'));
		execFileNoThrow = vi.fn();
		buildSshCommand = vi.fn(async (_sshRemote: SshRemoteConfig, options: any) => ({
			command: 'ssh',
			args: [options.command, ...(options.args ?? [])],
		}));
		detector = {
			clearCache: vi.fn(),
			detectAgents: vi.fn(),
			discoverModels: vi.fn(),
			getAgent: vi.fn(),
			setCustomPaths: vi.fn(),
		};

		vi.doMock('electron', () => ({
			ipcMain: {
				handle: vi.fn((channel: string, handler: IpcHandler) => {
					handlers.set(channel, handler);
				}),
				removeHandler: vi.fn((channel: string) => {
					handlers.delete(channel);
				}),
			},
		}));
		vi.doMock('../../main/utils/execFile', () => ({ execFileNoThrow }));
		vi.doMock('../../main/utils/ssh-command-builder', () => ({ buildSshCommand }));
		vi.doMock('../../main/utils/logger', () => ({
			logger: {
				debug: vi.fn(),
				error: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
			},
		}));
	});

	afterEach(async () => {
		vi.clearAllTimers();
		vi.useRealTimers();
		handlers.clear();
		vi.doUnmock('electron');
		vi.doUnmock('../../main/utils/execFile');
		vi.doUnmock('../../main/utils/ssh-command-builder');
		vi.doUnmock('../../main/utils/logger');
		vi.resetModules();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it('detects local agents and strips non-serializable config functions', async () => {
		detector.detectAgents.mockResolvedValue([createAgent()]);
		detector.getAgent.mockResolvedValue(createAgent({ id: 'claude-code', binaryName: 'claude' }));
		await registerAgents({
			getAgentDetector: () => detector,
			agentConfigsStore: createStore({ configs: {} }),
		});

		const detected = await invoke<any[]>('agents:detect');
		expect(detected).toHaveLength(1);
		expect(detected[0]).toMatchObject({ id: 'codex', available: true });
		expect(detected[0].resumeArgs).toBeUndefined();
		expect(detected[0].configOptions[0].argBuilder).toBeUndefined();

		const agent = await invoke<any>('agents:get', 'claude-code');
		expect(agent.id).toBe('claude-code');
		expect(agent.modelArgs).toBeUndefined();
		expect(detector.detectAgents).toHaveBeenCalledTimes(1);
		expect(detector.getAgent).toHaveBeenCalledWith('claude-code');
	});

	it('refreshes local detection with unavailable-agent debug details', async () => {
		detector.detectAgents.mockResolvedValue([
			createAgent({ available: false, path: undefined, binaryName: 'codex' }),
		]);
		execFileNoThrow.mockResolvedValue({
			exitCode: 1,
			stdout: '',
			stderr: 'not found',
		});
		await registerAgents({
			getAgentDetector: () => detector,
			agentConfigsStore: createStore({ configs: {} }),
		});

		const refreshed = await invoke<{ agents: any[]; debugInfo: Record<string, unknown> }>(
			'agents:refresh',
			'codex'
		);

		expect(detector.clearCache).toHaveBeenCalled();
		expect(refreshed.agents[0].available).toBe(false);
		expect(refreshed.debugInfo).toMatchObject({
			agentId: 'codex',
			available: false,
			path: null,
		});
		expect(String(refreshed.debugInfo.error)).toContain('failed');
		expect(execFileNoThrow).toHaveBeenCalledWith(expect.any(String), ['codex']);

		const allRefreshed = await invoke<{ agents: any[]; debugInfo: null }>('agents:refresh');
		expect(allRefreshed.debugInfo).toBeNull();
		expect(allRefreshed.agents[0]).toMatchObject({ id: 'codex', available: false });
	});

	it('manages config, custom paths, args, and environment variables', async () => {
		const store = createStore({
			configs: {
				codex: { model: 'gpt-5.2', customPath: '/old/codex' },
				opencode: { customArgs: '--quiet', customEnvVars: { OPENCODE_DISABLE: '1' } },
			},
		});
		await registerAgents({
			getAgentDetector: () => detector,
			agentConfigsStore: store,
		});

		await expect(invoke('agents:getCapabilities', 'codex')).resolves.toMatchObject({
			supportsResume: expect.any(Boolean),
		});
		await expect(invoke('agents:getConfig', 'codex')).resolves.toMatchObject({
			model: 'gpt-5.2',
			customPath: '/old/codex',
		});
		await expect(invoke('agents:getConfigValue', 'codex', 'contextWindow')).resolves.toBe(200000);
		await expect(invoke('agents:setConfig', 'codex', { model: 'gpt-5' })).resolves.toBe(true);
		await expect(invoke('agents:setConfigValue', 'codex', 'reasoningEffort', 'high')).resolves.toBe(
			true
		);
		await expect(invoke('agents:getConfigValue', 'codex', 'reasoningEffort')).resolves.toBe('high');
		await expect(invoke('agents:setConfigValue', 'gemini', 'model', 'gemini-pro')).resolves.toBe(
			true
		);
		await expect(invoke('agents:getConfigValue', 'gemini', 'model')).resolves.toBe('gemini-pro');

		await expect(invoke('agents:setCustomPath', 'codex', '/opt/codex')).resolves.toBe(true);
		expect(detector.setCustomPaths).toHaveBeenLastCalledWith({ codex: '/opt/codex' });
		await expect(invoke('agents:getCustomPath', 'codex')).resolves.toBe('/opt/codex');
		await expect(invoke('agents:getAllCustomPaths')).resolves.toEqual({ codex: '/opt/codex' });
		await expect(invoke('agents:setCustomPath', 'codex', null)).resolves.toBe(true);
		await expect(invoke('agents:getCustomPath', 'codex')).resolves.toBeNull();
		await expect(invoke('agents:setCustomPath', 'fresh-path', '/opt/fresh')).resolves.toBe(true);
		await expect(invoke('agents:getCustomPath', 'fresh-path')).resolves.toBe('/opt/fresh');

		await expect(invoke('agents:setCustomArgs', 'codex', '  --model gpt-5  ')).resolves.toBe(true);
		await expect(invoke('agents:getCustomArgs', 'codex')).resolves.toBe('--model gpt-5');
		await expect(invoke('agents:getAllCustomArgs')).resolves.toEqual({
			codex: '--model gpt-5',
			opencode: '--quiet',
		});
		await expect(invoke('agents:setCustomArgs', 'codex', '')).resolves.toBe(true);
		await expect(invoke('agents:getCustomArgs', 'codex')).resolves.toBeNull();
		await expect(invoke('agents:setCustomArgs', 'fresh-args', ' --fast ')).resolves.toBe(true);
		await expect(invoke('agents:getCustomArgs', 'fresh-args')).resolves.toBe('--fast');

		await expect(
			invoke('agents:setCustomEnvVars', 'codex', { CODEX_HOME: '/tmp/codex' })
		).resolves.toBe(true);
		await expect(invoke('agents:getCustomEnvVars', 'codex')).resolves.toEqual({
			CODEX_HOME: '/tmp/codex',
		});
		await expect(invoke('agents:getAllCustomEnvVars')).resolves.toEqual({
			codex: { CODEX_HOME: '/tmp/codex' },
			opencode: { OPENCODE_DISABLE: '1' },
		});
		await expect(invoke('agents:setCustomEnvVars', 'codex', null)).resolves.toBe(true);
		await expect(invoke('agents:getCustomEnvVars', 'codex')).resolves.toBeNull();
		await expect(
			invoke('agents:setCustomEnvVars', 'fresh-env', { GEMINI_HOME: '/tmp/gemini' })
		).resolves.toBe(true);
		await expect(invoke('agents:getCustomEnvVars', 'fresh-env')).resolves.toEqual({
			GEMINI_HOME: '/tmp/gemini',
		});
	});

	it('detects remote agents and returns unavailable definitions for missing remotes', async () => {
		vi.useFakeTimers();
		execFileNoThrow.mockImplementation(async (_command: string, args: string[]) => {
			const binaryName = args.at(-1);
			if (binaryName === 'claude') {
				return {
					exitCode: 0,
					stdout: '\u001b[32m/usr/bin/claude\u001b[0m\n',
					stderr: '',
				};
			}
			return { exitCode: 1, stdout: '', stderr: '' };
		});
		await registerAgents({
			getAgentDetector: () => detector,
			agentConfigsStore: createStore({ configs: {} }),
			settingsStore: createStore({ sshRemotes: [remote] }),
		});

		const agents = await invoke<any[]>('agents:detect', 'remote-1');
		expect(buildSshCommand).toHaveBeenCalledWith(remote, {
			command: 'command',
			args: ['-v', 'claude'],
		});
		expect(agents.find((agent) => agent.id === 'claude-code')).toMatchObject({
			available: true,
			path: '/usr/bin/claude',
		});
		expect(agents.find((agent) => agent.id === 'codex')).toMatchObject({ available: false });

		const remoteAgent = await invoke<any>('agents:get', 'claude-code', 'remote-1');
		expect(remoteAgent).toMatchObject({
			id: 'claude-code',
			available: true,
			path: '/usr/bin/claude',
		});

		const missingRemote = await invoke<any>('agents:get', 'codex', 'missing');
		expect(missingRemote).toMatchObject({
			id: 'codex',
			available: false,
			error: 'SSH remote configuration not found: missing',
		});
	});

	it('handles remote detection connection and missing settings-store paths', async () => {
		await registerAgents({
			getAgentDetector: () => detector,
			agentConfigsStore: createStore({ configs: {} }),
		});

		const missingStoreAgents = await invoke<any[]>('agents:detect', 'remote-1');
		expect(missingStoreAgents.every((agent) => agent.available === false)).toBe(true);
		expect(missingStoreAgents[0].error).toBe('SSH remote configuration not found: remote-1');
		await expect(invoke('agents:get', 'not-real-agent', 'remote-1')).rejects.toThrow(
			'Unknown agent: not-real-agent'
		);

		handlers.clear();
		execFileNoThrow.mockResolvedValue({
			exitCode: 255,
			stdout: '',
			stderr: 'Permission denied (publickey).',
		});
		await registerAgents({
			getAgentDetector: () => detector,
			agentConfigsStore: createStore({ configs: {} }),
			settingsStore: createStore({ sshRemotes: [remote] }),
		});

		const unreachableAgents = await invoke<any[]>('agents:detect', 'remote-1');
		expect(unreachableAgents.every((agent) => agent.available === false)).toBe(true);
		expect(unreachableAgents[0].error).toBe('Permission denied (publickey).');

		const failedRemoteAgent = await invoke<any>('agents:get', 'codex', 'remote-1');
		expect(failedRemoteAgent).toMatchObject({
			id: 'codex',
			available: false,
			error: 'Permission denied (publickey).',
		});
		await expect(invoke('agents:get', 'not-real-agent', 'remote-1')).rejects.toThrow(
			'Unknown agent: not-real-agent'
		);

		buildSshCommand.mockRejectedValueOnce(new Error('ssh config failed'));
		const thrownRemoteAgent = await invoke<any>('agents:get', 'codex', 'remote-1');
		expect(thrownRemoteAgent).toMatchObject({
			id: 'codex',
			available: false,
			error: 'Failed to connect: ssh config failed',
		});
	});

	it('discovers local and remote models plus Claude slash commands', async () => {
		vi.useFakeTimers();
		const commandPath = path.join(tempRoot, 'claude');
		await fs.writeFile(commandPath, '#!/bin/sh\nexit 0\n');
		detector.discoverModels.mockResolvedValue(['gpt-5', 'gpt-5.2']);
		detector.getAgent.mockImplementation(async (agentId: string) =>
			agentId === 'claude-code'
				? createAgent({
						id: 'claude-code',
						binaryName: 'claude',
						command: commandPath,
						path: commandPath,
					})
				: createAgent({ id: agentId })
		);
		execFileNoThrow.mockImplementation(async (command: string, args: string[]) => {
			if (command === 'ssh' && args[0] === 'codex' && args[1] === 'models') {
				return { exitCode: 0, stdout: 'remote-a\nremote-b\n', stderr: '' };
			}
			if (command === commandPath) {
				return {
					exitCode: 0,
					stdout:
						'not-json\n' +
						JSON.stringify({
							type: 'system',
							subtype: 'init',
							slash_commands: ['/help', '/model'],
						}) +
						'\n',
					stderr: '',
				};
			}
			return { exitCode: 1, stdout: '', stderr: 'unexpected command' };
		});
		await registerAgents({
			getAgentDetector: () => detector,
			agentConfigsStore: createStore({ configs: {} }),
			settingsStore: createStore({ sshRemotes: [remote] }),
		});

		await expect(invoke('agents:getModels', 'codex', true)).resolves.toEqual(['gpt-5', 'gpt-5.2']);
		expect(detector.discoverModels).toHaveBeenCalledWith('codex', true);
		await expect(invoke('agents:getModels', 'codex', false, 'remote-1')).resolves.toEqual([
			'remote-a',
			'remote-b',
		]);
		await expect(invoke('agents:getModels', 'codex', false, 'remote-1')).resolves.toEqual([
			'remote-a',
			'remote-b',
		]);
		expect(execFileNoThrow).toHaveBeenCalledWith('ssh', ['codex', 'models']);

		await expect(
			invoke('agents:discoverSlashCommands', 'claude-code', tempRoot, commandPath)
		).resolves.toEqual([{ name: '/help' }, { name: '/model' }]);
		expect(execFileNoThrow).toHaveBeenCalledWith(
			commandPath,
			[
				'--print',
				'--verbose',
				'--output-format',
				'stream-json',
				'--dangerously-skip-permissions',
				'--',
				'/help',
			],
			tempRoot
		);
		await expect(invoke('agents:discoverSlashCommands', 'codex', tempRoot)).resolves.toBeNull();
	});

	it('handles remote model discovery failures and slash command fallbacks', async () => {
		vi.useFakeTimers();
		await registerAgents({
			getAgentDetector: () => detector,
			agentConfigsStore: createStore({ configs: {} }),
			settingsStore: createStore({ sshRemotes: [remote] }),
		});

		await expect(invoke('agents:getModels', 'unknown-agent', false, 'remote-1')).resolves.toEqual(
			[]
		);
		await expect(invoke('agents:getModels', 'codex', false, 'missing')).rejects.toThrow(
			'SSH remote not found: missing'
		);

		execFileNoThrow.mockResolvedValueOnce({ exitCode: 2, stdout: '', stderr: 'models failed' });
		await expect(invoke('agents:getModels', 'codex', true, 'remote-1')).resolves.toEqual([]);

		execFileNoThrow.mockImplementationOnce(
			() => new Promise<{ exitCode: number; stdout: string; stderr: string }>(() => {})
		);
		const timedOutModels = invoke<string[]>('agents:getModels', 'codex', true, 'remote-1');
		await vi.advanceTimersByTimeAsync(10_000);
		await expect(timedOutModels).resolves.toEqual([]);

		buildSshCommand.mockRejectedValueOnce(new Error('builder exploded'));
		await expect(invoke('agents:getModels', 'codex', true, 'remote-1')).rejects.toThrow(
			'builder exploded'
		);

		detector.getAgent.mockResolvedValue(createAgent({ id: 'claude-code', available: false }));
		await expect(
			invoke('agents:discoverSlashCommands', 'claude-code', tempRoot)
		).resolves.toBeNull();

		detector.getAgent.mockResolvedValue(
			createAgent({
				id: 'claude-code',
				binaryName: 'claude',
				available: true,
				command: path.join(tempRoot, 'missing-claude'),
				path: path.join(tempRoot, 'missing-claude'),
			})
		);
		await expect(
			invoke('agents:discoverSlashCommands', 'claude-code', tempRoot)
		).resolves.toBeNull();

		const commandPath = path.join(tempRoot, 'claude');
		await fs.writeFile(commandPath, '#!/bin/sh\nexit 0\n');
		detector.getAgent.mockResolvedValue(
			createAgent({
				id: 'claude-code',
				binaryName: 'claude',
				command: commandPath,
				path: commandPath,
			})
		);
		execFileNoThrow.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'boom' });
		await expect(
			invoke('agents:discoverSlashCommands', 'claude-code', tempRoot, commandPath)
		).resolves.toBeNull();

		execFileNoThrow.mockResolvedValueOnce({
			exitCode: 0,
			stdout: `\nnot-json\n${JSON.stringify({ type: 'assistant', message: 'no init' })}`,
			stderr: '',
		});
		await expect(
			invoke('agents:discoverSlashCommands', 'claude-code', tempRoot, commandPath)
		).resolves.toBeNull();

		execFileNoThrow.mockRejectedValueOnce(new Error('spawn failed'));
		await expect(
			invoke('agents:discoverSlashCommands', 'claude-code', tempRoot, commandPath)
		).resolves.toBeNull();
	});
});
