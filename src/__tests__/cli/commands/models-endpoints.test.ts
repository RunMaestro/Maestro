/**
 * @file models-endpoints.test.ts
 * @description Tests for `maestro-cli models endpoints`: list/add/update/remove
 * edit the `localModelEndpoints` setting through the shared list helpers, and
 * models/test/detect cross the WS bridge with the message shapes the desktop
 * handlers expect.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('crypto', () => ({
	randomUUID: vi.fn(() => 'new-uuid'),
}));

vi.mock('../../../cli/services/storage', () => ({
	readLocalModelEndpoints: vi.fn(),
	writeLocalModelEndpoints: vi.fn(),
	readSettingValue: vi.fn(),
}));

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

import {
	modelsEndpointsAdd,
	modelsEndpointsDetect,
	modelsEndpointsList,
	modelsEndpointsModels,
	modelsEndpointsRemove,
	modelsEndpointsTest,
	modelsEndpointsUpdate,
} from '../../../cli/commands/models-endpoints';
import {
	readLocalModelEndpoints,
	readSettingValue,
	writeLocalModelEndpoints,
} from '../../../cli/services/storage';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { ExitCode } from '../../../cli/exit-codes';
import type { LocalModelEndpoint } from '../../../shared/local-models/endpoints';

const ollama: LocalModelEndpoint = {
	id: 'aaaa-1111',
	name: 'Ollama',
	kind: 'ollama',
	baseUrl: 'http://127.0.0.1:11434',
	enabled: true,
};
const gateway: LocalModelEndpoint = {
	id: 'bbbb-2222',
	name: 'Gateway',
	kind: 'openai-compatible',
	baseUrl: 'https://llm.example.com',
	apiKeyEnvVar: 'LITELLM_KEY',
	enabled: true,
};

function mockSend(result: Record<string, unknown>) {
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
					return Promise.resolve(result);
				}),
		} as never)
	);
	return captured;
}

/** Last JSON line printed to stdout. */
function lastJson(spy: MockInstance): Record<string, unknown> {
	const calls = spy.mock.calls;
	return JSON.parse(calls[calls.length - 1][0] as string);
}

describe('models endpoints command', () => {
	let logSpy: MockInstance;
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
		vi.mocked(readLocalModelEndpoints).mockReturnValue([ollama]);
		vi.mocked(readSettingValue).mockReturnValue({});
	});

	describe('list', () => {
		it('prints one JSON line per endpoint and flags an unset key variable', () => {
			vi.mocked(readLocalModelEndpoints).mockReturnValue([ollama, gateway]);

			modelsEndpointsList({ json: true });

			expect(logSpy).toHaveBeenCalledTimes(2);
			expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual(ollama);
			expect(lastJson(logSpy)).toEqual({ ...gateway, apiKeyResolved: false });
		});

		it('reports a key variable as resolved when Settings -> Environment sets it', () => {
			vi.mocked(readLocalModelEndpoints).mockReturnValue([gateway]);
			vi.mocked(readSettingValue).mockReturnValue({ LITELLM_KEY: 'sk-1' });

			modelsEndpointsList({ json: true });

			expect(lastJson(logSpy).apiKeyResolved).toBe(true);
		});
	});

	describe('add', () => {
		it('defaults the URL and name for a local kind', () => {
			vi.mocked(readLocalModelEndpoints).mockReturnValue([]);

			modelsEndpointsAdd({ kind: 'lmstudio', json: true });

			const saved = {
				id: 'new-uuid',
				name: 'LM Studio',
				kind: 'lmstudio',
				baseUrl: 'http://127.0.0.1:1234',
				enabled: true,
			};
			expect(writeLocalModelEndpoints).toHaveBeenCalledWith([saved]);
			expect(lastJson(logSpy)).toEqual({ success: true, endpoint: saved });
		});

		it('appends an OpenAI-compatible endpoint with its key variable, normalized', () => {
			modelsEndpointsAdd({
				kind: 'openai-compatible',
				url: 'https://llm.example.com/',
				name: 'Gateway',
				apiKeyEnv: 'LITELLM_KEY',
				disabled: true,
				json: true,
			});

			expect(writeLocalModelEndpoints).toHaveBeenCalledWith([
				ollama,
				{ ...gateway, id: 'new-uuid', enabled: false },
			]);
			expect(lastJson(logSpy)).toMatchObject({ success: true, apiKeyResolved: false });
		});

		it('refuses an unknown kind as invalid usage', () => {
			expect(() => modelsEndpointsAdd({ kind: 'vllm', json: true })).toThrow('__exit__');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
			expect(writeLocalModelEndpoints).not.toHaveBeenCalled();
		});

		it('requires --url for an openai-compatible endpoint', () => {
			expect(() => modelsEndpointsAdd({ kind: 'openai-compatible', json: true })).toThrow(
				'__exit__'
			);
			expect(lastJson(logSpy).error).toContain('--url is required');
		});

		it('refuses credentials in the URL and a server already configured', () => {
			expect(() =>
				modelsEndpointsAdd({ kind: 'openai-compatible', url: 'https://u:p@h.example', json: true })
			).toThrow('__exit__');
			expect(lastJson(logSpy).error).toContain('credentials');

			expect(() =>
				modelsEndpointsAdd({ kind: 'ollama', url: 'http://localhost:11434', json: true })
			).toThrow('__exit__');
			expect(lastJson(logSpy).error).toContain('already configured as "Ollama"');
			expect(writeLocalModelEndpoints).not.toHaveBeenCalled();
		});
	});

	describe('update', () => {
		it('changes only the named fields and keeps the id and the place in the list', () => {
			vi.mocked(readLocalModelEndpoints).mockReturnValue([ollama, gateway]);

			modelsEndpointsUpdate('ollama', { name: 'Desk Ollama', json: true });

			const saved = { ...ollama, name: 'Desk Ollama' };
			expect(writeLocalModelEndpoints).toHaveBeenCalledWith([saved, gateway]);
			expect(lastJson(logSpy)).toEqual({ success: true, endpoint: saved });
		});

		it('switches an endpoint off and back on, leaving every other field', () => {
			vi.mocked(readLocalModelEndpoints).mockReturnValue([ollama, gateway]);

			modelsEndpointsUpdate('bbbb', { disable: true, json: true });
			expect(writeLocalModelEndpoints).toHaveBeenLastCalledWith([
				ollama,
				{ ...gateway, enabled: false },
			]);

			vi.mocked(readLocalModelEndpoints).mockReturnValue([ollama, { ...gateway, enabled: false }]);
			modelsEndpointsUpdate('bbbb', { enable: true, json: true });
			expect(writeLocalModelEndpoints).toHaveBeenLastCalledWith([ollama, gateway]);
		});

		it('sets, replaces and clears the key variable name', () => {
			vi.mocked(readLocalModelEndpoints).mockReturnValue([gateway]);
			vi.mocked(readSettingValue).mockReturnValue({ OTHER_KEY: 'sk-2' });

			modelsEndpointsUpdate('gateway', { apiKeyEnv: 'OTHER_KEY', json: true });
			expect(writeLocalModelEndpoints).toHaveBeenLastCalledWith([
				{ ...gateway, apiKeyEnvVar: 'OTHER_KEY' },
			]);
			expect(lastJson(logSpy).apiKeyResolved).toBe(true);

			modelsEndpointsUpdate('gateway', { clearApiKeyEnv: true, json: true });
			const { apiKeyEnvVar: _dropped, ...keyless } = gateway;
			expect(writeLocalModelEndpoints).toHaveBeenLastCalledWith([keyless]);
			expect(lastJson(logSpy)).toEqual({ success: true, endpoint: keyless });
		});

		it('normalizes a new URL and refuses one another endpoint already holds', () => {
			vi.mocked(readLocalModelEndpoints).mockReturnValue([ollama, gateway]);

			modelsEndpointsUpdate('gateway', { url: 'https://llm2.example.com/', json: true });
			expect(writeLocalModelEndpoints).toHaveBeenLastCalledWith([
				ollama,
				{ ...gateway, baseUrl: 'https://llm2.example.com' },
			]);

			vi.mocked(writeLocalModelEndpoints).mockClear();
			expect(() =>
				modelsEndpointsUpdate('gateway', { url: 'http://localhost:11434', json: true })
			).toThrow('__exit__');
			expect(lastJson(logSpy).error).toContain('already configured as "Ollama"');
			expect(writeLocalModelEndpoints).not.toHaveBeenCalled();
		});

		it('refuses a call that changes nothing, contradicts itself, or names a bad kind', () => {
			expect(() => modelsEndpointsUpdate('ollama', { json: true })).toThrow('__exit__');
			expect(lastJson(logSpy).error).toContain('Nothing to change');

			expect(() =>
				modelsEndpointsUpdate('ollama', { enable: true, disable: true, json: true })
			).toThrow('__exit__');
			expect(lastJson(logSpy).error).toContain('not both');

			expect(() =>
				modelsEndpointsUpdate('ollama', { apiKeyEnv: 'K', clearApiKeyEnv: true, json: true })
			).toThrow('__exit__');
			expect(lastJson(logSpy).error).toContain('not both');

			expect(() => modelsEndpointsUpdate('ollama', { kind: 'vllm', json: true })).toThrow(
				'__exit__'
			);
			expect(exitSpy).toHaveBeenLastCalledWith(ExitCode.InvalidUsage);
			expect(writeLocalModelEndpoints).not.toHaveBeenCalled();
		});

		it('exits non-zero for an unknown endpoint without writing', () => {
			expect(() => modelsEndpointsUpdate('nope', { disable: true, json: true })).toThrow(
				'__exit__'
			);
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
			expect(writeLocalModelEndpoints).not.toHaveBeenCalled();
		});
	});

	describe('remove', () => {
		it('removes by name and writes the rest back', () => {
			vi.mocked(readLocalModelEndpoints).mockReturnValue([ollama, gateway]);

			modelsEndpointsRemove('gateway', { json: true });

			expect(writeLocalModelEndpoints).toHaveBeenCalledWith([ollama]);
			expect(lastJson(logSpy)).toEqual({ success: true, id: 'bbbb-2222', name: 'Gateway' });
		});

		it('exits non-zero for an unknown endpoint without writing', () => {
			expect(() => modelsEndpointsRemove('nope', { json: true })).toThrow('__exit__');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
			expect(writeLocalModelEndpoints).not.toHaveBeenCalled();
		});
	});

	describe('models', () => {
		it('sends the reference and prints the ids the server lists', async () => {
			const models = [{ id: 'qwen3:4b', sizeBytes: 2_500_000_000 }, { id: 'nomic-embed-text' }];
			const cap = mockSend({ success: true, result: { ok: true, models } });

			await modelsEndpointsModels('ollama', { json: true });

			expect(cap.payload).toEqual({ type: 'local_models_endpoint_models', endpoint: 'ollama' });
			expect(cap.responseType).toBe('local_models_endpoint_models_result');
			expect(lastJson(logSpy)).toEqual({ success: true, models });
		});

		it('prints one model per line, with the size when the server reports it', async () => {
			mockSend({
				success: true,
				result: { ok: true, models: [{ id: 'qwen3:4b', sizeBytes: 1024 }, { id: 'bge' }] },
			});

			await modelsEndpointsModels('ollama', {});

			const lines = logSpy.mock.calls.map((call) => call[0] as string);
			expect(lines).toHaveLength(2);
			expect(lines[0]).toMatch(/^qwen3:4b {2}\S/);
			expect(lines[1]).toBe('bge');
		});

		it('passes the failure kind through and exits non-zero', async () => {
			mockSend({
				success: true,
				result: { ok: false, error: { kind: 'network', message: 'Nothing is listening' } },
			});

			await expect(modelsEndpointsModels('ollama', { json: true })).rejects.toThrow('__exit__');
			expect(lastJson(logSpy)).toEqual({
				success: false,
				error: { kind: 'network', message: 'Nothing is listening' },
			});
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
		});
	});

	describe('test', () => {
		it('sends the reference and model with a budget above the app test timeout', async () => {
			const cap = mockSend({
				success: true,
				result: { ok: true, model: 'qwen3', latencyMs: 120, modelCount: 3 },
			});

			await modelsEndpointsTest('ollama', { model: 'qwen3', json: true });

			expect(cap.payload).toEqual({
				type: 'local_models_endpoint_test',
				endpoint: 'ollama',
				model: 'qwen3',
			});
			expect(cap.responseType).toBe('local_models_endpoint_test_result');
			expect(cap.timeout).toBeGreaterThan(30_000);
			expect(lastJson(logSpy)).toEqual({
				success: true,
				ok: true,
				model: 'qwen3',
				latencyMs: 120,
				modelCount: 3,
			});
		});

		it('passes the failure kind through and exits non-zero', async () => {
			mockSend({
				success: true,
				result: { ok: false, error: { kind: 'missing-key', message: 'Set LITELLM_KEY' } },
			});

			await expect(modelsEndpointsTest('gateway', { json: true })).rejects.toThrow('__exit__');
			expect(lastJson(logSpy)).toEqual({
				success: false,
				error: { kind: 'missing-key', message: 'Set LITELLM_KEY' },
			});
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
		});
	});

	describe('detect', () => {
		it('reports detected servers without saving anything', async () => {
			const detected = [
				{ kind: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434', models: [] },
			];
			const cap = mockSend({ success: true, detected });

			await modelsEndpointsDetect({ json: true });

			expect(cap.payload).toEqual({ type: 'local_models_endpoints_detect' });
			expect(cap.responseType).toBe('local_models_endpoints_detect_result');
			expect(lastJson(logSpy)).toEqual({ success: true, detected });
			expect(writeLocalModelEndpoints).not.toHaveBeenCalled();
		});

		it('prints the add command for each detected server', async () => {
			mockSend({
				success: true,
				detected: [
					{ kind: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434', models: [] },
				],
			});

			await modelsEndpointsDetect({});

			expect(logSpy.mock.calls.flat().join('\n')).toContain(
				'maestro-cli models endpoints add --kind ollama --url http://127.0.0.1:11434'
			);
		});
	});
});
