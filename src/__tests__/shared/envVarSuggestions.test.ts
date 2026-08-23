/**
 * Tests for src/shared/envVarSuggestions.ts
 *
 * The two rules worth pinning: values stay bucketed by variable name, and
 * credential-looking names never contribute a value.
 */

import { describe, it, expect } from 'vitest';
import {
	EMPTY_ENV_VAR_SUGGESTIONS,
	PATH_VALUED_ENV_VAR_KEYS,
	WELL_KNOWN_ENV_VAR_KEYS,
	isSecretValuedEnvKey,
	suggestedValuesFor,
} from '../../shared/envVarSuggestions';

describe('isSecretValuedEnvKey', () => {
	it.each([
		'ANTHROPIC_API_KEY',
		'OPENAI_API_KEY',
		'GITHUB_TOKEN',
		'MY_SECRET',
		'DB_PASSWORD',
		'GOOGLE_CREDENTIALS',
		'anthropic_api_key',
	])('treats %s as secret', (key) => {
		expect(isSecretValuedEnvKey(key)).toBe(true);
	});

	it.each([
		'CLAUDE_CONFIG_DIR',
		'CODEX_HOME',
		'HTTPS_PROXY',
		'ANTHROPIC_BASE_URL',
		// Plural TOKENS names a count, and those values are worth offering.
		'MAX_THINKING_TOKENS',
		'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
	])('treats %s as safe to suggest', (key) => {
		expect(isSecretValuedEnvKey(key)).toBe(false);
	});
});

describe('suggestedValuesFor', () => {
	const suggestions = {
		keys: ['CLAUDE_CONFIG_DIR', 'MAX_THINKING_TOKENS'],
		valuesByKey: {
			CLAUDE_CONFIG_DIR: ['/Users/me/.claude'],
			MAX_THINKING_TOKENS: ['63999'],
		},
	};

	it('returns only the values recorded under that name', () => {
		expect(suggestedValuesFor(suggestions, 'CLAUDE_CONFIG_DIR')).toEqual(['/Users/me/.claude']);
		expect(suggestedValuesFor(suggestions, 'MAX_THINKING_TOKENS')).toEqual(['63999']);
	});

	it('returns an empty list for a name with nothing recorded', () => {
		expect(suggestedValuesFor(suggestions, 'BRAND_NEW_VAR')).toEqual([]);
		expect(suggestedValuesFor(EMPTY_ENV_VAR_SUGGESTIONS, 'CLAUDE_CONFIG_DIR')).toEqual([]);
	});
});

describe('key lists', () => {
	it('offers both account dirs as well-known names', () => {
		expect(WELL_KNOWN_ENV_VAR_KEYS).toContain('CLAUDE_CONFIG_DIR');
		expect(WELL_KNOWN_ENV_VAR_KEYS).toContain('CODEX_HOME');
	});

	it('marks both account dirs as path-valued so their labels abbreviate $HOME', () => {
		expect([...PATH_VALUED_ENV_VAR_KEYS].sort()).toEqual(['CLAUDE_CONFIG_DIR', 'CODEX_HOME']);
	});

	it('never suggests a name whose value it would then refuse to collect twice over', () => {
		// A well-known secret name is fine (the name is the useful part), but a
		// well-known name must never also be path-valued - the two lists mean
		// different things and overlapping them would abbreviate a credential.
		for (const key of PATH_VALUED_ENV_VAR_KEYS) {
			expect(isSecretValuedEnvKey(key)).toBe(false);
		}
	});
});
