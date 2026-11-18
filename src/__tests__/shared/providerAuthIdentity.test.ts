/**
 * @file providerAuthIdentity.test.ts
 * @description Tests for the credential scope key and the credential-kind classifier.
 *
 * The classifier answers one question for every auth surface: can a login flow
 * repair this? Getting it wrong in the permissive direction is the expensive
 * failure - Maestro runs the provider's login, the user completes it, and the
 * agent still presents the same rejected API key or gateway token. So the tests
 * below are mostly about what does NOT count as an OAuth agent.
 */

import { describe, it, expect } from 'vitest';
import { resolveAgentEnvironment } from '../../shared/agentEnvironment';
import {
	providerAuthKey,
	classifyCredentialKind,
	credentialKindBlocksLogin,
} from '../../shared/providerAuthIdentity';

describe('providerAuthKey', () => {
	it('scopes a local agent to its binary alone', () => {
		expect(providerAuthKey('claude-code')).toBe('claude-code');
	});

	// A remote has its own credential store: the same agent can be signed in here
	// and expired there, and fixing one does nothing for the other.
	it('separates the same agent on different hosts', () => {
		expect(providerAuthKey('claude-code', 'remote-a')).not.toBe(
			providerAuthKey('claude-code', 'remote-b')
		);
		expect(providerAuthKey('claude-code', 'remote-a')).not.toBe(providerAuthKey('claude-code'));
	});

	it('treats an absent remote and a null remote as the same local scope', () => {
		expect(providerAuthKey('codex', null)).toBe(providerAuthKey('codex'));
	});
});

describe('classifyCredentialKind', () => {
	it('defaults to oauth, which is every provider out of the box', () => {
		expect(classifyCredentialKind('claude-code', {}).kind).toBe('oauth');
		expect(classifyCredentialKind('codex', {}).kind).toBe('oauth');
		expect(classifyCredentialKind('opencode', {}).kind).toBe('oauth');
		expect(classifyCredentialKind('copilot-cli', {}).kind).toBe('oauth');
	});

	it('falls back to oauth for an agent it has no table for', () => {
		expect(classifyCredentialKind('factory-droid', { SOMETHING: 'x' }).kind).toBe('oauth');
	});

	it('names the API-key variable that decided the answer', () => {
		expect(classifyCredentialKind('claude-code', { ANTHROPIC_API_KEY: 'sk-x' })).toMatchObject({
			kind: 'api-key',
			envVarName: 'ANTHROPIC_API_KEY',
		});
	});

	// The gateway token is the more specific of the two, so it wins.
	it('prefers the gateway token over the plain API key', () => {
		expect(
			classifyCredentialKind('claude-code', {
				ANTHROPIC_API_KEY: 'sk-x',
				ANTHROPIC_AUTH_TOKEN: 'gw-x',
			}).envVarName
		).toBe('ANTHROPIC_AUTH_TOKEN');
	});

	// A base URL outranks any token: whatever failed belongs to the operator it
	// points at, and no provider login reaches them.
	it('reads a base-URL override as a gateway even when a token is set', () => {
		expect(
			classifyCredentialKind('claude-code', {
				ANTHROPIC_BASE_URL: 'https://api.z.ai/v1',
				ANTHROPIC_AUTH_TOKEN: 'gw-x',
			})
		).toMatchObject({ kind: 'gateway', label: 'api.z.ai' });
	});

	it('keeps an unparseable base URL rather than dropping the label', () => {
		expect(
			classifyCredentialKind('claude-code', { ANTHROPIC_BASE_URL: 'not a url' })
		).toMatchObject({ kind: 'gateway', label: 'not a url' });
	});

	// Bedrock and Vertex ignore the config dir AND the Anthropic vars, so they
	// have to be checked before anything else.
	it('reads a cloud-provider flag ahead of every other signal', () => {
		expect(
			classifyCredentialKind('claude-code', {
				CLAUDE_CODE_USE_BEDROCK: '1',
				ANTHROPIC_BASE_URL: 'https://api.z.ai/v1',
				ANTHROPIC_API_KEY: 'sk-x',
			})
		).toMatchObject({ kind: 'cloud-provider', label: 'AWS Bedrock' });
		expect(classifyCredentialKind('claude-code', { CLAUDE_CODE_USE_VERTEX: 'true' })).toMatchObject(
			{ kind: 'cloud-provider', label: 'Google Vertex AI' }
		);
	});

	it.each(['', '   ', '0', 'false', 'no', 'off', 'OFF'])(
		'treats the cloud flag value %o as off',
		(value) => {
			expect(classifyCredentialKind('claude-code', { CLAUDE_CODE_USE_BEDROCK: value }).kind).toBe(
				'oauth'
			);
		}
	);

	// An emptied row is how a user turns an inherited variable off, so a blank
	// value must not invent a credential.
	it('treats a whitespace-only secret as unset', () => {
		expect(classifyCredentialKind('claude-code', { ANTHROPIC_API_KEY: '  ' }).kind).toBe('oauth');
		expect(classifyCredentialKind('codex', { OPENAI_API_KEY: '' }).kind).toBe('oauth');
	});

	it('does not read one provider variables for another', () => {
		expect(classifyCredentialKind('codex', { ANTHROPIC_API_KEY: 'sk-x' }).kind).toBe('oauth');
		expect(classifyCredentialKind('claude-code', { OPENAI_API_KEY: 'sk-x' }).kind).toBe('oauth');
	});

	it('uses the Copilot CLI token precedence order', () => {
		expect(
			classifyCredentialKind('copilot-cli', { GH_TOKEN: 'a', COPILOT_GITHUB_TOKEN: 'b' })
		).toMatchObject({ kind: 'api-key', envVarName: 'COPILOT_GITHUB_TOKEN' });
		expect(classifyCredentialKind('copilot-cli', { GITHUB_TOKEN: 'a' }).kind).toBe('api-key');
	});

	// OpenCode keeps every provider in one auth.json, so a key set for ANY of
	// them changes what the agent presents. Matched by shape, not by a list that
	// goes stale on each release.
	it('matches any provider key variable for opencode', () => {
		expect(classifyCredentialKind('opencode', { GROQ_API_KEY: 'x' }).kind).toBe('api-key');
		expect(classifyCredentialKind('opencode', { MOONSHOT_API_KEY: 'x' }).kind).toBe('api-key');
		expect(classifyCredentialKind('opencode', { ANTHROPIC_AUTH_TOKEN: 'x' }).kind).toBe('api-key');
		expect(classifyCredentialKind('opencode', { NOT_A_KEY: 'x' }).kind).toBe('oauth');
	});

	it('reports opencode keys in a stable order regardless of env ordering', () => {
		const forward = classifyCredentialKind('opencode', { ZED_API_KEY: 'x', ALPHA_API_KEY: 'y' });
		const reverse = classifyCredentialKind('opencode', { ALPHA_API_KEY: 'y', ZED_API_KEY: 'x' });
		expect(forward.envVarName).toBe(reverse.envVarName);
	});
});

describe('credentialKindBlocksLogin', () => {
	it('lets an OAuth agent through', () => {
		expect(credentialKindBlocksLogin({ kind: 'oauth' }, 'Claude Code')).toBeNull();
	});

	it.each(['api-key', 'gateway', 'cloud-provider'] as const)('blocks a %s agent', (kind) => {
		const reason = credentialKindBlocksLogin({ kind, envVarName: 'SOME_VAR' }, 'Claude Code');
		expect(reason).toContain('Claude Code');
		expect(reason).toContain('SOME_VAR');
	});

	it('still explains itself when no variable named the credential', () => {
		expect(credentialKindBlocksLogin({ kind: 'api-key' }, 'Codex')).toContain('its environment');
	});
});

describe('Grok credential guidance', () => {
	it('keeps local and SSH failures in separate provider scopes', () => {
		const local = providerAuthKey('grok');
		const remote = providerAuthKey('grok', 'remote-a');
		expect(providerAuthKey('grok', null)).toBe(local);
		expect(new Set([local, remote, providerAuthKey('grok', 'remote-b')]).size).toBe(3);
		expect(remote).not.toBe(providerAuthKey('codex', 'remote-a'));
	});

	it.each<Record<string, string>>([
		{},
		{ GROK_HOME: 'selected-state' },
		{ GROK_AUTH_PATH: 'selected-auth.json', GROK_HOME: 'selected-state' },
		{ GROK_AUTH_PATH: ' \t', GROK_HOME: 'selected-state' },
		{ GROK_OIDC_ISSUER: 'https://idp.example.test', GROK_OIDC_CLIENT_ID: 'client-id' },
		{ GROK_AUTH_PROVIDER_COMMAND: 'company-auth', GROK_AUTH_PROVIDER_LABEL: 'Company' },
	])('keeps file and external login configurations eligible: %j', (env) => {
		const classification = classifyCredentialKind('grok', env);
		expect(classification).toEqual({
			kind: 'oauth',
			envVarName: env.GROK_AUTH_PATH?.trim() ? 'GROK_AUTH_PATH' : 'GROK_HOME',
		});
		expect(credentialKindBlocksLogin(classification, 'Grok CLI')).toBeNull();
	});

	it.each(['XAI_API_KEY', 'GROK_CODE_XAI_API_KEY'])(
		'describes %s as a possibly inactive fallback, never a login repair',
		(key) => {
			const classification = classifyCredentialKind('grok', { [key]: 'synthetic-api-secret' });
			expect(classification).toEqual({ kind: 'api-key', envVarName: key, fallback: true });
			const reason = credentialKindBlocksLogin(classification, 'Grok CLI');
			expect(reason).toContain(key);
			expect(reason).toContain('fallback API key');
			expect(reason).toContain('may take precedence');
			expect(reason).toContain('signing in does not repair an invalid API key');
			expect(reason).not.toContain('synthetic-api-secret');
		}
	);

	it('prefers the current fallback key, then exposes the legacy key when it is unset', () => {
		const env = { XAI_API_KEY: 'current-secret', GROK_CODE_XAI_API_KEY: 'legacy-secret' };
		expect(classifyCredentialKind('grok', env).envVarName).toBe('XAI_API_KEY');
		expect(classifyCredentialKind('grok', { ...env, XAI_API_KEY: ' \t' })).toEqual({
			kind: 'api-key',
			envVarName: 'GROK_CODE_XAI_API_KEY',
			fallback: true,
		});
	});

	it.each(['{"access_token":"inline-secret"}', '{malformed-inline-secret', 'null'])(
		'keeps inline credentials opaque even when malformed: %s',
		(bundle) => {
			const env = {
				GROK_AUTH: bundle,
				XAI_API_KEY: 'fallback-secret',
				GROK_AUTH_PATH: 'auth.json',
			};
			const classification = classifyCredentialKind('grok', env);
			expect(classification).toEqual({
				kind: 'inline',
				envVarName: 'GROK_AUTH',
				label: 'Inline credentials',
			});
			const reason = credentialKindBlocksLogin(classification, 'Grok CLI');
			expect(reason).toContain('does not replace this environment override');
			expect(reason).toContain('Update or unset GROK_AUTH');
			expect(reason).not.toContain('inline-secret');
			expect(JSON.stringify({ classification, reason })).not.toContain(bundle);
		}
	);

	it.each<Record<string, string>>([
		{},
		{ GROK_DISABLE_API_KEY_AUTH: '1' },
		{ GROK_FORCE_LOGIN_TEAM_ID: 'team-id' },
	])('keeps deployment keys ahead of inline credentials despite fallback lockdown: %j', (flags) => {
		const classification = classifyCredentialKind('grok', {
			...flags,
			GROK_DEPLOYMENT_KEY: 'deployment-secret',
			GROK_AUTH: 'inline-secret',
			XAI_API_KEY: 'fallback-secret',
		});
		expect(classification).toEqual({ kind: 'api-key', envVarName: 'GROK_DEPLOYMENT_KEY' });
		const reason = credentialKindBlocksLogin(classification, 'Grok CLI');
		expect(reason).toContain('Replace that key');
		expect(reason).toContain('signing in would not change');
		expect(reason).not.toContain('fallback');
		expect(reason).not.toContain('deployment-secret');
	});

	it.each(['', ' \t', '0', 'false', 'FALSE', 'no', 'off', ' OFF '])(
		'keeps API-key failures blocked when lockdown is off (%j)',
		(value) => {
			const classification = classifyCredentialKind('grok', {
				XAI_API_KEY: 'synthetic-secret',
				GROK_DISABLE_API_KEY_AUTH: value,
			});
			expect(classification.kind).toBe('api-key');
			expect(credentialKindBlocksLogin(classification, 'Grok CLI')).not.toBeNull();
		}
	);

	it.each(['1', 'true', ' TRUE ', 'yes', 'on', 'enabled'])(
		'allows login when lockdown disables both fallback keys (%j)',
		(value) => {
			const classification = classifyCredentialKind('grok', {
				XAI_API_KEY: 'current-secret',
				GROK_CODE_XAI_API_KEY: 'legacy-secret',
				GROK_DISABLE_API_KEY_AUTH: value,
			});
			expect(classification.kind).toBe('oauth');
			expect(credentialKindBlocksLogin(classification, 'Grok CLI')).toBeNull();
		}
	);

	it.each(['', ' \t', 'team-id', '0', 'false'])(
		'treats the forced team as a nonblank identifier rather than a boolean (%j)',
		(value) => {
			const classification = classifyCredentialKind('grok', {
				XAI_API_KEY: 'current-secret',
				GROK_CODE_XAI_API_KEY: 'legacy-secret',
				GROK_FORCE_LOGIN_TEAM_ID: value,
			});
			expect(classification.kind).toBe(value.trim() ? 'oauth' : 'api-key');
			expect(credentialKindBlocksLogin(classification, 'Grok CLI') === null).toBe(
				Boolean(value.trim())
			);
		}
	);

	it.each(['GROK_MODELS_BASE_URL', 'GROK_CLI_CHAT_PROXY_BASE_URL', 'GROK_XAI_API_BASE_URL'])(
		'blocks provider login for %s without disclosing URL credentials',
		(key) => {
			for (const [value, label] of [
				[
					'https://user-secret:password-secret@gateway.example.test:8443/path-secret?key=query-secret',
					'gateway.example.test:8443',
				],
				['not-a-url/path-secret?key=query-secret', 'a configured gateway'],
				['file:///path-secret?key=query-secret', 'a configured gateway'],
			]) {
				const classification = classifyCredentialKind('grok', {
					[key]: value,
					GROK_DEPLOYMENT_KEY: 'deployment-secret',
					GROK_AUTH: 'inline-secret',
					XAI_API_KEY: 'fallback-secret',
				});
				expect(classification).toEqual({ kind: 'gateway', envVarName: key, label });
				const reason = credentialKindBlocksLogin(classification, 'Grok CLI');
				expect(reason).toContain(key);
				expect(reason).toContain('provider login cannot repair it');
				expect(JSON.stringify({ classification, reason })).not.toContain('secret');
			}
		}
	);

	it.each([
		'XAI_API_KEY',
		'GROK_CODE_XAI_API_KEY',
		'GROK_DEPLOYMENT_KEY',
		'GROK_AUTH',
		'GROK_MODELS_BASE_URL',
		'GROK_CLI_CHAT_PROXY_BASE_URL',
		'GROK_XAI_API_BASE_URL',
	])('lets explicit unsets remove inherited %s from login gating', (key) => {
		for (const value of ['', ' \t\n']) {
			for (const layer of ['agent', 'session'] as const) {
				const entries = resolveAgentEnvironment({
					global: { [key]: 'inherited-secret' },
					[layer]: { [key]: value },
				});
				const env = Object.fromEntries(entries.map(({ key, value }) => [key, value]));
				expect(env[key]).toBe(value);
				const classification = classifyCredentialKind('grok', env);
				expect(classification.kind).toBe('oauth');
				expect(credentialKindBlocksLogin(classification, 'Grok CLI')).toBeNull();
			}
		}
	});

	it('classifies the selected environment, with session replacement of provider settings', () => {
		const layers = {
			global: { XAI_API_KEY: 'global-secret' },
			agent: { GROK_AUTH: 'provider-inline-secret' },
		};
		for (const [session, kind] of [
			[undefined, 'inline'],
			[{}, 'api-key'],
			[{ XAI_API_KEY: '' }, 'oauth'],
		] as const) {
			const env = Object.fromEntries(
				resolveAgentEnvironment({ ...layers, session }).map(({ key, value }) => [key, value])
			);
			expect(classifyCredentialKind('grok', env).kind).toBe(kind);
		}
	});

	it('ignores unrelated provider credentials in Grok and Grok credentials in Codex', () => {
		expect(
			classifyCredentialKind('grok', {
				OPENAI_API_KEY: 'openai-secret',
				ANTHROPIC_API_KEY: 'anthropic-secret',
				GH_TOKEN: 'github-secret',
			}).kind
		).toBe('oauth');
		expect(
			classifyCredentialKind('codex', {
				GROK_AUTH: 'inline-secret',
				XAI_API_KEY: 'xai-secret',
				GROK_MODELS_BASE_URL: 'https://gateway.example.test',
			}).kind
		).toBe('oauth');
	});
});
