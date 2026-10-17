/**
 * Tests for shared/local-models/background-requests: the stored setting as
 * every reader parses it, the message a client is answered with when the
 * target cannot be used, and what every writer shares: which provider has the
 * setting, how it is spelled, the check before it is stored, and the choices
 * the picker offers.
 */

import { describe, it, expect } from 'vitest';
import {
	BACKGROUND_REQUESTS_OFF_LABEL,
	backgroundRequestsSupport,
	backgroundRequestsUnavailable,
	buildBackgroundRequestsOptionGroups,
	formatBackgroundRequestsSpec,
	parseBackgroundRequests,
	parseBackgroundRequestsEdit,
	parseBackgroundRequestsSpec,
} from '../../../shared/local-models/background-requests';
import type { LocalModelEndpoint } from '../../../shared/local-models/endpoints';
import {
	MODEL_SERVER_ENDPOINT_ID,
	MODEL_SERVER_NAME,
} from '../../../shared/local-models/model-server';
import type { RunOnSourceTarget } from '../../../shared/local-models/run-on';

const ON_SERVER: RunOnSourceTarget = {
	type: 'source',
	endpointId: MODEL_SERVER_ENDPOINT_ID,
	model: 'qwen3.5-4b',
};
const ON_OLLAMA: RunOnSourceTarget = { type: 'source', endpointId: 'ep-ollama', model: 'qwen3:4b' };
const OLLAMA = { id: 'ep-ollama', name: 'Ollama' };

describe('parseBackgroundRequests', () => {
	it('reads an absent setting as not routed', () => {
		expect(parseBackgroundRequests(undefined)).toEqual({ ok: true, backgroundRequests: undefined });
		expect(parseBackgroundRequests(null)).toEqual({ ok: true, backgroundRequests: undefined });
	});

	it('reads a provider target as not routed', () => {
		expect(parseBackgroundRequests({ target: { type: 'provider' } })).toEqual({
			ok: true,
			backgroundRequests: undefined,
		});
	});

	it('keeps a source target in the one stored form', () => {
		expect(
			parseBackgroundRequests({
				target: { type: 'source', endpointId: ' ep-ollama ', model: ' qwen3:4b ', extra: 1 },
				stray: true,
			})
		).toEqual({ ok: true, backgroundRequests: { target: ON_OLLAMA } });
	});

	it('does not store a context size: a request states its own limits', () => {
		const parsed = parseBackgroundRequests({ target: { ...ON_SERVER, contextTokens: 65_536 } });

		expect(parsed).toEqual({ ok: true, backgroundRequests: { target: ON_SERVER } });
	});

	it('refuses anything that is not a target, and never reads it as not routed', () => {
		for (const value of [
			'maestro-server:qwen3.5-4b',
			[],
			{},
			{ target: null },
			{ target: 'provider' },
			{ target: { type: 'source', endpointId: 'ep-ollama' } },
			{ target: { type: 'source', model: 'qwen3:4b' } },
			{ target: { type: 'elsewhere' } },
		]) {
			const parsed = parseBackgroundRequests(value);
			expect(parsed.ok, JSON.stringify(value)).toBe(false);
			if (!parsed.ok) expect(parsed.error).not.toBe('');
		}
	});
});

describe('backgroundRequestsUnavailable', () => {
	it('always says the request did not go to the provider, and how to recover', () => {
		const messages = [
			backgroundRequestsUnavailable('background-invalid-target', null, null, 'It names no model.'),
			backgroundRequestsUnavailable('background-source-missing', ON_OLLAMA, null),
			backgroundRequestsUnavailable('background-source-disabled', ON_OLLAMA, OLLAMA),
			backgroundRequestsUnavailable('background-source-not-anthropic', ON_OLLAMA, OLLAMA),
			backgroundRequestsUnavailable('background-server-failed', ON_SERVER, null, 'out of memory.'),
		];
		for (const message of messages) {
			expect(message).toContain('The request was not sent to the provider.');
			expect(message).toContain('turn Background requests off');
			// No dash a person did not type.
			expect(message).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
		}
	});

	it('names the target and what is wrong with it', () => {
		expect(backgroundRequestsUnavailable('background-source-missing', ON_OLLAMA, null)).toContain(
			'its source (ep-ollama) is no longer configured'
		);
		expect(
			backgroundRequestsUnavailable('background-source-disabled', ON_OLLAMA, OLLAMA)
		).toContain(
			'sends background requests to qwen3:4b on Ollama, but the source "Ollama" is disabled'
		);
		expect(
			backgroundRequestsUnavailable('background-source-not-anthropic', ON_OLLAMA, {
				id: 'ep-ollama',
				name: 'Workstation',
			})
		).toContain('cannot tell that the source "Workstation" serves the Anthropic Messages route');
		expect(
			backgroundRequestsUnavailable('background-server-failed', ON_SERVER, null, 'out of memory.')
		).toContain('Maestro model server could not serve it (out of memory)');
	});

	it('carries what is wrong with a stored value that is not a target', () => {
		expect(
			backgroundRequestsUnavailable('background-invalid-target', null, null, 'It names no model.')
		).toContain("This agent's Background requests target cannot be used: It names no model.");
	});
});

const SAVED_OLLAMA: LocalModelEndpoint = {
	id: 'ep-ollama',
	name: 'Ollama',
	kind: 'ollama',
	baseUrl: 'http://127.0.0.1:11434',
	enabled: true,
};
const SAVED_CLOUD: LocalModelEndpoint = {
	id: 'ep-cloud',
	name: 'OpenRouter',
	kind: 'openai-compatible',
	baseUrl: 'https://openrouter.ai/api/v1',
	enabled: true,
};

describe('backgroundRequestsSupport', () => {
	it('is Claude Code alone', () => {
		expect(backgroundRequestsSupport('claude-code')).toEqual({ supported: true });
		const codex = backgroundRequestsSupport('codex');
		expect(codex.supported).toBe(false);
		if (!codex.supported) expect(codex.reason).toMatch(/Claude Code agents only/);
	});
});

describe('the background requests spelling', () => {
	it('spells off as none and a target as the Run on spelling', () => {
		expect(formatBackgroundRequestsSpec(undefined)).toBe('none');
		expect(formatBackgroundRequestsSpec(null)).toBe('none');
		expect(formatBackgroundRequestsSpec({ target: ON_OLLAMA })).toBe('ep-ollama:qwen3:4b');
	});

	it.each(['none', 'NONE', '', '  ', 'provider'])('reads %j as not routed', (spec) => {
		expect(parseBackgroundRequestsSpec(spec)).toEqual({ ok: true, backgroundRequests: undefined });
	});

	it('reads a source and a model, the id ending at the first colon', () => {
		expect(parseBackgroundRequestsSpec(' ep-ollama:qwen3:4b ')).toEqual({
			ok: true,
			backgroundRequests: { target: ON_OLLAMA },
		});
	});

	it('refuses a word that is neither', () => {
		const parsed = parseBackgroundRequestsSpec('qwen');
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.error).toMatch(/"none" or <source id>:<model>/);
	});

	it('round-trips what it writes', () => {
		const spec = formatBackgroundRequestsSpec({ target: ON_SERVER });
		expect(parseBackgroundRequestsSpec(spec)).toEqual({
			ok: true,
			backgroundRequests: { target: ON_SERVER },
		});
	});
});

describe('parseBackgroundRequestsEdit', () => {
	const endpoints = [SAVED_OLLAMA, SAVED_CLOUD];

	it('always lets the setting be turned off, on any provider', () => {
		expect(parseBackgroundRequestsEdit('codex', null, endpoints)).toEqual({
			ok: true,
			backgroundRequests: undefined,
		});
	});

	it('stores a target on a source that serves the Anthropic Messages route', () => {
		expect(parseBackgroundRequestsEdit('claude-code', { target: ON_OLLAMA }, endpoints)).toEqual({
			ok: true,
			backgroundRequests: { target: ON_OLLAMA },
		});
		expect(parseBackgroundRequestsEdit('claude-code', { target: ON_SERVER }, endpoints)).toEqual({
			ok: true,
			backgroundRequests: { target: ON_SERVER },
		});
	});

	it('refuses a provider the proxy cannot route for', () => {
		const edit = parseBackgroundRequestsEdit('codex', { target: ON_OLLAMA }, endpoints);
		expect(edit.ok).toBe(false);
		if (!edit.ok) expect(edit.error).toMatch(/Claude Code agents only/);
	});

	it('refuses a source id that names nothing', () => {
		const edit = parseBackgroundRequestsEdit(
			'claude-code',
			{ target: { type: 'source', endpointId: 'ep-gone', model: 'm' } },
			endpoints
		);
		expect(edit.ok).toBe(false);
		if (!edit.ok) expect(edit.error).toMatch(/No source has the id "ep-gone"/);
	});

	it('refuses a source not known to serve the route, by name', () => {
		const edit = parseBackgroundRequestsEdit(
			'claude-code',
			{ target: { type: 'source', endpointId: SAVED_CLOUD.id, model: 'm' } },
			endpoints
		);
		expect(edit.ok).toBe(false);
		if (!edit.ok) {
			expect(edit.error).toContain('"OpenRouter"');
			expect(edit.error).toContain('/v1/messages');
		}
	});

	it("refuses a malformed value with the reader's own reason", () => {
		expect(parseBackgroundRequestsEdit('claude-code', { target: 'x' }, endpoints).ok).toBe(false);
	});
});

describe('buildBackgroundRequestsOptionGroups', () => {
	const sources = [
		{ endpointId: MODEL_SERVER_ENDPOINT_ID, name: MODEL_SERVER_NAME, models: ['qwen3.5-4b'] },
		{ endpointId: SAVED_OLLAMA.id, name: 'Ollama', models: ['qwen3:4b'] },
		{ endpointId: SAVED_CLOUD.id, name: 'OpenRouter', models: ['some/model'] },
	];
	const endpoints = [SAVED_OLLAMA, SAVED_CLOUD];
	const values = (groups: ReturnType<typeof buildBackgroundRequestsOptionGroups>) =>
		groups.flatMap((group) => group.options.map((option) => option.value));

	it('offers Off first, then each source that serves the route', () => {
		const groups = buildBackgroundRequestsOptionGroups({ current: undefined, sources, endpoints });

		expect(groups[0]).toEqual({
			label: null,
			options: [{ value: 'none', label: BACKGROUND_REQUESTS_OFF_LABEL }],
		});
		expect(groups.map((group) => group.label)).toEqual([null, MODEL_SERVER_NAME, 'Ollama']);
		expect(values(groups)).toEqual(['none', 'maestro-server:qwen3.5-4b', 'ep-ollama:qwen3:4b']);
	});

	it('leaves out a source a background request cannot be sent to', () => {
		const groups = buildBackgroundRequestsOptionGroups({ current: undefined, sources, endpoints });
		expect(values(groups).some((value) => value.startsWith('ep-cloud:'))).toBe(false);
	});

	it('lists the current target when nothing lists it, so the picker shows it', () => {
		const groups = buildBackgroundRequestsOptionGroups({
			current: { target: { type: 'source', endpointId: 'ep-gone', model: 'm' } },
			sources,
			endpoints,
		});

		expect(groups[0].options.map((option) => option.value)).toEqual(['none', 'ep-gone:m']);
		expect(groups[0].options[1].label).toMatch(/source removed/);
	});
});
