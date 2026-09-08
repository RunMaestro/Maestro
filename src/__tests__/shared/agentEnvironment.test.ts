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
	stripBlankEnvVars,
} from '../../shared/agentEnvironment';

describe('resolveAgentEnvironment', () => {
	it('returns an empty list when no layer sets anything', () => {
		expect(resolveAgentEnvironment({})).toEqual([]);
	});

	it('applies precedence: session over provider over global', () => {
		const resolved = resolveAgentEnvironment({
			global: { MODEL: 'global' },
			agent: { MODEL: 'provider' },
			session: { MODEL: 'session' },
		});

		expect(resolved).toEqual([
			{ key: 'MODEL', value: 'session', source: 'session', shadowedBy: ['global', 'agent'] },
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

	it('merges keys from different layers rather than replacing the map', () => {
		const resolved = resolveAgentEnvironment({
			global: { A: '1' },
			agent: { B: '2' },
			session: { C: '3' },
		});
		expect(resolved.map((e) => e.key)).toEqual(['A', 'B', 'C']);
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
		const labels = (['global', 'agent', 'session'] as const).map(envSourceLabel);
		expect(new Set(labels).size).toBe(3);
		expect(labels).toEqual(['Global', 'Provider', 'This agent']);
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
