import { describe, it, expect } from 'vitest';
import {
	BLANK_ENV_VAR_KEY,
	COMMON_ENV_VAR_SUGGESTIONS,
	PROVIDER_ENV_VAR_SUGGESTIONS,
	rememberableEnvVarKeys,
	suggestEnvVarKeys,
	withBlankEnvVarRow,
	type KnownEnvVarKeys,
} from '../../shared/envVarCatalog';

const known: KnownEnvVarKeys = {
	byProvider: {
		'claude-code': ['ANTHROPIC_MODEL', 'MY_TEAM_TOKEN'],
		codex: ['CODEX_ONLY_VAR'],
	},
	global: ['HTTPS_PROXY', 'COMPANY_CA_PATH'],
};

describe('suggestEnvVarKeys', () => {
	it("leads with the provider's own catalog", () => {
		const keys = suggestEnvVarKeys({ toolType: 'claude-code' }).map((entry) => entry.key);

		expect(keys[0]).toBe('CLAUDE_CONFIG_DIR');
		expect(keys).toContain('ANTHROPIC_BASE_URL');
		expect(keys).not.toContain('CODEX_HOME');
	});

	it('offers only verified Grok variables before common suggestions', () => {
		const suggestions = suggestEnvVarKeys({ toolType: 'grok' });
		const providerKeys = suggestions
			.filter((entry) => entry.origin === 'provider')
			.map((entry) => entry.key);

		expect(providerKeys).toEqual(['GROK_HOME', 'GROK_AUTH_PATH', 'GROK_AUTH', 'XAI_API_KEY']);
		expect(suggestions[0].key).toBe('GROK_HOME');
		expect(suggestions.find((entry) => entry.key === 'HTTPS_PROXY')?.origin).toBe('common');
		expect(suggestions.map((entry) => entry.key)).not.toContain('CODEX_HOME');
	});

	it('filters Grok auth suggestions without duplicating catalog or global names', () => {
		const suggestions = suggestEnvVarKeys({
			toolType: 'grok',
			query: ' auth ',
			exclude: ['GROK_AUTH'],
			known: {
				byProvider: {
					grok: ['GROK_AUTH_PATH', 'TEAM_AUTH'],
					codex: ['CODEX_AUTH'],
				},
				global: ['GROK_AUTH_PATH', 'TEAM_AUTH'],
			},
		});

		expect(suggestions.map((entry) => [entry.key, entry.origin])).toEqual([
			['GROK_AUTH_PATH', 'provider'],
			['TEAM_AUTH', 'remembered'],
		]);
	});

	it('offers names the user set before, and marks them as remembered', () => {
		const suggestions = suggestEnvVarKeys({ toolType: 'claude-code', known });
		const remembered = suggestions.find((entry) => entry.key === 'MY_TEAM_TOKEN');

		expect(remembered?.origin).toBe('remembered');
		// Global names apply to every provider, so they come along.
		expect(suggestions.map((entry) => entry.key)).toContain('COMPANY_CA_PATH');
		// Another provider's name is noise here.
		expect(suggestions.map((entry) => entry.key)).not.toContain('CODEX_ONLY_VAR');
	});

	it('keeps a catalog name catalogued even when the user has also set it', () => {
		const suggestions = suggestEnvVarKeys({ toolType: 'claude-code', known });
		const matches = suggestions.filter((entry) => entry.key === 'ANTHROPIC_MODEL');

		expect(matches).toHaveLength(1);
		expect(matches[0].origin).toBe('provider');
	});

	it('drops names already used by another row', () => {
		const keys = suggestEnvVarKeys({
			toolType: 'claude-code',
			exclude: ['CLAUDE_CONFIG_DIR'],
		}).map((entry) => entry.key);

		expect(keys).not.toContain('CLAUDE_CONFIG_DIR');
	});

	it('ranks a prefix match above a match in the middle of a name', () => {
		const keys = suggestEnvVarKeys({ toolType: 'claude-code', query: 'claude' }).map(
			(entry) => entry.key
		);

		expect(keys[0]).toBe('CLAUDE_CONFIG_DIR');
		expect(keys).toContain('CLAUDE_CODE_USE_BEDROCK');
		// Matching is case-insensitive but the suggestion keeps its own spelling.
		expect(keys.every((key) => key === key.toUpperCase())).toBe(true);
	});

	it('offers every provider catalog when no provider is named', () => {
		const keys = suggestEnvVarKeys({ query: 'HOME', limit: 50 }).map((entry) => entry.key);

		expect(keys).toContain('CODEX_HOME');
		expect(keys).toContain('COPILOT_HOME');
		expect(keys).toContain('GROK_HOME');
	});

	it('falls back to the common set for a provider with no catalog', () => {
		const suggestions = suggestEnvVarKeys({ toolType: 'terminal' });

		expect(suggestions.map((entry) => entry.key)).toEqual(
			COMMON_ENV_VAR_SUGGESTIONS.map((entry) => entry.key)
		);
		expect(suggestions.every((entry) => entry.origin === 'common')).toBe(true);
	});

	it('honors the limit', () => {
		expect(suggestEnvVarKeys({ toolType: 'claude-code', known, limit: 3 })).toHaveLength(3);
	});
});

describe('PROVIDER_ENV_VAR_SUGGESTIONS', () => {
	it('names every entry in env-var form and describes it', () => {
		for (const entries of Object.values(PROVIDER_ENV_VAR_SUGGESTIONS)) {
			for (const entry of entries) {
				expect(entry.key).toMatch(/^[A-Z][A-Z0-9_]*$/);
				expect(entry.description.length).toBeGreaterThan(0);
			}
		}
	});
});

describe('withBlankEnvVarRow', () => {
	it('adds an UNNAMED row, not a placeholder name', () => {
		expect(withBlankEnvVarRow({ A: '1' })).toEqual({ A: '1', [BLANK_ENV_VAR_KEY]: '' });
	});

	it('cannot produce two unnamed rows', () => {
		// The record is keyed by name, so pressing Add twice is idempotent.
		expect(withBlankEnvVarRow(withBlankEnvVarRow({ A: '1' }))).toEqual({
			A: '1',
			[BLANK_ENV_VAR_KEY]: '',
		});
	});

	it('preserves explicit Grok unsets when adding a row without remembering blank values', () => {
		const original = { GROK_HOME: ' \t', GROK_AUTH_PATH: '' };
		const updated = withBlankEnvVarRow(original);

		expect(updated).toEqual({ GROK_HOME: ' \t', GROK_AUTH_PATH: '', [BLANK_ENV_VAR_KEY]: '' });
		expect(original).toEqual({ GROK_HOME: ' \t', GROK_AUTH_PATH: '' });
		expect(rememberableEnvVarKeys(updated)).toEqual([]);
	});

	it("leaves the caller's record untouched", () => {
		const original = { A: '1' };
		withBlankEnvVarRow(original);
		expect(original).toEqual({ A: '1' });
	});
});

describe('rememberableEnvVarKeys', () => {
	it('keeps names that carry a value', () => {
		expect(rememberableEnvVarKeys({ A: '1', B: 'x' })).toEqual(['A', 'B']);
	});

	it('drops blank and non-string values, which are unfinished rows', () => {
		expect(rememberableEnvVarKeys({ A: '', B: '   ', C: 42 as unknown as string })).toEqual([]);
	});

	it('drops the unnamed row even once it carries a value', () => {
		expect(
			rememberableEnvVarKeys({ [BLANK_ENV_VAR_KEY]: 'typed the value first', A: '1' })
		).toEqual(['A']);
	});

	it('tolerates a missing record', () => {
		expect(rememberableEnvVarKeys(undefined)).toEqual([]);
		expect(rememberableEnvVarKeys(null)).toEqual([]);
	});
});
