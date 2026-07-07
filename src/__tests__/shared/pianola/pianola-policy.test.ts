/**
 * @file pianola-policy.test.ts
 * @description Unit tests for the pure Pianola policy engine.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
	decide,
	selectRule,
	ruleAppliesToScope,
	ruleMatchesClassification,
	hasNarrowingPredicate,
	matchHasNarrowingPredicate,
} from '../../../shared/pianola/pianola-policy';
import type {
	PianolaClassification,
	PianolaRisk,
	PianolaRule,
	PianolaSignalKind,
} from '../../../shared/pianola/types';

function classification(
	overrides: Partial<PianolaClassification> & { kind: PianolaSignalKind; risk: PianolaRisk }
): PianolaClassification {
	return {
		topic: 'should i use tabs',
		confidence: 'medium',
		evidence: { messageId: 'm1', reason: 'test', structured: false },
		...overrides,
	};
}

let ruleSeq = 0;
function rule(overrides: Partial<PianolaRule>): PianolaRule {
	ruleSeq += 1;
	return {
		id: `r${ruleSeq}`,
		enabled: true,
		scope: 'global',
		match: {},
		action: 'auto_answer',
		answer: 'Use tabs.',
		priority: 100,
		createdAt: ruleSeq,
		updatedAt: ruleSeq,
		...overrides,
	};
}

describe('decide - safety defaults', () => {
	it('ignores a none classification', () => {
		const d = decide(classification({ kind: 'none', risk: 'low' }), [rule({})]);
		expect(d.action).toBe('ignore');
		expect(d.matchedRuleId).toBeNull();
	});

	it('escalates when no rule matches', () => {
		const d = decide(classification({ kind: 'question', risk: 'low' }), []);
		expect(d.action).toBe('escalate');
		expect(d.matchedRuleId).toBeNull();
	});

	it('never auto-answers a high-risk prompt even if a rule says to', () => {
		const r = rule({ match: { maxRisk: 'high' }, action: 'auto_answer', answer: 'go' });
		const d = decide(classification({ kind: 'question', risk: 'high' }), [r]);
		expect(d.action).toBe('escalate');
		expect(d.matchedRuleId).toBe(r.id);
		expect(d.reason).toContain('high-risk');
	});

	it('never lets an ignore rule suppress a high-risk prompt', () => {
		// Regression: high-risk override must run before rule actions, so a broad
		// ignore rule cannot silence the most important alerts.
		const r = rule({ action: 'ignore', match: {} });
		const d = decide(classification({ kind: 'blocked', risk: 'high' }), [r]);
		expect(d.action).toBe('escalate');
		expect(d.reason).toContain('high-risk');
	});
});

describe('decide - rule actions', () => {
	it('auto-answers a low-risk prompt matched by a rule', () => {
		const r = rule({ match: { maxRisk: 'low' }, action: 'auto_answer', answer: 'Use tabs.' });
		const d = decide(classification({ kind: 'question', risk: 'low' }), [r]);
		expect(d).toMatchObject({ action: 'auto_answer', answer: 'Use tabs.', matchedRuleId: r.id });
	});

	it('escalates an auto-answer rule that has no narrowing predicate (too broad)', () => {
		const r = rule({ match: {}, action: 'auto_answer', answer: 'sure' });
		const d = decide(classification({ kind: 'question', risk: 'low' }), [r]);
		expect(d.action).toBe('escalate');
		expect(d.reason).toContain('narrowing predicate');
	});

	it('escalates when matched auto-answer rule has no answer text', () => {
		const r = rule({ match: { maxRisk: 'low' }, action: 'auto_answer', answer: '   ' });
		const d = decide(classification({ kind: 'question', risk: 'low' }), [r]);
		expect(d.action).toBe('escalate');
		expect(d.reason).toContain('no answer');
	});

	it('honors an explicit escalate rule', () => {
		const r = rule({ action: 'escalate' });
		const d = decide(classification({ kind: 'question', risk: 'low' }), [r]);
		expect(d.action).toBe('escalate');
		expect(d.matchedRuleId).toBe(r.id);
	});

	it('honors an explicit ignore rule for a non-high-risk prompt', () => {
		const r = rule({ action: 'ignore', match: { maxRisk: 'low' } });
		const d = decide(classification({ kind: 'blocked', risk: 'low' }), [r]);
		expect(d.action).toBe('ignore');
		expect(d.matchedRuleId).toBe(r.id);
	});
});

describe('matchHasNarrowingPredicate', () => {
	it('treats maxRisk, kinds, or topicIncludes as narrowing', () => {
		expect(matchHasNarrowingPredicate({ maxRisk: 'low' })).toBe(true);
		expect(matchHasNarrowingPredicate({ kinds: ['question'] })).toBe(true);
		expect(matchHasNarrowingPredicate({ topicIncludes: ['naming'] })).toBe(true);
	});

	it('treats an empty match as not narrowing', () => {
		expect(matchHasNarrowingPredicate({})).toBe(false);
		expect(matchHasNarrowingPredicate({ kinds: [], topicIncludes: [] })).toBe(false);
	});

	it('hasNarrowingPredicate delegates to the match check', () => {
		expect(hasNarrowingPredicate(rule({ match: { maxRisk: 'low' } }))).toBe(true);
		expect(hasNarrowingPredicate(rule({ match: {} }))).toBe(false);
	});
});

describe('rule matching', () => {
	it('respects maxRisk', () => {
		const r = rule({ match: { maxRisk: 'low' } });
		expect(ruleMatchesClassification(r, classification({ kind: 'question', risk: 'low' }))).toBe(
			true
		);
		expect(ruleMatchesClassification(r, classification({ kind: 'question', risk: 'medium' }))).toBe(
			false
		);
	});

	it('respects kinds filter', () => {
		const r = rule({ match: { kinds: ['blocked'] } });
		expect(ruleMatchesClassification(r, classification({ kind: 'blocked', risk: 'low' }))).toBe(
			true
		);
		expect(ruleMatchesClassification(r, classification({ kind: 'question', risk: 'low' }))).toBe(
			false
		);
	});

	it('respects topicIncludes (case-insensitive)', () => {
		const r = rule({ match: { topicIncludes: ['TABS'] } });
		expect(
			ruleMatchesClassification(
				r,
				classification({ kind: 'question', risk: 'low', topic: 'should i use tabs' })
			)
		).toBe(true);
		expect(
			ruleMatchesClassification(
				r,
				classification({ kind: 'question', risk: 'low', topic: 'rename the module' })
			)
		).toBe(false);
	});
});

describe('scope filtering', () => {
	it('global rules always apply', () => {
		expect(ruleAppliesToScope(rule({ scope: 'global' }), {})).toBe(true);
	});

	it('project rules apply only for the matching project path', () => {
		const r = rule({ scope: 'project', scopeId: '/repo/a' });
		expect(ruleAppliesToScope(r, { projectPath: '/repo/a' })).toBe(true);
		expect(ruleAppliesToScope(r, { projectPath: '/repo/b' })).toBe(false);
		expect(ruleAppliesToScope(r, {})).toBe(false);
	});

	it('tab rules apply only for the matching tab id', () => {
		const r = rule({ scope: 'tab', scopeId: 'tab-1' });
		expect(ruleAppliesToScope(r, { tabId: 'tab-1' })).toBe(true);
		expect(ruleAppliesToScope(r, { tabId: 'tab-2' })).toBe(false);
	});
});

describe('selectRule precedence', () => {
	it('picks the lowest priority number among matches', () => {
		const low = rule({ priority: 10, answer: 'low-pri-wins' });
		const high = rule({ priority: 50, answer: 'high-pri' });
		const picked = selectRule(classification({ kind: 'question', risk: 'low' }), [high, low], {});
		expect(picked?.id).toBe(low.id);
	});

	it('skips disabled and out-of-scope rules', () => {
		const disabled = rule({ priority: 1, enabled: false });
		const wrongScope = rule({ priority: 2, scope: 'project', scopeId: '/other' });
		const ok = rule({ priority: 3 });
		const picked = selectRule(classification({ kind: 'question', risk: 'low' }), [
			disabled,
			wrongScope,
			ok,
		]);
		expect(picked?.id).toBe(ok.id);
	});
});

describe('decide - confidence gating', () => {
	it('escalates instead of auto-answering a low-confidence classification', () => {
		const r = rule({ match: { maxRisk: 'low' }, action: 'auto_answer', answer: 'go' });
		const d = decide(classification({ kind: 'question', risk: 'low', confidence: 'low' }), [r]);
		expect(d.action).toBe('escalate');
		expect(d.reason).toContain('low-confidence');
	});

	it('still auto-answers a medium-confidence classification matched by a rule', () => {
		const r = rule({ match: { maxRisk: 'low' }, action: 'auto_answer', answer: 'go' });
		const d = decide(classification({ kind: 'question', risk: 'low', confidence: 'medium' }), [r]);
		expect(d.action).toBe('auto_answer');
	});
});

describe('scope normalization case-sensitivity', () => {
	const originalPlatform = process.platform;
	afterEach(() => {
		Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
	});

	it('folds case on Windows (case-insensitive filesystem)', () => {
		Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
		const r = rule({ scope: 'project', scopeId: 'C:/Repo/App' });
		expect(ruleAppliesToScope(r, { projectPath: 'c:/repo/app' })).toBe(true);
	});

	it('does NOT fold case off Windows (case-sensitive filesystem)', () => {
		Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
		const r = rule({ scope: 'project', scopeId: '/repo/App' });
		expect(ruleAppliesToScope(r, { projectPath: '/repo/app' })).toBe(false);
		expect(ruleAppliesToScope(r, { projectPath: '/repo/App' })).toBe(true);
	});
});
