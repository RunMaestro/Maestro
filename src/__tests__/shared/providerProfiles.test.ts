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
	getProviderProfileConfig,
	makeAccountKeyHelpers,
	parseProviderProfileKey,
	providerProfileKey,
	providerProfileLabel,
	providerProfileShortLabel,
	resolveAgentAccountKey,
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

describe('makeAccountKeyHelpers', () => {
	it('derives short names the same way the quota panels always have', () => {
		const { deriveShortName, deriveDisplayName } = makeAccountKeyHelpers('.claude');
		expect(deriveShortName('/Users/me/.claude')).toBe('default');
		expect(deriveShortName('/Users/me/.claude-gmail')).toBe('gmail');
		expect(deriveShortName(undefined)).toBe('default');
		expect(deriveDisplayName('/Users/me/.claude')).toBe('Default account');
	});
});
