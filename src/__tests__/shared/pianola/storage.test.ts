/**
 * @file storage.test.ts
 * @description Tests for the pure Pianola rule validator.
 */

import { describe, it, expect } from 'vitest';
import {
	validatePianolaRule,
	validatePianolaDecisionRecord,
	validatePianolaRules,
	validatePianolaProfileEntry,
	validatePianolaProfiles,
	resolveProfile,
	PIANOLA_PROFILE_MAX_CHARS,
	trimJsonlToLastRecords,
	trimJsonlToFit,
	type PianolaProfiles,
} from '../../../shared/pianola/storage';

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

	it('rejects an auto_answer rule with no narrowing predicate', () => {
		expect(validatePianolaRule(validRaw({ match: {} }))).toBeNull();
	});

	it('rejects an auto_answer rule with blank answer text', () => {
		expect(validatePianolaRule(validRaw({ answer: '   ' }))).toBeNull();
	});

	it('rejects an auto_answer rule with no answer', () => {
		expect(validatePianolaRule(validRaw({ answer: undefined }))).toBeNull();
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

describe('validatePianolaProfileEntry', () => {
	it('accepts a well-formed entry', () => {
		const entry = validatePianolaProfileEntry({
			profile: 'Approves tests freely.',
			updatedAt: 123,
			pairCount: 42,
		});
		expect(entry).toEqual({ profile: 'Approves tests freely.', updatedAt: 123, pairCount: 42 });
	});

	it('accepts an entry without pairCount', () => {
		const entry = validatePianolaProfileEntry({ profile: 'x', updatedAt: 1 });
		expect(entry).toEqual({ profile: 'x', updatedAt: 1 });
		expect(entry?.pairCount).toBeUndefined();
	});

	it('drops a non-finite pairCount rather than failing', () => {
		const entry = validatePianolaProfileEntry({ profile: 'x', updatedAt: 1, pairCount: NaN });
		expect(entry).toEqual({ profile: 'x', updatedAt: 1 });
	});

	it('truncates an over-long profile to the max', () => {
		const entry = validatePianolaProfileEntry({
			profile: 'a'.repeat(PIANOLA_PROFILE_MAX_CHARS + 500),
			updatedAt: 1,
		});
		expect(entry?.profile.length).toBe(PIANOLA_PROFILE_MAX_CHARS);
	});

	it.each([
		['non-object', null],
		['missing profile', { updatedAt: 1 }],
		['non-string profile', { profile: 5, updatedAt: 1 }],
		['missing updatedAt', { profile: 'x' }],
		['non-finite updatedAt', { profile: 'x', updatedAt: Infinity }],
	])('rejects %s', (_label, raw) => {
		expect(validatePianolaProfileEntry(raw)).toBeNull();
	});
});

describe('validatePianolaProfiles', () => {
	it('keeps valid global and project entries, drops malformed ones', () => {
		const profiles = validatePianolaProfiles({
			global: { profile: 'g', updatedAt: 1 },
			projects: {
				'/a': { profile: 'pa', updatedAt: 2 },
				'/bad': { profile: 5, updatedAt: 3 },
			},
		});
		expect(profiles.global).toEqual({ profile: 'g', updatedAt: 1 });
		expect(profiles.projects['/a']).toEqual({ profile: 'pa', updatedAt: 2 });
		expect(profiles.projects['/bad']).toBeUndefined();
	});

	it('returns a well-formed empty object for junk input', () => {
		expect(validatePianolaProfiles(null)).toEqual({ projects: {} });
		expect(validatePianolaProfiles('nope')).toEqual({ projects: {} });
		expect(validatePianolaProfiles({ projects: 'nope' })).toEqual({ projects: {} });
	});
});

describe('resolveProfile', () => {
	const profiles: PianolaProfiles = {
		global: { profile: 'global guidance', updatedAt: 1 },
		projects: { '/proj': { profile: 'project guidance', updatedAt: 2 } },
	};

	it('returns the project profile when one exists for the path', () => {
		expect(resolveProfile(profiles, '/proj')).toEqual({
			source: 'project',
			entry: profiles.projects['/proj'],
		});
	});

	it('falls back to global when the project has no profile', () => {
		expect(resolveProfile(profiles, '/other')).toEqual({
			source: 'global',
			entry: profiles.global,
		});
	});

	it('falls back to global when no path is given', () => {
		expect(resolveProfile(profiles)).toEqual({ source: 'global', entry: profiles.global });
	});

	it('returns none when neither project nor global exists', () => {
		expect(resolveProfile({ projects: {} }, '/proj')).toEqual({ source: 'none', entry: null });
	});
});

describe('trimJsonlToLastRecords', () => {
	it('returns content unchanged when within the cap', () => {
		const content = 'a\nb\nc\n';
		expect(trimJsonlToLastRecords(content, 5)).toBe(content);
	});

	it('keeps only the most recent records when over the cap', () => {
		expect(trimJsonlToLastRecords('l1\nl2\nl3\nl4\n', 2)).toBe('l3\nl4\n');
	});

	it('ignores blank lines when counting', () => {
		expect(trimJsonlToLastRecords('l1\n\nl2\n\nl3\n', 2)).toBe('l2\nl3\n');
	});

	it('returns content unchanged for a non-positive cap', () => {
		expect(trimJsonlToLastRecords('l1\nl2\n', 0)).toBe('l1\nl2\n');
		expect(trimJsonlToLastRecords('l1\nl2\n', -1)).toBe('l1\nl2\n');
	});
});

describe('trimJsonlToFit', () => {
	it('returns content unchanged when within both caps', () => {
		const content = 'a\nb\nc\n';
		expect(trimJsonlToFit(content, 10, 1000)).toBe(content);
	});

	it('trims by record cap', () => {
		expect(trimJsonlToFit('l1\nl2\nl3\nl4\n', 2, 100000)).toBe('l3\nl4\n');
	});

	it('trims further to fit the byte budget', () => {
		// Four 5-byte lines ("xxxx\n"); a 10-byte budget keeps the last two.
		expect(trimJsonlToFit('xxxx\nxxxx\nxxxx\nxxxx\n', 100, 10)).toBe('xxxx\nxxxx\n');
	});

	it('applies the tighter of record cap and byte budget', () => {
		// record cap 3 keeps last 3 (15 bytes); byte budget 12 drops one more.
		expect(trimJsonlToFit('aaaa\nbbbb\ncccc\ndddd\n', 3, 12)).toBe('cccc\ndddd\n');
	});
});

function decisionRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'd1',
		timestamp: '2026-01-01T00:00:00.000Z',
		tabId: 't1',
		agentId: 'a1',
		dispatched: false,
		dryRun: true,
		classification: {
			kind: 'question',
			risk: 'low',
			topic: 'tabs or spaces?',
			confidence: 'high',
			evidence: { messageId: 'm1', reason: 'asked about indentation', structured: true },
		},
		decision: { action: 'escalate', matchedRuleId: null, reason: 'no rule matched' },
		...over,
	};
}

function withEvidence(evidence: unknown): Record<string, unknown> {
	return decisionRecord({
		classification: {
			kind: 'question',
			risk: 'low',
			topic: 'tabs or spaces?',
			confidence: 'high',
			evidence,
		},
	});
}

describe('validatePianolaDecisionRecord', () => {
	it('accepts a fully valid record', () => {
		const rec = validatePianolaDecisionRecord(decisionRecord());
		expect(rec).not.toBeNull();
		expect(rec?.id).toBe('d1');
		expect(rec?.classification.evidence.messageId).toBe('m1');
	});

	it('accepts a record whose evidence.messageId is null', () => {
		const rec = validatePianolaDecisionRecord(
			withEvidence({ messageId: null, reason: 'heuristic', structured: false })
		);
		expect(rec).not.toBeNull();
		expect(rec?.classification.evidence.messageId).toBeNull();
	});

	it('rejects evidence missing messageId', () => {
		expect(
			validatePianolaDecisionRecord(withEvidence({ reason: 'r', structured: true }))
		).toBeNull();
	});

	it('rejects a non-string evidence.reason', () => {
		expect(
			validatePianolaDecisionRecord(withEvidence({ messageId: 'm1', reason: 42, structured: true }))
		).toBeNull();
	});

	it('rejects a non-boolean evidence.structured', () => {
		expect(
			validatePianolaDecisionRecord(
				withEvidence({ messageId: 'm1', reason: 'r', structured: 'yes' })
			)
		).toBeNull();
	});

	it('rejects evidence that is not an object', () => {
		expect(validatePianolaDecisionRecord(withEvidence('nope'))).toBeNull();
		expect(validatePianolaDecisionRecord(withEvidence(null))).toBeNull();
	});
});
