/**
 * @file models-status.test.ts
 * @description Tests for `maestro-cli models status`: the task id is checked
 * before the bridge is opened, the request crosses the WS bridge in the shape
 * the desktop handler expects, and the exit code tells a script whether the
 * task (or every assigned task) would run.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

import { modelsStatus } from '../../../cli/commands/models-status';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { ExitCode } from '../../../cli/exit-codes';
import type { LocalModelTaskReadiness } from '../../../shared/local-models/task-readiness';
import { formatError } from '../../../cli/output/formatter';

function mockSend(reply: Record<string, unknown>) {
	const captured: { payload?: Record<string, unknown>; responseType?: string; timeout?: number } =
		{};
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi
				.fn()
				.mockImplementation((payload: Record<string, unknown>, rt: string, timeout?: number) => {
					captured.payload = payload;
					captured.responseType = rt;
					captured.timeout = timeout;
					return Promise.resolve(reply);
				}),
		} as never)
	);
	return captured;
}

const READY: LocalModelTaskReadiness = {
	taskId: 'semantic-search',
	label: 'Semantic search',
	needs: 'embedding',
	assignment: { type: 'local', modelId: 'bge-small-en-v1.5' },
	state: 'ready',
	detail: 'Runs BGE Small (English) on this machine.',
	runtimeId: 'onnx',
};

const OFF: LocalModelTaskReadiness = {
	taskId: 'git-drafts',
	label: 'Git drafts',
	needs: 'text-gen',
	assignment: { type: 'off' },
	state: 'off',
	detail: 'Git drafts is off.',
	suggestedAction: 'Assign it a local model or an endpoint in Settings -> Local Models.',
};

const UNAVAILABLE: LocalModelTaskReadiness = {
	taskId: 'injection-screen',
	label: 'Prompt-injection screen',
	needs: 'classifier',
	assignment: { type: 'local', modelId: 'prompt-guard-2-22m' },
	state: 'unavailable',
	reason: 'model-not-installed',
	detail: 'Llama Prompt Guard 2 22M is not downloaded.',
	suggestedAction: 'Download it in Settings.',
	runtimeId: 'onnx',
};

describe('models status command', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('asks for every task when none is named and exits 0 when nothing assigned is down', async () => {
		const captured = mockSend({ success: true, readiness: [READY, OFF] });

		await modelsStatus(undefined, {});

		expect(captured.payload).toEqual({ type: 'local_models_task_readiness' });
		expect(captured.responseType).toBe('local_models_task_readiness_result');
		expect(captured.timeout).toBeGreaterThan(5_000);
		const output = logSpy.mock.calls[0][0] as string;
		expect(output).toMatch(/LOCAL MODEL TASKS/);
		expect(output).toMatch(/semantic-search\s+ready\s+Runs BGE Small/);
		// An off task's action is noise in a full listing.
		expect(output).not.toMatch(/Assign it a local model/);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('exits non-zero for a full listing with an unavailable task, showing its reason and action', async () => {
		mockSend({ success: true, readiness: [READY, UNAVAILABLE] });

		await expect(modelsStatus(undefined, {})).rejects.toThrow('__exit__');

		const output = logSpy.mock.calls[0][0] as string;
		expect(output).toMatch(/injection-screen\s+unavailable\s+Llama Prompt Guard 2 22M/);
		expect(output).toMatch(/\[model-not-installed\]/);
		expect(output).toMatch(/-> Download it in Settings\./);
		expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
	});

	it('sends a named task and exits 0 only when it would run', async () => {
		const captured = mockSend({ success: true, readiness: [READY] });

		await modelsStatus('semantic-search', {});

		expect(captured.payload).toEqual({
			type: 'local_models_task_readiness',
			taskId: 'semantic-search',
		});
		expect(logSpy.mock.calls[0][0]).not.toMatch(/LOCAL MODEL TASKS/);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('exits non-zero for a named task that is off, showing what to do', async () => {
		mockSend({ success: true, readiness: [OFF] });

		await expect(modelsStatus('git-drafts', {})).rejects.toThrow('__exit__');

		expect(logSpy.mock.calls[0][0]).toMatch(/-> Assign it a local model or an endpoint/);
		expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
	});

	it('prints the verdicts as JSON with success reflecting the exit code', async () => {
		mockSend({ success: true, readiness: [UNAVAILABLE] });

		await expect(modelsStatus('injection-screen', { json: true })).rejects.toThrow('__exit__');

		expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
			success: false,
			tasks: [UNAVAILABLE],
		});
	});

	it('reports a refused request from the app', async () => {
		mockSend({ success: false, error: 'Unknown task "x".' });

		await expect(modelsStatus(undefined, {})).rejects.toThrow('__exit__');

		expect(errorSpy).toHaveBeenCalledWith(formatError('Unknown task "x".'));
	});

	it('refuses an unknown task before opening the bridge', async () => {
		await expect(modelsStatus('tab-nameing', {})).rejects.toThrow('__exit__');

		expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
		expect(errorSpy.mock.calls[0][0]).toMatch(/Unknown task "tab-nameing"/);
		expect(withMaestroClient).not.toHaveBeenCalled();
	});
});
