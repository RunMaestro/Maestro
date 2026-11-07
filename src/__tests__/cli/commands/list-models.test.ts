/**
 * @file list-models.test.ts
 * @description Tests for `maestro-cli list models` - the CLI half of the model
 * pickers' list and their Refresh button.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

import { listModels } from '../../../cli/commands/list-models';
import { withMaestroClient } from '../../../cli/services/maestro-client';

function mockSend(result: Record<string, unknown>) {
	let captured: { payload?: Record<string, unknown>; responseType?: string } = {};
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi
				.fn()
				.mockImplementation((payload: Record<string, unknown>, responseType: string) => {
					captured = { payload, responseType };
					return Promise.resolve(result);
				}),
		} as never)
	);
	return () => captured;
}

describe('list models command', () => {
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

	it('asks the desktop for a cached read by default and prints one model per line', async () => {
		const sent = mockSend({
			success: true,
			agentId: 'opencode',
			sshRemoteId: null,
			models: ['', 'ollama/qwen3:8b', 'ollama/deepseek-v4.1-flash:cloud'],
		});

		await listModels('opencode', {});

		expect(sent()).toEqual({
			payload: { type: 'list_agent_models', agentId: 'opencode', refresh: false },
			responseType: 'list_agent_models_result',
		});
		// The '' agent-default sentinel is not a model and is not printed.
		expect(logSpy.mock.calls.map((c) => c[0])).toEqual([
			'ollama/qwen3:8b',
			'ollama/deepseek-v4.1-flash:cloud',
		]);
	});

	it('passes --refresh and --ssh-remote through and reports JSON', async () => {
		const sent = mockSend({
			success: true,
			agentId: 'opencode',
			sshRemoteId: 'remote-1',
			models: ['ollama/new'],
		});

		await listModels('opencode', { refresh: true, sshRemote: 'remote-1', json: true });

		expect(sent().payload).toEqual({
			type: 'list_agent_models',
			agentId: 'opencode',
			refresh: true,
			sshRemoteId: 'remote-1',
		});
		expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
			success: true,
			provider: 'opencode',
			sshRemoteId: 'remote-1',
			refreshed: true,
			models: ['ollama/new'],
		});
	});

	it('says so when a provider has no models', async () => {
		mockSend({ success: true, agentId: 'claude-code', sshRemoteId: null, models: [] });

		await listModels('claude-code', {});

		expect(logSpy).toHaveBeenCalledWith('No models discovered for claude-code.');
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('exits non-zero with the desktop error', async () => {
		mockSend({ success: false, error: 'Unknown provider "nope".' });

		await expect(listModels('nope', {})).rejects.toThrow('__exit__');

		expect(errorSpy).toHaveBeenCalledWith('Error: Unknown provider "nope".');
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it('reports a failure to reach the desktop as JSON when asked', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('Maestro is not running'));

		await expect(listModels('opencode', { json: true })).rejects.toThrow('__exit__');

		expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
			success: false,
			error: 'Maestro is not running',
		});
	});
});
