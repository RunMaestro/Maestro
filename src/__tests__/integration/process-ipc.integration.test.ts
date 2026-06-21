import os from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshRemoteConfig } from '../../shared/types';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
type StoreData = Record<string, unknown>;
type StoreLike<T extends StoreData> = {
	data: T;
	get: ReturnType<typeof vi.fn>;
	set: ReturnType<typeof vi.fn>;
};

const handlers = new Map<string, Handler>();

let processManager: {
	spawn: ReturnType<typeof vi.fn>;
	write: ReturnType<typeof vi.fn>;
	interrupt: ReturnType<typeof vi.fn>;
	kill: ReturnType<typeof vi.fn>;
	resize: ReturnType<typeof vi.fn>;
	getAll: ReturnType<typeof vi.fn>;
	runCommand: ReturnType<typeof vi.fn>;
};
let agentDetector: {
	getAgent: ReturnType<typeof vi.fn>;
};
let agentConfigsStore: StoreLike<{ configs: Record<string, Record<string, unknown>> }>;
let settingsStore: StoreLike<{
	defaultShell?: string;
	customShellPath?: string;
	shellArgs?: string;
	shellEnvVars?: Record<string, string>;
	sshRemotes?: SshRemoteConfig[];
}>;
let mainWindow: {
	isDestroyed: ReturnType<typeof vi.fn>;
	webContents: {
		isDestroyed: ReturnType<typeof vi.fn>;
		send: ReturnType<typeof vi.fn>;
	};
};
let addBreadcrumb: ReturnType<typeof vi.fn>;
let buildAgentArgs: ReturnType<typeof vi.fn>;
let applyAgentConfigOverrides: ReturnType<typeof vi.fn>;
let getContextWindowValue: ReturnType<typeof vi.fn>;
let buildSshCommandWithStdin: ReturnType<typeof vi.fn>;
let buildStreamJsonMessage: ReturnType<typeof vi.fn>;
let addBlockReason: ReturnType<typeof vi.fn>;
let isWindowsValue: boolean;

const sshRemote: SshRemoteConfig = {
	id: 'remote-1',
	name: 'Dev Remote',
	host: 'dev.example.test',
	port: 2222,
	username: 'dev',
	privateKeyPath: '/keys/dev',
	enabled: true,
	remoteEnv: { REMOTE_ONLY: '1' },
};

function createStore<T extends StoreData>(initialData: T): StoreLike<T> {
	const store: StoreLike<T> = {
		data: initialData,
		get: vi.fn((key: string, defaultValue?: unknown) => store.data[key] ?? defaultValue),
		set: vi.fn((key: string, value: unknown) => {
			store.data[key as keyof T] = value as T[keyof T];
		}),
	};
	return store;
}

function createAgent(overrides: Record<string, unknown> = {}) {
	return {
		id: 'codex',
		name: 'Codex',
		binaryName: 'codex',
		command: 'codex',
		path: '/usr/local/bin/codex',
		requiresPty: false,
		readOnlyEnvOverrides: { OPENCODE_PERMISSION: 'read-only' },
		capabilities: {
			supportsStreamJsonInput: false,
		},
		imageArgs: vi.fn((images: string[]) =>
			images.flatMap((_, index) => ['-i', `/tmp/${index}.png`])
		),
		promptArgs: vi.fn((prompt: string) => ['-p', prompt]),
		...overrides,
	};
}

async function registerProcessHandlers(overrides: Record<string, unknown> = {}) {
	const { registerProcessHandlers } = await import('../../main/ipc/handlers/process');
	registerProcessHandlers({
		getProcessManager: () => processManager,
		getAgentDetector: () => agentDetector,
		agentConfigsStore,
		settingsStore,
		getMainWindow: () => mainWindow as never,
		sessionsStore: createStore({ sessions: [] }),
		...overrides,
	} as never);
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
	const handler = handlers.get(channel);
	expect(handler, `Expected ${channel} to be registered`).toBeDefined();
	return (await handler!({}, ...args)) as T;
}

describe('process IPC integration', () => {
	beforeEach(async () => {
		vi.resetModules();
		handlers.clear();
		addBreadcrumb = vi.fn().mockResolvedValue(undefined);
		addBlockReason = vi.fn();
		buildAgentArgs = vi.fn((_agent, opts) => [
			...(opts.baseArgs ?? []),
			...(opts.agentSessionId ? ['--resume', opts.agentSessionId] : []),
			...(opts.modelId ? ['--model', opts.modelId] : []),
		]);
		applyAgentConfigOverrides = vi.fn((_agent, args, opts) => ({
			args: [...args, ...(opts.sessionCustomArgs ? opts.sessionCustomArgs.split(/\s+/) : [])],
			modelSource: opts.sessionCustomModel ? 'session' : 'none',
			customArgsSource: opts.sessionCustomArgs ? 'session' : 'none',
			customEnvSource: opts.sessionCustomEnvVars ? 'session' : 'none',
			effectiveCustomEnvVars: opts.sessionCustomEnvVars,
		}));
		getContextWindowValue = vi.fn(
			(_agent, _agentConfigValues, sessionValue) => sessionValue ?? 400000
		);
		buildStreamJsonMessage = vi.fn(
			(prompt: string, images: string[]) => `stream-json:${prompt}:${images.length}`
		);
		buildSshCommandWithStdin = vi.fn(async (remote: SshRemoteConfig, options: any) => ({
			command: 'ssh',
			args: ['-p', String(remote.port), `${remote.username}@${remote.host}`, '/bin/bash'],
			stdinScript: [
				`cd ${options.cwd}`,
				`exec ${options.command} ${(options.args ?? []).join(' ')}`,
				options.stdinInput ?? '',
			].join('\n'),
		}));
		isWindowsValue = false;

		processManager = {
			spawn: vi.fn().mockReturnValue({ pid: 1234, success: true }),
			write: vi.fn().mockReturnValue(true),
			interrupt: vi.fn().mockReturnValue(true),
			kill: vi.fn().mockReturnValue(true),
			resize: vi.fn().mockReturnValue(true),
			getAll: vi.fn().mockReturnValue([]),
			runCommand: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' }),
		};
		agentDetector = {
			getAgent: vi.fn().mockResolvedValue(createAgent()),
		};
		agentConfigsStore = createStore({ configs: { codex: { model: 'gpt-5' } } });
		settingsStore = createStore({
			defaultShell: 'zsh',
			customShellPath: '',
			shellArgs: '',
			shellEnvVars: {},
			sshRemotes: [],
		});
		mainWindow = {
			isDestroyed: vi.fn().mockReturnValue(false),
			webContents: {
				isDestroyed: vi.fn().mockReturnValue(false),
				send: vi.fn(),
			},
		};

		vi.doMock('electron', () => ({
			ipcMain: {
				handle: vi.fn((channel: string, handler: Handler) => {
					handlers.set(channel, handler);
				}),
				removeHandler: vi.fn((channel: string) => {
					handlers.delete(channel);
				}),
			},
			BrowserWindow: class {},
		}));
		vi.doMock('node-pty', () => ({ spawn: vi.fn() }));
		vi.doMock('../../main/process-manager', () => ({ ProcessManager: class {} }));
		vi.doMock('../../main/agents', () => ({ AgentDetector: class {} }));
		vi.doMock('../../main/utils/logger', () => ({
			logger: {
				debug: vi.fn(),
				error: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
			},
		}));
		vi.doMock('../../main/utils/sentry', () => ({ addBreadcrumb }));
		vi.doMock('../../main/power-manager', () => ({ powerManager: { addBlockReason } }));
		vi.doMock('../../main/utils/agent-args', () => ({
			buildAgentArgs,
			applyAgentConfigOverrides,
			getContextWindowValue,
		}));
		vi.doMock('../../main/process-manager/utils/streamJsonBuilder', () => ({
			buildStreamJsonMessage,
		}));
		vi.doMock('../../main/utils/ssh-command-builder', () => ({
			buildSshCommandWithStdin,
		}));
		vi.doMock('../../shared/platformDetection', () => ({
			isWindows: () => isWindowsValue,
		}));
	});

	afterEach(() => {
		handlers.clear();
		vi.doUnmock('electron');
		vi.doUnmock('node-pty');
		vi.doUnmock('../../main/process-manager');
		vi.doUnmock('../../main/agents');
		vi.doUnmock('../../main/utils/logger');
		vi.doUnmock('../../main/utils/sentry');
		vi.doUnmock('../../main/power-manager');
		vi.doUnmock('../../main/utils/agent-args');
		vi.doUnmock('../../main/process-manager/utils/streamJsonBuilder');
		vi.doUnmock('../../main/utils/ssh-command-builder');
		vi.doUnmock('../../shared/platformDetection');
		vi.resetModules();
	});

	it('registers process channels and routes lifecycle operations through the process manager', async () => {
		processManager.getAll.mockReturnValue([
			{
				sessionId: 'agent-1',
				toolType: 'codex',
				pid: 222,
				cwd: '/workspace/app',
				isTerminal: false,
				isBatchMode: true,
				startTime: 1700000000000,
				command: 'codex',
				args: ['exec'],
				childProcess: { nonSerializable: true },
			},
		]);
		await registerProcessHandlers();

		expect([...handlers.keys()].sort()).toEqual([
			'process:getActiveProcesses',
			'process:interrupt',
			'process:isTerminalBusy',
			'process:kill',
			'process:resize',
			'process:runCommand',
			'process:spawn',
			'process:spawnTerminalTab',
			'process:write',
		]);
		await expect(invoke('process:write', 'agent-1', 'hello\n')).resolves.toBe(true);
		await expect(invoke('process:interrupt', 'agent-1')).resolves.toBe(true);
		await expect(invoke('process:kill', 'agent-1')).resolves.toBe(true);
		await expect(invoke('process:resize', 'agent-1', 120, 40)).resolves.toBe(true);
		await expect(invoke('process:getActiveProcesses')).resolves.toEqual([
			{
				sessionId: 'agent-1',
				toolType: 'codex',
				pid: 222,
				cwd: '/workspace/app',
				isTerminal: false,
				isBatchMode: true,
				startTime: 1700000000000,
				command: 'codex',
				args: ['exec'],
			},
		]);
		await expect(
			invoke('process:runCommand', {
				sessionId: 'cmd-1',
				command: 'npm test',
				cwd: '/workspace/app',
			})
		).resolves.toEqual({ exitCode: 0, stdout: 'ok', stderr: '' });

		expect(processManager.write).toHaveBeenCalledWith('agent-1', 'hello\n');
		expect(processManager.interrupt).toHaveBeenCalledWith('agent-1');
		expect(processManager.kill).toHaveBeenCalledWith('agent-1');
		expect(processManager.resize).toHaveBeenCalledWith('agent-1', 120, 40);
		expect(processManager.runCommand).toHaveBeenCalledWith(
			'cmd-1',
			'npm test',
			'/workspace/app',
			'zsh',
			{},
			null
		);
		expect(addBreadcrumb).toHaveBeenCalledWith('agent', 'Kill: agent-1', { sessionId: 'agent-1' });
	});

	it('spawns local agent sessions with config overrides, global env, power blocking, and renderer SSH status', async () => {
		settingsStore.data.shellEnvVars = { GLOBAL_TOKEN: 'set' };
		agentDetector.getAgent.mockResolvedValue(
			createAgent({
				requiresPty: true,
			})
		);
		await registerProcessHandlers();

		const result = await invoke<any>('process:spawn', {
			sessionId: 'agent-local',
			toolType: 'codex',
			cwd: '/workspace/app',
			command: 'codex',
			args: ['exec'],
			prompt: 'Summarize this',
			agentSessionId: 'resume-1',
			readOnlyMode: true,
			yoloMode: true,
			modelId: 'gpt-5.2',
			sessionCustomPath: '/opt/bin/codex',
			sessionCustomArgs: '--approval never',
			sessionCustomEnvVars: { SESSION_TOKEN: 'secret' },
			sessionCustomModel: 'gpt-5.2',
			sessionCustomContextWindow: 128000,
		});

		expect(result).toEqual({ pid: 1234, success: true, sshRemote: undefined });
		expect(buildAgentArgs).toHaveBeenCalledWith(expect.any(Object), {
			baseArgs: ['exec'],
			prompt: 'Summarize this',
			cwd: '/workspace/app',
			readOnlyMode: true,
			modelId: 'gpt-5.2',
			yoloMode: true,
			agentSessionId: 'resume-1',
		});
		expect(processManager.spawn).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'agent-local',
				command: '/opt/bin/codex',
				args: ['exec', '--resume', 'resume-1', '--model', 'gpt-5.2', '--approval', 'never'],
				cwd: '/workspace/app',
				requiresPty: true,
				prompt: 'Summarize this',
				shellEnvVars: { GLOBAL_TOKEN: 'set' },
				customEnvVars: {
					SESSION_TOKEN: 'secret',
					OPENCODE_PERMISSION: 'read-only',
				},
				contextWindow: 128000,
				projectPath: '/workspace/app',
			})
		);
		expect(addBreadcrumb).toHaveBeenCalledWith(
			'agent',
			'Spawn: codex',
			expect.objectContaining({ sessionId: 'agent-local' })
		);
		expect(addBlockReason).toHaveBeenCalledWith('session:agent-local');
		expect(mainWindow.webContents.send).toHaveBeenCalledWith(
			'process:ssh-remote',
			'agent-local',
			null
		);
	});

	it('spawns terminal sessions with configured shell settings without AI power blocking', async () => {
		settingsStore.data.defaultShell = 'fish';
		settingsStore.data.customShellPath = '/opt/homebrew/bin/fish';
		settingsStore.data.shellArgs = '-l';
		settingsStore.data.shellEnvVars = { PATH_HINT: '/opt/bin' };
		agentDetector.getAgent.mockResolvedValue(createAgent({ id: 'terminal', requiresPty: true }));
		await registerProcessHandlers();

		await invoke('process:spawn', {
			sessionId: 'terminal-1',
			toolType: 'terminal',
			cwd: '/workspace/app',
			command: '/bin/zsh',
			args: [],
		});

		expect(processManager.spawn).toHaveBeenCalledWith(
			expect.objectContaining({
				command: '/bin/zsh',
				requiresPty: true,
				shell: '/opt/homebrew/bin/fish',
				shellArgs: '-l',
				shellEnvVars: { PATH_HINT: '/opt/bin' },
			})
		);
		expect(addBlockReason).not.toHaveBeenCalled();
	});

	it('forces shell execution for local agent spawns on Windows', async () => {
		isWindowsValue = true;
		settingsStore.data.customShellPath = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
		await registerProcessHandlers();

		await invoke('process:spawn', {
			sessionId: 'windows-agent',
			toolType: 'codex',
			cwd: 'C:\\workspace\\app',
			command: 'codex',
			args: ['exec', '--session', 'session-from-args'],
			prompt: `${'x'.repeat(520)}#\nnext`,
			sessionCustomEnvVars: { WINDOWS_TOKEN: 'set' },
		});

		expect(processManager.spawn).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'windows-agent',
				command: 'codex',
				runInShell: true,
				shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
				customEnvVars: expect.objectContaining({ WINDOWS_TOKEN: 'set' }),
			})
		);
	});

	it('wraps non-terminal agent spawns in SSH stdin execution when a session remote is enabled', async () => {
		settingsStore.data.sshRemotes = [sshRemote];
		settingsStore.data.shellEnvVars = { GLOBAL_TOKEN: 'set' };
		agentDetector.getAgent.mockResolvedValue(
			createAgent({
				id: 'claude-code',
				binaryName: 'claude',
				requiresPty: true,
				capabilities: { supportsStreamJsonInput: true },
			})
		);
		await registerProcessHandlers();

		const result = await invoke<any>('process:spawn', {
			sessionId: 'remote-agent',
			toolType: 'claude-code',
			cwd: '/remote/workspace',
			command: '/local/bin/claude',
			args: ['--print'],
			prompt: 'Review this image',
			images: ['data:image/png;base64,abc'],
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
			},
		});

		expect(result.sshRemote).toEqual({
			id: 'remote-1',
			name: 'Dev Remote',
			host: 'dev.example.test',
		});
		expect(buildStreamJsonMessage).toHaveBeenCalledWith('Review this image', [
			'data:image/png;base64,abc',
		]);
		expect(buildSshCommandWithStdin).toHaveBeenCalledWith(
			sshRemote,
			expect.objectContaining({
				command: 'claude',
				args: ['--print', '--input-format', 'stream-json'],
				cwd: '/remote/workspace',
				env: { GLOBAL_TOKEN: 'set' },
				stdinInput: 'stream-json:Review this image:1\n',
			})
		);
		expect(processManager.spawn).toHaveBeenCalledWith(
			expect.objectContaining({
				command: 'ssh',
				cwd: os.homedir(),
				requiresPty: false,
				prompt: undefined,
				runInShell: false,
				shell: undefined,
				customEnvVars: undefined,
				sshRemoteId: 'remote-1',
				sshRemoteHost: 'dev.example.test',
				sshStdinScript: expect.stringContaining('exec claude --print --input-format stream-json'),
			})
		);
		expect(mainWindow.webContents.send).toHaveBeenCalledWith('process:ssh-remote', 'remote-agent', {
			id: 'remote-1',
			name: 'Dev Remote',
			host: 'dev.example.test',
		});
	});

	it('runs commands with custom shell settings and resolved SSH remotes', async () => {
		settingsStore.data.defaultShell = 'bash';
		settingsStore.data.customShellPath = '/bin/zsh';
		settingsStore.data.shellEnvVars = { TERM_VAR: '1' };
		settingsStore.data.sshRemotes = [sshRemote];
		await registerProcessHandlers();

		await invoke('process:runCommand', {
			sessionId: 'remote-cmd',
			command: 'npm test',
			cwd: '/remote/workspace',
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
			},
		});

		expect(processManager.runCommand).toHaveBeenCalledWith(
			'remote-cmd',
			'npm test',
			'/remote/workspace',
			'/bin/zsh',
			{ TERM_VAR: '1' },
			expect.objectContaining({ id: 'remote-1', host: 'dev.example.test' })
		);
	});

	it('surfaces missing process manager and agent detector dependencies', async () => {
		await registerProcessHandlers({ getProcessManager: () => null });
		await expect(invoke('process:write', 'missing', 'data')).rejects.toThrow('Process manager');

		handlers.clear();
		await registerProcessHandlers({ getAgentDetector: () => null });
		await expect(
			invoke('process:spawn', {
				sessionId: 'agent-missing',
				toolType: 'codex',
				cwd: '/workspace/app',
				command: 'codex',
				args: [],
			})
		).rejects.toThrow('Agent detector');
	});
});
