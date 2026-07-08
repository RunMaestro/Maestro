import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ipcMain } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import {
	cleanupAllGroomingSessions,
	getActiveGroomingSessionCount,
	registerContextHandlers,
} from '../../main/ipc/handlers/context';
import { getSessionStorage } from '../../main/agents';
import { cancelAllGroomingSessions, groomContext } from '../../main/utils/context-groomer';

const state = vi.hoisted(() => ({
	handlers: new Map<string, Function>(),
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
}));

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn((channel: string, handler: Function) => {
			state.handlers.set(channel, handler);
		}),
	},
	BrowserWindow: vi.fn(),
}));

vi.mock('uuid', () => ({
	v4: vi.fn(() => 'uuid-1'),
}));

vi.mock('../../main/utils/logger', () => ({
	logger: state.logger,
}));

vi.mock('../../main/agents', () => ({
	getSessionStorage: vi.fn(),
}));

vi.mock('../../main/utils/context-groomer', () => ({
	groomContext: vi.fn(),
	cancelAllGroomingSessions: vi.fn(),
}));

type MockProcessManager = {
	spawn: ReturnType<typeof vi.fn>;
	write: ReturnType<typeof vi.fn>;
	kill: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	off: ReturnType<typeof vi.fn>;
};

function invoke(channel: string, ...args: unknown[]) {
	const handler = state.handlers.get(channel);
	expect(handler, `missing handler for ${channel}`).toBeDefined();
	return handler?.({}, ...args);
}

describe('context IPC integration', () => {
	let emitter: EventEmitter;
	let processManager: MockProcessManager;
	let agentDetector: { getAgent: ReturnType<typeof vi.fn> };
	let agentConfigsStore: { get: ReturnType<typeof vi.fn> };

	function createProcessManager() {
		emitter = new EventEmitter();
		const manager: MockProcessManager = {
			spawn: vi.fn().mockResolvedValue({ pid: 4321 }),
			write: vi.fn().mockReturnValue(true),
			kill: vi.fn(),
			on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
				emitter.on(event, listener);
				return manager;
			}),
			off: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
				emitter.off(event, listener);
				return manager;
			}),
		};
		return manager;
	}

	function registerHandlers(
		overrides: Partial<Parameters<typeof registerContextHandlers>[0]> = {}
	) {
		registerContextHandlers({
			getMainWindow: () => null,
			getProcessManager: () => processManager as never,
			getAgentDetector: () => agentDetector as never,
			agentConfigsStore: agentConfigsStore as never,
			...overrides,
		});
	}

	async function createGroomingSession() {
		return invoke('context:createGroomingSession', '/repo', 'claude-code') as Promise<string>;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		state.handlers.clear();
		vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: Function) => {
			state.handlers.set(channel, handler);
		});
		processManager = createProcessManager();
		agentDetector = {
			getAgent: vi.fn().mockResolvedValue({
				available: true,
				command: 'claude',
				args: ['--model', 'sonnet'],
				capabilities: { supportsBatchMode: true },
			}),
		};
		agentConfigsStore = {
			get: vi.fn().mockReturnValue({
				'claude-code': {
					customPath: '/configured/claude',
					customArgs: '--configured',
				},
			}),
		};
		vi.mocked(groomContext).mockResolvedValue({
			response: 'groomed context',
			durationMs: 20,
			completionReason: 'process exited',
		});
		registerHandlers();
	});

	afterEach(async () => {
		await cleanupAllGroomingSessions(processManager as never);
		vi.restoreAllMocks();
		state.handlers.clear();
	});

	it('registers context channels and logs registration failures without blocking cleanup registration', () => {
		expect([...state.handlers.keys()]).toEqual([
			'context:getStoredSession',
			'context:groomContext',
			'context:cancelGrooming',
			'context:createGroomingSession',
			'context:sendGroomingPrompt',
			'context:cleanupGroomingSession',
		]);
		expect(state.logger.info).toHaveBeenCalledWith(
			'[ContextMerge] Registering context IPC handlers (v2 with response collection)'
		);

		state.handlers.clear();
		vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: Function) => {
			if (channel === 'context:sendGroomingPrompt') {
				throw new Error('registration failed');
			}
			state.handlers.set(channel, handler);
		});

		registerHandlers();

		expect(state.logger.error).toHaveBeenCalledWith(
			'[ContextMerge] Failed to register context:sendGroomingPrompt handler:',
			undefined,
			expect.any(Error)
		);
		expect(state.handlers.has('context:cleanupGroomingSession')).toBe(true);
	});

	it('reads stored sessions and returns null for unavailable storage paths', async () => {
		const storage = {
			readSessionMessages: vi.fn().mockResolvedValue({
				messages: [{ type: 'user', content: 'hello' }],
				total: 1,
				hasMore: false,
			}),
		};
		vi.mocked(getSessionStorage).mockReturnValueOnce(storage as never);

		await expect(
			invoke('context:getStoredSession', 'claude-code', '/repo', 'session-1')
		).resolves.toEqual({
			messages: [{ type: 'user', content: 'hello' }],
			total: 1,
			hasMore: false,
		});
		expect(storage.readSessionMessages).toHaveBeenCalledWith('/repo', 'session-1');

		vi.mocked(getSessionStorage).mockReturnValueOnce(null);
		await expect(
			invoke('context:getStoredSession', 'missing-agent', '/repo', 'session-2')
		).resolves.toBeNull();

		vi.mocked(getSessionStorage).mockReturnValueOnce({
			readSessionMessages: vi.fn().mockRejectedValue(new Error('EACCES')),
		} as never);
		await expect(
			invoke('context:getStoredSession', 'claude-code', '/repo', 'session-3')
		).resolves.toBeNull();
	});

	it('delegates single-call grooming with agent, session, SSH, and environment overrides', async () => {
		const sshRemoteConfig = {
			enabled: true,
			remoteId: 'remote-1',
			workingDirOverride: '/remote/repo',
		};
		const customEnvVars = { FEATURE_FLAG: '1' };

		await expect(
			invoke('context:groomContext', '/repo', 'claude-code', 'Summarize this', {
				sshRemoteConfig,
				customPath: '/session/claude',
				customArgs: '--print',
				customEnvVars,
			})
		).resolves.toBe('groomed context');

		expect(agentConfigsStore.get).toHaveBeenCalledWith('configs', {});
		expect(groomContext).toHaveBeenCalledWith(
			{
				projectRoot: '/repo',
				agentType: 'claude-code',
				prompt: 'Summarize this',
				sessionSshRemoteConfig: sshRemoteConfig,
				sessionCustomPath: '/session/claude',
				sessionCustomArgs: '--print',
				sessionCustomEnvVars: customEnvVars,
				agentConfigValues: {
					customPath: '/configured/claude',
					customArgs: '--configured',
				},
			},
			processManager,
			agentDetector
		);

		agentConfigsStore.get.mockReturnValueOnce({});
		await invoke('context:groomContext', '/repo', 'opencode', 'Summarize this');
		expect(groomContext).toHaveBeenLastCalledWith(
			expect.objectContaining({
				agentType: 'opencode',
				agentConfigValues: {},
			}),
			processManager,
			agentDetector
		);
	});

	it('surfaces missing grooming dependencies and routes cancellation to the shared groomer', async () => {
		state.handlers.clear();
		registerHandlers({ getProcessManager: () => null });

		await expect(invoke('context:groomContext', '/repo', 'claude-code', 'prompt')).rejects.toThrow(
			'Process manager not initialized'
		);

		state.handlers.clear();
		registerHandlers();
		await expect(invoke('context:cancelGrooming')).resolves.toBeUndefined();
		expect(cancelAllGroomingSessions).toHaveBeenCalledTimes(1);
	});

	it('creates and cleans up deprecated grooming sessions through the process manager', async () => {
		const sessionId = await createGroomingSession();

		expect(sessionId).toBe('groomer-uuid-1');
		expect(agentDetector.getAgent).toHaveBeenCalledWith('claude-code');
		expect(processManager.spawn).toHaveBeenCalledWith({
			sessionId: 'groomer-uuid-1',
			toolType: 'claude-code',
			cwd: '/repo',
			command: 'claude',
			args: ['--model', 'sonnet'],
		});
		expect(getActiveGroomingSessionCount()).toBe(1);

		await expect(invoke('context:cleanupGroomingSession', sessionId)).resolves.toBeUndefined();

		expect(processManager.kill).toHaveBeenCalledWith('groomer-uuid-1');
		expect(getActiveGroomingSessionCount()).toBe(0);
	});

	it('rejects unavailable agents and failed grooming process spawns', async () => {
		agentDetector.getAgent.mockResolvedValueOnce({ available: false });

		await expect(createGroomingSession()).rejects.toThrow('Agent claude-code is not available');

		agentDetector.getAgent.mockResolvedValueOnce({
			available: true,
			command: 'claude',
			args: [],
		});
		processManager.spawn.mockResolvedValueOnce({ pid: 0 });

		await expect(createGroomingSession()).rejects.toThrow(
			'Failed to spawn grooming process for claude-code'
		);
	});

	it('handles prompt write failures and process-event response cleanup without timer leaks', async () => {
		const realSetTimeout = global.setTimeout;
		const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation(((
			handler: TimerHandler,
			timeout?: number,
			...args: unknown[]
		) => {
			const timer = realSetTimeout(handler, timeout, ...args);
			(timer as NodeJS.Timeout).unref?.();
			return timer;
		}) as typeof setTimeout);

		try {
			let sessionId = await createGroomingSession();
			processManager.write.mockReturnValueOnce(false);
			await expect(invoke('context:sendGroomingPrompt', sessionId, 'prompt')).rejects.toThrow(
				`Failed to write prompt to grooming session: ${sessionId}`
			);

			vi.mocked(uuidv4).mockReturnValueOnce('response-session');
			sessionId = await createGroomingSession();
			const responsePromise = invoke(
				'context:sendGroomingPrompt',
				sessionId,
				'Condense context'
			) as Promise<string>;

			expect(processManager.write).toHaveBeenLastCalledWith(sessionId, 'Condense context\n');
			emitter.emit('data', 'other-session', 'ignored');
			emitter.emit('data', sessionId, 'first ');
			emitter.emit('data', sessionId, 'second');
			emitter.emit('exit', sessionId, 0);

			await expect(responsePromise).resolves.toBe('first second');
			expect(processManager.off).toHaveBeenCalledWith('data', expect.any(Function));
			expect(processManager.off).toHaveBeenCalledWith('exit', expect.any(Function));
			expect(processManager.off).toHaveBeenCalledWith('agent-error', expect.any(Function));

			vi.mocked(uuidv4).mockReturnValueOnce('error-session');
			sessionId = await createGroomingSession();
			const errorPromise = invoke(
				'context:sendGroomingPrompt',
				sessionId,
				'Condense context'
			) as Promise<string>;
			emitter.emit('agent-error', 'other-session', new Error('ignored'));
			emitter.emit('agent-error', sessionId, new Error('model failed'));

			await expect(errorPromise).rejects.toThrow('Grooming session error: model failed');
		} finally {
			setTimeoutSpy.mockRestore();
		}
	});

	it('rejects unknown grooming prompts and tolerates cleanup kill failures', async () => {
		await expect(invoke('context:sendGroomingPrompt', 'missing-session', 'prompt')).rejects.toThrow(
			'No active grooming session found: missing-session'
		);

		processManager.kill.mockImplementationOnce(() => {
			throw new Error('already exited');
		});

		await expect(invoke('context:cleanupGroomingSession', 'already-gone')).resolves.toBeUndefined();
		expect(processManager.kill).toHaveBeenCalledWith('already-gone');
	});
});
