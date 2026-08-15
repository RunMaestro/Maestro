/**
 * Tests for shared/providerAuth.ts - credential identity resolution.
 *
 * The point of the module is dedup: many agents, one login. So most of these
 * assert on whether two inputs collapse to ONE `key` or stay apart, rather than
 * on the exact spelling of any single field.
 */

import { describe, it, expect } from 'vitest';
import {
	canonicalizeDirPath,
	fingerprintSecret,
	mergeEffectiveEnv,
	buildLoginRunSessionId,
	extractLoginEmail,
	isLoginRunSessionId,
	resolveCredentialIdentity,
	resolveLoginCommand,
	type CredentialIdentityInput,
	type CredentialKind,
} from '../../shared/providerAuth';

const HOME = '/Users/tester';

function identity(over: Partial<CredentialIdentityInput> = {}) {
	return resolveCredentialIdentity({
		toolType: 'claude-code',
		env: {},
		homeDir: HOME,
		...over,
	});
}

describe('resolveCredentialIdentity - claude-code oauth scoping', () => {
	it('collapses the same config dir written three different ways', () => {
		const trailingSlash = identity({ env: { CLAUDE_CONFIG_DIR: `${HOME}/.claude-work/` } });
		const dotDot = identity({
			env: { CLAUDE_CONFIG_DIR: `${HOME}/.claude-other/../.claude-work` },
		});
		const tilde = identity({ env: { CLAUDE_CONFIG_DIR: '~/.claude-work' } });

		expect(trailingSlash.key).toBe(dotDot.key);
		expect(trailingSlash.key).toBe(tilde.key);
		expect(trailingSlash.configDir).toBe(`${HOME}/.claude-work`);
		expect(trailingSlash.kind).toBe('oauth');
	});

	it('collapses an unset config dir onto the explicit default', () => {
		const implicit = identity({ env: {} });
		const explicit = identity({ env: { CLAUDE_CONFIG_DIR: `${HOME}/.claude` } });

		expect(implicit.key).toBe(explicit.key);
		expect(implicit.configDir).toBe(`${HOME}/.claude`);
	});

	it('treats a blank config dir as unset rather than as the process cwd', () => {
		// resolveConfigDirKey() uses `??` and resolves '' to the cwd; this module
		// deliberately uses the resolveCodexHomeKey() semantics instead.
		expect(identity({ env: { CLAUDE_CONFIG_DIR: '   ' } }).key).toBe(identity({ env: {} }).key);
	});

	it('keeps two different account dirs apart and labels them by basename', () => {
		const primary = identity({ env: { CLAUDE_CONFIG_DIR: `${HOME}/.claude` } });
		const smash = identity({ env: { CLAUDE_CONFIG_DIR: `${HOME}/.claude-smash` } });

		expect(primary.key).not.toBe(smash.key);
		expect(smash.label).toBe('.claude-smash');
	});
});

describe('resolveCredentialIdentity - gateways', () => {
	it('outranks the config dir and the credential vars', () => {
		const gateway = identity({
			env: {
				ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
				ANTHROPIC_AUTH_TOKEN: 'zai-token',
				CLAUDE_CONFIG_DIR: `${HOME}/.claude-smash`,
			},
		});

		expect(gateway.kind).toBe('gateway');
		expect(gateway.scope).toBe('api.z.ai');
		expect(gateway.label).toBe('api.z.ai');
		expect(gateway.configDir).toBeUndefined();
	});

	it('shares one identity per base URL host and splits on a different host', () => {
		const a = identity({ env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' } });
		const b = identity({ env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/v1' } });
		const c = identity({ env: { ANTHROPIC_BASE_URL: 'http://localhost:11434' } });

		expect(a.key).toBe(b.key);
		expect(a.key).not.toBe(c.key);
		expect(c.scope).toBe('localhost:11434');
	});
});

describe('resolveCredentialIdentity - api keys', () => {
	it('resolves ANTHROPIC_AUTH_TOKEN to an api-key identity', () => {
		const apiKey = identity({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-secret' } });

		expect(apiKey.kind).toBe('api-key');
		expect(apiKey.envVarName).toBe('ANTHROPIC_AUTH_TOKEN');
		expect(apiKey.scope).toMatch(/^fp_[0-9a-f]{8}$/);
	});

	it('gives two different tokens two keys and the same token one key', () => {
		const first = identity({ env: { ANTHROPIC_AUTH_TOKEN: 'token-one' } });
		const second = identity({ env: { ANTHROPIC_AUTH_TOKEN: 'token-two' } });
		const firstAgain = identity({ env: { ANTHROPIC_AUTH_TOKEN: 'token-one' } });

		expect(first.key).not.toBe(second.key);
		expect(first.key).toBe(firstAgain.key);
	});

	it('never carries the raw secret into the serialized identity', () => {
		const secret = 'sk-ant-super-secret-value';
		const serialized = JSON.stringify(identity({ env: { ANTHROPIC_AUTH_TOKEN: secret } }));

		expect(serialized).not.toContain(secret);
		expect(serialized).not.toContain('super-secret');
	});

	it('prefers ANTHROPIC_AUTH_TOKEN over ANTHROPIC_API_KEY', () => {
		const both = identity({
			env: { ANTHROPIC_AUTH_TOKEN: 'gateway-token', ANTHROPIC_API_KEY: 'plain-key' },
		});

		expect(both.envVarName).toBe('ANTHROPIC_AUTH_TOKEN');
	});
});

describe('resolveCredentialIdentity - cloud providers', () => {
	it('resolves Bedrock and Vertex flags to cloud-provider', () => {
		const bedrock = identity({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } });
		const vertex = identity({ env: { CLAUDE_CODE_USE_VERTEX: 'true' } });

		expect(bedrock.kind).toBe('cloud-provider');
		expect(bedrock.scope).toBe('bedrock');
		expect(vertex.kind).toBe('cloud-provider');
		expect(vertex.scope).toBe('vertex');
		expect(bedrock.key).not.toBe(vertex.key);
	});

	it('ignores an explicitly disabled flag', () => {
		expect(identity({ env: { CLAUDE_CODE_USE_BEDROCK: '0' } }).kind).toBe('oauth');
		expect(identity({ env: { CLAUDE_CODE_USE_VERTEX: 'false' } }).kind).toBe('oauth');
	});
});

describe('resolveCredentialIdentity - hosts', () => {
	it('keeps the same config dir on two SSH remotes apart', () => {
		const env = { CLAUDE_CONFIG_DIR: `${HOME}/.claude` };
		const remoteA = identity({ env, sshRemoteId: 'build-box' });
		const remoteB = identity({ env, sshRemoteId: 'gpu-box' });

		expect(remoteA.key).not.toBe(remoteB.key);
		expect(remoteA.host).toBe('ssh:build-box');
	});

	it('does not collapse a local and an SSH agent on the same config dir', () => {
		const env = { CLAUDE_CONFIG_DIR: `${HOME}/.claude` };

		expect(identity({ env }).key).not.toBe(identity({ env, sshRemoteId: 'build-box' }).key);
		expect(identity({ env }).host).toBe('local');
	});
});

describe('resolveCredentialIdentity - other providers', () => {
	it('scopes codex to CODEX_HOME and falls back to ~/.codex', () => {
		const explicit = resolveCredentialIdentity({
			toolType: 'codex',
			env: { CODEX_HOME: `${HOME}/.codex/` },
			homeDir: HOME,
		});
		const implicit = resolveCredentialIdentity({ toolType: 'codex', env: {}, homeDir: HOME });

		expect(explicit.key).toBe(implicit.key);
		expect(implicit.kind).toBe('oauth');
		expect(implicit.configDir).toBe(`${HOME}/.codex`);
	});

	it('resolves OPENAI_API_KEY to an api-key codex identity', () => {
		const apiKey = resolveCredentialIdentity({
			toolType: 'codex',
			env: { OPENAI_API_KEY: 'sk-openai' },
			homeDir: HOME,
		});

		expect(apiKey.kind).toBe('api-key');
		expect(apiKey.envVarName).toBe('OPENAI_API_KEY');
	});

	it('honors the copilot token precedence order', () => {
		const all = resolveCredentialIdentity({
			toolType: 'copilot-cli',
			env: { GITHUB_TOKEN: 'c', GH_TOKEN: 'b', COPILOT_GITHUB_TOKEN: 'a' },
			homeDir: HOME,
		});
		const fallback = resolveCredentialIdentity({
			toolType: 'copilot-cli',
			env: { GITHUB_TOKEN: 'c' },
			homeDir: HOME,
		});
		const loggedIn = resolveCredentialIdentity({
			toolType: 'copilot-cli',
			env: {},
			homeDir: HOME,
		});

		expect(all.envVarName).toBe('COPILOT_GITHUB_TOKEN');
		expect(fallback.envVarName).toBe('GITHUB_TOKEN');
		expect(loggedIn.kind).toBe('oauth');
		expect(loggedIn.configDir).toBe(`${HOME}/.copilot`);
		expect(loggedIn.envVarName).toBeUndefined();
	});

	it('scopes opencode to its XDG credential dir and honors the overrides', () => {
		const implicit = resolveCredentialIdentity({ toolType: 'opencode', env: {}, homeDir: HOME });
		const xdg = resolveCredentialIdentity({
			toolType: 'opencode',
			env: { XDG_DATA_HOME: `${HOME}/.local/share` },
			homeDir: HOME,
		});
		const explicit = resolveCredentialIdentity({
			toolType: 'opencode',
			env: { OPENCODE_CONFIG_DIR: `${HOME}/.opencode-alt` },
			homeDir: HOME,
		});

		expect(implicit.configDir).toBe(`${HOME}/.local/share/opencode`);
		expect(xdg.key).toBe(implicit.key);
		expect(explicit.key).not.toBe(implicit.key);
	});

	it('treats any provider API key as an opencode api-key identity, order-independently', () => {
		const forward = resolveCredentialIdentity({
			toolType: 'opencode',
			env: { GROQ_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' },
			homeDir: HOME,
		});
		const reversed = resolveCredentialIdentity({
			toolType: 'opencode',
			env: { ANTHROPIC_API_KEY: 'a', GROQ_API_KEY: 'g' },
			homeDir: HOME,
		});
		const single = resolveCredentialIdentity({
			toolType: 'opencode',
			env: { GROQ_API_KEY: 'g' },
			homeDir: HOME,
		});

		expect(forward.kind).toBe('api-key');
		expect(forward.key).toBe(reversed.key);
		expect(forward.key).not.toBe(single.key);
		// OPENCODE_CONFIG_CONTENT is set on every opencode spawn and must not read
		// as a credential.
		expect(
			resolveCredentialIdentity({
				toolType: 'opencode',
				env: { OPENCODE_CONFIG_CONTENT: '{"permission":{"*":"allow"}}' },
				homeDir: HOME,
			}).kind
		).toBe('oauth');
	});

	it('resolves factory-droid and unrecognized agents to unknown', () => {
		const droid = resolveCredentialIdentity({
			toolType: 'factory-droid',
			env: { FACTORY_API_KEY: 'secret' },
			homeDir: HOME,
		});
		const stranger = resolveCredentialIdentity({
			toolType: 'some-future-agent',
			env: {},
			homeDir: HOME,
		});

		expect(droid.kind).toBe('unknown');
		expect(droid.scope).toBe('default');
		expect(droid.label).toBe('Factory Droid');
		expect(stranger.kind).toBe('unknown');
		expect(stranger.label).toBe('some-future-agent');
	});
});

describe('resolveLoginCommand', () => {
	function oauthIdentity(toolType: string) {
		return resolveCredentialIdentity({ toolType, env: {}, homeDir: HOME });
	}

	it('builds the claude login command and only adds the flags it was asked for', () => {
		const plain = resolveLoginCommand(oauthIdentity('claude-code'));
		const everything = resolveLoginCommand(oauthIdentity('claude-code'), {
			preferConsole: true,
			sso: true,
			email: 'user@example.com',
		});

		expect(plain).toEqual({ command: 'claude', args: ['auth', 'login'] });
		expect(everything?.args).toEqual([
			'auth',
			'login',
			'--console',
			'--sso',
			'--email',
			'user@example.com',
		]);
	});

	it('ignores a blank email rather than passing an empty --email value', () => {
		expect(resolveLoginCommand(oauthIdentity('claude-code'), { email: '   ' })?.args).toEqual([
			'auth',
			'login',
		]);
		expect(resolveLoginCommand(oauthIdentity('claude-code'), { email: ' a@b.co ' })?.args).toEqual([
			'auth',
			'login',
			'--email',
			'a@b.co',
		]);
	});

	it('covers the other logged-in providers, with a note where the flow surprises the user', () => {
		const codex = resolveLoginCommand(oauthIdentity('codex'));
		const copilot = resolveLoginCommand(oauthIdentity('copilot-cli'));
		const opencode = resolveLoginCommand(oauthIdentity('opencode'));

		expect(codex).toEqual({ command: 'codex', args: ['login'] });
		expect(copilot?.args).toEqual(['login']);
		expect(copilot?.note).toMatch(/device[- ]code/i);
		expect(opencode?.args).toEqual(['auth', 'login']);
		expect(opencode?.note).toMatch(/provider/i);
	});

	it('ignores the claude-only options for the other providers', () => {
		const codex = resolveLoginCommand(oauthIdentity('codex'), {
			preferConsole: true,
			sso: true,
			email: 'user@example.com',
		});

		expect(codex?.args).toEqual(['login']);
	});

	it('returns null for providers with no verified login surface', () => {
		expect(resolveLoginCommand(oauthIdentity('factory-droid'))).toBeNull();
		expect(resolveLoginCommand(oauthIdentity('some-future-agent'))).toBeNull();
		// A provider that DOES have a login command still gets null once its
		// identity says the credential is not an interactive login.
		expect(resolveLoginCommand({ ...oauthIdentity('claude-code'), kind: 'api-key' })).toBeNull();
	});

	it('returns null for every non-oauth kind', () => {
		const kinds: CredentialKind[] = ['api-key', 'gateway', 'cloud-provider', 'unknown'];
		const base = oauthIdentity('claude-code');

		for (const kind of kinds) {
			expect(resolveLoginCommand({ ...base, kind })).toBeNull();
		}
		// Guards the loop above: the one kind left out must NOT return null.
		expect(resolveLoginCommand(base)).not.toBeNull();
	});
});

describe('mergeEffectiveEnv', () => {
	it('lets session-level win and keeps agent-only keys', () => {
		const merged = mergeEffectiveEnv(
			{ CLAUDE_CONFIG_DIR: `${HOME}/.claude`, ANTHROPIC_MODEL: 'agent-model' },
			{ CLAUDE_CONFIG_DIR: `${HOME}/.claude-smash` }
		);

		expect(merged.CLAUDE_CONFIG_DIR).toBe(`${HOME}/.claude-smash`);
		expect(merged.ANTHROPIC_MODEL).toBe('agent-model');
	});

	it('handles either side being undefined', () => {
		expect(mergeEffectiveEnv(undefined, undefined)).toEqual({});
		expect(mergeEffectiveEnv({ A: '1' }, undefined)).toEqual({ A: '1' });
		expect(mergeEffectiveEnv(undefined, { A: '1' })).toEqual({ A: '1' });
	});

	it('drives the resolver: a session-level config dir overrides the agent default', () => {
		const env = mergeEffectiveEnv(
			{ CLAUDE_CONFIG_DIR: `${HOME}/.claude` },
			{ CLAUDE_CONFIG_DIR: `${HOME}/.claude-smash` }
		);

		expect(identity({ env }).configDir).toBe(`${HOME}/.claude-smash`);
	});
});

describe('fingerprintSecret', () => {
	it('matches the SHA-256 test vectors', () => {
		// e3b0c442... (empty) and ba7816bf... ("abc") from FIPS 180-4.
		expect(fingerprintSecret('')).toBe('fp_e3b0c442');
		expect(fingerprintSecret('abc')).toBe('fp_ba7816bf');
	});

	it('is stable, short, and non-reversible', () => {
		const secret = 'sk-ant-api03-a-fairly-long-token-value-with-unicode-\u00e9\u4e2d';

		expect(fingerprintSecret(secret)).toBe(fingerprintSecret(secret));
		expect(fingerprintSecret(secret)).toMatch(/^fp_[0-9a-f]{8}$/);
		expect(fingerprintSecret(secret)).not.toContain(secret.slice(0, 8));
	});

	it('separates values that differ by one character', () => {
		expect(fingerprintSecret('token-a')).not.toBe(fingerprintSecret('token-b'));
	});

	it('hashes inputs that straddle the SHA-256 block padding boundary', () => {
		const lengths = [55, 56, 63, 64, 65, 119, 120];
		const digests = lengths.map((n) => fingerprintSecret('x'.repeat(n)));

		expect(new Set(digests).size).toBe(lengths.length);
		expect(digests.every((d) => /^fp_[0-9a-f]{8}$/.test(d))).toBe(true);
	});
});

describe('canonicalizeDirPath', () => {
	it('normalizes tildes, dots, and trailing separators', () => {
		expect(canonicalizeDirPath('~/.claude/', HOME)).toBe(`${HOME}/.claude`);
		expect(canonicalizeDirPath('~', HOME)).toBe(HOME);
		expect(canonicalizeDirPath(`${HOME}/./a/../.claude//`, HOME)).toBe(`${HOME}/.claude`);
	});

	it('resolves a relative path against the home dir, not the process cwd', () => {
		expect(canonicalizeDirPath('.claude-work', HOME)).toBe(`${HOME}/.claude-work`);
	});

	it('normalizes Windows paths without folding case of the path itself', () => {
		expect(canonicalizeDirPath('c:\\Users\\Tester\\.claude\\', HOME)).toBe(
			'C:/Users/Tester/.claude'
		);
	});

	it('returns empty for a blank input so callers can fall back to their default', () => {
		expect(canonicalizeDirPath('', HOME)).toBe('');
		expect(canonicalizeDirPath('   ', HOME)).toBe('');
	});
});

describe('buildLoginRunSessionId / isLoginRunSessionId', () => {
	it('produces an id that no agent listener claims', () => {
		const id = buildLoginRunSessionId(`claude-code::oauth::${HOME}/.claude::local`, 'run1');
		expect(id.startsWith('auth-login-')).toBe(true);
		expect(id.includes('-ai-')).toBe(false);
		expect(id.includes('-batch-')).toBe(false);
		expect(id.endsWith('-terminal')).toBe(false);
		expect(isLoginRunSessionId(id)).toBe(true);
	});

	it('gives two runs of the same account two ids', () => {
		const key = `claude-code::oauth::${HOME}/.claude::local`;
		expect(buildLoginRunSessionId(key, 'run1')).not.toBe(buildLoginRunSessionId(key, 'run2'));
	});

	it('gives two accounts two ids', () => {
		expect(buildLoginRunSessionId('a::oauth::/x::local', 'r')).not.toBe(
			buildLoginRunSessionId('a::oauth::/y::local', 'r')
		);
	});

	it('defuses a config dir that would otherwise forge a reserved segment', () => {
		// `~/terminal/.claude` is a legal account directory, and the naive slug of
		// it contains `-terminal-`, which the terminal-tab checks match on.
		const id = buildLoginRunSessionId(`claude-code::oauth::${HOME}/terminal/.claude::local`, 'r');
		expect(id.includes('-terminal-')).toBe(false);
		expect(isLoginRunSessionId(id)).toBe(true);
	});

	it('rejects ids it did not mint', () => {
		expect(isLoginRunSessionId('session-42-ai-tab-7')).toBe(false);
		expect(isLoginRunSessionId('session-42-terminal')).toBe(false);
		expect(isLoginRunSessionId('auth-login-')).toBe(false);
		expect(isLoginRunSessionId('auth-login-x-terminal-1')).toBe(false);
		expect(isLoginRunSessionId('auth-login-x-batch-1')).toBe(false);
	});
});

describe('extractLoginEmail', () => {
	it('pulls the address out of a claude probe detail', () => {
		expect(
			extractLoginEmail({
				identity: identity(),
				status: 'authenticated',
				detail: 'ada@example.com \u00b7 Acme \u00b7 max',
				checkedAt: 0,
				source: 'probe',
			})
		).toBe('ada@example.com');
	});

	it('prefers nothing over a guess', () => {
		expect(
			extractLoginEmail({
				identity: identity(),
				status: 'logged-out',
				detail: 'claude auth status reports no active login',
				checkedAt: 0,
				source: 'probe',
			})
		).toBeUndefined();
		expect(extractLoginEmail(null)).toBeUndefined();
		expect(extractLoginEmail(undefined)).toBeUndefined();
	});
});
