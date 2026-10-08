/**
 * Shared, view-agnostic helpers for the Pianola dashboard: the rule-summary and
 * scope-label helpers the tab views render, the action/risk display metadata, the
 * blank-rule factory, and the option arrays. Kept in one leaf module so the modal
 * shell, its tab views (DecisionsView, RulesView, SuggestionsView), and the
 * RuleEditor share a single source without an import cycle.
 */

import { Send, ShieldAlert, Ban } from 'lucide-react';
import type {
	PianolaRule,
	PianolaSignalKind,
	PianolaActionKind,
	PianolaRisk,
} from '../../../shared/pianola/types';
import { generateId } from '../../utils/ids';

export type PianolaTab = 'decisions' | 'rules' | 'suggestions';
export type DecisionFilter = 'all' | 'escalate' | 'auto_answer';

export const ACTION_META: Record<
	PianolaActionKind,
	{ label: string; color: string; Icon: typeof Send }
> = {
	auto_answer: { label: 'Auto-answered', color: '#22c55e', Icon: Send },
	escalate: { label: 'Escalated', color: '#f59e0b', Icon: ShieldAlert },
	ignore: { label: 'Ignored', color: '#94a3b8', Icon: Ban },
};

export const RISK_COLOR: Record<PianolaRisk, string> = {
	low: '#22c55e',
	medium: '#f59e0b',
	high: '#ef4444',
};

/** One-line, human-readable summary of a rule's match conditions. */
export function describeRuleMatch(rule: PianolaRule): string {
	const parts: string[] = [];
	if (rule.match.maxRisk) parts.push(`risk <= ${rule.match.maxRisk}`);
	if (rule.match.kinds && rule.match.kinds.length > 0)
		parts.push(`kind: ${rule.match.kinds.join(', ')}`);
	if (rule.match.topicIncludes && rule.match.topicIncludes.length > 0)
		parts.push(`topic ~ ${rule.match.topicIncludes.join(' / ')}`);
	return parts.length > 0 ? parts.join('  -  ') : 'any prompt';
}

export function scopeLabel(rule: PianolaRule): string {
	if (rule.scope === 'global') return 'global';
	if (rule.scope === 'project') return `project: ${rule.scopeId ?? '(unset)'}`;
	return `tab: ${rule.scopeId ?? '(unset)'}`;
}

/** Factory for a blank rule, used when creating. */
export function newBlankRule(): PianolaRule {
	const now = Date.now();
	return {
		id: generateId(),
		enabled: true,
		scope: 'global',
		match: { maxRisk: 'low', kinds: ['question'] },
		action: 'auto_answer',
		answer: '',
		priority: 100,
		createdAt: now,
		updatedAt: now,
	};
}

// Option constants for the editor selects. Scopes/actions/risks are single-sourced
// from types.ts; RULE_KINDS is the UI-selectable subset (the watcher's 'none' signal
// is never a user-authored rule kind, so it is intentionally excluded here).
export {
	RULE_SCOPES,
	ACTION_KINDS as RULE_ACTIONS,
	RISKS as RULE_RISKS,
} from '../../../shared/pianola/types';
export const RULE_KINDS: readonly PianolaSignalKind[] = ['question', 'blocked'];
