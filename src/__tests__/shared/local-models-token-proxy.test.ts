/**
 * @file local-models-token-proxy.test.ts
 *
 * The token proxy's addressing rules: which upstream a request path names, that
 * the path and query are carried as text, which requests carry a message list,
 * and when an agent's gateway URL means "the Maestro proxy". Also the two
 * things a launch and a mode switch decide: the base URL that carries an
 * agent's id, and an agent's mode (off, passthrough, compress) with the route
 * its provider and credential take.
 */

import { describe, it, expect } from 'vitest';
import {
	asStoredTokenProxyMode,
	asTokenProxyMode,
	classifyTokenProxyPath,
	defaultTokenProxyUpstreams,
	gatewayPointsAtTokenProxy,
	isCompressingTokenProxyMode,
	resolveTokenProxyMode,
	resolveTokenProxyTarget,
	TOKEN_PROXY_MODE_DESCRIPTIONS,
	TOKEN_PROXY_MODE_LABELS,
	TOKEN_PROXY_MODES,
	TOKEN_PROXY_ROUTES,
	tokenProxyAgentGatewayUrl,
	tokenProxyErrorBody,
	tokenProxyGatewayUrl,
	tokenProxyRouteForAgent,
} from '../../shared/local-models/token-proxy';
import { parseGatewayUrl } from '../../shared/local-models/gateway';

describe('resolveTokenProxyTarget', () => {
	it('routes by the first path segment to the real providers', () => {
		expect(resolveTokenProxyTarget('POST', '/anthropic/v1/messages')).toEqual({
			ok: true,
			route: 'anthropic',
			upstream: 'https://api.anthropic.com',
			path: '/v1/messages',
			query: '',
			kind: 'anthropic-messages',
			agentId: null,
		});
		expect(resolveTokenProxyTarget('POST', '/openai/v1/responses')).toMatchObject({
			route: 'openai',
			upstream: 'https://api.openai.com',
			path: '/v1/responses',
			kind: 'openai-responses',
		});
		expect(resolveTokenProxyTarget('POST', '/chatgpt/responses')).toMatchObject({
			route: 'chatgpt',
			upstream: 'https://chatgpt.com/backend-api/codex',
			path: '/responses',
			kind: 'openai-responses',
		});
	});

	it('carries the query string and an encoded path as the text they arrived as', () => {
		const target = resolveTokenProxyTarget('POST', '/anthropic/v1/messages?beta=true&x=a%20b');
		expect(target).toMatchObject({ path: '/v1/messages', query: '?beta=true&x=a%20b' });

		expect(resolveTokenProxyTarget('GET', '/openai/v1/files/a%2Fb')).toMatchObject({
			path: '/v1/files/a%2Fb',
			query: '',
		});
	});

	it('forwards every path under a route, not only the three message endpoints', () => {
		expect(resolveTokenProxyTarget('POST', '/anthropic/v1/messages/count_tokens')).toMatchObject({
			ok: true,
			path: '/v1/messages/count_tokens',
			kind: 'other',
		});
		expect(resolveTokenProxyTarget('GET', '/openai/v1/models')).toMatchObject({
			ok: true,
			kind: 'other',
		});
		expect(resolveTokenProxyTarget('GET', '/anthropic')).toMatchObject({ ok: true, path: '' });
	});

	it('refuses a path that names no route, and lists the routes', () => {
		for (const url of ['/', '/v1/messages', '/unknown/v1/messages', '']) {
			const target = resolveTokenProxyTarget('POST', url);
			expect(target.ok).toBe(false);
			if (!target.ok) {
				expect(target.error).toContain('Maestro token proxy');
				expect(target.error).toContain('/anthropic');
				expect(target.error).toContain('/openai');
			}
		}
	});

	it('reads the agent a launch put in front of the route', () => {
		expect(
			resolveTokenProxyTarget('POST', '/agent/agent-1/anthropic/v1/messages?beta=true')
		).toEqual({
			ok: true,
			route: 'anthropic',
			upstream: 'https://api.anthropic.com',
			path: '/v1/messages',
			query: '?beta=true',
			kind: 'anthropic-messages',
			agentId: 'agent-1',
		});
		// An id is decoded; the forwarded path is still carried as text.
		expect(resolveTokenProxyTarget('POST', '/agent/a%20b/openai/v1/files/x%2Fy')).toMatchObject({
			agentId: 'a b',
			route: 'openai',
			path: '/v1/files/x%2Fy',
		});
	});

	it('refuses an agent prefix with no agent or no route behind it', () => {
		for (const url of ['/agent', '/agent/', '/agent/agent-1', '/agent//anthropic/v1/messages']) {
			expect(resolveTokenProxyTarget('POST', url).ok).toBe(false);
		}
		// `agent` is a prefix, never a route: it cannot be given an upstream.
		expect(
			resolveTokenProxyTarget('POST', '/agent/x/v1/messages', { agent: 'http://127.0.0.1:9' }).ok
		).toBe(false);
		// A route that merely starts with the word is an ordinary unknown route.
		expect(resolveTokenProxyTarget('POST', '/agents/v1/messages').ok).toBe(false);
	});

	it('does not treat an inherited object key as a route', () => {
		expect(resolveTokenProxyTarget('GET', '/constructor/x').ok).toBe(false);
		expect(resolveTokenProxyTarget('GET', '/__proto__/x').ok).toBe(false);
	});

	it('routes with the table it is given', () => {
		expect(
			resolveTokenProxyTarget('POST', '/fake/v1/messages', { fake: 'http://127.0.0.1:9' })
		).toMatchObject({ ok: true, route: 'fake', upstream: 'http://127.0.0.1:9' });
		expect(resolveTokenProxyTarget('POST', '/anthropic/v1/messages', { fake: 'x' }).ok).toBe(false);
	});
});

describe('classifyTokenProxyPath', () => {
	it('names the three APIs that carry a message list', () => {
		expect(classifyTokenProxyPath('POST', '/v1/messages')).toBe('anthropic-messages');
		expect(classifyTokenProxyPath('post', '/v1/messages/')).toBe('anthropic-messages');
		expect(classifyTokenProxyPath('POST', '/v1/chat/completions')).toBe('openai-chat-completions');
		expect(classifyTokenProxyPath('POST', '/v1/responses')).toBe('openai-responses');
		expect(classifyTokenProxyPath('POST', '/responses')).toBe('openai-responses');
	});

	it('calls everything else other, including a GET of the same path', () => {
		expect(classifyTokenProxyPath('GET', '/v1/responses')).toBe('other');
		expect(classifyTokenProxyPath('POST', '/v1/messages/count_tokens')).toBe('other');
		expect(classifyTokenProxyPath('POST', '/v1/embeddings')).toBe('other');
	});
});

describe('tokenProxyGatewayUrl', () => {
	it('builds a base URL the gateway field accepts unchanged, for every route', () => {
		for (const route of Object.keys(TOKEN_PROXY_ROUTES) as Array<keyof typeof TOKEN_PROXY_ROUTES>) {
			const url = tokenProxyGatewayUrl(41234, route);
			expect(parseGatewayUrl(url)).toEqual({ ok: true, url });
			expect(gatewayPointsAtTokenProxy(url, 41234)).toBe(true);
		}
	});

	it('resolves back to the route it was built for', () => {
		// What the provider CLI appends to its base URL, per route.
		const suffix = { anthropic: '/v1/messages', openai: '/responses', chatgpt: '/responses' };
		for (const route of Object.keys(suffix) as Array<keyof typeof suffix>) {
			const requestPath = new URL(tokenProxyGatewayUrl(41234, route) + suffix[route]).pathname;
			expect(resolveTokenProxyTarget('POST', requestPath)).toMatchObject({ ok: true, route });
		}
		expect(resolveTokenProxyTarget('POST', '/openai/v1/responses')).toMatchObject({
			path: '/v1/responses',
		});
	});

	it('has an upstream for every route', () => {
		expect(Object.keys(defaultTokenProxyUpstreams()).sort()).toEqual(
			Object.keys(TOKEN_PROXY_ROUTES).sort()
		);
	});
});

describe('gatewayPointsAtTokenProxy', () => {
	it('is true for any loopback spelling on the proxy port', () => {
		expect(gatewayPointsAtTokenProxy('http://127.0.0.1:41234/anthropic', 41234)).toBe(true);
		expect(gatewayPointsAtTokenProxy('http://localhost:41234/openai/v1', 41234)).toBe(true);
		expect(gatewayPointsAtTokenProxy('http://[::1]:41234', 41234)).toBe(true);
		expect(gatewayPointsAtTokenProxy('  http://127.0.0.1:41234  ', 41234)).toBe(true);
	});

	it('is false for another port, another host, or no gateway', () => {
		expect(gatewayPointsAtTokenProxy('http://127.0.0.1:8787', 41234)).toBe(false);
		expect(gatewayPointsAtTokenProxy('http://127.0.0.1', 41234)).toBe(false);
		expect(gatewayPointsAtTokenProxy('http://proxy.example.com:41234', 41234)).toBe(false);
		expect(gatewayPointsAtTokenProxy('', 41234)).toBe(false);
		expect(gatewayPointsAtTokenProxy(undefined, 41234)).toBe(false);
		expect(gatewayPointsAtTokenProxy(null, 41234)).toBe(false);
		expect(gatewayPointsAtTokenProxy('not a url', 41234)).toBe(false);
	});
});

describe('tokenProxyErrorBody', () => {
	it('is one JSON object both provider SDKs read a message from', () => {
		const body = JSON.parse(tokenProxyErrorBody('upstream-unreachable', 'could not reach it'));
		expect(body).toEqual({
			type: 'error',
			error: {
				type: 'maestro_token_proxy_error',
				code: 'upstream-unreachable',
				message: 'could not reach it',
			},
		});
	});
});

describe('tokenProxyAgentGatewayUrl', () => {
	it('puts the agent in front of the route of a gateway that is the proxy', () => {
		expect(tokenProxyAgentGatewayUrl('http://127.0.0.1:41234/anthropic', 41234, 'agent-1')).toBe(
			'http://127.0.0.1:41234/agent/agent-1/anthropic'
		);
		expect(tokenProxyAgentGatewayUrl('http://localhost:41234/openai/v1/', 41234, 'a b')).toBe(
			'http://localhost:41234/agent/a%20b/openai/v1'
		);
	});

	it('resolves back to the same route, with the agent', () => {
		for (const route of Object.keys(TOKEN_PROXY_ROUTES) as Array<keyof typeof TOKEN_PROXY_ROUTES>) {
			const scoped = tokenProxyAgentGatewayUrl(
				tokenProxyGatewayUrl(41234, route),
				41234,
				'agent-1'
			);
			expect(parseGatewayUrl(scoped)).toEqual({ ok: true, url: scoped });
			expect(gatewayPointsAtTokenProxy(scoped, 41234)).toBe(true);
			expect(
				resolveTokenProxyTarget('POST', `${new URL(scoped).pathname}/responses`)
			).toMatchObject({ ok: true, route, agentId: 'agent-1' });
		}
	});

	it("leaves somebody else's proxy alone, whatever its path looks like", () => {
		// LiteLLM serves an Anthropic passthrough at /anthropic on its own port.
		for (const url of [
			'http://127.0.0.1:4000/anthropic',
			'https://gateway.example.com:41234/anthropic',
			'not a url',
		]) {
			expect(tokenProxyAgentGatewayUrl(url, 41234, 'agent-1')).toBe(url);
		}
	});

	it('does not scope twice, and does nothing without an agent', () => {
		const scoped = 'http://127.0.0.1:41234/agent/agent-1/anthropic';
		expect(tokenProxyAgentGatewayUrl(scoped, 41234, 'agent-2')).toBe(scoped);
		expect(tokenProxyAgentGatewayUrl('http://127.0.0.1:41234/anthropic', 41234, '')).toBe(
			'http://127.0.0.1:41234/anthropic'
		);
	});
});

describe('resolveTokenProxyMode', () => {
	const onProxy = 'http://127.0.0.1:41234/anthropic';

	it('is off unless the gateway reaches the proxy', () => {
		expect(
			resolveTokenProxyMode({ gatewayUrl: undefined, storedMode: 'compress', port: 41234 })
		).toBe('off');
		expect(
			resolveTokenProxyMode({
				gatewayUrl: 'http://127.0.0.1:8787',
				storedMode: 'compress',
				port: 41234,
			})
		).toBe('off');
		// No port has been chosen, so no gateway can be the proxy.
		expect(resolveTokenProxyMode({ gatewayUrl: onProxy, storedMode: 'compress', port: null })).toBe(
			'off'
		);
	});

	it('defaults to passthrough for a gateway that points at the proxy', () => {
		expect(resolveTokenProxyMode({ gatewayUrl: onProxy, port: 41234 })).toBe('passthrough');
		expect(resolveTokenProxyMode({ gatewayUrl: onProxy, storedMode: 'bogus', port: 41234 })).toBe(
			'passthrough'
		);
	});

	it('is compress only when the agent stored it', () => {
		expect(
			resolveTokenProxyMode({ gatewayUrl: onProxy, storedMode: 'compress', port: 41234 })
		).toBe('compress');
	});

	it('keeps the early choice, which is a different mode and not a spelling of compress', () => {
		expect(
			resolveTokenProxyMode({ gatewayUrl: onProxy, storedMode: 'compress-early', port: 41234 })
		).toBe('compress-early');
		expect(asTokenProxyMode('compress-early')).toBe('compress-early');
		expect(asStoredTokenProxyMode('compress-early')).toBe('compress-early');
	});

	it('says which modes read and shorten a request, and describes every mode', () => {
		expect(TOKEN_PROXY_MODES.filter(isCompressingTokenProxyMode)).toEqual([
			'compress',
			'compress-early',
		]);
		for (const mode of TOKEN_PROXY_MODES) {
			expect(TOKEN_PROXY_MODE_LABELS[mode].length).toBeGreaterThan(0);
			expect(TOKEN_PROXY_MODE_DESCRIPTIONS[mode].length).toBeGreaterThan(0);
		}
		// The two compress modes differ in what the MODEL sees; the words say so.
		expect(TOKEN_PROXY_MODE_DESCRIPTIONS['compress-early']).toMatch(/before the model first reads/);
		expect(TOKEN_PROXY_MODE_DESCRIPTIONS.compress).toMatch(/after the model has read/);
	});
});

describe('asTokenProxyMode', () => {
	it('narrows the modes and nothing else', () => {
		expect(asTokenProxyMode('off')).toBe('off');
		expect(asTokenProxyMode('passthrough')).toBe('passthrough');
		expect(asTokenProxyMode('compress')).toBe('compress');
		for (const value of ['', 'on', 'Compress', true, null, undefined, 1]) {
			expect(asTokenProxyMode(value)).toBeUndefined();
		}
	});

	it('reads anything but a compress mode as passthrough when stored', () => {
		expect(asStoredTokenProxyMode('compress')).toBe('compress');
		for (const value of ['passthrough', 'off', undefined, null, true]) {
			expect(asStoredTokenProxyMode(value)).toBe('passthrough');
		}
	});
});

describe('tokenProxyRouteForAgent', () => {
	it('sends Claude Code to the Anthropic route', () => {
		expect(tokenProxyRouteForAgent('claude-code', {})).toEqual({ ok: true, route: 'anthropic' });
	});

	it('sends Codex by its credential: an API key or a ChatGPT login', () => {
		expect(tokenProxyRouteForAgent('codex', { OPENAI_API_KEY: 'sk-test' })).toEqual({
			ok: true,
			route: 'openai',
		});
		expect(tokenProxyRouteForAgent('codex', {})).toEqual({ ok: true, route: 'chatgpt' });
		expect(tokenProxyRouteForAgent('codex', { OPENAI_API_KEY: '  ' })).toEqual({
			ok: true,
			route: 'chatgpt',
		});
	});

	it('refuses a provider that cannot use a gateway, with its reason', () => {
		const copilot = tokenProxyRouteForAgent('copilot-cli', {});
		expect(copilot.ok).toBe(false);
		if (!copilot.ok) expect(copilot.error).toContain('Copilot CLI ignores base-URL variables');
		expect(tokenProxyRouteForAgent('terminal', {}).ok).toBe(false);
	});
});
