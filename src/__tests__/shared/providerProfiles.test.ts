/**
 * Tests for shared/providerProfiles
 *
 * Covers:
 *   - account resolution from the effective env, and the implicit `~/.claude`
 *     default when no env var is set
 *   - the deliberate null when $HOME has not resolved yet (no guessed bucket)
 *   - providers with no account concept resolve to no account key
 *   - profile keys round-trip, including account keys that contain the
 *     separator's characters
 *   - labels read as the account for a multi-account provider and as the
 *     provider itself otherwise
 */

import { describe, it, expect } from 'vitest';
import {
	effectiveAgentCustomEnvVars,
	getProviderProfileConfig,
	makeAccountKeyHelpers,
	parseProviderProfileKey,
	providerProfileKey,
	providerProfileLabel,
	providerProfileShortLabel,
	resolveAgentAccountKey,
	resolveAgentBillingCredential,
	resolveAgentProfile,
} from '../../shared/providerProfiles';

const HOME = '/Users/me';

describe('resolveAgentAccountKey', () => {
	it('uses the provider env var when the agent sets one', () => {
		expect(
			resolveAgentAccountKey('claude-code', { CLAUDE_CONFIG_DIR: '/Users/me/.claude-smash' }, HOME)
		).toBe('/Users/me/.claude-smash');
		expect(resolveAgentAccountKey('codex', { CODEX_HOME: '/Users/me/.codex-work' }, HOME)).toBe(
			'/Users/me/.codex-work'
		);
	});

	it('normalizes trailing slashes so two spellings collapse to one account', () => {
		expect(
			resolveAgentAccountKey(
				'claude-code',
				{ CLAUDE_CONFIG_DIR: '/Users/me/.claude-smash//' },
				HOME
			)
		).toBe('/Users/me/.claude-smash');
	});

	it('falls back to the implicit default account dir when the env var is unset or empty', () => {
		expect(resolveAgentAccountKey('claude-code', {}, HOME)).toBe('/Users/me/.claude');
		expect(resolveAgentAccountKey('claude-code', { CLAUDE_CONFIG_DIR: '' }, HOME)).toBe(
			'/Users/me/.claude'
		);
		expect(resolveAgentAccountKey('codex', undefined, HOME)).toBe('/Users/me/.codex');
	});

	it('returns null when $HOME has not resolved and the agent named no dir', () => {
		// Guessing a default here would file the agent under an account it may
		// not belong to; absent is the honest answer until $HOME arrives.
		expect(resolveAgentAccountKey('claude-code', {}, undefined)).toBeNull();
	});

	it('returns null for a provider with no account concept, even with $HOME', () => {
		expect(getProviderProfileConfig('opencode')).toBeUndefined();
		expect(resolveAgentAccountKey('opencode', {}, HOME)).toBeNull();
	});
});

describe('provider profile keys', () => {
	it('round-trips a provider with an account', () => {
		const key = providerProfileKey('claude-code', '/Users/me/.claude-smash');
		expect(parseProviderProfileKey(key)).toEqual({
			toolType: 'claude-code',
			accountKey: '/Users/me/.claude-smash',
		});
	});

	it('round-trips a provider with no account', () => {
		const key = providerProfileKey('opencode', null);
		expect(key).toBe('opencode');
		expect(parseProviderProfileKey(key)).toEqual({ toolType: 'opencode', accountKey: null });
	});

	it('splits on the first separator only, so a path containing one survives', () => {
		const weird = '/Users/me/odd::dir/.claude';
		const key = providerProfileKey('claude-code', weird);
		expect(parseProviderProfileKey(key)).toEqual({
			toolType: 'claude-code',
			accountKey: weird,
		});
	});
});

describe('profile labels', () => {
	it('names the account for a provider that has accounts', () => {
		expect(providerProfileShortLabel('claude-code', '/Users/me/.claude-smash')).toBe('smash');
		expect(providerProfileLabel('claude-code', '/Users/me/.claude-smash')).toBe(
			'Claude Code - smash'
		);
	});

	it('humanizes the implicit default account', () => {
		expect(providerProfileShortLabel('claude-code', '/Users/me/.claude')).toBe('Default account');
		expect(providerProfileLabel('codex', '/Users/me/.codex')).toBe('Codex - Default account');
	});

	it('falls back to the provider name when there is no account', () => {
		expect(providerProfileShortLabel('opencode', null)).toBe('OpenCode');
		expect(providerProfileLabel('opencode', null)).toBe('OpenCode');
	});
});

describe('effectiveAgentCustomEnvVars', () => {
	const provider = { CLAUDE_CONFIG_DIR: '/Users/me/.claude-banaco' };

	it("uses the agent's own vars in place of the provider-level set, never a merge", () => {
		expect(effectiveAgentCustomEnvVars({ ANTHROPIC_API_KEY: 'k' }, provider)).toEqual({
			ANTHROPIC_API_KEY: 'k',
		});
		expect(effectiveAgentCustomEnvVars({}, provider)).toEqual({});
	});

	it('falls back to the provider-level set only when the agent has none', () => {
		expect(effectiveAgentCustomEnvVars(undefined, provider)).toBe(provider);
		expect(effectiveAgentCustomEnvVars(undefined, undefined)).toEqual({});
	});
});

describe('resolveAgentBillingCredential', () => {
	it('returns null for an agent on its login', () => {
		expect(
			resolveAgentBillingCredential('claude-code', { CLAUDE_CONFIG_DIR: '/Users/me/.claude-smash' })
		).toBeNull();
	});

	it('identifies an API key by its last 4 characters, never the whole secret', () => {
		const credential = resolveAgentBillingCredential('claude-code', {
			ANTHROPIC_API_KEY: 'sk-ant-api03-secret-wXyZ',
		});
		expect(credential).toEqual({ kind: 'api-key', id: 'api-key:wXyZ', label: 'API key …wXyZ' });
		expect(JSON.stringify(credential)).not.toContain('secret');
		expect(resolveAgentBillingCredential('codex', { OPENAI_API_KEY: 'sk-proj-abcd' })?.id).toBe(
			'api-key:abcd'
		);
	});

	it('names a gateway by host and a cloud provider by name', () => {
		expect(
			resolveAgentBillingCredential('claude-code', {
				ANTHROPIC_BASE_URL: 'https://llm.example.com/v1',
			})?.label
		).toBe('llm.example.com');
		expect(
			resolveAgentBillingCredential('claude-code', { CLAUDE_CODE_USE_BEDROCK: '1' })?.label
		).toBe('AWS Bedrock');
	});

	it('ignores providers with no account split', () => {
		expect(resolveAgentBillingCredential('opencode', { ANTHROPIC_API_KEY: 'k' })).toBeNull();
	});
});

describe('resolveAgentProfile', () => {
	it('files a keyed agent under the key even when it also names a config dir', () => {
		expect(
			resolveAgentProfile(
				'claude-code',
				{ CLAUDE_CONFIG_DIR: '/Users/me/.claude-banaco', ANTHROPIC_API_KEY: 'sk-ant-a1b2' },
				HOME
			)
		).toMatchObject({
			key: 'claude-code::api-key:a1b2',
			accountKey: null,
			label: 'Claude Code - API key …a1b2',
			shortLabel: 'API key …a1b2',
		});
	});

	it('files a login agent under its config dir', () => {
		expect(
			resolveAgentProfile('claude-code', { CLAUDE_CONFIG_DIR: '/Users/me/.claude-smash' }, HOME)
		).toMatchObject({
			key: 'claude-code::/Users/me/.claude-smash',
			accountKey: '/Users/me/.claude-smash',
			credential: null,
			shortLabel: 'smash',
		});
	});

	it('splits an SSH-remote agent into its own profile per host', () => {
		const env = { CLAUDE_CONFIG_DIR: '/Users/me/.claude-banaco' };
		const local = resolveAgentProfile('claude-code', env, HOME);
		const remote = resolveAgentProfile('claude-code', env, HOME, { id: 'r1', name: 'pedtome' });

		expect(remote).toMatchObject({
			key: 'claude-code::/Users/me/.claude-banaco@ssh:r1',
			accountKey: '/Users/me/.claude-banaco',
			sshRemoteId: 'r1',
			label: 'Claude Code - banaco @ pedtome',
			shortLabel: 'banaco @ pedtome',
		});
		expect(remote?.key).not.toBe(local?.key);
		expect(
			resolveAgentProfile('claude-code', env, HOME, { id: 'r2', name: 'linode' })?.key
		).not.toBe(remote?.key);
		// A deleted remote keeps its own bucket rather than folding into local.
		expect(resolveAgentProfile('claude-code', env, HOME, { id: 'gone' })?.shortLabel).toBe(
			'banaco @ unknown host'
		);
	});

	it('keeps a credential profile whole across hosts', () => {
		const env = { ANTHROPIC_API_KEY: 'sk-ant-a1b2' };
		expect(
			resolveAgentProfile('claude-code', env, HOME, { id: 'r1', name: 'pedtome' })
		).toMatchObject({ key: 'claude-code::api-key:a1b2', sshRemoteId: null });
	});

	it('returns null only while a login agent is waiting on $HOME', () => {
		expect(resolveAgentProfile('claude-code', {}, undefined)).toBeNull();
		expect(
			resolveAgentProfile('claude-code', { ANTHROPIC_API_KEY: 'sk-ant-a1b2' }, undefined)
		).not.toBeNull();
		expect(resolveAgentProfile('opencode', {}, undefined)?.key).toBe('opencode');
	});
});

describe('makeAccountKeyHelpers', () => {
	it('derives short names the same way the quota panels always have', () => {
		const { deriveShortName, deriveDisplayName } = makeAccountKeyHelpers('.claude');
		expect(deriveShortName('/Users/me/.claude')).toBe('default');
		expect(deriveShortName('/Users/me/.claude-gmail')).toBe('gmail');
		expect(deriveShortName(undefined)).toBe('default');
		expect(deriveDisplayName('/Users/me/.claude')).toBe('Default account');
	});
});
