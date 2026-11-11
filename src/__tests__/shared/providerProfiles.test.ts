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

import path from 'path';
import { describe, it, expect } from 'vitest';
import { classifyCredentialKind } from '../../shared/providerAuthIdentity';
import {
	effectiveAgentCustomEnvVars,
	getProviderProfileConfig,
	isAccountDirName,
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
		// Deliberate omissions, re-verified 2026-09-14: OpenCode's data dir follows
		// the OS-wide XDG_DATA_HOME rather than an OpenCode account selector, and
		// Factory Droid ships no config-dir override at all.
		expect(getProviderProfileConfig('opencode')).toBeUndefined();
		expect(getProviderProfileConfig('factory-droid')).toBeUndefined();
		expect(resolveAgentAccountKey('opencode', {}, HOME)).toBeNull();
		expect(resolveAgentAccountKey('factory-droid', {}, HOME)).toBeNull();
	});

	it('splits Copilot accounts on COPILOT_HOME', () => {
		// COPILOT_HOME, not COPILOT_CONFIG_DIR: GitHub's CLI docs are explicit
		// that COPILOT_HOME replaces the whole ~/.copilot path, and no release
		// has ever read COPILOT_CONFIG_DIR.
		expect(getProviderProfileConfig('copilot-cli')).toEqual({
			envVar: 'COPILOT_HOME',
			defaultSubdir: '.copilot',
			sessionsSubdir: 'session-state',
		});
		expect(
			resolveAgentAccountKey('copilot-cli', { COPILOT_HOME: '/Users/me/.copilot-work' }, HOME)
		).toBe('/Users/me/.copilot-work');
		expect(resolveAgentAccountKey('copilot-cli', {}, HOME)).toBe('/Users/me/.copilot');
	});
});

describe('account dir names', () => {
	it('accepts the default dir and its per-account siblings', () => {
		expect(isAccountDirName('.claude', '.claude')).toBe(true);
		expect(isAccountDirName('.claude-work', '.claude')).toBe(true);
		expect(isAccountDirName('.codex-project-acc-1', '.codex')).toBe(true);
	});

	it('rejects an unrelated folder and a backup copy', () => {
		expect(isAccountDirName('.claudette', '.claude')).toBe(false);
		expect(isAccountDirName('.claude-backup', '.claude')).toBe(false);
		expect(isAccountDirName('.codex-old', '.codex')).toBe(false);
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

	// "Default account" alone is the same phrase for every provider, so the
	// short label - the one a card badge prints on its own - names the provider.
	it('names the implicit default account after its provider', () => {
		expect(providerProfileShortLabel('claude-code', '/Users/me/.claude')).toBe(
			'Claude Code default'
		);
		expect(providerProfileShortLabel('codex', '/Users/me/.codex')).toBe('Codex default');
		expect(providerProfileShortLabel('claude-code', '/Users/me/.claude')).not.toBe(
			providerProfileShortLabel('codex', '/Users/me/.codex')
		);
		// The full label already carries the provider, so it is unchanged.
		expect(providerProfileLabel('codex', '/Users/me/.codex')).toBe('Codex - Default account');
		expect(providerProfileLabel('copilot-cli', '/Users/me/.copilot')).toBe(
			'Copilot-CLI - Default account'
		);
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

describe('Grok account profiles', () => {
	it.each(['XAI_API_KEY', 'GROK_CODE_XAI_API_KEY'])(
		'does not turn configured fallback %s into billing or quota-exclusion evidence',
		(key) => {
			for (const value of ['synthetic-personal-same', 'synthetic-work-same']) {
				const env = { GROK_HOME: path.posix.join(HOME, '.grok-work'), [key]: value };
				expect(classifyCredentialKind('grok', env)).toMatchObject({
					kind: 'api-key',
					fallback: true,
				});
				// A configured key (even with a shared suffix) proves neither active billing
				// nor a root login. Null billing must not fabricate either profile.
				expect(resolveAgentBillingCredential('grok', env)).toBeNull();
				expect(resolveAgentProfile('grok', env, HOME)).toBeNull();
				expect(resolveAgentProfile('grok', env, HOME, { id: 'r1' })).toBeNull();
				expect(resolveAgentAccountKey('grok', env, HOME)).toBe(env.GROK_HOME);
			}
		}
	);

	it.each([
		'{"token":"synthetic-personal-token","account":"personal"}',
		'{"token":"synthetic-work-token","account":"work"}',
		'{malformed-synthetic-inline-credentials',
	])('withholds opaque inline credentials %j across roots and hosts', (inline) => {
		for (const root of ['.grok', '.grok-work']) {
			const env = { GROK_HOME: path.posix.join(HOME, root), GROK_AUTH: inline };
			for (const remote of [undefined, { id: 'r1' }, { id: 'r2' }]) {
				// There must be no shared "inline" bucket, secret suffix or hashed ID.
				expect(resolveAgentProfile('grok', env, HOME, remote)).toBeNull();
			}
			expect(resolveAgentBillingCredential('grok', env)).toBeNull();
			expect(resolveAgentAccountKey('grok', env, HOME)).toBe(env.GROK_HOME);
		}
	});

	it.each([
		['GROK_MODELS_BASE_URL', 'https://user:synthetic-password@gateway.example/v1'],
		['GROK_CLI_CHAT_PROXY_BASE_URL', 'https://gateway.example/synthetic-path-secret'],
		['GROK_XAI_API_BASE_URL', 'https://gateway.example?token=synthetic-query-secret'],
		['GROK_DEPLOYMENT_KEY', 'synthetic-deployment-key'],
	])('withholds unobserved billing and account attribution for %s', (key, value) => {
		const env = { GROK_HOME: path.posix.join(HOME, '.grok-work'), [key]: value };
		expect(resolveAgentBillingCredential('grok', env)).toBeNull();
		expect(resolveAgentProfile('grok', env, HOME)).toBeNull();
		expect(resolveAgentProfile('grok', env, HOME, { id: 'r1' })).toBeNull();
		expect(resolveAgentAccountKey('grok', env, HOME)).toBe(env.GROK_HOME);
	});

	it('does not equate a login-capable independent auth file with its state root', () => {
		const env = {
			GROK_HOME: path.posix.join(HOME, '.grok-work'),
			GROK_AUTH_PATH: '/synthetic/other-account/auth.json',
		};
		expect(classifyCredentialKind('grok', env).kind).toBe('oauth');
		expect(resolveAgentBillingCredential('grok', env)).toBeNull();
		expect(resolveAgentAccountKey('grok', env, HOME)).toBe(env.GROK_HOME);
		expect(resolveAgentProfile('grok', env, HOME)).toBeNull();
		expect(resolveAgentProfile('grok', env, HOME, { id: 'r1' })).toBeNull();
	});

	it.each([
		'XAI_API_KEY',
		'GROK_CODE_XAI_API_KEY',
		'GROK_AUTH',
		'GROK_AUTH_PATH',
		'GROK_DEPLOYMENT_KEY',
		'GROK_MODELS_BASE_URL',
		'GROK_CLI_CHAT_PROXY_BASE_URL',
		'GROK_XAI_API_BASE_URL',
	])('allows an explicitly unset %s to retain the owning state-root profile', (key) => {
		const selected = { GROK_HOME: path.posix.join(HOME, '.grok-work') };
		for (const blank of ['', ' \t\n']) {
			for (const remote of [undefined, { id: 'r1', name: 'build' }]) {
				expect(resolveAgentProfile('grok', { ...selected, [key]: blank }, HOME, remote)).toEqual(
					resolveAgentProfile('grok', selected, HOME, remote)
				);
			}
		}
	});

	it.each([
		['GROK_DISABLE_API_KEY_AUTH', 'true'],
		['GROK_FORCE_LOGIN_TEAM_ID', 'synthetic-team'],
	])('retains state-root grouping when fallback API keys are disabled by %s', (key, value) => {
		const selected = { GROK_HOME: path.posix.join(HOME, '.grok-work') };
		const env = { ...selected, XAI_API_KEY: 'synthetic-unused-key', [key]: value };
		expect(resolveAgentBillingCredential('grok', env)).toBeNull();
		for (const remote of [undefined, { id: 'r1' }, { id: 'r2' }]) {
			expect(resolveAgentProfile('grok', env, HOME, remote)).toEqual(
				resolveAgentProfile('grok', selected, HOME, remote)
			);
		}
	});

	it('keeps established non-Grok billing attribution despite unrelated Grok overrides', () => {
		const env = {
			GROK_AUTH: '{malformed-synthetic-inline',
			XAI_API_KEY: 'synthetic-fallback-key',
			ANTHROPIC_API_KEY: 'synthetic-claude-abcd',
			OPENAI_API_KEY: 'synthetic-codex-efgh',
		};
		expect(resolveAgentProfile('claude-code', env, HOME, { id: 'r1' })).toMatchObject({
			key: 'claude-code::api-key:abcd',
			credential: { kind: 'api-key', id: 'api-key:abcd' },
			sshRemoteId: null,
		});
		expect(resolveAgentProfile('codex', env, HOME)).toMatchObject({
			key: 'codex::api-key:efgh',
			credential: { kind: 'api-key', id: 'api-key:efgh' },
		});
	});

	it('attributes two accounts separately and normalizes alternate spellings of one root', () => {
		const personalRoot = path.posix.join(HOME, '.grok');
		const workRoot = path.posix.join(HOME, '.grok-work');
		const personal = resolveAgentProfile('grok', {}, HOME);
		const work = resolveAgentProfile('grok', { GROK_HOME: workRoot }, HOME);

		expect(personal).toMatchObject({
			key: `grok::${personalRoot}`,
			accountKey: personalRoot,
			shortLabel: 'Grok CLI default',
		});
		expect(work).toMatchObject({
			key: `grok::${workRoot}`,
			accountKey: workRoot,
			label: 'Grok CLI - work',
			shortLabel: 'work',
		});
		expect(work?.key).not.toBe(personal?.key);
		expect(resolveAgentProfile('grok', { GROK_HOME: `${workRoot}//` }, HOME)).toEqual(work);
		expect(parseProviderProfileKey(work!.key)).toEqual({ toolType: 'grok', accountKey: workRoot });
	});

	it('keeps the same Grok root distinct on the local host and each SSH host', () => {
		const env = { GROK_HOME: path.posix.join(HOME, '.grok-work') };
		const local = resolveAgentProfile('grok', env, HOME);
		const first = resolveAgentProfile('grok', env, HOME, { id: 'r1', name: 'build' });
		const second = resolveAgentProfile('grok', env, HOME, { id: 'r2', name: 'build' });

		expect(local).toMatchObject({ accountKey: env.GROK_HOME, sshRemoteId: null });
		expect(first).toMatchObject({
			accountKey: env.GROK_HOME,
			sshRemoteId: 'r1',
			label: 'Grok CLI - work @ build',
		});
		expect(second?.sshRemoteId).toBe('r2');
		expect(new Set([local?.key, first?.key, second?.key]).size).toBe(3);
	});

	it.each(['', ' \t\n', '\u00a0'])(
		'treats blank GROK_HOME %j as the default, never an account',
		(blank) => {
			expect(resolveAgentAccountKey('grok', { GROK_HOME: blank }, HOME)).toBe(
				path.posix.join(HOME, '.grok')
			);
			expect(resolveAgentProfile('grok', { GROK_HOME: blank }, HOME)).toEqual(
				resolveAgentProfile('grok', {}, HOME)
			);
			expect(resolveAgentProfile('grok', { GROK_HOME: blank }, undefined)).toBeNull();
		}
	);

	it('waits for the owning host home only when no Grok root was selected', () => {
		const remote = { id: 'r1', name: 'build' };
		expect(resolveAgentProfile('grok', {}, undefined, remote)).toBeNull();
		expect(
			resolveAgentProfile(
				'grok',
				{ GROK_HOME: path.posix.join('~', '.grok-work') },
				undefined,
				remote
			)
		).toMatchObject({ accountKey: path.posix.join('~', '.grok-work'), sshRemoteId: 'r1' });
	});
});
