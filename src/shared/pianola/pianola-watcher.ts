/**
 * Pianola watcher - one iteration of the watch loop, with all I/O injected.
 *
 * Ties the brain together: enrich a transcript with structured awaiting-input
 * signals, classify it, decide via the rules, and (for a live auto-answer)
 * dispatch. All side effects come in through `WatchDeps`, so the loop is
 * unit-testable without a desktop app, network, or filesystem, and the same
 * logic can back both the CLI watcher and a future in-app engine.
 *
 * Safety invariants:
 *  - Audit before dispatch: the decision is recorded BEFORE any message is sent,
 *    so Pianola can never dispatch without an audit trail. A second record
 *    captures the dispatch outcome (readers fold the two by id).
 *  - Bounded retry: a failed dispatch does NOT advance the dedup cursor, so the
 *    same prompt is retried on the next poll, up to MAX_DISPATCH_ATTEMPTS, after
 *    which Pianola gives up on that prompt rather than looping forever.
 */

import type { PianolaClassification, PianolaDecision, PianolaMessage, PianolaRule } from './types';
import type { PianolaDecisionRecord, PianolaProfileEntry } from './storage';
import { classifyMessages } from './pianola-classifier';
import { enrichWithAwaitingInput } from './pianola-awaiting-detector';
import { decide } from './pianola-policy';

/** Max dispatch attempts for a single prompt before giving up. */
export const MAX_DISPATCH_ATTEMPTS = 3;

/** The tab Pianola is watching and the agent it would dispatch to. */
export interface WatchTarget {
	tabId: string;
	agentId: string;
	projectPath?: string;
}

/**
 * An ask the rules did not cover, handed to Pianola (an LLM agent) to judge
 * against the user's learned decision profile rather than escalating straight to
 * the user. The watcher provides everything Pianola needs to decide.
 */
export interface PianolaJudgmentRequest {
	target: WatchTarget;
	classification: PianolaClassification;
	profile: PianolaProfileEntry;
	/** The agent's awaiting-input prompt text, when extractable. */
	promptText?: string;
	/** Discrete options the agent offered, if any. */
	options?: string[];
}

/** Injected side effects. */
export interface WatchDeps {
	readRules: () => PianolaRule[];
	/** Send an auto-answer to the target tab. */
	dispatch: (target: WatchTarget, answer: string) => Promise<{ success: boolean; error?: string }>;
	recordDecision: (record: PianolaDecisionRecord) => void;
	/** ISO-8601 timestamp source (injected for determinism in tests). */
	now: () => string;
	/** Unique id source for audit records. */
	genId: () => string;
	/** Human-readable progress line. */
	log: (line: string) => void;
	/**
	 * Resolve the learned decision profile for a project (null when none). Its
	 * presence, together with `requestJudgment`, enables the thought-based handoff
	 * path; omit both to keep the watcher purely rule-driven (the default for a
	 * plain CLI watch with no Pianola agent to hand off to).
	 */
	resolveProfile?: (projectPath?: string) => PianolaProfileEntry | null;
	/** Hand an uncovered, non-high-risk ask to Pianola to judge against the profile. */
	requestJudgment?: (
		request: PianolaJudgmentRequest
	) => Promise<{ success: boolean; error?: string }>;
}

/** Per-tab loop state, carried between iterations. */
export interface WatchState {
	/** Id of the last assistant message we already finished handling (dedup guard). */
	lastHandledMessageId: string | null;
	/** A prompt whose dispatch failed and is awaiting another attempt. */
	pendingRetry: { messageId: string; attempts: number } | null;
}

export function initialWatchState(): WatchState {
	return { lastHandledMessageId: null, pendingRetry: null };
}

export interface IterationResult {
	classification: PianolaClassification;
	/** The decision taken, or null when nothing actionable / already handled. */
	decision: PianolaDecision | null;
	record: PianolaDecisionRecord | null;
	/** True when this iteration produced a new decision. */
	acted: boolean;
	/** True when an auto-answer was sent successfully. */
	dispatched: boolean;
	/** True when the ask was handed to Pianola to judge against the profile. */
	handoff?: boolean;
	/** Reason an actionable prompt was skipped (e.g. already handled). */
	skipped?: string;
}

function describe(result: IterationResult, error?: string): string {
	const { classification: c, decision } = result;
	if (!decision) {
		return result.skipped
			? `[pianola] skip (${result.skipped})`
			: `[pianola] none (${c.evidence.reason})`;
	}
	const detail = c.topic ? `: ${c.topic}` : '';
	if (result.handoff) {
		const errSuffix = error ? ` (handoff error: ${error})` : '';
		return `[pianola] ${c.kind}/${c.risk} -> handoff to Pianola${detail}${errSuffix}`;
	}
	const errSuffix = error ? ` (dispatch error: ${error})` : '';
	return `[pianola] ${c.kind}/${c.risk} -> ${decision.action}${detail}${errSuffix}`;
}

function buildRecord(
	deps: WatchDeps,
	target: WatchTarget,
	classification: PianolaClassification,
	decision: PianolaDecision,
	fields: { id: string; dispatched: boolean; dryRun: boolean; error?: string }
): PianolaDecisionRecord {
	return {
		id: fields.id,
		timestamp: deps.now(),
		tabId: target.tabId,
		agentId: target.agentId,
		projectPath: target.projectPath,
		classification,
		decision,
		dispatched: fields.dispatched,
		dryRun: fields.dryRun,
		...(fields.error ? { error: fields.error } : {}),
	};
}

/**
 * Run one watch iteration over the latest transcript for a tab. Returns the next
 * state and a structured result. Never throws for an expected dispatch failure
 * (it is recorded on the audit entry and retried). An audit-write failure is
 * unexpected and propagates BEFORE any dispatch, so the caller fails closed.
 */
export async function runWatchIteration(
	messages: readonly PianolaMessage[],
	target: WatchTarget,
	state: WatchState,
	deps: WatchDeps,
	options: { dryRun: boolean }
): Promise<{ state: WatchState; result: IterationResult }> {
	const enriched = enrichWithAwaitingInput(messages);
	const classification = classifyMessages(enriched);

	if (classification.kind === 'none') {
		const result: IterationResult = {
			classification,
			decision: null,
			record: null,
			acted: false,
			dispatched: false,
		};
		deps.log(describe(result));
		return { state, result };
	}

	const messageId = classification.evidence.messageId;
	if (messageId && messageId === state.lastHandledMessageId) {
		const result: IterationResult = {
			classification,
			decision: null,
			record: null,
			acted: false,
			dispatched: false,
			skipped: 'already handled this prompt',
		};
		deps.log(describe(result));
		return { state, result };
	}

	const rules = deps.readRules();
	const decision = decide(classification, rules, {
		projectPath: target.projectPath,
		tabId: target.tabId,
	});

	// Thought-based handoff. When the rules did not cover this ask (the policy fell
	// through to a default escalate, matchedRuleId === null) and it is not high
	// risk, hand the decision to Pianola (an LLM agent) to judge against the user's
	// learned profile instead of escalating straight to the user. High risk always
	// escalates; a dry run never hands off; and we only hand off when both handoff
	// deps are wired and a profile actually exists for this project.
	const uncoveredEscalation = decision.action === 'escalate' && decision.matchedRuleId === null;
	if (
		uncoveredEscalation &&
		classification.risk !== 'high' &&
		!options.dryRun &&
		deps.resolveProfile &&
		deps.requestJudgment
	) {
		const profile = deps.resolveProfile(target.projectPath);
		if (profile) {
			const handoffDecision: PianolaDecision = {
				action: 'escalate',
				matchedRuleId: null,
				reason: 'handed off to Pianola for profile-based judgment',
			};
			// Audit the intent BEFORE the side effect, mirroring the auto-answer path,
			// so a handoff is never sent without an audit trail. Intent and outcome
			// share an id; readers fold the two.
			const id = deps.genId();
			const intent = buildRecord(deps, target, classification, handoffDecision, {
				id,
				dispatched: false,
				dryRun: false,
			});
			deps.recordDecision(intent); // throws here => no handoff

			const relevant = messageId ? messages.find((m) => m.id === messageId) : undefined;
			const res = await deps.requestJudgment({
				target,
				classification,
				profile,
				promptText: relevant?.awaitingInput?.prompt ?? relevant?.content,
				options: relevant?.awaitingInput?.options,
			});
			const error = res.success ? undefined : (res.error ?? 'handoff failed');

			const outcome = buildRecord(deps, target, classification, handoffDecision, {
				id,
				dispatched: false,
				dryRun: false,
				error,
			});
			deps.recordDecision(outcome);

			const result: IterationResult = {
				classification,
				decision: handoffDecision,
				record: outcome,
				acted: true,
				dispatched: false,
				handoff: true,
			};
			deps.log(describe(result, error));
			return {
				state: {
					lastHandledMessageId: messageId ?? state.lastHandledMessageId,
					pendingRetry: null,
				},
				result,
			};
		}
	}

	const willDispatch = decision.action === 'auto_answer' && !options.dryRun;

	// Non-dispatch decisions (escalate / ignore / dry-run auto-answer): a single
	// audit record, and the prompt is considered handled.
	if (!willDispatch) {
		const record = buildRecord(deps, target, classification, decision, {
			id: deps.genId(),
			dispatched: false,
			dryRun: options.dryRun,
		});
		deps.recordDecision(record);
		const result: IterationResult = {
			classification,
			decision,
			record,
			acted: true,
			dispatched: false,
		};
		deps.log(describe(result));
		return {
			state: { lastHandledMessageId: messageId ?? state.lastHandledMessageId, pendingRetry: null },
			result,
		};
	}

	// Live auto-answer. Audit the intent BEFORE dispatching so a message is never
	// sent without a record. The id is shared by the intent and outcome records.
	const id = deps.genId();
	const priorAttempts =
		state.pendingRetry && state.pendingRetry.messageId === messageId
			? state.pendingRetry.attempts
			: 0;
	const attempts = priorAttempts + 1;

	const intent = buildRecord(deps, target, classification, decision, {
		id,
		dispatched: false,
		dryRun: false,
	});
	deps.recordDecision(intent); // audit-before-dispatch; throws here => no dispatch

	const res = await deps.dispatch(target, decision.action === 'auto_answer' ? decision.answer : '');
	const error = res.success ? undefined : (res.error ?? 'dispatch failed');

	const outcome = buildRecord(deps, target, classification, decision, {
		id,
		dispatched: res.success,
		dryRun: false,
		error,
	});
	deps.recordDecision(outcome);

	const result: IterationResult = {
		classification,
		decision,
		record: outcome,
		acted: true,
		dispatched: res.success,
	};
	deps.log(describe(result, error));

	if (res.success) {
		return {
			state: { lastHandledMessageId: messageId ?? state.lastHandledMessageId, pendingRetry: null },
			result,
		};
	}

	// Dispatch failed. Retry on the next poll until we hit the attempt cap, then
	// give up on this prompt so we do not loop on it forever.
	if (!messageId || attempts >= MAX_DISPATCH_ATTEMPTS) {
		deps.log(`[pianola] giving up on prompt after ${attempts} dispatch attempt(s)`);
		return {
			state: { lastHandledMessageId: messageId ?? state.lastHandledMessageId, pendingRetry: null },
			result,
		};
	}
	return {
		state: {
			lastHandledMessageId: state.lastHandledMessageId,
			pendingRetry: { messageId, attempts },
		},
		result,
	};
}
