/**
 * Pianola - shared contracts.
 *
 * Pianola is Maestro's autonomous manager agent (Encore-gated, flag `pianola`).
 * It watches agent tabs, detects when an agent is awaiting the user, classifies
 * the ask and its risk, then either auto-answers low-risk prompts from the user's
 * rules or escalates. These contracts are shared across main, renderer, and CLI.
 *
 * The classifier and policy engine that consume these types are pure functions
 * (see src/shared/pianola/pianola-classifier.ts and pianola-policy.ts).
 */

/** Risk of acting on a detected prompt, ordered low < medium < high. */
export const RISKS = ['low', 'medium', 'high'] as const;
export type PianolaRisk = (typeof RISKS)[number];

/** What Pianola decides to do about a detected prompt. */
export const ACTION_KINDS = ['auto_answer', 'escalate', 'ignore'] as const;
export type PianolaActionKind = (typeof ACTION_KINDS)[number];

/** What the classifier detected in the transcript tail. */
export const SIGNAL_KINDS = ['question', 'blocked', 'none'] as const;
export type PianolaSignalKind = (typeof SIGNAL_KINDS)[number];

/** Role of a message, mirroring the WS SessionHistoryMessage contract. */
export type PianolaMessageRole =
	| 'user'
	| 'assistant'
	| 'system'
	| 'tool'
	| 'thinking'
	| 'error'
	| 'unknown';

/**
 * Structured signal emitted by the parser layer when an agent is unambiguously
 * waiting on the user. Narrow by design: only set for high-confidence cases
 * (permission prompts, plan-mode review, explicit choices). Populated in a later
 * step; the classifier treats its presence as authoritative.
 */
export interface AwaitingInputSignal {
	kind: 'permission' | 'plan_review' | 'choice' | 'question';
	/** The prompt text shown to the user, if extractable. */
	prompt?: string;
	/** Discrete options the user may pick from, if any. */
	options?: string[];
}

/**
 * A normalized message the classifier reads. Mirrors the WebSocket
 * `SessionHistoryMessage` shape so the CLI watcher can feed
 * `maestro-cli session show --json` output in directly.
 */
export interface PianolaMessage {
	id: string;
	role: PianolaMessageRole;
	source: string;
	content: string;
	/** ISO-8601 timestamp. */
	timestamp: string;
	/** Structured awaiting-input marker, when the parser layer provides one. */
	awaitingInput?: AwaitingInputSignal;
}

/** Result of classifying a transcript tail. */
export interface PianolaClassification {
	kind: PianolaSignalKind;
	risk: PianolaRisk;
	/** Short human-readable summary of what is being asked. */
	topic: string;
	confidence: 'low' | 'medium' | 'high';
	/** Why this classification was reached, for the audit log and UI. */
	evidence: {
		messageId: string | null;
		reason: string;
		/** True if derived from a structured AwaitingInputSignal, false if heuristic. */
		structured: boolean;
	};
}

/** Scope a rule applies to. */
export const RULE_SCOPES = ['global', 'project', 'tab'] as const;
export type PianolaRuleScope = (typeof RULE_SCOPES)[number];

/**
 * Editable user rule. Matched against a classification to decide an action.
 * Kept declarative and simple for v1 - no embedded code, just match conditions.
 */
export interface PianolaRule {
	id: string;
	enabled: boolean;
	scope: PianolaRuleScope;
	/** Project path (scope 'project') or tab id (scope 'tab'); omit for global. */
	scopeId?: string;
	match: {
		/** Only fire when classification.risk is at most this level. */
		maxRisk?: PianolaRisk;
		/** Restrict to these signal kinds. */
		kinds?: PianolaSignalKind[];
		/** Case-insensitive substring match against the classification topic. */
		topicIncludes?: string[];
	};
	action: PianolaActionKind;
	/** Reply text for an auto_answer action (template, v1). */
	answer?: string;
	/** Lower runs first. */
	priority: number;
	createdAt: number;
	updatedAt: number;
	description?: string;
}

/**
 * Decision the policy engine produced for a classification. Discriminated on
 * `action` so `answer` only exists on an auto_answer decision - impossible
 * states (e.g. an escalate carrying an answer) are unrepresentable.
 */
export type PianolaDecision =
	| { action: 'auto_answer'; answer: string; matchedRuleId: string | null; reason: string }
	| { action: 'escalate'; matchedRuleId: string | null; reason: string }
	| { action: 'ignore'; matchedRuleId: string | null; reason: string };
