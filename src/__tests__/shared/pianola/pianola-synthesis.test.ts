/**
 * @file pianola-synthesis.test.ts
 * @description Unit tests for the pure Pianola suggestion synthesis.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { canonicalJson } from '../../../shared/canonicalJson';
import { createPianolaFsStore } from '../../../shared/pianola/fs-store';
import {
	validatePianolaSuggestionsFile,
	isValidHumanDecisionEvidence,
} from '../../../shared/pianola/storage';
import { createMockNativeDecisionPair } from '../../helpers/pianola';
import {
	synthesizeSuggestions,
	reconcileSuggestionEvidence,
	SUGGESTION_MIN_SAMPLES,
} from '../../../shared/pianola/pianola-synthesis';
import type { DecisionPair, ReplyPolarity } from '../../../shared/pianola/transcript-mining';
import type { PianolaSuggestionsFile } from '../../../shared/pianola/storage';
import {
	validatePianolaRule,
	pianolaCandidateEvidenceFingerprint,
} from '../../../shared/pianola/storage';
import type { PianolaRisk, PianolaSignalKind, PianolaRule } from '../../../shared/pianola/types';

function pair(
	kind: PianolaSignalKind,
	risk: PianolaRisk,
	polarity: ReplyPolarity,
	i = 0
): DecisionPair {
	const value = createMockNativeDecisionPair(`${kind}-${risk}-${i}`);
	value.classification.kind = kind;
	value.classification.risk = risk;
	value.polarity = polarity;
	value.reply = polarity === 'affirmative' ? value.reply : 'No, stop.';
	value.evidence!.answer = value.reply;
	return value;
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
	it('proposes a low-risk auto_answer rule for a consistently approved exact scoped question', () => {
		const pairs = manyPairs('question', 'low', SUGGESTION_MIN_SAMPLES, SUGGESTION_MIN_SAMPLES);
		const { proposals } = synthesizeSuggestions({ pairs, existingRules: [], now: 1 });
		expect(proposals).toHaveLength(1);
		expect(proposals[0].action).toBe('auto_answer');
		expect(proposals[0].match.kinds).toEqual(['question']);
		expect(proposals[0].match.maxRisk).toBe('low');
	});

	it('every proposal is valid per validatePianolaRule', () => {
		const pairs = manyPairs('question', 'low', 10, 10);
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

	it('does not duplicate an accepted rule for the same exact scoped answer', () => {
		const existing: PianolaRule = {
			id: 'r1',
			enabled: true,
			scope: 'agent',
			scopeId: 'fixture-agent',
			match: {
				kinds: ['question'],
				maxRisk: 'low',
				exactQuestion: 'Should I run `git status`?',
				groupId: 'fixture-group',
			},
			action: 'auto_answer',
			answer: 'Yes, run git status.',
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

	it('does not let a global kinds-only rule erase a narrower proposal', () => {
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
		expect(proposals).toHaveLength(1);
	});
});

describe('R08 independent human evidence and durable conflict projection', () => {
	it.each([
		'May I merge this PR?',
		'May I grant write access?',
		'Should I send this email?',
		'Should I deploy to production?',
	])('never turns repeated single-action permission for %s into a learned rule', (ask) => {
		const pairs = manyPairs('question', 'low', 3, 3);
		for (const sample of pairs) {
			sample.ask = sample.evidence!.question = sample.classification.questionText = ask;
		}
		expect(synthesizeSuggestions({ pairs, existingRules: [] }).candidates).toEqual([]);
	});

	it.each(['duplicate ask', 'duplicate answer', 'unknown', 'rule', 'Mira'])(
		'does not promote two humans plus %s to three independent decisions',
		(variant) => {
			const pairs = manyPairs('question', 'low', 3, 3);
			if (variant === 'duplicate ask') pairs[2] = structuredClone(pairs[0]);
			if (variant === 'duplicate answer')
				pairs[2].evidence!.answerMessageId = pairs[0].evidence!.answerMessageId;
			if (variant === 'unknown') delete pairs[2].evidence;
			if (variant === 'rule' || variant === 'Mira')
				Object.assign(pairs[2].evidence!, { principal: variant, sourceKind: variant });
			expect(synthesizeSuggestions({ pairs, existingRules: [] }).candidates).toEqual([]);
		}
	);

	it.each(['agent', 'group', 'question', 'conditions'])(
		'does not pool unrelated yes answers across %s boundaries',
		(variant) => {
			const pairs = manyPairs('question', 'low', 3, 3);
			const last = pairs[2];
			if (variant === 'agent') last.evidence!.agentId = 'another-agent';
			if (variant === 'group') last.evidence!.groupId = 'another-group';
			if (variant === 'conditions') last.evidence!.conditions = ['only after backup'];
			if (variant === 'question') {
				last.ask = 'Should I run `git diff`?';
				last.evidence!.question = last.ask;
				last.classification.questionText = last.ask;
			}
			expect(synthesizeSuggestions({ pairs, existingRules: [] }).candidates).toEqual([]);
		}
	);

	it('retains exact independent links and boundaries with an order/time stable fingerprint', () => {
		const pairs = manyPairs('question', 'low', 3, 3);
		const candidate = synthesizeSuggestions({ pairs, existingRules: [], now: 1 }).candidates[0];
		expect(candidate.sampleCount).toBe(3);
		expect(candidate.evidence).toEqual(pairs.map((sample) => sample.evidence));
		expect(candidate.conditions).toEqual([pairs[0].ask]);
		expect(candidate.exclusions).toEqual([
			'medium/high risk',
			'low confidence',
			'different question',
			'outside native scope/group',
		]);
		expect(candidate.rule).toMatchObject({
			enabled: false,
			scope: 'agent',
			scopeId: 'fixture-agent',
			match: { exactQuestion: pairs[0].ask, groupId: 'fixture-group' },
		});
		const reordered = synthesizeSuggestions({
			pairs: [...pairs].reverse(),
			existingRules: [],
			now: 999,
		}).candidates[0];
		expect(reordered.evidenceFingerprint).toBe(candidate.evidenceFingerprint);
		const changed = synthesizeSuggestions({
			pairs: [...pairs, pair('question', 'low', 'affirmative', 4)],
			existingRules: [],
		}).candidates[0];
		expect(changed.id).toBe(candidate.id);
		expect(changed.evidenceFingerprint).not.toBe(candidate.evidenceFingerprint);
	});

	it.each([
		'source answer',
		'source risk',
		'source conditions',
		'later contradiction',
		'other agent',
		'other group',
		'other conditions',
		'earlier contradiction',
		'unknown',
		'unchanged edited approval',
		'failed activation',
	])('projects review for %s only when accepted evidence is affected', (variant) => {
		const originals = manyPairs('question', 'low', 3, 3);
		const candidate = synthesizeSuggestions({ pairs: originals, existingRules: [], now: 1 })
			.candidates[0];
		const approvedAt = Date.parse('2026-10-28T00:01:00.000Z');
		const rule = { ...candidate.rule, enabled: true, updatedAt: approvedAt };
		if (variant === 'unchanged edited approval') rule.answer = 'No, wait for review.';
		const file: PianolaSuggestionsFile = {
			generatedAt: 1,
			pairCount: 3,
			proposals: [],
			candidates: [],
			proposedProfile: '',
			previousProfile: '',
			approvals: [
				{
					sourceKind: 'native-human-review',
					principal: 'chris',
					actorId: 'desktop',
					candidate,
					rule,
					approvedAt,
					edited: variant === 'unchanged edited approval',
				},
			],
		};
		const snapshots = structuredClone(originals);
		if (variant.startsWith('source')) {
			const corrected = structuredClone(originals[0]);
			if (variant === 'source answer') {
				corrected.reply = corrected.evidence!.answer = 'No, stop.';
				corrected.polarity = 'negative';
			}
			if (variant === 'source risk') corrected.classification.risk = 'high';
			if (variant === 'source conditions') corrected.evidence!.conditions = ['after review'];
			snapshots.push(corrected);
		} else if (!['unchanged edited approval', 'failed activation'].includes(variant)) {
			const later = pair('question', 'low', 'negative', 10);
			later.repliedAt = later.evidence!.answeredAt = '2026-10-28T00:02:00.000Z';
			if (variant === 'other agent') later.evidence!.agentId = 'another-agent';
			if (variant === 'other group') later.evidence!.groupId = 'another-group';
			if (variant === 'other conditions') later.evidence!.conditions = ['after review'];
			if (variant === 'earlier contradiction')
				later.repliedAt = later.evidence!.answeredAt = '2026-10-28T00:00:30.000Z';
			if (variant === 'unknown') delete later.evidence;
			snapshots.push(later);
		}
		const live = variant === 'failed activation' ? [] : [structuredClone(rule)];
		const before = structuredClone(live);
		const result = reconcileSuggestionEvidence(file, snapshots, live, approvedAt + 1000);
		const requiresReview = variant.startsWith('source') || variant === 'later contradiction';
		expect(result.conflicts).toHaveLength(requiresReview ? 1 : 0);
		if (requiresReview) {
			expect(result.conflicts![0]).toMatchObject({
				ruleId: rule.id,
				evidenceFingerprint: candidate.evidenceFingerprint,
				approvedAt,
				status: 'needs_review',
				nextActor: 'human',
				reason: variant.startsWith('source') ? 'source_corrected' : 'contradictory_decision',
			});
			expect(result.conflicts![0].evidence).toEqual([snapshots.at(-1)!.evidence]);
			expect(result.conflicts![0].nextAction).toContain('Owner');
		}
		expect(live).toEqual(before);
		expect(result.approvals).toEqual(file.approvals);
	});
});

describe('owner compatibility provenance', () => {
	it('preserves the legacy fingerprint when only generated description changes', () => {
		const pairs = manyPairs('question', 'low', 3, 3);
		const candidate = synthesizeSuggestions({ pairs, existingRules: [], now: 1 }).candidates[0];
		const copy = structuredClone(candidate);
		copy.rule.description = 'Neutral generated description';
		expect(pianolaCandidateEvidenceFingerprint(copy)).toBe(candidate.evidenceFingerprint);
		expect(candidate.evidenceFingerprint).toBe(
			canonicalJson({
				id: candidate.id,
				scope: candidate.rule.scope,
				scopeId: candidate.rule.scopeId,
				match: candidate.rule.match,
				action: candidate.action,
				conditions: candidate.conditions,
				exclusions: candidate.exclusions,
				answer: candidate.rule.answer,
				evidence: candidate.evidence.map((source) => canonicalJson(source)).sort(),
			})
		);
		expect(synthesizeSuggestions({ pairs, existingRules: [], now: 2 }).candidates[0].id).toBe(
			candidate.id
		);
	});

	it.each(['chris', 'owner'])('accepts %s evidence without changing its spelling', (principal) => {
		const pairs = manyPairs('question', 'low', 3, 3);
		for (const value of pairs) Object.assign(value.evidence!, { principal });
		const candidate = synthesizeSuggestions({ pairs, existingRules: [] }).candidates[0];
		expect(candidate.evidence.map((source) => source.principal)).toEqual([
			principal,
			principal,
			principal,
		]);
		expect(candidate.evidenceFingerprint).toBe(pianolaCandidateEvidenceFingerprint(candidate));
	});

	it('treats a principal change for the same ask as conflicting source evidence', () => {
		const pairs = manyPairs('question', 'low', 3, 3);
		const changed = structuredClone(pairs[0]);
		Object.assign(changed.evidence!, { principal: 'owner' });
		expect(
			synthesizeSuggestions({ pairs: [...pairs, changed], existingRules: [] }).candidates
		).toEqual([]);
	});
});

describe('durable legacy review compatibility', () => {
	it('preserves legacy receipts and rejects attribution replacement at the actual store seam', () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-review-'));
		try {
			const store = createPianolaFsStore({
				resolveDir: () => directory,
				indent: 2,
				trailingNewline: true,
			});
			const candidate = synthesizeSuggestions({
				pairs: manyPairs('question', 'low', 3, 3),
				existingRules: [],
				now: 1,
			}).candidates[0];
			const rejection = {
				sourceKind: 'native-human-review' as const,
				principal: 'chris' as const,
				actorId: 'desktop',
				candidateId: candidate.id,
				evidenceFingerprint: candidate.evidenceFingerprint,
				candidate,
				rejectedAt: 2,
			};
			const file: PianolaSuggestionsFile = {
				generatedAt: 1,
				pairCount: 3,
				proposals: [candidate.rule],
				candidates: [candidate],
				proposedProfile: '',
				previousProfile: '',
				rejections: [rejection],
			};
			store.writeSuggestions(file);
			const restarted = createPianolaFsStore({
				resolveDir: () => directory,
				indent: 2,
				trailingNewline: true,
			});
			expect(restarted.readSuggestions().rejections).toEqual([rejection]);
			expect(restarted.writeSuggestions({ ...file, rejections: [] }).candidates).toEqual([]);
			const forged = { ...rejection, actorId: 'another-actor' };
			try {
				restarted.writeSuggestions({ ...file, rejections: [forged] });
			} catch {
				/* rejection is also fail closed */
			}
			expect(restarted.readSuggestions().rejections).toEqual([rejection]);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each(['chris', 'owner'])('retains %s review and raw source provenance', (principal) => {
		const candidate = synthesizeSuggestions({
			pairs: manyPairs('question', 'low', 3, 3),
			existingRules: [],
			now: 1,
		}).candidates[0];
		const approval = {
			sourceKind: 'native-human-review',
			principal,
			actorId: 'desktop',
			candidate,
			rule: { ...candidate.rule, enabled: true, answer: 'Edited answer' },
			approvedAt: 2,
			edited: true,
		};
		const rejection = {
			sourceKind: 'native-human-review',
			principal,
			actorId: 'desktop',
			candidateId: candidate.id,
			evidenceFingerprint: candidate.evidenceFingerprint,
			candidate,
			rejectedAt: 3,
		};
		const conflict = {
			ruleId: candidate.id,
			evidenceFingerprint: candidate.evidenceFingerprint,
			approvedAt: 2,
			detectedAt: 4,
			reason: 'source_corrected',
			status: 'needs_review',
			nextActor: 'human',
			nextAction: 'Review',
			evidence: [candidate.evidence[0]],
		};
		const result = validatePianolaSuggestionsFile({
			approvals: [approval],
			rejections: [rejection],
			conflicts: [conflict],
		});
		expect(result.approvals).toEqual([approval]);
		expect(result.rejections).toEqual([rejection]);
		expect(result.conflicts).toEqual([conflict]);
	});

	it('rejects arbitrary evidence principals', () => {
		const evidence = { ...createMockNativeDecisionPair().evidence!, principal: 'someone' };
		expect(isValidHumanDecisionEvidence(evidence)).toBe(false);
	});

	it('does not replace an approval principal on the same durable key', () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-approval-'));
		try {
			const store = createPianolaFsStore({
				resolveDir: () => directory,
				indent: 2,
				trailingNewline: true,
			});
			const candidate = synthesizeSuggestions({
				pairs: manyPairs('question', 'low', 3, 3),
				existingRules: [],
				now: 1,
			}).candidates[0];
			const approval = {
				sourceKind: 'native-human-review' as const,
				principal: 'chris' as const,
				actorId: 'desktop',
				candidate,
				rule: { ...candidate.rule, enabled: true },
				approvedAt: 2,
				edited: false,
			};
			const file: PianolaSuggestionsFile = {
				generatedAt: 1,
				pairCount: 3,
				proposals: [],
				proposedProfile: '',
				previousProfile: '',
				approvals: [approval],
			};
			store.writeSuggestions(file);
			const altered = structuredClone(file) as unknown as {
				approvals: Array<Record<string, unknown>>;
			};
			altered.approvals[0].principal = 'owner';
			try {
				store.writeSuggestions(altered as unknown as PianolaSuggestionsFile);
			} catch {
				/* rejection is fail closed */
			}
			expect(store.readSuggestions().approvals).toEqual([approval]);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each(['approvals', 'rejections'] as const)(
		'rejects unknown principals in otherwise valid %s',
		(kind) => {
			const candidate = synthesizeSuggestions({
				pairs: manyPairs('question', 'low', 3, 3),
				existingRules: [],
				now: 1,
			}).candidates[0];
			const receipt = {
				sourceKind: 'native-human-review',
				principal: 'owner',
				actorId: 'desktop',
				candidate,
				...(kind === 'approvals'
					? { rule: { ...candidate.rule, enabled: true }, approvedAt: 2, edited: false }
					: {
							candidateId: candidate.id,
							evidenceFingerprint: candidate.evidenceFingerprint,
							rejectedAt: 2,
						}),
			};
			expect(validatePianolaSuggestionsFile({ [kind]: [receipt] })[kind]).toHaveLength(1);
			expect(() =>
				validatePianolaSuggestionsFile({ [kind]: [{ ...receipt, principal: 'someone' }] })
			).toThrow(kind === 'approvals' ? 'InvalidSuggestionApproval' : 'InvalidSuggestionRejection');
		}
	);
});
