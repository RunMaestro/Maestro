/**
 * @file billing-mode.test.ts
 * @description Tests for src/maestro-p/billing-mode.ts - reading claude's
 * billing mode off the TUI startup header and explaining it.
 */

import { describe, expect, it } from 'vitest';

import { diagnoseApiUsageBilling, showsApiUsageBilling } from '../../maestro-p/billing-mode';
import { getErrorPatterns, matchErrorPattern } from '../../shared/agentErrorPatterns';

describe('showsApiUsageBilling', () => {
	it.each([
		'Fable 5.1 · API Usage Billing',
		// Cursor-addressed paints lose their spaces once ANSI is stripped.
		'Fable5.1·APIUsageBilling',
		'│  Opus 4.8 · api usage billing  │',
	])('detects the header: %s', (text) => {
		expect(showsApiUsageBilling(text)).toBe(true);
	});

	it.each([
		'Fable 5.1 · Claude Max',
		'Fable 5.1 · Claude Pro',
		'',
		// Prose that names the mode without the header's separator.
		'Earlier this account was on API Usage Billing.',
	])('ignores: %s', (text) => {
		expect(showsApiUsageBilling(text)).toBe(false);
	});
});

describe('diagnoseApiUsageBilling', () => {
	it('reports a missed login when the environment names no API credential', () => {
		const diagnosis = diagnoseApiUsageBilling(
			{ CLAUDE_CONFIG_DIR: '/cfg', HOME: '/Users/alice', UNSET: undefined },
			'/cfg'
		);
		expect(diagnosis.expected).toBe(false);
		expect(diagnosis.reason).toContain('/cfg');
		expect(diagnosis.reason).toContain('USER');
	});

	it.each([
		['ANTHROPIC_API_KEY', 'sk-test'],
		['ANTHROPIC_AUTH_TOKEN', 'token'],
		['ANTHROPIC_BASE_URL', 'https://gateway.example'],
		['CLAUDE_CODE_USE_BEDROCK', '1'],
	])('treats %s as asking for API billing', (key, value) => {
		const diagnosis = diagnoseApiUsageBilling({ [key]: value }, '/cfg');
		expect(diagnosis.expected).toBe(true);
		expect(diagnosis.reason).toContain(key);
	});

	it('treats a blank API key as unset', () => {
		expect(diagnoseApiUsageBilling({ ANTHROPIC_API_KEY: ' ' }, '/cfg').expected).toBe(false);
	});

	// The desktop scans maestro-p stderr with Claude's error bank, so a reason
	// that happened to read as an auth or limit error would fail a good turn.
	it.each([{}, { ANTHROPIC_API_KEY: 'sk-test' }])(
		'never words a reason the Claude error bank reads as an agent error (%o)',
		(env) => {
			const { reason } = diagnoseApiUsageBilling(env, '/Users/alice/.claude');
			expect(matchErrorPattern(getErrorPatterns('claude-code'), reason)).toBeNull();
		}
	);
});
