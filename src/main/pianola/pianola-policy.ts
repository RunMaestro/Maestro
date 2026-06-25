/**
 * Pianola policy engine - PURE functions.
 *
 * Given a classification and the user's rules, decide the action. Safety-first:
 *   - kind 'none'                  -> ignore
 *   - high risk                    -> always escalate (a rule can never auto-answer it)
 *   - matched rule, auto_answer    -> auto-answer (only when risk is below high)
 *   - matched rule, escalate/ignore-> as the rule says
 *   - no matching rule             -> escalate (we never auto-answer without an explicit rule)
 *
 * No I/O, no Electron, no app state. Unit tested against fixtures.
 */

import type {
	PianolaClassification,
	PianolaDecision,
	PianolaRule,
} from '../../shared/pianola/types';
import { riskAtMost } from './pianola-classifier';

/** Context needed to scope-filter rules to the current tab/project. */
export interface PianolaPolicyContext {
	projectPath?: string;
	tabId?: string;
}

/** True if a rule's scope applies in the given context. */
export function ruleAppliesToScope(rule: PianolaRule, ctx: PianolaPolicyContext): boolean {
	switch (rule.scope) {
		case 'global':
			return true;
		case 'project':
			return !!rule.scopeId && rule.scopeId === ctx.projectPath;
		case 'tab':
			return !!rule.scopeId && rule.scopeId === ctx.tabId;
		default:
			return false;
	}
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
	if (classification.risk === 'high') {
		return {
			action: 'escalate',
			matchedRuleId: rule.id,
			reason: 'high-risk prompt always escalates, overriding auto-answer rule',
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
