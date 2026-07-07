/**
 * @file pianola-synthesis.test.ts
 * @description Unit tests for the pure Pianola suggestion synthesis.
 */

import { describe, it, expect } from 'vitest';
import {
	synthesizeSuggestions,
	SUGGESTION_MIN_SAMPLES,
} from '../../../shared/pianola/pianola-synthesis';
import type { DecisionPair, ReplyPolarity } from '../../../shared/pianola/transcript-mining';
import { validatePianolaRule } from '../../../shared/pianola/storage';
import type { PianolaRisk, PianolaSignalKind, PianolaRule } from '../../../shared/pianola/types';

function pair(
	kind: PianolaSignalKind,
	risk: PianolaRisk,
	polarity: ReplyPolarity,
	i = 0
): DecisionPair {
	return {
		agent: 'claude-code',
		sessionId: `s${i}`,
		classification: {
			kind,
			risk,
			topic: 'something',
			confidence: 'medium',
			evidence: { messageId: `m${i}`, reason: 'test', structured: false },
		},
		ask: 'May I proceed?',
		reply: polarity === 'affirmative' ? 'yes' : 'no',
		polarity,
		askedAt: '2026-01-01T00:00:00.000Z',
		repliedAt: '2026-01-01T00:00:01.000Z',
	};
}

function manyPairs(
	kind: PianolaSignalKind,
	risk: PianolaRisk,
	count: number,
	affirmative: number
): DecisionPair[] {
	const out: DecisionPair[] = [];
	for (let i = 0; i < count; i++) {
		out.push(pair(kind, risk, i < affirmative ? 'affirmative' : 'other', i));
	}
	return out;
}

describe('synthesizeSuggestions', () => {
	it('proposes a low-risk auto_answer rule for a consistently-approved kind', () => {
		const pairs = manyPairs('question', 'low', SUGGESTION_MIN_SAMPLES, SUGGESTION_MIN_SAMPLES);
		const { proposals } = synthesizeSuggestions({ pairs, existingRules: [], now: 1 });
		expect(proposals).toHaveLength(1);
		expect(proposals[0].action).toBe('auto_answer');
		expect(proposals[0].match.kinds).toEqual(['question']);
		expect(proposals[0].match.maxRisk).toBe('low');
	});

	it('every proposal is valid per validatePianolaRule', () => {
		const pairs = [...manyPairs('question', 'low', 10, 10), ...manyPairs('blocked', 'low', 10, 9)];
		const { proposals } = synthesizeSuggestions({ pairs, existingRules: [], now: 1 });
		expect(proposals.length).toBeGreaterThan(0);
		for (const p of proposals) {
			expect(validatePianolaRule(p)).not.toBeNull();
		}
	});

	it('does not propose below the sample threshold', () => {
		const pairs = manyPairs(
			'question',
			'low',
			SUGGESTION_MIN_SAMPLES - 1,
			SUGGESTION_MIN_SAMPLES - 1
		);
		const { proposals } = synthesizeSuggestions({ pairs, existingRules: [], now: 1 });
		expect(proposals).toHaveLength(0);
	});

	it('does not propose when approvals are inconsistent', () => {
		// 10 samples, only 5 affirmative (50%) - below the ratio.
		const pairs = manyPairs('question', 'low', 10, 5);
		const { proposals } = synthesizeSuggestions({ pairs, existingRules: [], now: 1 });
		expect(proposals).toHaveLength(0);
	});

	it('never proposes an auto_answer for medium or high risk', () => {
		const pairs = [
			...manyPairs('question', 'medium', 20, 20),
			...manyPairs('blocked', 'high', 20, 20),
		];
		const { proposals } = synthesizeSuggestions({ pairs, existingRules: [], now: 1 });
		expect(proposals).toHaveLength(0);
	});

	it('does not duplicate a kind already covered by an existing rule', () => {
		const existing: PianolaRule = {
			id: 'r1',
			enabled: true,
			scope: 'global',
			match: { kinds: ['question'], maxRisk: 'low' },
			action: 'auto_answer',
			answer: 'sure',
			priority: 1,
			createdAt: 1,
			updatedAt: 1,
		};
		const pairs = manyPairs('question', 'low', 10, 10);
		const { proposals } = synthesizeSuggestions({ pairs, existingRules: [existing], now: 1 });
		expect(proposals).toHaveLength(0);
	});

	it('builds a profile diff against the existing profile', () => {
		const pairs = manyPairs('question', 'low', 6, 6);
		const { profileDiff } = synthesizeSuggestions({
			pairs,
			existingRules: [],
			existingProfile: 'old profile',
			now: 1,
		});
		expect(profileDiff.before).toBe('old profile');
		expect(profileDiff.after.length).toBeGreaterThan(0);
		expect(profileDiff.changed).toBe(true);
	});

	it('reports no profile change for an empty corpus', () => {
		const { profileDiff, proposals } = synthesizeSuggestions({
			pairs: [],
			existingRules: [],
			now: 1,
		});
		expect(proposals).toHaveLength(0);
		expect(profileDiff.changed).toBe(false);
	});
});

describe('synthesizeSuggestions - safety scoping', () => {
	it('never proposes for the blocked kind (only question)', () => {
		const pairs = manyPairs('blocked', 'low', 50, 50);
		const { proposals } = synthesizeSuggestions({ pairs, existingRules: [], now: 1 });
		expect(proposals).toHaveLength(0);
	});

	it('treats an existing kinds-only rule (no maxRisk) as already covering', () => {
		const existing: PianolaRule = {
			id: 'r-no-maxrisk',
			enabled: true,
			scope: 'global',
			match: { kinds: ['question'] },
			action: 'auto_answer',
			answer: 'sure',
			priority: 1,
			createdAt: 1,
			updatedAt: 1,
		};
		const pairs = manyPairs('question', 'low', 10, 10);
		const { proposals } = synthesizeSuggestions({ pairs, existingRules: [existing], now: 1 });
		expect(proposals).toHaveLength(0);
	});
});
