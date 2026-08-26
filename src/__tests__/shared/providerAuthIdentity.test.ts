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
