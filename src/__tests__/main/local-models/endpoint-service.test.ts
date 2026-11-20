/**
 * @file endpoint-service.test.ts
 *
 * The persisted-state layer over the endpoint client: which record a saved id
 * resolves to, that a not-yet-saved record is validated before anything is
 * sent, that the API key comes from Settings -> Environment, and that detection
 * is handed the configured list so it never offers a server twice.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const settings = vi.hoisted(() => new Map<string, unknown>());

vi.mock('../../../main/stores/getters', () => ({
	getSettingsStore: () => ({
		get: (key: string, fallback?: unknown) => (settings.has(key) ? settings.get(key) : fallback),
	}),
}));

const client = vi.hoisted(() => ({
	detectLocalEndpoints: vi.fn(async () => []),
	listEndpointModelsResult: vi.fn(async () => ({ ok: true, models: [] })),
	testEndpoint: vi.fn(async () => ({ ok: true, model: 'm', latencyMs: 5 })),
	endpointChat: vi.fn(async () => ({ content: 'hi', model: 'm' })),
	endpointEmbed: vi.fn(async () => ({ embeddings: [[1, 0]], model: 'm' })),
	endpointTranscribe: vi.fn(async () => ({ text: 'hello' })),
}));

vi.mock('../../../main/local-models/endpoint-client', () => client);

const serverTarget = vi.hoisted(() => ({
	endpoint: {
		id: 'maestro-server',
		name: 'Maestro model server',
		kind: 'openai-compatible',
		baseUrl: 'http://127.0.0.1:41234',
		enabled: true,
	},
	apiKey: 'sk-maestro-test',
}));
const server = vi.hoisted(() => ({
	refersToModelServer: vi.fn(
		(ref: unknown) =>
			ref === 'maestro-server' ||
			ref === 'Maestro model server' ||
			(typeof ref === 'object' && (ref as { id?: unknown })?.id === 'maestro-server')
	),
	listModelServerModels: vi.fn(async () => ({ ok: true, models: [{ id: 'qwen3-1.7b' }] })),
	testModelServer: vi.fn(async () => ({ ok: true, model: 'qwen3-1.7b', latencyMs: 9 })),
	modelServerCallTarget: vi.fn(async () => serverTarget),
	modelServerUnsupported: vi.fn((what: string) =>
		Object.assign(new Error(`text generation only, not ${what}`), { kind: 'invalid' })
	),
}));

vi.mock('../../../main/local-models/server/server-endpoint', () => server);

import {
	chatWithLocalModelEndpoint,
	detectNewLocalModelEndpoints,
	embedWithLocalModelEndpoint,
	getConfiguredLocalModelEndpoints,
	listLocalModelEndpointModels,
	testLocalModelEndpoint,
	transcribeWithLocalModelEndpoint,
} from '../../../main/local-models/endpoint-service';

const saved = {
	id: 'ep-1',
	name: 'Gateway',
	kind: 'openai-compatible',
	baseUrl: 'https://llm.example.com/',
	apiKeyEnvVar: 'LITELLM_KEY',
	enabled: true,
};

beforeEach(() => {
	vi.clearAllMocks();
	settings.clear();
	settings.set('localModelEndpoints', [saved, { id: 'broken', baseUrl: 'ftp://x' }]);
	settings.set('shellEnvVars', { LITELLM_KEY: 'sk-test' });
});

describe('endpoint-service', () => {
	it('reads the saved list through the validator, dropping invalid records', () => {
		expect(getConfiguredLocalModelEndpoints()).toEqual([
			{ ...saved, baseUrl: 'https://llm.example.com' },
		]);
	});

	it('hands detection the configured list', async () => {
		await detectNewLocalModelEndpoints();

		expect(client.detectLocalEndpoints).toHaveBeenCalledWith([
			expect.objectContaining({ id: 'ep-1', baseUrl: 'https://llm.example.com' }),
		]);
	});

	it('resolves a saved id and passes Settings -> Environment for the key', async () => {
		await testLocalModelEndpoint('ep-1', ' gpt-x ');

		expect(client.testEndpoint).toHaveBeenCalledWith(expect.objectContaining({ id: 'ep-1' }), {
			shellEnvVars: { LITELLM_KEY: 'sk-test' },
			model: 'gpt-x',
		});
	});

	it('resolves a saved endpoint by name or id prefix, as the CLI names one', async () => {
		await testLocalModelEndpoint('gateway');
		await listLocalModelEndpointModels('ep-');

		expect(client.testEndpoint).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'ep-1' }),
			expect.anything()
		);
		expect(client.listEndpointModelsResult).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'ep-1' }),
			expect.anything()
		);
	});

	it('tests an unsaved record without a model, letting the client pick one', async () => {
		const draft = { ...saved, id: 'draft', baseUrl: 'http://127.0.0.1:1234' };

		await testLocalModelEndpoint(draft);

		expect(client.testEndpoint).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'draft', baseUrl: 'http://127.0.0.1:1234' }),
			{ shellEnvVars: { LITELLM_KEY: 'sk-test' } }
		);
	});

	it('answers an unknown id as invalid without calling the client', async () => {
		const result = await listLocalModelEndpointModels('nope');

		expect(result).toEqual({
			ok: false,
			error: { kind: 'invalid', message: 'No endpoint matches "nope".' },
		});
		expect(client.listEndpointModelsResult).not.toHaveBeenCalled();
	});

	it('answers a record that fails validation as invalid, naming the problem', async () => {
		const result = await testLocalModelEndpoint({ ...saved, baseUrl: 'http://u:p@host' });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe('invalid');
		expect(result.error.message).toContain('credentials');
		expect(client.testEndpoint).not.toHaveBeenCalled();
	});

	it('chats with a saved endpoint by exact id, with the key from Settings -> Environment', async () => {
		const messages = [{ role: 'user' as const, content: 'hi' }];

		await chatWithLocalModelEndpoint('ep-1', { model: 'gpt-x', messages });

		expect(client.endpointChat).toHaveBeenCalledWith(expect.objectContaining({ id: 'ep-1' }), {
			model: 'gpt-x',
			messages,
			shellEnvVars: { LITELLM_KEY: 'sk-test' },
		});
	});

	it('refuses to chat by prefix or name, or with a disabled endpoint', async () => {
		settings.set('localModelEndpoints', [saved, { ...saved, id: 'ep-off', enabled: false }]);
		const request = { model: 'm', messages: [] };

		await expect(chatWithLocalModelEndpoint('ep-', request)).rejects.toMatchObject({
			kind: 'invalid',
		});
		await expect(chatWithLocalModelEndpoint('Gateway', request)).rejects.toMatchObject({
			kind: 'invalid',
		});
		await expect(chatWithLocalModelEndpoint('ep-off', request)).rejects.toMatchObject({
			kind: 'invalid',
		});
		expect(client.endpointChat).not.toHaveBeenCalled();
	});

	it('transcribes on a saved endpoint by exact id, with the key from Settings -> Environment', async () => {
		const wav = Uint8Array.from([1, 2, 3]);
		await expect(
			transcribeWithLocalModelEndpoint('ep-1', { model: 'whisper-1', wav })
		).resolves.toEqual({ text: 'hello' });

		expect(client.endpointTranscribe).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'ep-1' }),
			{ model: 'whisper-1', wav, shellEnvVars: { LITELLM_KEY: 'sk-test' } }
		);
	});

	it('refuses to transcribe on an endpoint that is unknown, before any request', async () => {
		await expect(
			transcribeWithLocalModelEndpoint('ep-', { model: 'whisper-1', wav: new Uint8Array(1) })
		).rejects.toMatchObject({ kind: 'invalid' });
		expect(client.endpointTranscribe).not.toHaveBeenCalled();
	});

	it('embeds on a saved endpoint by exact id, with the key from Settings -> Environment', async () => {
		await embedWithLocalModelEndpoint('ep-1', { model: 'nomic-embed-text', input: ['a', 'b'] });

		expect(client.endpointEmbed).toHaveBeenCalledWith(expect.objectContaining({ id: 'ep-1' }), {
			model: 'nomic-embed-text',
			input: ['a', 'b'],
			shellEnvVars: { LITELLM_KEY: 'sk-test' },
		});
	});

	it('refuses to embed on an unknown or disabled endpoint, by the same rule as chat', async () => {
		settings.set('localModelEndpoints', [saved, { ...saved, id: 'ep-off', enabled: false }]);
		const request = { model: 'm', input: ['a'] };

		await expect(embedWithLocalModelEndpoint('ep-', request)).rejects.toMatchObject({
			kind: 'invalid',
		});
		await expect(embedWithLocalModelEndpoint('ep-off', request)).rejects.toMatchObject({
			kind: 'invalid',
		});
		expect(client.endpointEmbed).not.toHaveBeenCalled();
	});

	describe('the built-in Maestro model server', () => {
		it('lists and tests it through the server, by id, by name, or by record', async () => {
			await expect(listLocalModelEndpointModels('maestro-server')).resolves.toEqual({
				ok: true,
				models: [{ id: 'qwen3-1.7b' }],
			});
			await listLocalModelEndpointModels({ id: 'maestro-server' });
			await testLocalModelEndpoint('Maestro model server', 'qwen3-1.7b');

			expect(server.listModelServerModels).toHaveBeenCalledTimes(2);
			expect(server.testModelServer).toHaveBeenCalledWith('qwen3-1.7b');
			expect(client.listEndpointModelsResult).not.toHaveBeenCalled();
			expect(client.testEndpoint).not.toHaveBeenCalled();
		});

		it('chats on it with the key Maestro holds, after making it ready for the model', async () => {
			const messages = [{ role: 'user' as const, content: 'hi' }];

			await chatWithLocalModelEndpoint('maestro-server', { model: 'qwen3-1.7b', messages });

			expect(server.modelServerCallTarget).toHaveBeenCalledWith('qwen3-1.7b');
			expect(client.endpointChat).toHaveBeenCalledWith(serverTarget.endpoint, {
				model: 'qwen3-1.7b',
				messages,
				apiKey: 'sk-maestro-test',
			});
		});

		it('does not chat when the server cannot be made ready', async () => {
			server.modelServerCallTarget.mockRejectedValueOnce(
				Object.assign(new Error('engine not downloaded'), { kind: 'invalid' })
			);

			await expect(
				chatWithLocalModelEndpoint('maestro-server', { model: 'qwen3-1.7b', messages: [] })
			).rejects.toMatchObject({ kind: 'invalid' });
			expect(client.endpointChat).not.toHaveBeenCalled();
		});

		it('refuses embeddings and speech-to-text on it, before any request', async () => {
			await expect(
				embedWithLocalModelEndpoint('maestro-server', { model: 'm', input: ['a'] })
			).rejects.toMatchObject({ kind: 'invalid' });
			await expect(
				transcribeWithLocalModelEndpoint('maestro-server', { model: 'm', wav: new Uint8Array(1) })
			).rejects.toMatchObject({ kind: 'invalid' });
			expect(client.endpointEmbed).not.toHaveBeenCalled();
			expect(client.endpointTranscribe).not.toHaveBeenCalled();
			expect(server.modelServerCallTarget).not.toHaveBeenCalled();
		});
	});
});
