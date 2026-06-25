/**
 * Pianola policy engine - PURE functions.
 *
 * Given a classification and the user's rules, decide the action. Safety-first,
 * in this exact precedence:
 *   1. kind 'none'                  -> ignore
 *   2. risk 'high'                  -> ALWAYS escalate (no rule can suppress it)
 *   3. matched auto_answer rule     -> auto-answer (rule must narrow its scope + have answer text)
 *   4. matched escalate/ignore rule -> as the rule says
 *   5. no matching rule             -> escalate (we never auto-answer without an explicit rule)
 *
 * The high-risk guard runs before rule actions so an `ignore` rule can never
 * silence a high-risk prompt. No I/O, no Electron, no app state.
 */

import type { PianolaClassification, PianolaDecision, PianolaRule } from './types';
import { riskAtMost } from './pianola-risk';

/** Context needed to scope-filter rules to the current tab/project. */
export interface PianolaPolicyContext {
	projectPath?: string;
	tabId?: string;
}

/**
 * Normalize a scope identifier for comparison: trim, unify path separators,
 * drop a trailing slash, and lowercase. This makes project-path matching robust
 * to Windows casing and slash differences; tab ids (uuids) are unaffected.
 */
function normalizeScopeId(value: string | undefined): string {
	if (!value) return '';
	return value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** True if a rule's scope applies in the given context. */
export function ruleAppliesToScope(rule: PianolaRule, ctx: PianolaPolicyContext): boolean {
	switch (rule.scope) {
		case 'global':
			return true;
		case 'project':
			return !!rule.scopeId && normalizeScopeId(rule.scopeId) === normalizeScopeId(ctx.projectPath);
		case 'tab':
			return !!rule.scopeId && normalizeScopeId(rule.scopeId) === normalizeScopeId(ctx.tabId);
		default:
			return false;
	}
}

/** True if a rule constrains what it matches (vs matching everything). */
export function hasNarrowingPredicate(rule: PianolaRule): boolean {
	const { match } = rule;
	return (
		!!match.maxRisk ||
		(!!match.kinds && match.kinds.length > 0) ||
		(!!match.topicIncludes && match.topicIncludes.length > 0)
	);
}

/** True if a rule's match conditions are satisfied by the classification. */
export function ruleMatchesClassification(
	rule: PianolaRule,
	classification: PianolaClassification
): boolean {
	const { match } = rule;

	if (match.maxRisk && !riskAtMost(classification.risk, match.maxRisk)) {
		return false;
	}

	if (match.kinds && match.kinds.length > 0 && !match.kinds.includes(classification.kind)) {
		return false;
	}

	if (match.topicIncludes && match.topicIncludes.length > 0) {
		const topic = classification.topic.toLowerCase();
		const anyHit = match.topicIncludes.some((needle) => topic.includes(needle.toLowerCase()));
		if (!anyHit) return false;
	}

	return true;
}

/**
 * Select the highest-precedence enabled rule that applies to scope and matches
 * the classification. Lower `priority` wins; ties break by earlier `createdAt`.
 */
export function selectRule(
	classification: PianolaClassification,
	rules: readonly PianolaRule[],
	ctx: PianolaPolicyContext = {}
): PianolaRule | null {
	const candidates = rules
		.filter((r) => r.enabled)
		.filter((r) => ruleAppliesToScope(r, ctx))
		.filter((r) => ruleMatchesClassification(r, classification))
		.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
	return candidates[0] ?? null;
}

/** Decide what Pianola should do about a classified prompt. */
export function decide(
	classification: PianolaClassification,
	rules: readonly PianolaRule[],
	ctx: PianolaPolicyContext = {}
): PianolaDecision {
	if (classification.kind === 'none') {
		return { action: 'ignore', matchedRuleId: null, reason: 'nothing actionable' };
	}

	const rule = selectRule(classification, rules, ctx);

	// High risk always escalates, before any rule action is applied. An ignore or
	// auto_answer rule must never be able to suppress a high-risk prompt.
	if (classification.risk === 'high') {
		return {
			action: 'escalate',
			matchedRuleId: rule?.id ?? null,
			reason: 'high-risk prompt always escalates',
		};
	}

	if (!rule) {
		return {
			action: 'escalate',
			matchedRuleId: null,
			reason: 'no matching rule; escalating by default',
		};
	}

	if (rule.action === 'ignore') {
		return { action: 'ignore', matchedRuleId: rule.id, reason: 'rule says ignore' };
	}

	if (rule.action === 'escalate') {
		return { action: 'escalate', matchedRuleId: rule.id, reason: 'rule says escalate' };
	}

	// rule.action === 'auto_answer'
	if (!hasNarrowingPredicate(rule)) {
		return {
			action: 'escalate',
			matchedRuleId: rule.id,
			reason: 'auto-answer rule has no narrowing predicate; too broad to auto-answer',
		};
	}

	if (!rule.answer || rule.answer.trim().length === 0) {
		return {
			action: 'escalate',
			matchedRuleId: rule.id,
			reason: 'auto-answer rule matched but has no answer text; escalating',
		};
	}

	return {
		action: 'auto_answer',
		answer: rule.answer,
		matchedRuleId: rule.id,
		reason: 'matched auto-answer rule',
	};
}
