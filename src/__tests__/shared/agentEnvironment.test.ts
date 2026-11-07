/**
 * Tests for shared/agentEnvironment - the three-layer env merge and the
 * secret masking that goes with displaying it.
 */

import { describe, it, expect } from 'vitest';
import {
	envSourceLabel,
	isSecretEnvKey,
	maskEnvValue,
	resolveAgentEnvironment,
	isBlankEnvValue,
	isBlankEnvKey,
	isEnvVarSet,
	isValidEnvVarName,
	stripBlankEnvVars,
	applyEnvVarMerges,
} from '../../shared/agentEnvironment';

describe('resolveAgentEnvironment', () => {
	it('returns an empty list when no layer sets anything', () => {
		expect(resolveAgentEnvironment({})).toEqual([]);
	});

	it('applies precedence: session over global, with the provider layer replaced', () => {
		const resolved = resolveAgentEnvironment({
			global: { MODEL: 'global' },
			agent: { MODEL: 'provider' },
			session: { MODEL: 'session' },
		});

		expect(resolved).toEqual([
			{ key: 'MODEL', value: 'session', source: 'session', shadowedBy: ['global'] },
		]);
	});

	it('lets a lower layer win when higher layers are silent', () => {
		const resolved = resolveAgentEnvironment({ global: { A: '1' }, session: {} });
		expect(resolved).toEqual([{ key: 'A', value: '1', source: 'global', shadowedBy: [] }]);
	});

	it('reports the provider layer when only global is overridden', () => {
		const [entry] = resolveAgentEnvironment({
			global: { URL: 'a' },
			agent: { URL: 'b' },
		});
		expect(entry).toMatchObject({ value: 'b', source: 'agent', shadowedBy: ['global'] });
	});

	// The spawner hands a process the agent's own vars OR the provider's, never
	// both, so a provider key the agent does not set must not appear.
	it('drops the provider layer once the agent has a vars record, even an empty one', () => {
		const resolved = resolveAgentEnvironment({
			global: { A: '1' },
			agent: { B: '2' },
			session: { C: '3' },
		});
		expect(resolved.map((e) => e.key)).toEqual(['A', 'C']);
		expect(resolveAgentEnvironment({ agent: { B: '2' }, session: {} })).toEqual([]);
	});

	it('layers the provider set over global when the agent has no vars record', () => {
		const resolved = resolveAgentEnvironment({ global: { A: '1' }, agent: { B: '2' } });
		expect(resolved.map((e) => e.key)).toEqual(['A', 'B']);
	});

	// `FOO=` is a real setting that blanks a lower layer, not an absent one.
	it('keeps an empty-string override', () => {
		const [entry] = resolveAgentEnvironment({
			global: { TOKEN: 'set' },
			session: { TOKEN: '' },
		});
		expect(entry).toMatchObject({ value: '', source: 'session', shadowedBy: ['global'] });
	});

	it('sorts by key so the list is stable between renders', () => {
		const resolved = resolveAgentEnvironment({ global: { Z: '1', A: '2', M: '3' } });
		expect(resolved.map((e) => e.key)).toEqual(['A', 'M', 'Z']);
	});
});

describe('isSecretEnvKey', () => {
	it('flags credential-shaped keys', () => {
		for (const key of [
			'ANTHROPIC_API_KEY',
			'OPENAI_TOKEN',
			'MY_SECRET',
			'DB_PASSWORD',
			'AWS_CREDENTIAL_FILE',
			'CLAUDE_CODE_OAUTH_TOKEN',
		]) {
			expect(isSecretEnvKey(key), key).toBe(true);
		}
	});

	it('leaves configuration keys visible', () => {
		for (const key of ['ANTHROPIC_BASE_URL', 'NODE_ENV', 'PATH', 'MAESTRO_PROFILE', 'HTTP_PROXY']) {
			expect(isSecretEnvKey(key), key).toBe(false);
		}
	});

	// These match the secret pattern but name a mode or a path. Masking them
	// would hide exactly what the user opened this view to check.
	it('exempts keys that describe a credential rather than being one', () => {
		expect(isSecretEnvKey('CLAUDE_AUTH_TYPE')).toBe(false);
		expect(isSecretEnvKey('SSH_KEY_PATH')).toBe(false);
		expect(isSecretEnvKey('MY_TOKEN_PATH')).toBe(false);
		// ...but the token itself is still a secret.
		expect(isSecretEnvKey('MY_AUTH_TOKEN')).toBe(true);
	});

	it('is case-insensitive', () => {
		expect(isSecretEnvKey('anthropic_api_key')).toBe(true);
	});
});

describe('maskEnvValue', () => {
	it('keeps a distinguishing tail on a long value', () => {
		const masked = maskEnvValue('sk-ant-api03-abcdefghijklmnop');
		expect(masked.endsWith('mnop')).toBe(true);
		expect(masked).not.toContain('sk-ant');
	});

	it('masks a short value entirely', () => {
		expect(maskEnvValue('abc123')).toBe('••••••');
		expect(maskEnvValue('abc123')).not.toContain('a');
	});

	it('never renders as blank for an empty value', () => {
		expect(maskEnvValue('')).toBe('•');
	});
});

describe('envSourceLabel', () => {
	it('names each layer distinctly', () => {
		const labels = (['global', 'agent', 'session', 'gateway'] as const).map(envSourceLabel);
		expect(new Set(labels).size).toBe(4);
		expect(labels).toEqual(['Global', 'Provider', 'This agent', 'Local Models gateway']);
	});
});

describe('resolveAgentEnvironment: the gateway layer', () => {
	const gateway = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' };

	it('reports the gateway as the source, over a global value it shadows', () => {
		const resolved = resolveAgentEnvironment({
			global: { ANTHROPIC_BASE_URL: 'https://global.example.com' },
			session: { OTHER: 'x' },
			gateway,
		});

		expect(resolved.find((entry) => entry.key === 'ANTHROPIC_BASE_URL')).toEqual({
			key: 'ANTHROPIC_BASE_URL',
			value: 'http://127.0.0.1:8787',
			source: 'gateway',
			shadowedBy: ['global'],
		});
	});

	it("leaves the variable to the agent's own value when it sets one", () => {
		const resolved = resolveAgentEnvironment({
			session: { ANTHROPIC_BASE_URL: 'https://mine.example.com' },
			gateway,
		});

		expect(resolved).toEqual([
			{
				key: 'ANTHROPIC_BASE_URL',
				value: 'https://mine.example.com',
				source: 'session',
				shadowedBy: [],
			},
		]);
	});

	it('yields to the provider-level value only while the agent has no vars of its own', () => {
		const agent = { ANTHROPIC_BASE_URL: 'https://provider.example.com' };

		expect(resolveAgentEnvironment({ agent, gateway })[0].source).toBe('agent');
		// An agent record, even an empty one, replaces the provider-level set.
		expect(resolveAgentEnvironment({ agent, session: {}, gateway })[0].source).toBe('gateway');
	});

	it('applies over a blank value, which is an absence and not a choice', () => {
		const resolved = resolveAgentEnvironment({ session: { ANTHROPIC_BASE_URL: ' ' }, gateway });

		expect(resolved[0]).toMatchObject({ source: 'gateway', shadowedBy: ['session'] });
	});
});

describe('isEnvVarSet', () => {
	it('is true only for a real value', () => {
		expect(isEnvVarSet({ A: 'x' }, 'A')).toBe(true);
		expect(isEnvVarSet({ A: '  ' }, 'A')).toBe(false);
		expect(isEnvVarSet({ A: 'x' }, 'B')).toBe(false);
		expect(isEnvVarSet(undefined, 'A')).toBe(false);
	});
});

describe('stripBlankEnvVars', () => {
	it('drops blank and whitespace-only values, keeps everything else', () => {
		expect(
			stripBlankEnvVars({
				CLAUDE_CONFIG_DIR: '',
				PADDED: '   ',
				KEPT: 'value',
				KEPT_WITH_SPACE: ' value ',
			})
		).toEqual({ KEPT: 'value', KEPT_WITH_SPACE: ' value ' });
	});

	it('returns an empty object for undefined input', () => {
		expect(stripBlankEnvVars(undefined)).toEqual({});
	});

	it('drops an UNNAMED row even when it carries a value', () => {
		// A row the user gave a value to before naming it. `env[''] = 'x'` is a
		// variable no child can read, and Windows rejects the empty name outright.
		expect(stripBlankEnvVars({ '': 'orphan', KEPT: 'value' })).toEqual({ KEPT: 'value' });
	});

	it('does not mutate its input', () => {
		const input = { A: '', B: 'b' };
		stripBlankEnvVars(input);
		expect(input).toEqual({ A: '', B: 'b' });
	});

	it('classifies blanks the same way isBlankEnvValue does', () => {
		expect(isBlankEnvValue('')).toBe(true);
		expect(isBlankEnvValue('\t ')).toBe(true);
		expect(isBlankEnvValue('0')).toBe(false);
	});
});

describe('resolveAgentEnvironment vs stripBlankEnvVars', () => {
	it('keeps blanks in the reported config even though the spawner drops them', () => {
		// The two answer different questions: what did the user CONFIGURE (shown in
		// the env viewer) versus what gets EXPORTED to the child.
		const resolved = resolveAgentEnvironment({ session: { CLAUDE_CONFIG_DIR: '' } });
		expect(resolved).toHaveLength(1);
		expect(resolved[0].value).toBe('');
		expect(stripBlankEnvVars({ CLAUDE_CONFIG_DIR: '' })).toEqual({});
	});
});

describe('isBlankEnvKey', () => {
	it('treats an empty or whitespace-only name as unnamed', () => {
		expect(isBlankEnvKey('')).toBe(true);
		expect(isBlankEnvKey('   ')).toBe(true);
	});

	it('treats any real name as named', () => {
		expect(isBlankEnvKey('A')).toBe(false);
		expect(isBlankEnvKey('CLAUDE_CONFIG_DIR')).toBe(false);
	});
});

describe('isValidEnvVarName', () => {
	it('accepts portable names', () => {
		expect(isValidEnvVarName('OPENAI_API_KEY')).toBe(true);
		expect(isValidEnvVarName('_private')).toBe(true);
		expect(isValidEnvVarName('a1')).toBe(true);
	});

	it('rejects names a shell cannot export', () => {
		expect(isValidEnvVarName('')).toBe(false);
		expect(isValidEnvVarName('1KEY')).toBe(false);
		expect(isValidEnvVarName('MY-KEY')).toBe(false);
		expect(isValidEnvVarName('MY KEY')).toBe(false);
		expect(isValidEnvVarName('$KEY')).toBe(false);
	});
});

describe('applyEnvVarMerges', () => {
	const merges = { DOC: (current: string | undefined) => `${current ?? 'none'}+added` };

	it('builds each variable from the value the record carries', () => {
		const env: Record<string, string | undefined> = { DOC: 'mine', OTHER: 'kept' };

		applyEnvVarMerges(env, merges);

		expect(env).toEqual({ DOC: 'mine+added', OTHER: 'kept' });
	});

	it('builds on the fallback when the record does not set the variable, or sets it blank', () => {
		for (const own of [undefined, '', '  ']) {
			const env: Record<string, string | undefined> = { DOC: own };

			applyEnvVarMerges(env, merges, { DOC: 'beneath' });

			expect(env.DOC).toBe('beneath+added');
		}
	});

	it('hands the merge nothing when no layer has a value', () => {
		const env: Record<string, string | undefined> = {};

		applyEnvVarMerges(env, merges, { DOC: '' });

		expect(env.DOC).toBe('none+added');
	});

	it('leaves the record alone when there is nothing to merge', () => {
		const env = { DOC: 'mine' };

		applyEnvVarMerges(env, undefined);

		expect(env).toEqual({ DOC: 'mine' });
	});
});
