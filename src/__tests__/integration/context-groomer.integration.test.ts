import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const uuidMocks = vi.hoisted(() => ({
	v4: vi.fn(),
}));

const agentArgsMocks = vi.hoisted(() => ({
	buildAgentArgs: vi.fn(),
	applyAgentConfigOverrides: vi.fn(),
}));

vi.mock('uuid', () => ({
	v4: uuidMocks.v4,
}));

vi.mock('../../main/utils/agent-args', () => agentArgsMocks);

vi.mock('../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
}));

import {
	cancelAllGroomingSessions,
	getActiveGroomingSessionCount,
	groomContext,
	type GroomContextOptions,
	type GroomingProcessManager,
} from '../../main/utils/context-groomer';
import { logger } from '../../main/utils/logger';

type Handler = (...args: unknown[]) => void;

function createProcessManager(overrides: Partial<GroomingProcessManager> = {}) {
	const handlers = new Map<string, Set<Handler>>();
	const manager = {
		spawn: vi.fn(() => ({ pid: 1234, success: true })),
		on: vi.fn((event: string, handler: Handler) => {
			if (!handlers.has(event)) handlers.set(event, new Set());
			handlers.get(event)!.add(handler);
		}),
		off: vi.fn((event: string, handler: Handler) => {
			handlers.get(event)?.delete(handler);
		}),
		kill: vi.fn(),
		emit(event: string, ...args: unknown[]) {
			for (const handler of handlers.get(event) || []) {
				handler(...args);
			}
		},
		handlerCount(event: string) {
			return handlers.get(event)?.size ?? 0;
		},
		...overrides,
	};
	return manager;
}

function createAgentDetector(agent: Record<string, unknown> | null = {}) {
	return {
		getAgent: vi.fn().mockResolvedValue(
			agent === null
				? null
				: {
						id: 'codex',
						command: 'codex',
						path: '/usr/local/bin/codex',
						available: true,
						args: ['--json'],
						promptArgs: vi.fn((prompt: string) => ['--prompt', prompt]),
						noPromptSeparator: true,
						...agent,
					}
		),
	};
}

function createOptions(overrides: Partial<GroomContextOptions> = {}): GroomContextOptions {
	return {
		projectRoot: '/repo',
		agentType: 'codex',
		prompt: 'Summarize this context',
		agentSessionId: 'source-session',
		readOnlyMode: true,
		sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		sessionCustomPath: '/opt/codex',
		sessionCustomArgs: '--fast',
		sessionCustomEnvVars: { MODE: 'test' },
		agentConfigValues: { model: 'gpt-5.3-codex' },
		...overrides,
	};
}

async function flushPromises() {
	await Promise.resolve();
	await Promise.resolve();
}

describe('context groomer integration', () => {
	let uuidCounter = 0;

	beforeEach(() => {
		vi.clearAllMocks();
		uuidCounter = 0;
		uuidMocks.v4.mockImplementation(() => `uuid-${++uuidCounter}`);
		agentArgsMocks.buildAgentArgs.mockReturnValue(['--batch', '--readonly']);
		agentArgsMocks.applyAgentConfigOverrides.mockReturnValue({
			args: ['--resolved'],
			effectiveCustomEnvVars: { MODE: 'resolved' },
		});
		cancelAllGroomingSessions();
	});

	afterEach(() => {
		cancelAllGroomingSessions();
		vi.useRealTimers();
	});

	it('spawns a configured grooming process, collects chunks, and resolves on process exit', async () => {
		const processManager = createProcessManager();
		const agentDetector = createAgentDetector();

		const promise = groomContext(createOptions(), processManager, agentDetector as any);
		await flushPromises();

		expect(getActiveGroomingSessionCount()).toBe(1);
		expect(agentArgsMocks.buildAgentArgs).toHaveBeenCalledWith(
			expect.objectContaining({ command: 'codex' }),
			expect.objectContaining({
				baseArgs: ['--json'],
				prompt: 'Summarize this context',
				cwd: '/repo',
				readOnlyMode: true,
				agentSessionId: 'source-session',
			})
		);
		expect(agentArgsMocks.applyAgentConfigOverrides).toHaveBeenCalledWith(
			expect.objectContaining({ command: 'codex' }),
			['--batch', '--readonly'],
			{
				agentConfigValues: { model: 'gpt-5.3-codex' },
				sessionCustomArgs: '--fast',
				sessionCustomEnvVars: { MODE: 'test' },
			}
		);
		expect(processManager.spawn).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'groomer-uuid-1',
				toolType: 'codex',
				cwd: '/repo',
				command: '/opt/codex',
				args: ['--resolved'],
				prompt: 'Summarize this context',
				noPromptSeparator: true,
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				customEnvVars: { MODE: 'resolved' },
			})
		);

		processManager.emit('data', 'other-session', 'ignored');
		processManager.emit('exit', 'other-session', 0);
		for (let index = 0; index < 10; index++) {
			processManager.emit('data', 'groomer-uuid-1', `chunk-${index};`);
		}
		processManager.emit('exit', 'groomer-uuid-1', 0);

		await expect(promise).resolves.toMatchObject({
			response: 'chunk-0;chunk-1;chunk-2;chunk-3;chunk-4;chunk-5;chunk-6;chunk-7;chunk-8;chunk-9;',
			completionReason: 'process exited with code 0',
		});
		expect(processManager.handlerCount('data')).toBe(0);
		expect(getActiveGroomingSessionCount()).toBe(0);
		expect(logger.debug).toHaveBeenCalledWith(
			'Grooming data chunk received',
			'[ContextGroomer]',
			expect.objectContaining({ chunkCount: 10 })
		);
	});

	it('cancels active grooming sessions and tolerates kill failures', async () => {
		const processManager = createProcessManager({
			kill: vi.fn(() => {
				throw new Error('already gone');
			}),
		});
		const promise = groomContext(createOptions(), processManager, createAgentDetector() as any);
		await flushPromises();

		expect(getActiveGroomingSessionCount()).toBe(1);
		cancelAllGroomingSessions();

		await expect(promise).rejects.toThrow('Grooming cancelled by user');
		expect(processManager.kill).toHaveBeenCalledWith('groomer-uuid-1');
		expect(getActiveGroomingSessionCount()).toBe(0);

		cancelAllGroomingSessions();
		expect(logger.info).toHaveBeenCalledWith(
			'Cancelling all grooming sessions',
			'[ContextGroomer]',
			{ count: 0 }
		);
	});

	it('rejects unavailable agents and failed spawn attempts', async () => {
		await expect(
			groomContext(createOptions(), createProcessManager(), createAgentDetector(null) as any)
		).rejects.toThrow('Agent codex is not available');

		await expect(
			groomContext(
				createOptions(),
				createProcessManager(),
				createAgentDetector({ available: false }) as any
			)
		).rejects.toThrow('Agent codex is not available');

		await expect(
			groomContext(
				createOptions(),
				createProcessManager({ spawn: vi.fn(() => null) }),
				createAgentDetector() as any
			)
		).rejects.toThrow('Failed to spawn grooming process for codex');

		await expect(
			groomContext(
				createOptions(),
				createProcessManager({ spawn: vi.fn(() => ({ pid: 0 })) }),
				createAgentDetector() as any
			)
		).rejects.toThrow('Failed to spawn grooming process for codex');
	});

	it('rejects agent-error events and ignores late duplicate resolutions', async () => {
		const processManager = createProcessManager();
		const promise = groomContext(createOptions(), processManager, createAgentDetector() as any);
		await flushPromises();

		processManager.emit('agent-error', 'other-session', new Error('ignored'));
		processManager.emit('agent-error', 'groomer-uuid-1', new Error('agent failed'));
		processManager.emit('agent-error', 'groomer-uuid-1', 'late failure');
		processManager.emit('exit', 'groomer-uuid-1', 1);

		await expect(promise).rejects.toThrow('Grooming error: agent failed');
		expect(logger.error).toHaveBeenCalledWith(
			'Grooming error',
			'[ContextGroomer]',
			expect.objectContaining({ error: 'agent failed' })
		);

		const secondManager = createProcessManager();
		const second = groomContext(createOptions(), secondManager, createAgentDetector() as any);
		await flushPromises();
		secondManager.emit('agent-error', 'groomer-uuid-2', 'string failure');
		await expect(second).rejects.toThrow('Grooming error: string failure');
	});

	it('resolves on idle timeout after enough content is received', async () => {
		vi.useFakeTimers();
		const processManager = createProcessManager();
		const promise = groomContext(createOptions(), processManager, createAgentDetector() as any);
		await flushPromises();

		processManager.emit('data', 'groomer-uuid-1', 'x'.repeat(120));
		await vi.advanceTimersByTimeAsync(6001);

		await expect(promise).resolves.toMatchObject({
			response: 'x'.repeat(120),
			completionReason: 'idle timeout with content',
		});
		expect(getActiveGroomingSessionCount()).toBe(0);
	});

	it('clears the overall timeout after process exit cleanup', async () => {
		let overallTimer: ReturnType<typeof setTimeout> | undefined;
		const nativeSetTimeout = globalThis.setTimeout;
		const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
			handler: TimerHandler,
			timeout?: number,
			...args: any[]
		) => {
			const timer = nativeSetTimeout(handler, timeout, ...args);
			if (timeout === 1234 && typeof handler === 'function') {
				overallTimer = timer;
			}
			return timer;
		}) as typeof setTimeout);
		const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

		try {
			const processManager = createProcessManager();
			const promise = groomContext(
				createOptions({ timeoutMs: 1234 }),
				processManager,
				createAgentDetector() as any
			);
			await flushPromises();

			processManager.emit('exit', 'groomer-uuid-1', 0);
			await expect(promise).resolves.toMatchObject({
				completionReason: 'process exited with code 0',
			});

			expect(overallTimer).toBeDefined();
			expect(clearTimeoutSpy).toHaveBeenCalledWith(overallTimer);
		} finally {
			clearTimeoutSpy.mockRestore();
			setTimeoutSpy.mockRestore();
		}
	});

	it('handles overall timeout with and without partial content', async () => {
		vi.useFakeTimers();
		const withContentManager = createProcessManager();
		const withContent = groomContext(
			createOptions({ timeoutMs: 1000 }),
			withContentManager,
			createAgentDetector() as any
		);
		await flushPromises();

		withContentManager.emit('data', 'groomer-uuid-1', 'partial');
		await vi.advanceTimersByTimeAsync(1001);
		await expect(withContent).resolves.toMatchObject({
			response: 'partial',
			completionReason: 'overall timeout with content',
		});

		const noContentManager = createProcessManager();
		const noContent = groomContext(
			createOptions({ timeoutMs: 1000 }),
			noContentManager,
			createAgentDetector() as any
		);
		const noContentExpectation = expect(noContent).rejects.toThrow(
			'Grooming timed out with no response'
		);
		await flushPromises();

		await vi.advanceTimersByTimeAsync(1001);
		await noContentExpectation;
		expect(logger.warn).toHaveBeenCalledWith(
			'Grooming timeout',
			'[ContextGroomer]',
			expect.objectContaining({ responseLength: 0 })
		);
	});
});
