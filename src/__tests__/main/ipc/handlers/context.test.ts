/**
 * Tests for the Context IPC handlers' Local Models routing.
 *
 * `context:groomContext` with `cheapTurn` is a context summary, and runs
 * through the `tab-summary` assignment first. Grooming and transfer (no
 * `cheapTurn`) never ask the router.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ipcMain } from 'electron';
import { registerContextHandlers } from '../../../../main/ipc/handlers/context';
import { groomContext, cancelAllGroomingSessions } from '../../../../main/utils/context-groomer';
import { MAX_TASK_MAX_TOKENS, runLocalTask } from '../../../../main/local-models/task-router';

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn() },
	BrowserWindow: vi.fn(),
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

vi.mock('../../../../main/agents', () => ({
	getSessionStorage: vi.fn(),
}));

vi.mock('../../../../main/stores', () => ({
	getSettingsStore: vi.fn(() => ({ get: vi.fn() })),
}));

vi.mock('../../../../main/utils/ssh-remote-resolver', () => ({
	createSshRemoteStoreAdapter: vi.fn(),
}));

vi.mock('../../../../main/utils/context-groomer', () => ({
	groomContext: vi.fn(),
	cancelAllGroomingSessions: vi.fn(),
}));

vi.mock('../../../../main/local-models/task-router', () => ({
	MAX_TASK_MAX_TOKENS: 8192,
	runLocalTask: vi.fn(),
}));

describe('context IPC handlers: Local Models routing', () => {
	const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
	const localSource = { type: 'local', modelId: 'qwen3-1.7b' } as const;
	const settings = new Map<string, unknown>();

	const groom = (options?: Record<string, unknown>) =>
		handlers.get('context:groomContext')!({}, '/proj', 'claude-code', 'SUMMARIZE THIS', options);

	beforeEach(() => {
		vi.clearAllMocks();
		settings.clear();
		handlers.clear();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler as never);
			return undefined as never;
		});
		vi.mocked(runLocalTask).mockResolvedValue({ status: 'use-utility-agent' });
		vi.mocked(groomContext).mockResolvedValue({ response: 'agent summary' } as never);

		registerContextHandlers({
			getMainWindow: () => null,
			getProcessManager: () => ({}) as never,
			getAgentDetector: () => ({}) as never,
			agentConfigsStore: { get: vi.fn(() => ({})) } as never,
			settingsStore: {
				get: vi.fn((key: string, fallback?: unknown) =>
					settings.has(key) ? settings.get(key) : fallback
				),
			} as never,
		});
	});

	it('never asks the router for grooming or transfer (no cheapTurn)', async () => {
		expect(await groom()).toBe('agent summary');
		expect(await groom({ customPath: '/bin/claude' })).toBe('agent summary');

		expect(runLocalTask).not.toHaveBeenCalled();
		expect(groomContext).toHaveBeenCalledTimes(2);
	});

	it('does not use a hidden provider override when the utility source is local', async () => {
		settings.set('utilitySource', localSource);
		settings.set('utilityAgentId', 'codex');
		settings.set('utilityModelId', 'utility-model');
		await groom({ customPath: '/bin/claude' });
		expect(groomContext).toHaveBeenCalledWith(
			expect.objectContaining({
				agentType: 'claude-code',
				modelId: undefined,
				sessionCustomPath: '/bin/claude',
			}),
			expect.anything(),
			expect.anything()
		);
	});

	it('retains the configured provider and model on the provider utility path', async () => {
		settings.set('utilityAgentId', 'codex');
		settings.set('utilityModelId', 'utility-model');
		await groom();
		expect(groomContext).toHaveBeenCalledWith(
			expect.objectContaining({
				agentType: 'codex',
				modelId: 'utility-model',
			}),
			expect.anything(),
			expect.anything()
		);
	});

	it('never sends an answer-only cheap turn to the summary model', async () => {
		// Quick Chat's tab routing: cheap, but a one-word answer, not a summary.
		vi.mocked(runLocalTask).mockResolvedValue({ status: 'ok', text: 'a summary' } as never);

		expect(await groom({ cheapTurn: true, readOnly: true, disableTools: true })).toBe(
			'agent summary'
		);

		expect(runLocalTask).not.toHaveBeenCalled();
		expect(groomContext).toHaveBeenCalledTimes(1);
	});

	it('keeps the agent path for a summary on use-utility-agent', async () => {
		expect(await groom({ cheapTurn: true })).toBe('agent summary');

		expect(runLocalTask).toHaveBeenCalledWith(
			'tab-summary',
			expect.objectContaining({
				prompt: 'SUMMARIZE THIS',
				maxTokens: MAX_TASK_MAX_TOKENS,
				signal: expect.any(AbortSignal),
			})
		);
		expect(groomContext).toHaveBeenCalledTimes(1);
	});

	it('returns the assigned model summary and never spawns an agent', async () => {
		vi.mocked(runLocalTask).mockResolvedValue({
			status: 'ok',
			text: 'local summary',
			source: localSource,
			durationMs: 40,
		});

		expect(await groom({ cheapTurn: true })).toBe('local summary');
		expect(groomContext).not.toHaveBeenCalled();
	});

	it('keeps the agent path when the assignment is off (compaction needs a model)', async () => {
		vi.mocked(runLocalTask).mockResolvedValue({ status: 'off' });

		expect(await groom({ cheapTurn: true })).toBe('agent summary');
		expect(groomContext).toHaveBeenCalledTimes(1);
	});

	it('fails with the reason when the model is unavailable, without an agent', async () => {
		vi.mocked(runLocalTask).mockResolvedValue({
			status: 'unavailable',
			source: localSource,
			reason: 'Qwen3 1.7B is not downloaded. Download it in Settings.',
			code: 'model-not-installed',
		});

		await expect(groom({ cheapTurn: true })).rejects.toThrow(
			'Qwen3 1.7B is not downloaded. Download it in Settings.'
		);
		expect(groomContext).not.toHaveBeenCalled();
	});

	it('fails when the summary was cancelled, without an agent', async () => {
		vi.mocked(runLocalTask).mockResolvedValue({ status: 'cancelled', source: localSource });

		await expect(groom({ cheapTurn: true })).rejects.toThrow(/stopped before it finished/);
		expect(groomContext).not.toHaveBeenCalled();
	});

	it('cancelGrooming aborts a local summary in flight', async () => {
		let seenSignal: AbortSignal | undefined;
		vi.mocked(runLocalTask).mockImplementation(
			(_task, input) =>
				new Promise((resolve) => {
					seenSignal = input.signal;
					input.signal!.addEventListener('abort', () =>
						resolve({ status: 'cancelled', source: localSource })
					);
				})
		);

		const pending = groom({ cheapTurn: true });
		await vi.waitFor(() => expect(seenSignal).toBeDefined());

		await handlers.get('context:cancelGrooming')!({});

		expect(cancelAllGroomingSessions).toHaveBeenCalled();
		expect(seenSignal!.aborted).toBe(true);
		await expect(pending).rejects.toThrow(/stopped before it finished/);
	});
});
