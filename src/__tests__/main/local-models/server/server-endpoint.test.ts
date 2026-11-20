/**
 * @file server-endpoint.test.ts
 *
 * The Maestro model server as the built-in endpoint `maestro-server`, with the
 * supervisor, the engine store and the model list mocked. What is pinned: a
 * call makes the server ready for its model and carries the key Maestro holds;
 * a server that cannot be made ready is refused as an endpoint error that names
 * why, with no request sent; listing reads the installed models without
 * starting anything; Test starts it, like any call.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const supervisor = vi.hoisted(() => ({
	ensureModelServerFor: vi.fn(),
	getModelServerKey: vi.fn(async () => 'sk-maestro-key'),
	modelServerServingLoaded: vi.fn(),
}));
vi.mock('../../../../main/local-models/server/supervisor', () => supervisor);

const engine = vi.hoisted(() => ({ isServerEngineInstalled: vi.fn(async () => true) }));
vi.mock('../../../../main/local-models/server/engine-store', () => engine);

const presets = vi.hoisted(() => ({
	collectServerModels: vi.fn(async () => [
		{ id: 'qwen3-1.7b', modelPath: '/models/qwen.gguf', contextSize: 40_960 },
		{ id: 'other', modelPath: '/models/other.gguf', contextSize: 40_960 },
	]),
}));
vi.mock('../../../../main/local-models/server/presets', () => presets);

const client = vi.hoisted(() => ({
	testEndpoint: vi.fn(async () => ({ ok: true, model: 'qwen3-1.7b', latencyMs: 12 })),
}));
vi.mock('../../../../main/local-models/endpoint-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../main/local-models/endpoint-client')>()),
	testEndpoint: client.testEndpoint,
}));

import {
	listModelServerModels,
	loadedModelServerTarget,
	modelServerCallTarget,
	modelServerForHarness,
	modelServerUnsupported,
	refersToModelServer,
	testModelServer,
} from '../../../../main/local-models/server/server-endpoint';
import { LocalModelEndpointError } from '../../../../main/local-models/errors';

const BASE_URL = 'http://127.0.0.1:41234';
const serverRecord = {
	id: 'maestro-server',
	name: 'Maestro model server',
	kind: 'openai-compatible',
	baseUrl: BASE_URL,
	enabled: true,
};

beforeEach(() => {
	vi.clearAllMocks();
	supervisor.ensureModelServerFor.mockResolvedValue({
		ok: true,
		baseUrl: BASE_URL,
		model: 'qwen3-1.7b',
	});
	supervisor.modelServerServingLoaded.mockResolvedValue(null);
	engine.isServerEngineInstalled.mockResolvedValue(true);
});

describe('modelServerForHarness', () => {
	it('makes the server ready for the model and answers with its root and key', async () => {
		expect(await modelServerForHarness('qwen3-1.7b')).toEqual({
			ok: true,
			baseUrl: BASE_URL,
			key: 'sk-maestro-key',
		});
		expect(supervisor.ensureModelServerFor).toHaveBeenCalledWith('qwen3-1.7b');
	});

	it('answers with the reason, as a result, when the server cannot serve the model', async () => {
		supervisor.ensureModelServerFor.mockResolvedValue({
			ok: false,
			code: 'model-not-installed',
			error: 'Qwen3 1.7B is not downloaded.',
		});

		expect(await modelServerForHarness('qwen3-1.7b')).toEqual({
			ok: false,
			error: 'Qwen3 1.7B is not downloaded.',
		});
		// No key is read for a server that will not be used.
		expect(supervisor.getModelServerKey).not.toHaveBeenCalled();
	});

	it('lets an unexpected failure through', async () => {
		supervisor.ensureModelServerFor.mockRejectedValue(new Error('disk on fire'));

		await expect(modelServerForHarness('qwen3-1.7b')).rejects.toThrow('disk on fire');
	});
});

describe('refersToModelServer', () => {
	it('recognizes its id, its name, and a record carrying its id', () => {
		expect(refersToModelServer('maestro-server')).toBe(true);
		expect(refersToModelServer('Maestro model server')).toBe(true);
		expect(refersToModelServer({ id: 'maestro-server' })).toBe(true);
		expect(refersToModelServer('ep-1')).toBe(false);
		expect(refersToModelServer({ id: 'ep-1' })).toBe(false);
		expect(refersToModelServer(null)).toBe(false);
	});
});

describe('modelServerCallTarget', () => {
	it('makes the server ready for the model and hands back its record and key', async () => {
		await expect(modelServerCallTarget('qwen3-1.7b')).resolves.toEqual({
			endpoint: serverRecord,
			apiKey: 'sk-maestro-key',
		});
		expect(supervisor.ensureModelServerFor).toHaveBeenCalledWith('qwen3-1.7b');
	});

	it.each([
		['engine-not-installed', 'invalid'],
		['model-not-installed', 'invalid'],
		['no-models', 'no-models'],
		['port-in-use', 'network'],
		['start-failed', 'network'],
		['load-failed', 'network'],
	] as const)('refuses a %s server as a %s endpoint error naming why', async (code, kind) => {
		supervisor.ensureModelServerFor.mockResolvedValueOnce({
			ok: false,
			code,
			error: `the reason for ${code}`,
		});

		const error = await modelServerCallTarget('qwen3-1.7b').catch((e: unknown) => e);
		expect(error).toBeInstanceOf(LocalModelEndpointError);
		expect(error).toMatchObject({
			kind,
			message: `the reason for ${code}`,
			endpointId: 'maestro-server',
			endpointName: 'Maestro model server',
		});
		expect(supervisor.getModelServerKey).not.toHaveBeenCalled();
	});
});

describe('loadedModelServerTarget', () => {
	it('is null unless the running server already has the model loaded', async () => {
		await expect(loadedModelServerTarget('qwen3-1.7b')).resolves.toBeNull();

		supervisor.modelServerServingLoaded.mockResolvedValueOnce({
			baseUrl: BASE_URL,
			key: 'sk-running-key',
		});
		await expect(loadedModelServerTarget('qwen3-1.7b')).resolves.toEqual({
			endpoint: serverRecord,
			apiKey: 'sk-running-key',
		});
		expect(supervisor.ensureModelServerFor).not.toHaveBeenCalled();
	});
});

describe('listModelServerModels', () => {
	it('lists the installed text models by catalog id without starting the server', async () => {
		await expect(listModelServerModels()).resolves.toEqual({
			ok: true,
			models: [{ id: 'qwen3-1.7b' }, { id: 'other' }],
		});
		expect(supervisor.ensureModelServerFor).not.toHaveBeenCalled();
	});

	it('names the missing engine instead of listing', async () => {
		engine.isServerEngineInstalled.mockResolvedValueOnce(false);

		const result = await listModelServerModels();
		expect(result).toMatchObject({ ok: false, error: { kind: 'invalid' } });
		expect(result.ok ? '' : result.error.message).toContain('llama-server');
		expect(presets.collectServerModels).not.toHaveBeenCalled();
	});
});

describe('testModelServer', () => {
	it('tests the named model through the server with its key', async () => {
		await expect(testModelServer('qwen3-1.7b')).resolves.toEqual({
			ok: true,
			model: 'qwen3-1.7b',
			latencyMs: 12,
		});
		expect(client.testEndpoint).toHaveBeenCalledWith(serverRecord, {
			apiKey: 'sk-maestro-key',
			model: 'qwen3-1.7b',
		});
	});

	it('picks the first installed model when none is named, and reports the count', async () => {
		await expect(testModelServer()).resolves.toMatchObject({ ok: true, modelCount: 2 });
		expect(supervisor.ensureModelServerFor).toHaveBeenCalledWith('qwen3-1.7b');
	});

	it('reports no-models when nothing is installed, and starts nothing', async () => {
		presets.collectServerModels.mockResolvedValueOnce([]);

		await expect(testModelServer()).resolves.toMatchObject({
			ok: false,
			error: { kind: 'no-models' },
		});
		expect(supervisor.ensureModelServerFor).not.toHaveBeenCalled();
	});

	it('answers a server that cannot start as a failed test, with no request sent', async () => {
		supervisor.ensureModelServerFor.mockResolvedValueOnce({
			ok: false,
			code: 'port-in-use',
			error: 'Port 41234 is in use.',
		});

		await expect(testModelServer('qwen3-1.7b')).resolves.toEqual({
			ok: false,
			error: { kind: 'network', message: 'Port 41234 is in use.' },
		});
		expect(client.testEndpoint).not.toHaveBeenCalled();
	});
});

describe('modelServerUnsupported', () => {
	it('names what the server does not serve', () => {
		const error = modelServerUnsupported('embeddings');
		expect(error).toBeInstanceOf(LocalModelEndpointError);
		expect(error).toMatchObject({ kind: 'invalid', endpointId: 'maestro-server' });
		expect(error.message).toContain('text generation only, not embeddings');
	});
});
