/**
 * @file pianola-policy.test.ts
 * @description Unit tests for the pure Pianola policy engine.
 */

import { describe, it, expect } from 'vitest';
import {
	decide,
	selectRule,
	ruleAppliesToScope,
	ruleMatchesClassification,
} from '../../../main/pianola/pianola-policy';
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
});

describe('decide - rule actions', () => {
	it('auto-answers a low-risk prompt matched by a rule', () => {
		const r = rule({ match: { maxRisk: 'low' }, action: 'auto_answer', answer: 'Use tabs.' });
		const d = decide(classification({ kind: 'question', risk: 'low' }), [r]);
		expect(d.action).toBe('auto_answer');
		expect(d.answer).toBe('Use tabs.');
		expect(d.matchedRuleId).toBe(r.id);
	});

	it('escalates when matched auto-answer rule has no answer text', () => {
		const r = rule({ action: 'auto_answer', answer: '   ' });
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

	it('honors an explicit ignore rule', () => {
		const r = rule({ action: 'ignore' });
		const d = decide(classification({ kind: 'blocked', risk: 'low' }), [r]);
		expect(d.action).toBe('ignore');
		expect(d.matchedRuleId).toBe(r.id);
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
