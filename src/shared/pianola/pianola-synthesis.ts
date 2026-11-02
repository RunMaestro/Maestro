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
 * Safety: only a closed set of concrete local inspection questions is mapped.
 * Every candidate retains the full question, exact answer and native scope,
 * remains disabled and requires explicit acceptance. Unknown semantics and
 * conflicting evidence yield no candidate. Full-turn risk guards still apply.
 */

import type { PianolaRule } from './types';
import { learnableDecisionAction } from './pianola-policy';
import { canonicalJson } from '../canonicalJson';
import type { DecisionAggregates, DecisionPair } from './transcript-mining';
import { aggregateDecisionPairs, confirmedHumanDecisionPairs } from './transcript-mining';
import {
	pianolaCandidateEvidenceFingerprint,
	type PianolaSuggestionCandidate,
	type PianolaSuggestionsFile,
	type PianolaLearnedRuleConflict,
} from './storage';

/** Configurable heuristic; never an authorization threshold. */
export const SUGGESTION_MIN_SAMPLES = 3;
/** Retained export for legacy consumers; every matching sample must agree. */
export const SUGGESTION_MIN_AFFIRM_RATIO = 1;

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
	minSamples?: number;
	/** Group pooling must be explicitly requested; default is individual agent. */
	learningScope?: 'agent' | 'group';
}

export interface SynthesisResult {
	/** Hard-rule proposals, each valid per validatePianolaRule. Never auto-applied. */
	proposals: PianolaRule[];
	/** Source-linked candidates for Suggestions; no live policy mutation. */
	candidates: PianolaSuggestionCandidate[];

	/** Proposed profile draft vs the current one. */
	profileDiff: ProfileDiff;
	/** The aggregates the synthesis reasoned over (for the UI summary). */
	aggregates: DecisionAggregates;
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
		'- Counts describe history only; they grant no permission. Require an explicitly accepted exact scoped rule.',
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
	const pairs = confirmedHumanDecisionPairs(input.pairs);
	const aggregates = aggregateDecisionPairs(pairs);

	const candidates: SynthesisResult['candidates'] = [];
	const threshold = input.minSamples ?? SUGGESTION_MIN_SAMPLES;
	if (!Number.isSafeInteger(threshold) || threshold < 1)
		throw new Error('Invalid learning sample threshold');
	const clusters = new Map<string, DecisionPair[]>();
	for (const pair of pairs) {
		const evidence = pair.evidence!;
		const action = learnableDecisionAction(evidence.question);
		if (!action) continue;
		const scope = input.learningScope ?? 'agent';
		const scopeId = scope === 'agent' ? evidence.agentId : evidence.groupId;
		if (!scopeId) continue;
		const key = canonicalJson([scope, scopeId, evidence.groupId, action, evidence.question]);
		const cluster = clusters.get(key) ?? [];
		cluster.push(pair);
		clusters.set(key, cluster);
	}
	for (const [key, cluster] of clusters) {
		const first = cluster[0];
		// Include all matching responses in the veto, including negative/other/high-risk
		// and changed answers. A correction cannot be outvoted by old yes counts.
		if (
			cluster.length < threshold ||
			cluster.some(
				(pair) =>
					pair.conflictingEvidence ||
					(pair.evidence!.action !== null &&
						pair.evidence!.action !== learnableDecisionAction(pair.ask)) ||
					(pair.evidence!.conditions !== null &&
						canonicalJson(pair.evidence!.conditions) !== canonicalJson([pair.ask])) ||
					pair.polarity !== 'affirmative' ||
					pair.reply !== first.reply ||
					pair.classification.risk !== 'low' ||
					pair.classification.kind !== 'question' ||
					pair.classification.confidence === 'low'
			)
		)
			continue;
		const evidence = first.evidence!;
		const scope = input.learningScope ?? 'agent';
		const scopeId = scope === 'agent' ? evidence.agentId : evidence.groupId!;
		if (
			input.existingRules.some(
				(rule) =>
					rule.id === `suggested:${key}` ||
					(rule.scope === scope &&
						rule.scopeId === scopeId &&
						rule.match.exactQuestion === evidence.question &&
						rule.match.groupId === evidence.groupId &&
						rule.answer === first.reply)
			)
		)
			continue;
		const rule: PianolaRule = {
			id: `suggested:${key}`,
			enabled: false,
			scope,
			scopeId,
			match: {
				kinds: ['question'],
				maxRisk: 'low',
				exactQuestion: evidence.question,
				groupId: evidence.groupId,
			},
			action: 'auto_answer',
			answer: first.reply,
			priority: 100,
			createdAt: now,
			updatedAt: now,
			description: `${cluster.length} independent owner decisions for this exact action and condition; explicit acceptance required.`,
		};
		const candidate = {
			id: rule.id,
			rule,
			action: learnableDecisionAction(evidence.question)!,
			conditions: [evidence.question],
			exclusions: [
				'medium/high risk',
				'low confidence',
				'different question',
				'outside native scope/group',
			],
			evidence: cluster.map((pair) => pair.evidence!),
			sampleCount: cluster.length,
		};
		candidates.push({
			...candidate,
			evidenceFingerprint: pianolaCandidateEvidenceFingerprint(candidate),
		});
	}
	const proposals = candidates.map((candidate) => candidate.rule);

	const before = input.existingProfile ?? '';
	const after = renderProfile(aggregates);
	const profileDiff: ProfileDiff = { before, after, changed: after.length > 0 && after !== before };

	return { proposals, candidates, profileDiff, aggregates };
}

/**
 * Revalidate staged/accepted evidence without changing rules or approval receipts.
 * Pass native snapshots so a correction under an existing ask retains its actual
 * source example. The folded corpus still supplies the independent sample count.
 */
export function reconcileSuggestionEvidence(
	file: PianolaSuggestionsFile,
	snapshots: readonly DecisionPair[],
	rules: readonly PianolaRule[],
	now: number
): PianolaSuggestionsFile {
	const pairs = confirmedHumanDecisionPairs(snapshots);
	const fresh = new Map<string, PianolaSuggestionCandidate>();
	for (const scope of ['agent', 'group'] as const) {
		if (!file.candidates?.some((candidate) => candidate.rule.scope === scope)) continue;
		for (const candidate of synthesizeSuggestions({
			pairs,
			existingRules: rules,
			learningScope: scope,
			// Revalidation cannot create a proposal; the original threshold and
			// current configured threshold remain enforced by synthesis/review.
			minSamples: 1,
			now,
		}).candidates)
			fresh.set(candidate.id, candidate);
	}
	const conflicts = (file.conflicts ?? []).map((item) => ({
		...item,
		evidence: [...item.evidence],
	}));
	// Validate each snapshot individually, preserving later corrections that
	// counting deliberately folds into a single vetoed sample.
	const sources = snapshots.flatMap((pair) => confirmedHumanDecisionPairs([pair]));
	for (const approval of file.approvals ?? []) {
		const { candidate, rule, approvedAt } = approval;
		// A pre-activation receipt (or a subsequently replaced policy) alone
		// cannot establish an active learned rule. Retain any earlier conflict.
		if (
			!rules.some(
				(live) =>
					live.id === rule.id &&
					canonicalJson([live.scope, live.scopeId, live.match, live.action, live.answer]) ===
						canonicalJson([rule.scope, rule.scopeId, rule.match, rule.action, rule.answer])
			)
		)
			continue;
		let conflict = conflicts.find(
			(item) =>
				item.ruleId === rule.id &&
				item.evidenceFingerprint === candidate.evidenceFingerprint &&
				item.approvedAt === approvedAt
		);
		for (const pair of sources) {
			const evidence = pair.evidence!;
			const original = candidate.evidence.find(
				(source) =>
					(source.agentId === evidence.agentId &&
						source.tabId === evidence.tabId &&
						source.questionMessageId === evidence.questionMessageId) ||
					(source.actorId === evidence.actorId &&
						source.answerMessageId === evidence.answerMessageId)
			);
			let reason: PianolaLearnedRuleConflict['reason'];
			if (original) {
				if (
					canonicalJson(original) === canonicalJson(evidence) &&
					!pair.conflictingEvidence &&
					pair.classification.kind === 'question' &&
					pair.classification.risk === 'low' &&
					pair.classification.confidence !== 'low'
				)
					continue;
				reason = 'source_corrected';
			} else {
				if (
					Date.parse(evidence.answeredAt) < approvedAt ||
					evidence.question !== rule.match.exactQuestion ||
					evidence.groupId !== rule.match.groupId ||
					(rule.scope === 'agent' ? evidence.agentId : evidence.groupId) !== rule.scopeId ||
					(evidence.action !== null && evidence.action !== candidate.action) ||
					(evidence.conditions !== null &&
						canonicalJson(evidence.conditions) !== canonicalJson(candidate.conditions))
				)
					continue;
				if (
					evidence.answer === rule.answer &&
					pair.classification.kind === 'question' &&
					pair.classification.risk === 'low' &&
					pair.classification.confidence !== 'low' &&
					!pair.conflictingEvidence
				)
					continue;
				reason = 'contradictory_decision';
			}
			if (!conflict) {
				conflict = {
					ruleId: rule.id,
					evidenceFingerprint: candidate.evidenceFingerprint,
					approvedAt,
					detectedAt: now,
					reason,
					status: 'needs_review',
					nextActor: 'human',
					nextAction:
						'Owner: review the accepted examples and later evidence, then explicitly edit or disable the rule in Rules. Live policy remains unchanged.',
					evidence: [],
				};
				conflicts.push(conflict);
			}
			if (reason === 'source_corrected') conflict.reason = reason;
			if (!conflict.evidence.some((source) => canonicalJson(source) === canonicalJson(evidence)))
				conflict.evidence.push(evidence);
		}
	}
	const candidates = file.candidates?.filter(
		(candidate) =>
			fresh.get(candidate.id)?.evidenceFingerprint === candidate.evidenceFingerprint &&
			!file.rejections?.some(
				(item) =>
					item.candidateId === candidate.id &&
					item.evidenceFingerprint === candidate.evidenceFingerprint
			)
	);
	return {
		...file,
		...(candidates ? { candidates, proposals: candidates.map((candidate) => candidate.rule) } : {}),
		conflicts,
	};
}
