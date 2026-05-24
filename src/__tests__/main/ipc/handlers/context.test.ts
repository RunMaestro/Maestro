import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import {
	registerContextHandlers,
	getActiveGroomingSessionCount,
	cleanupAllGroomingSessions,
} from '../../../../main/ipc/handlers/context';
import { getSessionStorage } from '../../../../main/agents';
import { groomContext, cancelAllGroomingSessions } from '../../../../main/utils/context-groomer';

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
	},
}));

vi.mock('uuid', () => ({
	v4: vi.fn(() => 'uuid-1'),
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../../../main/agents', () => ({
	getSessionStorage: vi.fn(),
}));

vi.mock('../../../../main/utils/context-groomer', () => ({
	groomContext: vi.fn(),
	cancelAllGroomingSessions: vi.fn(),
}));

describe('context IPC handlers', () => {
	let handlers: Map<string, Function>;
	let emitter: EventEmitter;
	let processManager: {
		spawn: ReturnType<typeof vi.fn>;
		write: ReturnType<typeof vi.fn>;
		kill: ReturnType<typeof vi.fn>;
		on: ReturnType<typeof vi.fn>;
		off: ReturnType<typeof vi.fn>;
	};
	let agentDetector: {
		getAgent: ReturnType<typeof vi.fn>;
	};
	let agentConfigsStore: {
		get: ReturnType<typeof vi.fn>;
	};
	let consoleLog: ReturnType<typeof vi.spyOn>;
	let consoleError: ReturnType<typeof vi.spyOn>;

	const createProcessManager = () => {
		emitter = new EventEmitter();
		const manager = {
			spawn: vi.fn().mockResolvedValue({ pid: 1234 }),
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
	};

	const createGroomingSession = async () =>
		handlers.get('context:createGroomingSession')!(
			{} as any,
			'/project',
			'claude-code'
		) as Promise<string>;

	beforeEach(() => {
		vi.clearAllMocks();

		consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
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
					customPath: '/custom/claude',
					customArgs: '--dangerously-skip-permissions',
				},
			}),
		};
		vi.mocked(groomContext).mockResolvedValue({
			response: 'groomed context',
			durationMs: 25,
			completionReason: 'process exited',
		});

		registerContextHandlers({
			getMainWindow: () => null,
			getProcessManager: () => processManager as any,
			getAgentDetector: () => agentDetector as any,
			agentConfigsStore: agentConfigsStore as any,
		});
	});

	afterEach(async () => {
		await cleanupAllGroomingSessions(processManager as any);
		handlers.clear();
		vi.useRealTimers();
		consoleLog.mockRestore();
		consoleError.mockRestore();
	});

	describe('registration', () => {
		it('registers all context handlers without leaking registration logs', () => {
			expect(Array.from(handlers.keys())).toEqual([
				'context:getStoredSession',
				'context:groomContext',
				'context:cancelGrooming',
				'context:createGroomingSession',
				'context:sendGroomingPrompt',
				'context:cleanupGroomingSession',
			]);
			expect(consoleLog).toHaveBeenCalledWith(
				'[ContextMerge] Registering context IPC handlers (v2 with response collection)'
			);
			expect(consoleError).not.toHaveBeenCalled();
		});

		it('logs sendGroomingPrompt registration failures and continues registration', () => {
			handlers.clear();
			vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
				if (channel === 'context:sendGroomingPrompt') {
					throw new Error('registration failed');
				}
				handlers.set(channel, handler);
			});

			registerContextHandlers({
				getMainWindow: () => null,
				getProcessManager: () => processManager as any,
				getAgentDetector: () => agentDetector as any,
				agentConfigsStore: agentConfigsStore as any,
			});

			expect(consoleError).toHaveBeenCalledWith(
				'[ContextMerge] Failed to register context:sendGroomingPrompt handler:',
				expect.any(Error)
			);
			expect(handlers.has('context:cleanupGroomingSession')).toBe(true);
		});
	});

	describe('context:getStoredSession', () => {
		it('reads stored messages through provider session storage', async () => {
			const storage = {
				readSessionMessages: vi.fn().mockResolvedValue({
					messages: [{ type: 'user', content: 'hello' }],
					total: 1,
					hasMore: false,
				}),
			};
			vi.mocked(getSessionStorage).mockReturnValue(storage as any);

			const result = await handlers.get('context:getStoredSession')!(
				{} as any,
				'claude-code',
				'/project',
				'session-1'
			);

			expect(storage.readSessionMessages).toHaveBeenCalledWith('/project', 'session-1');
			expect(result).toEqual({
				messages: [{ type: 'user', content: 'hello' }],
				total: 1,
				hasMore: false,
			});
		});

		it('returns null for missing storage or storage read failures', async () => {
			vi.mocked(getSessionStorage).mockReturnValueOnce(null);

			const missing = await handlers.get('context:getStoredSession')!(
				{} as any,
				'unknown',
				'/project',
				'session-1'
			);
			expect(missing).toBeNull();

			vi.mocked(getSessionStorage).mockReturnValueOnce({
				readSessionMessages: vi.fn().mockRejectedValue(new Error('EACCES')),
			} as any);
			const failed = await handlers.get('context:getStoredSession')!(
				{} as any,
				'claude-code',
				'/project',
				'session-2'
			);
			expect(failed).toBeNull();
		});
	});

	describe('context:groomContext', () => {
		it('delegates single-call grooming with session and agent configuration overrides', async () => {
			const sshRemoteConfig = {
				enabled: true,
				remoteId: 'prod',
				workingDirOverride: '/remote/project',
			};
			const customEnvVars = { FEATURE_FLAG: '1' };

			const result = await handlers.get('context:groomContext')!(
				{} as any,
				'/project',
				'claude-code',
				'Summarize this',
				{
					sshRemoteConfig,
					customPath: '/session/claude',
					customArgs: '--print',
					customEnvVars,
				}
			);

			expect(result).toBe('groomed context');
			expect(agentConfigsStore.get).toHaveBeenCalledWith('configs', {});
			expect(groomContext).toHaveBeenCalledWith(
				{
					projectRoot: '/project',
					agentType: 'claude-code',
					prompt: 'Summarize this',
					sessionSshRemoteConfig: sshRemoteConfig,
					sessionCustomPath: '/session/claude',
					sessionCustomArgs: '--print',
					sessionCustomEnvVars: customEnvVars,
					agentConfigValues: {
						customPath: '/custom/claude',
						customArgs: '--dangerously-skip-permissions',
					},
				},
				processManager,
				agentDetector
			);
		});

		it('passes an empty agent config when no saved config exists', async () => {
			agentConfigsStore.get.mockReturnValueOnce({});

			await handlers.get('context:groomContext')!(
				{} as any,
				'/project',
				'opencode',
				'Summarize this'
			);

			expect(groomContext).toHaveBeenCalledWith(
				expect.objectContaining({
					agentType: 'opencode',
					agentConfigValues: {},
				}),
				processManager,
				agentDetector
			);
		});

		it('throws when required grooming dependencies are unavailable', async () => {
			handlers.clear();
			registerContextHandlers({
				getMainWindow: () => null,
				getProcessManager: () => null,
				getAgentDetector: () => agentDetector as any,
				agentConfigsStore: agentConfigsStore as any,
			});

			await expect(
				handlers.get('context:groomContext')!({} as any, '/project', 'claude-code', 'prompt')
			).rejects.toThrow('Process manager not initialized');
		});

		it('cancels active grooming sessions through the shared groomer utility', async () => {
			await handlers.get('context:cancelGrooming')!({} as any);

			expect(cancelAllGroomingSessions).toHaveBeenCalledTimes(1);
		});
	});

	describe('legacy grooming session lifecycle', () => {
		it('creates a grooming process and cleans it up through IPC', async () => {
			vi.useFakeTimers();

			const sessionId = await createGroomingSession();

			expect(sessionId).toBe('groomer-uuid-1');
			expect(agentDetector.getAgent).toHaveBeenCalledWith('claude-code');
			expect(processManager.spawn).toHaveBeenCalledWith({
				sessionId: 'groomer-uuid-1',
				toolType: 'claude-code',
				cwd: '/project',
				command: 'claude',
				args: ['--model', 'sonnet'],
			});
			expect(getActiveGroomingSessionCount()).toBe(1);

			await handlers.get('context:cleanupGroomingSession')!({} as any, sessionId);

			expect(processManager.kill).toHaveBeenCalledWith('groomer-uuid-1');
			expect(getActiveGroomingSessionCount()).toBe(0);
		});

		it('creates a grooming process with empty args when the agent has no args', async () => {
			vi.mocked(uuidv4).mockReturnValueOnce('no-args');
			agentDetector.getAgent.mockResolvedValueOnce({
				available: true,
				command: 'opencode',
			});

			const sessionId = await createGroomingSession();

			expect(sessionId).toBe('groomer-no-args');
			expect(processManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'groomer-no-args',
					command: 'opencode',
					args: [],
				})
			);
		});

		it('cleans sessions left without timeout cleanup when timer setup fails', async () => {
			const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementationOnce(() => {
				throw new Error('timer unavailable');
			});

			try {
				await expect(createGroomingSession()).rejects.toThrow('timer unavailable');
			} finally {
				setTimeoutSpy.mockRestore();
			}

			await cleanupAllGroomingSessions(processManager as any);

			expect(processManager.kill).toHaveBeenCalledWith('groomer-uuid-1');
			expect(getActiveGroomingSessionCount()).toBe(0);
		});

		it('rejects unavailable agents and failed spawns', async () => {
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

		it('collects matching process data until exit and unregisters listeners', async () => {
			vi.useFakeTimers();
			const sessionId = await createGroomingSession();

			const responsePromise = handlers.get('context:sendGroomingPrompt')!(
				{} as any,
				sessionId,
				'Condense context'
			);

			expect(processManager.write).toHaveBeenCalledWith(sessionId, 'Condense context\n');
			emitter.emit('data', 'other-session', 'ignored');
			emitter.emit('data', sessionId, 'first ');
			emitter.emit('data', sessionId, 'second');
			emitter.emit('exit', sessionId, 0);

			await expect(responsePromise).resolves.toBe('first second');
			expect(processManager.off).toHaveBeenCalledWith('data', expect.any(Function));
			expect(processManager.off).toHaveBeenCalledWith('exit', expect.any(Function));
			expect(processManager.off).toHaveBeenCalledWith('agent-error', expect.any(Function));
		});

		it('rejects prompts for unknown grooming sessions', async () => {
			await expect(
				handlers.get('context:sendGroomingPrompt')!({} as any, 'missing-session', 'prompt')
			).rejects.toThrow('No active grooming session found: missing-session');
		});

		it('ignores unrelated and late process events after a response resolves', async () => {
			vi.useFakeTimers();
			processManager.off.mockImplementation(() => processManager);
			const sessionId = await createGroomingSession();

			const responsePromise = handlers.get('context:sendGroomingPrompt')!(
				{} as any,
				sessionId,
				'Condense context'
			);

			emitter.emit('data', sessionId, 'complete');
			emitter.emit('exit', 'other-session', 0);
			emitter.emit('agent-error', 'other-session', new Error('ignored'));
			emitter.emit('exit', sessionId, 0);
			emitter.emit('exit', sessionId, 0);
			emitter.emit('agent-error', sessionId, new Error('late error'));

			await expect(responsePromise).resolves.toBe('complete');
		});

		it('rejects when the prompt cannot be written or the process reports an error', async () => {
			vi.useFakeTimers();
			let sessionId = await createGroomingSession();
			processManager.write.mockReturnValueOnce(false);

			await expect(
				handlers.get('context:sendGroomingPrompt')!({} as any, sessionId, 'prompt')
			).rejects.toThrow(`Failed to write prompt to grooming session: ${sessionId}`);

			sessionId = await createGroomingSession();
			const responsePromise = handlers.get('context:sendGroomingPrompt')!(
				{} as any,
				sessionId,
				'prompt'
			);
			emitter.emit('agent-error', sessionId, new Error('model failed'));

			await expect(responsePromise).rejects.toThrow('Grooming session error: model failed');

			sessionId = await createGroomingSession();
			const stringErrorPromise = handlers.get('context:sendGroomingPrompt')!(
				{} as any,
				sessionId,
				'prompt'
			);
			emitter.emit('agent-error', sessionId, 'process crashed');

			await expect(stringErrorPromise).rejects.toThrow('Grooming session error: process crashed');
		});

		it('resolves after idle timeout with enough content and rejects on empty overall timeout', async () => {
			vi.useFakeTimers();
			let sessionId = await createGroomingSession();
			const enoughContent = 'x'.repeat(120);

			const idlePromise = handlers.get('context:sendGroomingPrompt')!(
				{} as any,
				sessionId,
				'prompt'
			);
			emitter.emit('data', sessionId, enoughContent);
			await vi.advanceTimersByTimeAsync(6000);
			await expect(idlePromise).resolves.toBe(enoughContent);

			sessionId = await createGroomingSession();
			const timeoutPromise = handlers.get('context:sendGroomingPrompt')!(
				{} as any,
				sessionId,
				'prompt'
			);
			const timeoutExpectation = expect(timeoutPromise).rejects.toThrow(
				'Grooming session timed out with no response'
			);
			await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

			await timeoutExpectation;
		});

		it('returns partial content when the overall timeout fires after some output', async () => {
			vi.useFakeTimers();
			const sessionId = await createGroomingSession();

			const responsePromise = handlers.get('context:sendGroomingPrompt')!(
				{} as any,
				sessionId,
				'prompt'
			);
			emitter.emit('data', sessionId, 'partial response');
			await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

			await expect(responsePromise).resolves.toBe('partial response');
		});

		it('cleans all active grooming sessions and tolerates kill failures', async () => {
			vi.useFakeTimers();
			vi.mocked(uuidv4).mockReturnValueOnce('one').mockReturnValueOnce('two');

			const first = await createGroomingSession();
			const second = await createGroomingSession();

			await cleanupAllGroomingSessions(processManager as any);

			expect(processManager.kill).toHaveBeenCalledWith(first);
			expect(processManager.kill).toHaveBeenCalledWith(second);
			expect(getActiveGroomingSessionCount()).toBe(0);

			processManager.kill.mockImplementationOnce(() => {
				throw new Error('already exited');
			});
			await expect(
				handlers.get('context:cleanupGroomingSession')!({} as any, 'already-gone')
			).resolves.toBeUndefined();
		});
	});
});
