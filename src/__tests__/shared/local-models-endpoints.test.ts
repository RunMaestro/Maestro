/**
 * Tests for shared/local-models/endpoints - the endpoint record, its base URL
 * rules, the settings reader, and API-key resolution from Settings -> Environment.
 */

import { describe, it, expect } from 'vitest';
import {
	addLocalModelEndpoint,
	DEFAULT_ENDPOINT_BASE_URLS,
	findLocalModelEndpoint,
	removeLocalModelEndpoint,
	updateLocalModelEndpoint,
	endpointBaseUrlProblem,
	endpointServesAnthropicMessages,
	LOCAL_MODEL_ENDPOINT_KINDS,
	LOCAL_MODEL_ENDPOINT_KIND_LABELS,
	isLocalModelEndpointKind,
	isLoopbackEndpointUrl,
	isSameEndpointServer,
	normalizeEndpointBaseUrl,
	parseLocalModelEndpoints,
	resolveEndpointApiKey,
	validateLocalModelEndpoint,
	type LocalModelEndpoint,
} from '../../shared/local-models/endpoints';
import {
	isModelServerEndpointRef,
	MODEL_SERVER_ENDPOINT_ID,
	MODEL_SERVER_NAME,
	modelServerEndpoint,
} from '../../shared/local-models/model-server';
import { SETTINGS_METADATA } from '../../shared/settingsMetadata';

const valid: LocalModelEndpoint = {
	id: 'ep-1',
	name: 'Ollama',
	kind: 'ollama',
	baseUrl: 'http://127.0.0.1:11434',
	enabled: true,
};

describe('endpointBaseUrlProblem', () => {
	it('accepts http and https base URLs, with or without a path prefix', () => {
		expect(endpointBaseUrlProblem('http://127.0.0.1:11434')).toBeNull();
		expect(endpointBaseUrlProblem('https://llm.example.com/v1')).toBeNull();
		expect(endpointBaseUrlProblem('  http://localhost:1234/  ')).toBeNull();
		expect(endpointBaseUrlProblem('http://[::1]:8080')).toBeNull();
	});

	it('requires a value', () => {
		expect(endpointBaseUrlProblem('')).toMatch(/required/);
		expect(endpointBaseUrlProblem('   ')).toMatch(/required/);
	});

	it('rejects text that does not parse as a URL', () => {
		expect(endpointBaseUrlProblem('127.0.0.1:11434')).not.toBeNull();
		expect(endpointBaseUrlProblem('not a url')).toMatch(/not a valid URL/);
	});

	it('rejects schemes other than http and https', () => {
		expect(endpointBaseUrlProblem('ftp://host')).toMatch(/Only http and https/);
		expect(endpointBaseUrlProblem('file:///tmp/model')).toMatch(/Only http and https/);
		expect(endpointBaseUrlProblem('javascript:alert(1)')).toMatch(/Only http and https/);
		expect(endpointBaseUrlProblem('ws://127.0.0.1:1234')).toMatch(/Only http and https/);
	});

	it('refuses credentials embedded in the URL instead of storing them', () => {
		expect(endpointBaseUrlProblem('https://user:secret@llm.example.com')).toMatch(/credentials/);
		expect(endpointBaseUrlProblem('https://token@llm.example.com')).toMatch(/credentials/);
	});

	it('rejects a query string or fragment, which would swallow appended paths', () => {
		expect(endpointBaseUrlProblem('http://host/v1?key=abc')).toMatch(/query string/);
		expect(endpointBaseUrlProblem('http://host/#x')).toMatch(/query string/);
	});
});

describe('normalizeEndpointBaseUrl', () => {
	it('trims and drops trailing slashes', () => {
		expect(normalizeEndpointBaseUrl(' http://127.0.0.1:11434/ ')).toBe('http://127.0.0.1:11434');
		expect(normalizeEndpointBaseUrl('https://host/proxy//')).toBe('https://host/proxy');
	});

	it('keeps an explicit port and path prefix', () => {
		expect(normalizeEndpointBaseUrl('http://host:8000/openai/v1')).toBe(
			'http://host:8000/openai/v1'
		);
	});
});

describe('validateLocalModelEndpoint', () => {
	it('accepts a valid record and returns a normalized copy', () => {
		const result = validateLocalModelEndpoint({
			...valid,
			name: '  Ollama  ',
			baseUrl: 'http://127.0.0.1:11434/',
			apiKeyEnvVar: ' OLLAMA_KEY ',
		});
		expect(result).toEqual({
			ok: true,
			endpoint: { ...valid, apiKeyEnvVar: 'OLLAMA_KEY' },
		});
	});

	it('drops a blank apiKeyEnvVar rather than storing an empty name', () => {
		const result = validateLocalModelEndpoint({ ...valid, apiKeyEnvVar: '  ' });
		expect(result.ok).toBe(true);
		if (result.ok) expect('apiKeyEnvVar' in result.endpoint).toBe(false);
	});

	it('reports every bad field at once', () => {
		const result = validateLocalModelEndpoint({
			id: '',
			name: '',
			kind: 'llamafile',
			baseUrl: 'ftp://host',
			apiKeyEnvVar: 'MY-KEY',
			enabled: 'yes',
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.issues.map((i) => i.field).sort()).toEqual(
				['apiKeyEnvVar', 'baseUrl', 'enabled', 'id', 'kind', 'name'].sort()
			);
		}
	});

	it('rejects something that is not an object', () => {
		expect(validateLocalModelEndpoint(null).ok).toBe(false);
		expect(validateLocalModelEndpoint('http://127.0.0.1:11434').ok).toBe(false);
		expect(validateLocalModelEndpoint([valid]).ok).toBe(false);
	});

	it('accepts each supported kind', () => {
		for (const kind of ['ollama', 'lmstudio', 'openai-compatible'] as const) {
			expect(validateLocalModelEndpoint({ ...valid, kind }).ok).toBe(true);
			expect(isLocalModelEndpointKind(kind)).toBe(true);
		}
		expect(isLocalModelEndpointKind('vllm')).toBe(false);
	});
});

describe('parseLocalModelEndpoints', () => {
	it('reads anything that is not a list as empty', () => {
		expect(parseLocalModelEndpoints(undefined)).toEqual([]);
		expect(parseLocalModelEndpoints({})).toEqual([]);
		expect(parseLocalModelEndpoints('[]')).toEqual([]);
	});

	it('drops invalid records and keeps the first record for a repeated id', () => {
		const second = { ...valid, id: 'ep-2', kind: 'lmstudio', baseUrl: 'http://127.0.0.1:1234' };
		const parsed = parseLocalModelEndpoints([
			valid,
			{ ...valid, baseUrl: 'https://u:p@host' },
			{ ...valid, name: 'Duplicate' },
			second,
		]);
		expect(parsed).toEqual([valid, second]);
	});
});

describe('resolveEndpointApiKey', () => {
	it('reads the named variable from Settings -> Environment', () => {
		expect(
			resolveEndpointApiKey({ apiKeyEnvVar: 'LLM_KEY' }, { LLM_KEY: ' sk-123 ', OTHER: 'x' })
		).toBe('sk-123');
	});

	it('is undefined when no variable is named, it is missing, or it is blank', () => {
		expect(resolveEndpointApiKey({}, { LLM_KEY: 'sk' })).toBeUndefined();
		expect(resolveEndpointApiKey({ apiKeyEnvVar: 'LLM_KEY' }, {})).toBeUndefined();
		expect(resolveEndpointApiKey({ apiKeyEnvVar: 'LLM_KEY' }, undefined)).toBeUndefined();
		expect(resolveEndpointApiKey({ apiKeyEnvVar: 'LLM_KEY' }, { LLM_KEY: '  ' })).toBeUndefined();
	});
});

describe('localModelEndpoints setting', () => {
	it('defaults to an empty list', () => {
		expect(SETTINGS_METADATA.localModelEndpoints.default).toEqual([]);
		expect(SETTINGS_METADATA.localModelEndpoints.type).toBe('array');
	});

	it('ships default base URLs that pass validation', () => {
		for (const url of Object.values(DEFAULT_ENDPOINT_BASE_URLS)) {
			expect(endpointBaseUrlProblem(url!)).toBeNull();
		}
	});
});

describe('endpointServesAnthropicMessages', () => {
	it('is true for the servers known to serve /v1/messages', () => {
		expect(endpointServesAnthropicMessages({ id: 'a', kind: 'ollama' })).toBe(true);
		expect(endpointServesAnthropicMessages({ id: 'b', kind: 'lmstudio' })).toBe(true);
		expect(endpointServesAnthropicMessages(modelServerEndpoint('http://127.0.0.1:1'))).toBe(true);
	});

	it('is false for a base URL Maestro knows nothing more about', () => {
		expect(endpointServesAnthropicMessages({ id: 'c', kind: 'openai-compatible' })).toBe(false);
	});
});

describe('isLoopbackEndpointUrl', () => {
	it('accepts every loopback spelling, including every default base URL', () => {
		expect(isLoopbackEndpointUrl('http://127.0.0.1:11434')).toBe(true);
		expect(isLoopbackEndpointUrl('http://LOCALHOST:1234')).toBe(true);
		expect(isLoopbackEndpointUrl('http://[::1]:11434')).toBe(true);
		for (const url of Object.values(DEFAULT_ENDPOINT_BASE_URLS)) {
			expect(isLoopbackEndpointUrl(url!)).toBe(true);
		}
	});

	it('rejects anything off this machine, and garbage', () => {
		expect(isLoopbackEndpointUrl('http://192.168.1.10:11434')).toBe(false);
		expect(isLoopbackEndpointUrl('http://127.0.0.1.example.com')).toBe(false);
		expect(isLoopbackEndpointUrl('not a url')).toBe(false);
	});
});

describe('isSameEndpointServer', () => {
	it('treats every loopback spelling as one host, and ignores a trailing slash', () => {
		expect(isSameEndpointServer('http://localhost:11434/', 'http://127.0.0.1:11434')).toBe(true);
		expect(isSameEndpointServer('http://[::1]:11434', 'http://127.0.0.1:11434')).toBe(true);
	});

	it('distinguishes port, scheme, path, and a remote host', () => {
		expect(isSameEndpointServer('http://127.0.0.1:11435', 'http://127.0.0.1:11434')).toBe(false);
		expect(isSameEndpointServer('https://127.0.0.1:11434', 'http://127.0.0.1:11434')).toBe(false);
		expect(isSameEndpointServer('http://127.0.0.1:11434/v1', 'http://127.0.0.1:11434')).toBe(false);
		expect(isSameEndpointServer('http://box.lan:11434', 'http://127.0.0.1:11434')).toBe(false);
	});

	it('is false when either side does not parse', () => {
		expect(isSameEndpointServer('nope', 'http://127.0.0.1:11434')).toBe(false);
	});
});

describe('LOCAL_MODEL_ENDPOINT_KIND_LABELS', () => {
	it('names every kind', () => {
		for (const kind of LOCAL_MODEL_ENDPOINT_KINDS) {
			expect(LOCAL_MODEL_ENDPOINT_KIND_LABELS[kind]).not.toBe('');
		}
	});
});

describe('endpoint list editing (add / remove / find)', () => {
	const ollama: LocalModelEndpoint = {
		id: 'aaaa-1111',
		name: 'Ollama',
		kind: 'ollama',
		baseUrl: 'http://127.0.0.1:11434',
		enabled: true,
	};
	const gateway: LocalModelEndpoint = {
		id: 'abcd-2222',
		name: 'Gateway',
		kind: 'openai-compatible',
		baseUrl: 'https://llm.example.com/v1',
		enabled: true,
	};
	const list = [ollama, gateway];

	it('finds by exact id, unique id prefix, or case-insensitive name', () => {
		expect(findLocalModelEndpoint(list, 'abcd-2222')).toEqual({ ok: true, endpoint: gateway });
		expect(findLocalModelEndpoint(list, 'aaaa')).toEqual({ ok: true, endpoint: ollama });
		expect(findLocalModelEndpoint(list, ' gateway ')).toEqual({ ok: true, endpoint: gateway });
	});

	it('refuses an ambiguous or unknown reference and names the candidates', () => {
		const ambiguous = findLocalModelEndpoint(list, 'a');
		expect(ambiguous.ok).toBe(false);
		if (!ambiguous.ok) {
			expect(ambiguous.message).toContain('matches 2 endpoints');
			expect(ambiguous.message).toContain('Gateway (abcd-2222)');
		}
		expect(findLocalModelEndpoint(list, 'zzz')).toEqual({
			ok: false,
			message: 'No endpoint matches "zzz".',
		});
		expect(findLocalModelEndpoint(list, '  ').ok).toBe(false);
	});

	it('adds a valid endpoint in normalized form without mutating the input', () => {
		const before = [ollama];
		const change = addLocalModelEndpoint(before, {
			...gateway,
			baseUrl: 'https://llm.example.com/v1/',
		});
		expect(change.ok).toBe(true);
		if (!change.ok) return;
		expect(change.endpoint.baseUrl).toBe('https://llm.example.com/v1');
		expect(change.endpoints).toEqual([ollama, change.endpoint]);
		expect(before).toEqual([ollama]);
	});

	it('refuses an invalid record, a taken id, and a server already configured', () => {
		const invalid = addLocalModelEndpoint([], { ...gateway, baseUrl: 'http://u:p@host' });
		expect(invalid.ok).toBe(false);
		if (!invalid.ok) expect(invalid.message).toContain('credentials');

		expect(
			addLocalModelEndpoint(list, { ...gateway, baseUrl: 'https://other.example.com' })
		).toEqual({
			ok: false,
			message: 'An endpoint with id "abcd-2222" already exists.',
		});

		const sameServer = addLocalModelEndpoint(list, {
			...ollama,
			id: 'new',
			name: 'Mine',
			baseUrl: 'http://localhost:11434/',
		});
		expect(sameServer.ok).toBe(false);
		if (!sameServer.ok) expect(sameServer.message).toContain('already configured as "Ollama"');
	});

	it('updates one endpoint in place, keeping its id and position', () => {
		const change = updateLocalModelEndpoint(list, ollama.id, {
			...ollama,
			id: 'ignored',
			name: 'Ollama (desk)',
			enabled: false,
		});
		expect(change.ok).toBe(true);
		if (!change.ok) return;
		expect(change.endpoint).toEqual({ ...ollama, name: 'Ollama (desk)', enabled: false });
		expect(change.endpoints).toEqual([change.endpoint, gateway]);
		expect(list[0]).toBe(ollama);
	});

	it("refuses an update to an unknown id, an invalid record, or another record's server", () => {
		expect(updateLocalModelEndpoint(list, 'nope', ollama)).toEqual({
			ok: false,
			message: 'No endpoint has id "nope".',
		});
		const invalid = updateLocalModelEndpoint(list, ollama.id, { ...ollama, baseUrl: 'ftp://x' });
		expect(invalid.ok).toBe(false);
		const clash = updateLocalModelEndpoint(list, gateway.id, {
			...gateway,
			baseUrl: 'http://localhost:11434',
		});
		expect(clash.ok).toBe(false);
		if (!clash.ok) expect(clash.message).toContain('already configured as "Ollama"');
	});

	it('removes the resolved endpoint and reports which one', () => {
		const change = removeLocalModelEndpoint(list, 'gateway');
		expect(change).toEqual({ ok: true, endpoints: [ollama], endpoint: gateway });
		expect(removeLocalModelEndpoint(list, 'nope').ok).toBe(false);
	});
});

describe('the built-in Maestro model server endpoint', () => {
	const builtIn = { ...valid, id: MODEL_SERVER_ENDPOINT_ID, name: MODEL_SERVER_NAME };

	it('describes the server as an openai-compatible endpoint with no key variable', () => {
		expect(modelServerEndpoint('http://127.0.0.1:41234')).toEqual({
			id: MODEL_SERVER_ENDPOINT_ID,
			name: MODEL_SERVER_NAME,
			kind: 'openai-compatible',
			baseUrl: 'http://127.0.0.1:41234',
			enabled: true,
		});
	});

	it('is named by its id or its name, and nothing else', () => {
		expect(isModelServerEndpointRef(MODEL_SERVER_ENDPOINT_ID)).toBe(true);
		expect(isModelServerEndpointRef(' maestro model server ')).toBe(true);
		expect(isModelServerEndpointRef('maestro')).toBe(false);
		expect(isModelServerEndpointRef(undefined)).toBe(false);
	});

	it('is never read from the saved list', () => {
		expect(parseLocalModelEndpoints([builtIn, valid])).toEqual([valid]);
	});

	it('cannot be added, edited or removed through the endpoint list', () => {
		const add = addLocalModelEndpoint([valid], builtIn);
		expect(add).toMatchObject({ ok: false, message: expect.stringContaining('belongs to') });

		const edit = updateLocalModelEndpoint([valid], MODEL_SERVER_ENDPOINT_ID, builtIn);
		expect(edit).toMatchObject({ ok: false, message: expect.stringContaining('cannot be edited') });

		for (const ref of [MODEL_SERVER_ENDPOINT_ID, MODEL_SERVER_NAME]) {
			const removed = removeLocalModelEndpoint([valid], ref);
			expect(removed).toMatchObject({
				ok: false,
				message: expect.stringContaining('maestro-cli models server'),
			});
		}
	});
});
