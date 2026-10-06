/**
 * Pianola suggestion synthesis - PURE, runtime-agnostic.
 *
 * Turns a mined decision corpus (DecisionPair[]) plus the user's existing rules
 * and profile into APPROVABLE suggestions: a short set of hard-rule proposals and
 * a refreshed decision-profile draft (with a diff against the current profile).
 *
 * Deterministic and code-driven (no LLM): the same corpus always yields the same
 * proposals, so the scheduled re-learn job (Step 2) and the in-app suggestions UI
 * (Step 3) share one source of truth. Nothing here auto-applies; the caller (a
 * staging write, or a user clicking approve) decides what to persist.
 *
 * Safety: proposals are ONLY ever for low-risk decisions and only when the user
 * answered consistently and often. High- and medium-risk asks never become an
 * auto_answer suggestion - high risk always escalates at decide() time, and
 * medium is left for the user to judge. Every proposal carries a narrowing
 * predicate (kinds + maxRisk) and answer text, so it passes validatePianolaRule.
 */

import type { PianolaRule, PianolaSignalKind } from './types';
import type { DecisionAggregates, DecisionPair } from './transcript-mining';
import { aggregateDecisionPairs } from './transcript-mining';

/** Minimum observed decisions in a (kind) cluster before it can become a rule. */
export const SUGGESTION_MIN_SAMPLES = 5;
/** Minimum affirmative fraction in a cluster before proposing an auto_answer. */
export const SUGGESTION_MIN_AFFIRM_RATIO = 0.8;

/** A before/after view of the decision-profile markdown. */
export interface ProfileDiff {
	before: string;
	after: string;
	changed: boolean;
}

export interface SynthesisInput {
	/** Mined ask -> reply decisions to learn from. */
	pairs: readonly DecisionPair[];
	/** The user's current rules, so we never propose a duplicate. */
	existingRules: readonly PianolaRule[];
	/** The current decision-profile markdown for this scope (empty when none). */
	existingProfile?: string;
	/** Epoch ms stamped onto proposals; injected for deterministic tests. */
	now?: number;
}

export interface SynthesisResult {
	/** Hard-rule proposals, each valid per validatePianolaRule. Never auto-applied. */
	proposals: PianolaRule[];
	/** Proposed profile draft vs the current one. */
	profileDiff: ProfileDiff;
	/** The aggregates the synthesis reasoned over (for the UI summary). */
	aggregates: DecisionAggregates;
}

// Kinds we will ever propose an auto_answer for. Only 'question': a blanket
// "Yes, go ahead." is nonsensical for a 'blocked' ask, and limiting to questions
// keeps the auto-proposed rule's blast radius small. High/medium risk never gets
// here, and decide() still escalates any high-risk prompt regardless of the rule.
const RULEABLE_KINDS: readonly PianolaSignalKind[] = ['question'];

/** Count affirmative vs total low-risk pairs for one signal kind. */
function lowRiskKindStats(
	pairs: readonly DecisionPair[],
	kind: PianolaSignalKind
): { total: number; affirmative: number } {
	let total = 0;
	let affirmative = 0;
	for (const pair of pairs) {
		if (pair.classification.risk !== 'low') continue;
		if (pair.classification.kind !== kind) continue;
		total += 1;
		if (pair.polarity === 'affirmative') affirmative += 1;
	}
	return { total, affirmative };
}

/**
 * True when an enabled auto_answer rule already covers this kind at low risk.
 * A rule with NO maxRisk has no upper bound, so it already covers low risk too -
 * treat undefined as covering, otherwise we re-propose a duplicate the user has.
 */
function ruleAlreadyCovers(rules: readonly PianolaRule[], kind: PianolaSignalKind): boolean {
	return rules.some(
		(r) => r.enabled && r.action === 'auto_answer' && (r.match.kinds?.includes(kind) ?? false)
	);
}

/** Build a deterministic low-risk auto_answer proposal for one signal kind. */
function proposalForKind(kind: PianolaSignalKind, total: number, now: number): PianolaRule {
	return {
		id: `suggested-low-${kind}`,
		enabled: true,
		scope: 'global',
		match: { kinds: [kind], maxRisk: 'low' },
		action: 'auto_answer',
		answer: 'Yes, go ahead.',
		priority: 100,
		createdAt: now,
		updatedAt: now,
		description: `Auto-approve low-risk ${kind} prompts (you approved ${total} of these). Review before enabling.`,
	};
}

/** Render a short, deterministic decision-profile draft from the aggregates. */
function renderProfile(aggregates: DecisionAggregates): string {
	if (aggregates.total === 0) return '';
	const line = (risk: string): string => {
		const cell = aggregates.byRiskPolarity[risk];
		if (!cell) return `- ${risk} risk: no observed decisions.`;
		return `- ${risk} risk: ${cell.affirmative} approved, ${cell.negative} declined, ${cell.other} other.`;
	};
	return [
		'# Decision profile (synthesized)',
		'',
		`Synthesized from ${aggregates.total} observed decisions.`,
		'',
		'How you tend to respond, by risk:',
		line('low'),
		line('medium'),
		line('high'),
		'',
		'Guidance for Pianola:',
		'- High-risk asks ALWAYS escalate to me, regardless of any rule.',
		'- For low-risk asks I approve the large majority; auto-answering those is usually safe.',
		'- For medium-risk asks, prefer to ask me unless a specific rule clearly applies.',
		'',
	].join('\n');
}

/**
 * Synthesize approvable suggestions from a mined corpus. Pure: deterministic in
 * its inputs (pass `now` for stable proposal timestamps in tests).
 */
export function synthesizeSuggestions(input: SynthesisInput): SynthesisResult {
	const now = input.now ?? Date.now();
	const aggregates = aggregateDecisionPairs(input.pairs);

	const proposals: PianolaRule[] = [];
	for (const kind of RULEABLE_KINDS) {
		if (ruleAlreadyCovers(input.existingRules, kind)) continue;
		const { total, affirmative } = lowRiskKindStats(input.pairs, kind);
		if (total < SUGGESTION_MIN_SAMPLES) continue;
		if (affirmative / total < SUGGESTION_MIN_AFFIRM_RATIO) continue;
		proposals.push(proposalForKind(kind, total, now));
	}

	const before = input.existingProfile ?? '';
	const after = renderProfile(aggregates);
	const profileDiff: ProfileDiff = { before, after, changed: after.length > 0 && after !== before };

	return { proposals, profileDiff, aggregates };
}
