// Source: src/__tests__/cli/commands/list-models.test.ts
// Source: src/__tests__/cli/commands/set-theme.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { listModels } from '../../../cli/commands/list-models';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { setTheme } from '../../../cli/commands/set-theme';
import { formatError } from '../../../cli/output/formatter';
vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));
describeSourceSuite('list-models', () => {
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
});
describeSourceSuite('set-theme', () => {
	function mockSend(result: Record<string, unknown>) {
		let captured: Record<string, unknown> = {};
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({
				sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
					captured = payload;
					return Promise.resolve(result);
				}),
			} as never)
		);
		return () => captured;
	}

	describe('set-theme command', () => {
		let consoleSpy: MockInstance;
		let processExitSpy: MockInstance;

		beforeEach(() => {
			vi.clearAllMocks();
			consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
			vi.spyOn(console, 'error').mockImplementation(() => {});
			processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
				throw new Error('__exit__');
			});
		});

		it('sets a theme by id via set_setting/activeThemeId', async () => {
			const getPayload = mockSend({ success: true });
			await setTheme('dracula', {});
			const p = getPayload();
			expect(p.type).toBe('set_setting');
			expect(p.key).toBe('activeThemeId');
			expect(p.value).toBe('dracula');
		});

		it('matches a theme by display name (case-insensitive)', async () => {
			const getPayload = mockSend({ success: true });
			await setTheme('dracula', {});
			expect(getPayload().value).toBe('dracula');
		});

		it('rejects an unknown theme without connecting', async () => {
			await expect(setTheme('not-a-real-theme', {})).rejects.toThrow('__exit__');
			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Unknown theme'));
			expect(withMaestroClient).not.toHaveBeenCalled();
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('--list prints themes and does not connect', async () => {
			await setTheme(undefined, { list: true });
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Available themes'));
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('lists as JSON when --list --json', async () => {
			await setTheme(undefined, { list: true, json: true });
			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(Array.isArray(parsed)).toBe(true);
			expect(parsed[0]).toHaveProperty('id');
		});

		it('reports a server failure', async () => {
			mockSend({ success: false, error: 'Setting modification not configured' });
			await expect(setTheme('dracula', {})).rejects.toThrow('__exit__');
			expect(formatError).toHaveBeenCalledWith('Setting modification not configured');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});
});
