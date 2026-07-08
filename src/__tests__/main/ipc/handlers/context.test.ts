/**
 * Tests for the context IPC handlers.
 *
 * These handlers cover context transfer, grooming, and cleanup flows.
 */

import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';
import {
	registerContextHandlers,
	getActiveGroomingSessionCount,
	cleanupAllGroomingSessions,
	type ContextHandlerDependencies,
} from '../../../../main/ipc/handlers/context';

const {
	mockGetSessionStorage,
	mockGroomContext,
	mockCancelAllGroomingSessions,
	mockCaptureException,
	mockUuidV4,
} = vi.hoisted(() => ({
	mockGetSessionStorage: vi.fn(),
	mockGroomContext: vi.fn(),
	mockCancelAllGroomingSessions: vi.fn(),
	mockCaptureException: vi.fn(),
	mockUuidV4: vi.fn(),
}));

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
	BrowserWindow: vi.fn(),
}));

vi.mock('uuid', () => ({
	v4: mockUuidV4,
}));

vi.mock('../../../../main/agents', () => ({
	getSessionStorage: mockGetSessionStorage,
}));

vi.mock('../../../../main/utils/context-groomer', () => ({
	groomContext: mockGroomContext,
	cancelAllGroomingSessions: mockCancelAllGroomingSessions,
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../../../main/utils/sentry', () => ({
	captureException: mockCaptureException,
}));

class MockProcessManager extends EventEmitter {
	spawn = vi.fn();
	write = vi.fn();
	kill = vi.fn();
}

describe('context IPC handlers', () => {
	let handlers: Map<string, Function>;
	let mockProcessManager: MockProcessManager;
	let mockAgentDetector: { getAgent: ReturnType<typeof vi.fn> };
	let mockAgentConfigsStore: { get: ReturnType<typeof vi.fn> };
	let deps: ContextHandlerDependencies;
	let uuidCount: number;

	beforeEach(() => {
		vi.clearAllMocks();
		handlers = new Map();
		uuidCount = 0;

		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		mockUuidV4.mockImplementation(() => {
			uuidCount += 1;
			return `uuid-${uuidCount}`;
		});

		mockProcessManager = new MockProcessManager();
		mockProcessManager.spawn.mockResolvedValue({ pid: 1234 });
		mockProcessManager.write.mockReturnValue(true);
		mockProcessManager.kill.mockImplementation(() => undefined);

		mockAgentDetector = {
			getAgent: vi.fn().mockResolvedValue({
				available: true,
				command: 'claude',
				args: ['--model', 'sonnet'],
				capabilities: { supportsBatchMode: true },
			}),
		};

		mockAgentConfigsStore = {
			get: vi.fn().mockReturnValue({
				'claude-code': {
					customPath: '/custom/claude',
					customArgs: '--allowedTools Read',
					customEnvVars: { MAESTRO_TEST: '1' },
				},
			}),
		};

		deps = {
			getMainWindow: () => null,
			getProcessManager: () => mockProcessManager as any,
			getAgentDetector: () => mockAgentDetector as any,
			agentConfigsStore: mockAgentConfigsStore as any,
		};

		registerContextHandlers(deps);
	});

	afterEach(async () => {
		await cleanupAllGroomingSessions(mockProcessManager as any);
		handlers.clear();
		vi.useRealTimers();
	});

	describe('registration', () => {
		it('registers every context handler', () => {
			const expectedChannels = [
				'context:getStoredSession',
				'context:groomContext',
				'context:cancelGrooming',
				'context:createGroomingSession',
				'context:sendGroomingPrompt',
				'context:cleanupGroomingSession',
			];

			for (const channel of expectedChannels) {
				expect(handlers.has(channel), `Handler ${channel} should be registered`).toBe(true);
			}
			expect(handlers.size).toBe(expectedChannels.length);
		});
	});

	describe('context:getStoredSession', () => {
		it('returns stored messages when session storage is available', async () => {
			const messagesResult = {
				messages: [{ role: 'assistant', content: 'stored context' }],
				total: 1,
			};
			const storage = {
				readSessionMessages: vi.fn().mockResolvedValue(messagesResult),
			};
			mockGetSessionStorage.mockReturnValue(storage);

			const result = await handlers.get('context:getStoredSession')!(
				{},
				'claude-code',
				'/repo',
				'session-1'
			);

			expect(mockGetSessionStorage).toHaveBeenCalledWith('claude-code');
			expect(storage.readSessionMessages).toHaveBeenCalledWith('/repo', 'session-1');
			expect(result).toBe(messagesResult);
		});

		it('returns null when no storage exists for the agent', async () => {
			mockGetSessionStorage.mockReturnValue(null);

			const result = await handlers.get('context:getStoredSession')!(
				{},
				'unknown-agent',
				'/repo',
				'session-1'
			);

			expect(result).toBeNull();
		});

		it('captures storage read errors and returns null', async () => {
			const error = new Error('read failed');
			mockGetSessionStorage.mockReturnValue({
				readSessionMessages: vi.fn().mockRejectedValue(error),
			});

			const result = await handlers.get('context:getStoredSession')!(
				{},
				'claude-code',
				'/repo',
				'session-1'
			);

			expect(result).toBeNull();
			expect(mockCaptureException).toHaveBeenCalledWith(error);
		});
	});

	describe('context:groomContext', () => {
		it('delegates to groomContext with session and agent config overrides', async () => {
			mockGroomContext.mockResolvedValue({ response: 'groomed response' });
			const options = {
				sshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
					workingDirOverride: '/remote/repo',
				},
				customPath: '/bin/custom-claude',
				customArgs: '--print',
				customEnvVars: { TEST_ENV: 'yes' },
			};

			const result = await handlers.get('context:groomContext')!(
				{},
				'/repo',
				'claude-code',
				'Summarize this session',
				options
			);

			expect(result).toBe('groomed response');
			expect(mockAgentConfigsStore.get).toHaveBeenCalledWith('configs', {});
			expect(mockGroomContext).toHaveBeenCalledWith(
				{
					projectRoot: '/repo',
					agentType: 'claude-code',
					prompt: 'Summarize this session',
					sessionSshRemoteConfig: options.sshRemoteConfig,
					sessionCustomPath: options.customPath,
					sessionCustomArgs: options.customArgs,
					sessionCustomEnvVars: options.customEnvVars,
					agentConfigValues: mockAgentConfigsStore.get.mock.results[0].value['claude-code'],
				},
				mockProcessManager,
				mockAgentDetector
			);
		});

		it('uses empty agent config values when no agent-level config exists', async () => {
			mockAgentConfigsStore.get.mockReturnValue({});
			mockGroomContext.mockResolvedValue({ response: 'fallback response' });

			const result = await handlers.get('context:groomContext')!(
				{},
				'/repo',
				'codex',
				'Summarize this session'
			);

			expect(result).toBe('fallback response');
			expect(mockGroomContext).toHaveBeenCalledWith(
				expect.objectContaining({
					agentType: 'codex',
					sessionSshRemoteConfig: undefined,
					sessionCustomPath: undefined,
					sessionCustomArgs: undefined,
					sessionCustomEnvVars: undefined,
					agentConfigValues: {},
				}),
				mockProcessManager,
				mockAgentDetector
			);
		});

		it('throws when the process manager dependency is missing', async () => {
			registerContextHandlers({
				...deps,
				getProcessManager: () => null,
			});

			await expect(
				handlers.get('context:groomContext')!({}, '/repo', 'claude-code', 'prompt')
			).rejects.toThrow('Process manager not initialized');
		});
	});

	describe('context:cancelGrooming', () => {
		it('cancels all shared grooming utility sessions', async () => {
			await handlers.get('context:cancelGrooming')!({});

			expect(mockCancelAllGroomingSessions).toHaveBeenCalledTimes(1);
		});
	});

	describe('deprecated grooming session handlers', () => {
		it('creates and tracks a grooming process', async () => {
			const result = await handlers.get('context:createGroomingSession')!(
				{},
				'/repo',
				'claude-code'
			);

			expect(result).toBe('groomer-uuid-1');
			expect(mockAgentDetector.getAgent).toHaveBeenCalledWith('claude-code');
			expect(mockProcessManager.spawn).toHaveBeenCalledWith({
				sessionId: 'groomer-uuid-1',
				toolType: 'claude-code',
				cwd: '/repo',
				command: 'claude',
				args: ['--model', 'sonnet'],
			});
			expect(getActiveGroomingSessionCount()).toBe(1);
		});

		it('rejects unavailable grooming agents', async () => {
			mockAgentDetector.getAgent.mockResolvedValue({ available: false });

			await expect(
				handlers.get('context:createGroomingSession')!({}, '/repo', 'missing-agent')
			).rejects.toThrow('Agent missing-agent is not available');
		});

		it('rejects failed grooming process spawns', async () => {
			mockProcessManager.spawn.mockResolvedValue({ pid: 0 });

			await expect(
				handlers.get('context:createGroomingSession')!({}, '/repo', 'claude-code')
			).rejects.toThrow('Failed to spawn grooming process for claude-code');
		});

		it('uses empty args when the grooming agent has no default args', async () => {
			mockAgentDetector.getAgent.mockResolvedValue({
				available: true,
				command: 'codex',
			});

			const result = await handlers.get('context:createGroomingSession')!({}, '/repo', 'codex');

			expect(result).toBe('groomer-uuid-1');
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					command: 'codex',
					args: [],
				})
			);
		});

		it('times out and cleans stale grooming sessions', async () => {
			vi.useFakeTimers();
			const sessionId = await handlers.get('context:createGroomingSession')!(
				{},
				'/repo',
				'claude-code'
			);

			await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

			expect(getActiveGroomingSessionCount()).toBe(0);
			expect(mockProcessManager.kill).toHaveBeenCalledWith(sessionId);
		});

		it('handles a tracked session whose timeout cleanup callback was not stored', async () => {
			const originalGet = Map.prototype.get;
			let skipStoredCleanupLookup = true;
			const getSpy = vi.spyOn(Map.prototype, 'get').mockImplementation(function (key) {
				if (key === 'groomer-uuid-1' && skipStoredCleanupLookup) {
					skipStoredCleanupLookup = false;
					return undefined;
				}
				return originalGet.call(this, key);
			});

			const sessionId = await handlers.get('context:createGroomingSession')!(
				{},
				'/repo',
				'claude-code'
			);
			getSpy.mockRestore();

			await handlers.get('context:cleanupGroomingSession')!({}, sessionId);

			expect(mockProcessManager.kill).toHaveBeenCalledWith(sessionId);
		});

		it('sends a grooming prompt and resolves with collected output on exit', async () => {
			const sessionId = await handlers.get('context:createGroomingSession')!(
				{},
				'/repo',
				'claude-code'
			);

			const responsePromise = handlers.get('context:sendGroomingPrompt')!(
				{},
				sessionId,
				'Summarize context'
			);

			mockProcessManager.emit('data', 'other-session', 'ignored');
			mockProcessManager.emit('exit', 'other-session', 0);
			mockProcessManager.emit('agent-error', 'other-session', new Error('ignored'));
			mockProcessManager.emit('data', sessionId, 'first chunk ');
			mockProcessManager.emit('data', sessionId, 'second chunk');
			mockProcessManager.emit('exit', sessionId, 0);

			await expect(responsePromise).resolves.toBe('first chunk second chunk');
			expect(mockProcessManager.write).toHaveBeenCalledWith(sessionId, 'Summarize context\n');
			expect(mockProcessManager.listenerCount('data')).toBe(0);
			expect(mockProcessManager.listenerCount('exit')).toBe(0);
			expect(mockProcessManager.listenerCount('agent-error')).toBe(0);
		});

		it('ignores duplicate completion and error events after resolving', async () => {
			const offSpy = vi.spyOn(mockProcessManager, 'off').mockImplementation(() => {
				return mockProcessManager as any;
			});
			const sessionId = await handlers.get('context:createGroomingSession')!(
				{},
				'/repo',
				'claude-code'
			);

			const responsePromise = handlers.get('context:sendGroomingPrompt')!({}, sessionId, 'prompt');

			mockProcessManager.emit('data', sessionId, 'done');
			mockProcessManager.emit('exit', sessionId, 0);
			mockProcessManager.emit('exit', sessionId, 0);
			mockProcessManager.emit('agent-error', sessionId, new Error('ignored after resolve'));

			await expect(responsePromise).resolves.toBe('done');
			offSpy.mockRestore();
			mockProcessManager.removeAllListeners();
		});

		it('rejects sends to unknown grooming sessions', async () => {
			await expect(
				handlers.get('context:sendGroomingPrompt')!({}, 'missing-session', 'prompt')
			).rejects.toThrow('No active grooming session found: missing-session');
		});

		it('rejects when prompt writing fails', async () => {
			const sessionId = await handlers.get('context:createGroomingSession')!(
				{},
				'/repo',
				'claude-code'
			);
			mockProcessManager.write.mockReturnValue(false);

			await expect(
				handlers.get('context:sendGroomingPrompt')!({}, sessionId, 'prompt')
			).rejects.toThrow(`Failed to write prompt to grooming session: ${sessionId}`);
			expect(mockProcessManager.listenerCount('data')).toBe(0);
		});

		it('resolves with valid buffered output after the idle timeout', async () => {
			vi.useFakeTimers();
			const sessionId = await handlers.get('context:createGroomingSession')!(
				{},
				'/repo',
				'claude-code'
			);
			const response = 'x'.repeat(100);

			const responsePromise = handlers.get('context:sendGroomingPrompt')!({}, sessionId, 'prompt');

			mockProcessManager.emit('data', sessionId, response);
			await vi.advanceTimersByTimeAsync(6000);

			await expect(responsePromise).resolves.toBe(response);
			await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
		});

		it('resolves with partial output at the overall timeout', async () => {
			vi.useFakeTimers();
			const sessionId = await handlers.get('context:createGroomingSession')!(
				{},
				'/repo',
				'claude-code'
			);

			const responsePromise = handlers.get('context:sendGroomingPrompt')!({}, sessionId, 'prompt');

			mockProcessManager.emit('data', sessionId, 'partial');
			await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

			await expect(responsePromise).resolves.toBe('partial');
		});

		it('rejects with no output at the overall timeout', async () => {
			vi.useFakeTimers();
			const sessionId = await handlers.get('context:createGroomingSession')!(
				{},
				'/repo',
				'claude-code'
			);

			const responsePromise = handlers.get('context:sendGroomingPrompt')!({}, sessionId, 'prompt');
			const assertion = expect(responsePromise).rejects.toThrow(
				'Grooming session timed out with no response'
			);

			await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

			await assertion;
		});

		it('rejects when the grooming process emits an error', async () => {
			const sessionId = await handlers.get('context:createGroomingSession')!(
				{},
				'/repo',
				'claude-code'
			);

			const responsePromise = handlers.get('context:sendGroomingPrompt')!({}, sessionId, 'prompt');

			mockProcessManager.emit('agent-error', sessionId, new Error('agent failed'));

			await expect(responsePromise).rejects.toThrow('Grooming session error: agent failed');
			expect(mockProcessManager.listenerCount('agent-error')).toBe(0);
		});

		it('rejects string grooming process errors', async () => {
			const sessionId = await handlers.get('context:createGroomingSession')!(
				{},
				'/repo',
				'claude-code'
			);

			const responsePromise = handlers.get('context:sendGroomingPrompt')!({}, sessionId, 'prompt');

			mockProcessManager.emit('agent-error', sessionId, 'string failure');

			await expect(responsePromise).rejects.toThrow('Grooming session error: string failure');
		});

		it('cleans up tracked grooming sessions', async () => {
			const sessionId = await handlers.get('context:createGroomingSession')!(
				{},
				'/repo',
				'claude-code'
			);

			await handlers.get('context:cleanupGroomingSession')!({}, sessionId);

			expect(getActiveGroomingSessionCount()).toBe(0);
			expect(mockProcessManager.kill).toHaveBeenCalledWith(sessionId);
		});

		it('still asks the process manager to kill unknown cleanup sessions', async () => {
			await handlers.get('context:cleanupGroomingSession')!({}, 'missing-session');

			expect(mockProcessManager.kill).toHaveBeenCalledWith('missing-session');
		});

		it('cleans up every active grooming session', async () => {
			const firstSessionId = await handlers.get('context:createGroomingSession')!(
				{},
				'/repo',
				'claude-code'
			);
			const secondSessionId = await handlers.get('context:createGroomingSession')!(
				{},
				'/repo',
				'claude-code'
			);

			await cleanupAllGroomingSessions(mockProcessManager as any);

			expect(getActiveGroomingSessionCount()).toBe(0);
			expect(mockProcessManager.kill).toHaveBeenCalledWith(firstSessionId);
			expect(mockProcessManager.kill).toHaveBeenCalledWith(secondSessionId);
		});

		it('captures kill errors during cleanup without failing', async () => {
			const sessionId = await handlers.get('context:createGroomingSession')!(
				{},
				'/repo',
				'claude-code'
			);
			const error = new Error('already exited');
			mockProcessManager.kill.mockImplementation(() => {
				throw error;
			});

			await expect(
				handlers.get('context:cleanupGroomingSession')!({}, sessionId)
			).resolves.toBeUndefined();
			expect(mockCaptureException).toHaveBeenCalledWith(error);
		});
	});

	it('captures send prompt handler registration failures and continues registering cleanup', () => {
		const error = new Error('registration failed');
		handlers.clear();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			if (channel === 'context:sendGroomingPrompt') {
				throw error;
			}
			handlers.set(channel, handler);
		});

		registerContextHandlers(deps);

		expect(mockCaptureException).toHaveBeenCalledWith(error);
		expect(handlers.has('context:cleanupGroomingSession')).toBe(true);
		expect(handlers.has('context:sendGroomingPrompt')).toBe(false);
	});
});
