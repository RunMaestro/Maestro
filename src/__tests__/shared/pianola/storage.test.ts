/**
 * @file storage.test.ts
 * @description Tests for the pure Pianola rule validator.
 */

import { describe, it, expect } from 'vitest';
import { validatePianolaRule, validatePianolaRules } from '../../../shared/pianola/storage';

function validRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'r1',
		enabled: true,
		scope: 'global',
		match: { maxRisk: 'low', kinds: ['question'], topicIncludes: ['tabs'] },
		action: 'auto_answer',
		answer: 'Use tabs.',
		priority: 100,
		createdAt: 1,
		updatedAt: 2,
		...overrides,
	};
}

describe('validatePianolaRule', () => {
	it('accepts a well-formed rule', () => {
		const rule = validatePianolaRule(validRaw());
		expect(rule).not.toBeNull();
		expect(rule?.id).toBe('r1');
		expect(rule?.match.kinds).toEqual(['question']);
	});

	it('accepts a minimal rule with an empty match', () => {
		const rule = validatePianolaRule(
			validRaw({ match: undefined, action: 'escalate', answer: undefined })
		);
		expect(rule?.match).toEqual({});
	});

	it.each([
		['missing id', { id: undefined }],
		['empty id', { id: '' }],
		['non-boolean enabled', { enabled: 'yes' }],
		['bad scope', { scope: 'planet' }],
		['bad action', { action: 'nuke' }],
		['non-numeric priority', { priority: 'high' }],
		['missing timestamps', { createdAt: undefined }],
		['bad maxRisk', { match: { maxRisk: 'extreme' } }],
		['bad kinds', { match: { kinds: ['banana'] } }],
		['non-string topicIncludes', { match: { topicIncludes: [1, 2] } }],
		['non-string scopeId', { scopeId: 42 }],
	])('rejects %s', (_label, overrides) => {
		expect(validatePianolaRule(validRaw(overrides))).toBeNull();
	});

	it('rejects non-object input', () => {
		expect(validatePianolaRule(null)).toBeNull();
		expect(validatePianolaRule('rule')).toBeNull();
		expect(validatePianolaRule([])).toBeNull();
	});
});

describe('validatePianolaRules', () => {
	it('keeps valid rules and drops invalid ones', () => {
		const rules = validatePianolaRules([
			validRaw({ id: 'a' }),
			{ junk: true },
			validRaw({ id: 'b' }),
		]);
		expect(rules.map((r) => r.id)).toEqual(['a', 'b']);
	});

	it('returns an empty array for non-array input', () => {
		expect(validatePianolaRules({})).toEqual([]);
		expect(validatePianolaRules(undefined)).toEqual([]);
	});
});
