import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (event: unknown, ...args: unknown[]) => void;

const listeners = new Map<string, Listener>();

let invoke: ReturnType<typeof vi.fn>;
let on: ReturnType<typeof vi.fn>;
let removeListener: ReturnType<typeof vi.fn>;
let send: ReturnType<typeof vi.fn>;
let api: Awaited<ReturnType<typeof loadProcessApi>>;

async function loadProcessApi() {
	const { createProcessApi } = await import('../../main/preload/process');
	return createProcessApi();
}

function emit(channel: string, ...args: unknown[]) {
	const handler = listeners.get(channel);
	expect(handler, `Expected ${channel} listener to be registered`).toBeDefined();
	handler!({}, ...args);
}

describe('process preload integration', () => {
	beforeEach(async () => {
		vi.resetModules();
		listeners.clear();
		invoke = vi.fn().mockResolvedValue({ ok: true });
		on = vi.fn((channel: string, handler: Listener) => {
			listeners.set(channel, handler);
		});
		removeListener = vi.fn((channel: string, handler: Listener) => {
			if (listeners.get(channel) === handler) listeners.delete(channel);
		});
		send = vi.fn();

		vi.doMock('electron', () => ({
			ipcRenderer: {
				invoke,
				on,
				removeListener,
				send,
			},
		}));

		api = await loadProcessApi();
	});

	afterEach(() => {
		listeners.clear();
		vi.doUnmock('electron');
		vi.resetModules();
	});

	it('invokes process lifecycle IPC channels and sends remote tab responses', async () => {
		const spawnConfig = {
			sessionId: 'session-1',
			toolType: 'codex',
			cwd: '/workspace/app',
			command: 'codex',
			args: ['exec'],
		};
		const commandConfig = {
			sessionId: 'session-1',
			command: 'npm test',
			cwd: '/workspace/app',
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		};
		invoke
			.mockResolvedValueOnce({ pid: 123, success: true })
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce({ exitCode: 0 })
			.mockResolvedValueOnce([{ sessionId: 'session-1', pid: 123 }]);

		await expect(api.spawn(spawnConfig)).resolves.toEqual({ pid: 123, success: true });
		await expect(api.write('session-1', 'hello\n')).resolves.toBe(true);
		await expect(api.interrupt('session-1')).resolves.toBe(true);
		await expect(api.kill('session-1')).resolves.toBe(true);
		await expect(api.resize('session-1', 120, 40)).resolves.toBe(true);
		await expect(api.runCommand(commandConfig)).resolves.toEqual({ exitCode: 0 });
		await expect(api.getActiveProcesses()).resolves.toEqual([{ sessionId: 'session-1', pid: 123 }]);
		api.sendRemoteNewTabResponse('remote:new-tab-response', { tabId: 'tab-1' });
		api.sendRemoteNewTabResponse('remote:new-tab-response', null);

		expect(invoke).toHaveBeenCalledWith('process:spawn', spawnConfig);
		expect(invoke).toHaveBeenCalledWith('process:write', 'session-1', 'hello\n');
		expect(invoke).toHaveBeenCalledWith('process:interrupt', 'session-1');
		expect(invoke).toHaveBeenCalledWith('process:kill', 'session-1');
		expect(invoke).toHaveBeenCalledWith('process:resize', 'session-1', 120, 40);
		expect(invoke).toHaveBeenCalledWith('process:runCommand', commandConfig);
		expect(invoke).toHaveBeenCalledWith('process:getActiveProcesses');
		expect(send).toHaveBeenCalledWith('remote:new-tab-response', { tabId: 'tab-1' });
		expect(send).toHaveBeenCalledWith('remote:new-tab-response', null);
	});

	it('bridges process event callbacks and cleans up listeners', () => {
		const toolEvent = { toolName: 'Edit', timestamp: 1 };
		const usage = {
			inputTokens: 10,
			outputTokens: 20,
			cacheReadInputTokens: 1,
			cacheCreationInputTokens: 2,
			totalCostUsd: 0.01,
			contextWindow: 100000,
		};
		const agentError = {
			type: 'auth_expired',
			message: 'Auth expired',
			recoverable: true,
			agentId: 'codex',
			timestamp: 1,
		};
		const sshRemote = { id: 'remote-1', name: 'Remote', host: 'remote.test' };
		const cases: Array<{
			channel: string;
			register: (callback: (...args: any[]) => void) => () => void;
			eventArgs: unknown[];
			expectedArgs: unknown[];
		}> = [
			{
				channel: 'process:data',
				register: (callback) => api.onData(callback),
				eventArgs: ['session-1', 'stdout'],
				expectedArgs: ['session-1', 'stdout'],
			},
			{
				channel: 'process:exit',
				register: (callback) => api.onExit(callback),
				eventArgs: ['session-1', 0],
				expectedArgs: ['session-1', 0],
			},
			{
				channel: 'process:session-id',
				register: (callback) => api.onSessionId(callback),
				eventArgs: ['session-1', 'agent-session-1'],
				expectedArgs: ['session-1', 'agent-session-1'],
			},
			{
				channel: 'process:slash-commands',
				register: (callback) => api.onSlashCommands(callback),
				eventArgs: ['session-1', ['/help']],
				expectedArgs: ['session-1', ['/help']],
			},
			{
				channel: 'process:thinking-chunk',
				register: (callback) => api.onThinkingChunk(callback),
				eventArgs: ['session-1', 'thinking'],
				expectedArgs: ['session-1', 'thinking'],
			},
			{
				channel: 'process:tool-execution',
				register: (callback) => api.onToolExecution(callback),
				eventArgs: ['session-1', toolEvent],
				expectedArgs: ['session-1', toolEvent],
			},
			{
				channel: 'process:ssh-remote',
				register: (callback) => api.onSshRemote(callback),
				eventArgs: ['session-1', sshRemote],
				expectedArgs: ['session-1', sshRemote],
			},
			{
				channel: 'process:stderr',
				register: (callback) => api.onStderr(callback),
				eventArgs: ['session-1', 'stderr'],
				expectedArgs: ['session-1', 'stderr'],
			},
			{
				channel: 'process:command-exit',
				register: (callback) => api.onCommandExit(callback),
				eventArgs: ['session-1', 2],
				expectedArgs: ['session-1', 2],
			},
			{
				channel: 'process:usage',
				register: (callback) => api.onUsage(callback),
				eventArgs: ['session-1', usage],
				expectedArgs: ['session-1', usage],
			},
			{
				channel: 'agent:error',
				register: (callback) => api.onAgentError(callback),
				eventArgs: ['session-1', agentError],
				expectedArgs: ['session-1', agentError],
			},
		];

		for (const testCase of cases) {
			const callback = vi.fn();
			const cleanup = testCase.register(callback);
			const handler = listeners.get(testCase.channel);
			emit(testCase.channel, ...testCase.eventArgs);
			cleanup();

			expect(callback).toHaveBeenCalledWith(...testCase.expectedArgs);
			expect(removeListener).toHaveBeenCalledWith(testCase.channel, handler);
			expect(listeners.has(testCase.channel)).toBe(false);
		}
	});

	it('bridges remote-control callbacks, logs remote command failures, and cleans up listeners', () => {
		const cases: Array<{
			channel: string;
			register: (callback: (...args: any[]) => void) => () => void;
			eventArgs: unknown[];
			expectedArgs: unknown[];
		}> = [
			{
				channel: 'remote:executeCommand',
				register: (callback) => api.onRemoteCommand(callback),
				eventArgs: ['session-1', 'npm test', 'terminal'],
				expectedArgs: ['session-1', 'npm test', 'terminal', undefined, undefined, undefined],
			},
			{
				channel: 'remote:switchMode',
				register: (callback) => api.onRemoteSwitchMode(callback),
				eventArgs: ['session-1', 'ai'],
				expectedArgs: ['session-1', 'ai'],
			},
			{
				channel: 'remote:interrupt',
				register: (callback) => api.onRemoteInterrupt(callback),
				eventArgs: ['session-1'],
				expectedArgs: ['session-1'],
			},
			{
				channel: 'remote:selectSession',
				register: (callback) => api.onRemoteSelectSession(callback),
				eventArgs: ['session-1', 'tab-1'],
				expectedArgs: ['session-1', 'tab-1'],
			},
			{
				channel: 'remote:selectTab',
				register: (callback) => api.onRemoteSelectTab(callback),
				eventArgs: ['session-1', 'tab-1'],
				expectedArgs: ['session-1', 'tab-1'],
			},
			{
				channel: 'remote:newTab',
				register: (callback) => api.onRemoteNewTab(callback),
				eventArgs: ['session-1', 'response-channel'],
				expectedArgs: ['session-1', 'response-channel'],
			},
			{
				channel: 'remote:closeTab',
				register: (callback) => api.onRemoteCloseTab(callback),
				eventArgs: ['session-1', 'tab-1'],
				expectedArgs: ['session-1', 'tab-1'],
			},
			{
				channel: 'remote:renameTab',
				register: (callback) => api.onRemoteRenameTab(callback),
				eventArgs: ['session-1', 'tab-1', 'New name'],
				expectedArgs: ['session-1', 'tab-1', 'New name'],
			},
			{
				channel: 'remote:starTab',
				register: (callback) => api.onRemoteStarTab(callback),
				eventArgs: ['session-1', 'tab-1', true],
				expectedArgs: ['session-1', 'tab-1', true],
			},
			{
				channel: 'remote:reorderTab',
				register: (callback) => api.onRemoteReorderTab(callback),
				eventArgs: ['session-1', 0, 2],
				expectedArgs: ['session-1', 0, 2],
			},
			{
				channel: 'remote:toggleBookmark',
				register: (callback) => api.onRemoteToggleBookmark(callback),
				eventArgs: ['session-1'],
				expectedArgs: ['session-1'],
			},
		];

		for (const testCase of cases) {
			const callback = vi.fn();
			const cleanup = testCase.register(callback);
			const handler = listeners.get(testCase.channel);
			emit(testCase.channel, ...testCase.eventArgs);
			cleanup();

			expect(callback).toHaveBeenCalledWith(...testCase.expectedArgs);
			expect(removeListener).toHaveBeenCalledWith(testCase.channel, handler);
			expect(listeners.has(testCase.channel)).toBe(false);
		}

		const failingCallback = vi.fn(() => {
			throw new Error('callback failed');
		});
		api.onRemoteCommand(failingCallback);
		invoke.mockClear();
		emit('remote:executeCommand', 'session-1', 'explode', 'ai');

		expect(failingCallback).toHaveBeenCalledWith(
			'session-1',
			'explode',
			'ai',
			undefined,
			undefined,
			undefined
		);
		expect(invoke).toHaveBeenCalledWith(
			'logger:log',
			'error',
			'Error invoking remote command callback',
			'Preload',
			{ error: 'Error: callback failed' }
		);
	});
});
