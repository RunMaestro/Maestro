/**
 * Tests for shared/local-models/gateway - which providers can use a per-agent
 * gateway, what a stored URL may be, and what one launch does with it.
 */

import { describe, it, expect } from 'vitest';
import { AGENT_IDS } from '../../../shared/agentIds';
import {
	agentGatewaySupport,
	gatewayEnvVarsFor,
	isLoopbackGatewayUrl,
	parseGatewayUrl,
	parseGatewayUrlEdit,
	resolveAgentGateway,
} from '../../../shared/local-models/gateway';

describe('agentGatewaySupport', () => {
	it.each([
		['claude-code', 'ANTHROPIC_BASE_URL'],
		['codex', 'OPENAI_BASE_URL'],
	])('%s is reached through %s', (toolType, envVar) => {
		expect(agentGatewaySupport(toolType)).toMatchObject({ supported: true, envVar });
	});

	it('gives Codex a config argument too, because its variable alone is ignored', () => {
		const support = agentGatewaySupport('codex');
		if (!support.supported) throw new Error('expected supported');
		// Codex CLI 0.162.1 with a ChatGPT login ignores OPENAI_BASE_URL; the root
		// config override is what it honors. A TOML basic string, quotes included.
		expect(support.configArgs?.('http://127.0.0.1:8787/chatgpt')).toEqual([
			'-c',
			'openai_base_url="http://127.0.0.1:8787/chatgpt"',
		]);

		const claude = agentGatewaySupport('claude-code');
		if (!claude.supported) throw new Error('expected supported');
		expect(claude.configArgs).toBeUndefined();
	});

	it('refuses Copilot CLI and says it ignores base-URL variables', () => {
		const support = agentGatewaySupport('copilot-cli');

		expect(support.supported).toBe(false);
		if (support.supported) throw new Error('expected unsupported');
		expect(support.reason).toContain('ignores base-URL variables');
	});

	it('answers for every agent id, with a reason wherever it refuses', () => {
		for (const id of AGENT_IDS) {
			const support = agentGatewaySupport(id);
			if (!support.supported) expect(support.reason.length).toBeGreaterThan(0);
		}
	});

	it('refuses an id it has never heard of rather than guessing a variable', () => {
		expect(agentGatewaySupport('not-a-provider').supported).toBe(false);
	});
});

describe('parseGatewayUrl', () => {
	it('trims and drops trailing slashes, keeping a route prefix', () => {
		expect(parseGatewayUrl('  http://127.0.0.1:8787/anthropic//  ')).toEqual({
			ok: true,
			url: 'http://127.0.0.1:8787/anthropic',
		});
		expect(parseGatewayUrl('https://proxy.example.com/')).toEqual({
			ok: true,
			url: 'https://proxy.example.com',
		});
	});

	it.each([
		['', 'empty'],
		['127.0.0.1:8787', 'not a URL'],
		['not a url', 'not a URL'],
		['ftp://proxy.example.com', 'http:// or https://'],
		['http://proxy.example.com/?key=1', 'query string'],
		['http://proxy.example.com/#frag', 'query string'],
	])('refuses %j', (raw, fragment) => {
		const parsed = parseGatewayUrl(raw);

		expect(parsed.ok).toBe(false);
		if (parsed.ok) throw new Error('expected a refusal');
		expect(parsed.error).toContain(fragment);
	});
});

describe('isLoopbackGatewayUrl', () => {
	it.each([
		'http://127.0.0.1:8787',
		'http://127.8.9.10',
		'http://localhost:4000/anthropic',
		'http://proxy.localhost',
		'http://[::1]:8787',
		'http://0.0.0.0:8787',
	])('%s is loopback', (url) => {
		expect(isLoopbackGatewayUrl(url)).toBe(true);
	});

	it.each([
		'http://10.0.0.5:8787',
		'https://proxy.example.com',
		'http://127.example.com',
		'http://localhost.example.com',
		'nonsense',
	])('%s is not loopback', (url) => {
		expect(isLoopbackGatewayUrl(url)).toBe(false);
	});
});

describe('resolveAgentGateway', () => {
	const url = 'http://127.0.0.1:8787';

	it('does nothing for an agent with no gateway', () => {
		expect(resolveAgentGateway({ toolType: 'claude-code' })).toEqual({ kind: 'none' });
		expect(resolveAgentGateway({ toolType: 'claude-code', gatewayUrl: '   ' })).toEqual({
			kind: 'none',
		});
		// No gateway means no opinion, even for a provider that could not use one.
		expect(resolveAgentGateway({ toolType: 'copilot-cli', gatewayUrl: null })).toEqual({
			kind: 'none',
		});
	});

	it.each([
		['claude-code', 'ANTHROPIC_BASE_URL', []],
		['codex', 'OPENAI_BASE_URL', ['-c', `openai_base_url=${JSON.stringify(url)}`]],
	])('injects the base-URL variable for %s', (toolType, envVar, args) => {
		expect(resolveAgentGateway({ toolType, gatewayUrl: `${url}/` })).toEqual({
			kind: 'inject',
			envVar,
			url,
			envVars: { [envVar]: url },
			args,
		});
	});

	it('adds no config argument when the agent sets the variable itself', () => {
		// Rule 1 covers both halves: a user's own base URL wins, so Maestro's
		// argument must not override it from the command line.
		const resolution = resolveAgentGateway({
			toolType: 'codex',
			gatewayUrl: url,
			userEnvVars: { OPENAI_BASE_URL: 'https://mine.example.com' },
		});
		expect(resolution.kind).toBe('user-override');
		expect(resolution).not.toHaveProperty('args');
	});

	it('lets a variable the agent sets itself win', () => {
		expect(
			resolveAgentGateway({
				toolType: 'claude-code',
				gatewayUrl: url,
				userEnvVars: { ANTHROPIC_BASE_URL: 'https://mine.example.com' },
			})
		).toEqual({
			kind: 'user-override',
			envVar: 'ANTHROPIC_BASE_URL',
			url,
			userValue: 'https://mine.example.com',
		});
	});

	it('does not count a blank user value, or another provider variable, as an override', () => {
		expect(
			resolveAgentGateway({
				toolType: 'claude-code',
				gatewayUrl: url,
				userEnvVars: { ANTHROPIC_BASE_URL: '  ', OPENAI_BASE_URL: 'https://other.example.com' },
			}).kind
		).toBe('inject');
	});

	it('refuses a loopback gateway for an SSH remote, naming the gateway and the remote', () => {
		const resolution = resolveAgentGateway({
			toolType: 'codex',
			gatewayUrl: url,
			remote: { name: 'Build Box' },
		});

		expect(resolution.kind).toBe('refused');
		if (resolution.kind !== 'refused') throw new Error('expected a refusal');
		expect(resolution.code).toBe('gateway-loopback-on-remote');
		expect(resolution.message).toContain(url);
		expect(resolution.message).toContain('"Build Box"');
	});

	it('sends a reachable gateway to an SSH remote', () => {
		expect(
			resolveAgentGateway({
				toolType: 'codex',
				gatewayUrl: 'https://proxy.example.com',
				remote: { name: 'Build Box' },
			})
		).toMatchObject({ kind: 'inject', envVar: 'OPENAI_BASE_URL' });
	});

	it('does not refuse a remote agent that overrides the variable itself', () => {
		// The gateway is not in force, so where it points does not matter.
		expect(
			resolveAgentGateway({
				toolType: 'codex',
				gatewayUrl: url,
				userEnvVars: { OPENAI_BASE_URL: 'https://mine.example.com' },
				remote: { name: 'Build Box' },
			}).kind
		).toBe('user-override');
	});

	it('refuses a stored gateway on a provider that cannot use one', () => {
		const resolution = resolveAgentGateway({ toolType: 'copilot-cli', gatewayUrl: url });

		expect(resolution).toMatchObject({ kind: 'refused', code: 'gateway-unsupported-provider' });
		if (resolution.kind !== 'refused') throw new Error('expected a refusal');
		expect(resolution.message).toContain('Copilot CLI');
	});

	it('refuses a stored value that is not a URL', () => {
		expect(resolveAgentGateway({ toolType: 'claude-code', gatewayUrl: 'nope' })).toMatchObject({
			kind: 'refused',
			code: 'gateway-invalid-url',
		});
	});
});

describe('gatewayEnvVarsFor', () => {
	it('names the variable a usable gateway would set', () => {
		expect(gatewayEnvVarsFor('claude-code', 'http://127.0.0.1:8787')).toEqual({
			ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787',
		});
	});

	it('is undefined with no gateway, an unusable one, or an unsupported provider', () => {
		expect(gatewayEnvVarsFor('claude-code', undefined)).toBeUndefined();
		expect(gatewayEnvVarsFor('claude-code', 'nope')).toBeUndefined();
		expect(gatewayEnvVarsFor('copilot-cli', 'http://127.0.0.1:8787')).toBeUndefined();
	});
});

describe('parseGatewayUrlEdit', () => {
	it.each(['', '   ', 'none', 'NONE'])('reads %j as clearing the gateway', (raw) => {
		expect(parseGatewayUrlEdit('claude-code', raw)).toEqual({ ok: true, gatewayUrl: null });
	});

	it('clears on any provider, so a gateway left by a provider switch can be removed', () => {
		expect(parseGatewayUrlEdit('copilot-cli', 'none')).toEqual({ ok: true, gatewayUrl: null });
	});

	it('stores the normalized URL', () => {
		expect(parseGatewayUrlEdit('codex', ' http://localhost:4000/openai/ ')).toEqual({
			ok: true,
			gatewayUrl: 'http://localhost:4000/openai',
		});
	});

	it('refuses a URL for a provider that cannot use a gateway, with the reason', () => {
		const edit = parseGatewayUrlEdit('copilot-cli', 'http://127.0.0.1:8787');

		expect(edit.ok).toBe(false);
		if (edit.ok) throw new Error('expected a refusal');
		expect(edit.error).toContain('ignores base-URL variables');
	});

	it('refuses a value that is not a URL', () => {
		expect(parseGatewayUrlEdit('claude-code', 'nope').ok).toBe(false);
	});
});
