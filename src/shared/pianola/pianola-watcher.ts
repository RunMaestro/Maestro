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

/**
 * How many polls to wait for Pianola to answer a handed-off prompt before giving
 * up and escalating to the user. Prevents a stalled Pianola from blocking a
 * waiting agent forever. At the default 5s interval this is ~1 minute.
 */
export const HANDOFF_TIMEOUT_POLLS = 12;

/** Why Pianola is pushing a blocking ask to the user's attention. */
export type PianolaNotifyKind = 'escalate' | 'handoff_failed' | 'handoff_timeout';

/** A user-facing notification request (a blocking ask the user must see). */
export interface PianolaNotifyEvent {
	kind: PianolaNotifyKind;
	target: WatchTarget;
	classification: PianolaClassification;
	/** True for high-risk asks (notification should be sticky / louder). */
	highRisk: boolean;
}

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
	/**
	 * Push a blocking ask to the user's attention (e.g. a desktop toast). Optional:
	 * when omitted, escalations are recorded to the audit log only (the old
	 * behavior). Fired on escalate, handoff delivery failure, and handoff timeout.
	 */
	notify?: (event: PianolaNotifyEvent) => void | Promise<void>;
}

/** Per-tab loop state, carried between iterations. */
export interface WatchState {
	/** Id of the last assistant message we already finished handling (dedup guard). */
	lastHandledMessageId: string | null;
	/** A prompt whose dispatch failed and is awaiting another attempt. */
	pendingRetry: { messageId: string; attempts: number } | null;
	/**
	 * A prompt handed off to Pianola and awaiting its reply. While set, we do not
	 * re-hand-off the same prompt; if Pianola does not answer within
	 * HANDOFF_TIMEOUT_POLLS we escalate to the user instead of blocking forever.
	 * Carries the original ask's classification so the resolution (recorded when
	 * the agent advances) is auditable with the same kind/risk/topic as the ask.
	 */
	pendingHandoff: {
		messageId: string;
		polls: number;
		classification: PianolaClassification;
	} | null;
}

export function initialWatchState(): WatchState {
	return { lastHandledMessageId: null, pendingRetry: null, pendingHandoff: null };
}

/**
 * Seed watch state from the decision audit log so a restarted watcher does not
 * re-act on a prompt it already handled. Without this, `initialWatchState()`
 * starts with no cursor and the still-waiting prompt is re-classified and
 * (critically) auto-answered a SECOND time. We take the most recent recorded
 * prompt for this tab as the handled cursor. A prompt mid-handoff is restored to
 * `pendingHandoff` so its timeout is honored across the restart. A latest record
 * whose auto_answer dispatch FAILED (dispatched===false, non-dry-run) is NOT
 * adopted as handled, so the still-waiting prompt is re-attempted/escalated.
 *
 * Pure: callers pass the records (chronological, oldest first) they read.
 */
export function rehydrateWatchState(
	records: readonly PianolaDecisionRecord[],
	tabId: string
): WatchState {
	let lastRecord: PianolaDecisionRecord | null = null;
	let lastMid: string | null = null;
	for (const r of records) {
		if (r.tabId !== tabId) continue;
		const mid = r.classification.evidence.messageId;
		if (!mid) continue;
		lastRecord = r;
		lastMid = mid;
	}
	if (!lastRecord || !lastMid) {
		return { lastHandledMessageId: null, pendingRetry: null, pendingHandoff: null };
	}
	// A successfully-delivered handoff (escalate decision, not dispatched, no
	// error) means we were awaiting Pianola's reply when we stopped. Restore the
	// pending-handoff so the timeout resumes rather than re-handing-off, and keep
	// the cursor behind it so the pending-handoff branch can time it out.
	const isHandoff =
		lastRecord.decision.action === 'escalate' &&
		/handed off/i.test(lastRecord.decision.reason) &&
		!lastRecord.error;
	if (isHandoff) {
		return {
			lastHandledMessageId: null,
			pendingRetry: null,
			pendingHandoff: { messageId: lastMid, polls: 0, classification: lastRecord.classification },
		};
	}
	// A non-dry-run auto_answer that was NOT dispatched means the dispatch FAILED:
	// the waiting prompt was never actually answered. Do NOT adopt it as the
	// handled cursor - otherwise on restart the still-awaiting prompt is skipped as
	// "already handled" and silently dropped. Leaving the cursor behind it lets the
	// next iteration re-attempt and ultimately escalate the prompt.
	const failedAutoAnswer =
		lastRecord.decision.action === 'auto_answer' &&
		lastRecord.dispatched === false &&
		lastRecord.dryRun === false;
	if (failedAutoAnswer) {
		return { lastHandledMessageId: null, pendingRetry: null, pendingHandoff: null };
	}
	return { lastHandledMessageId: lastMid, pendingRetry: null, pendingHandoff: null };
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
	/** True when a pending handoff resolved (agent advanced) and was recorded. */
	handoffResolved?: boolean;
	/** True when a handoff was attempted but delivery to Pianola failed. */
	handoffFailed?: boolean;
	/** True when a pending handoff timed out and was escalated to the user. */
	handoffTimedOut?: boolean;
	/** True when this iteration escalated to the user and fired a notification. */
	notified?: boolean;
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
	if (result.handoffResolved) {
		return `[pianola] ${c.kind}/${c.risk} -> handoff resolved${detail}`;
	}
	if (result.handoff) {
		const errSuffix = error ? ` (handoff error: ${error})` : '';
		return `[pianola] ${c.kind}/${c.risk} -> handoff to Pianola${detail}${errSuffix}`;
	}
	const errSuffix = error ? ` (dispatch error: ${error})` : '';
	return `[pianola] ${c.kind}/${c.risk} -> ${decision.action}${detail}${errSuffix}`;
}

/** Fire a user notification, swallowing errors so a notify failure never breaks the loop. */
async function safeNotify(deps: WatchDeps, event: PianolaNotifyEvent): Promise<boolean> {
	if (!deps.notify) return false;
	try {
		await deps.notify(event);
		return true;
	} catch {
		// A failed toast must not crash autonomous watching; the audit record stands.
		return false;
	}
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
 * Best-effort answer for a resolved handoff: the reply Pianola dispatched shows
 * up as the first user-role message after the awaiting prompt in the agent's
 * transcript tail. Truncated for the audit log; falls back to a clear marker
 * when the prompt has already scrolled out of the polled tail.
 */
function observeHandoffAnswer(
	messages: readonly PianolaMessage[],
	promptMessageId: string
): string {
	const idx = messages.findIndex((m) => m.id === promptMessageId);
	if (idx >= 0) {
		for (let i = idx + 1; i < messages.length; i++) {
			if (messages[i].role === 'user') {
				const text = messages[i].content.trim();
				return text.length > 200 ? `${text.slice(0, 197)}...` : text;
			}
		}
	}
	return '(answer not in polled transcript tail)';
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
		// A pending handoff resolves when the agent stops awaiting input: it
		// advanced past the handed-off prompt, so Pianola (or the user) answered.
		// Record the observed resolution so handoff-driven answers are auditable
		// like rule-driven ones, then clear the handoff and advance the cursor.
		if (state.pendingHandoff) {
			const resolved = state.pendingHandoff;
			const resolution: PianolaDecision = {
				action: 'auto_answer',
				answer: observeHandoffAnswer(messages, resolved.messageId),
				matchedRuleId: null,
				reason: 'handed-off ask resolved; agent advanced',
			};
			const record = buildRecord(deps, target, resolved.classification, resolution, {
				id: deps.genId(),
				dispatched: true,
				dryRun: false,
			});
			deps.recordDecision(record);
			const result: IterationResult = {
				classification: resolved.classification,
				decision: resolution,
				record,
				acted: true,
				dispatched: true,
				handoffResolved: true,
			};
			deps.log(describe(result));
			return {
				state: {
					lastHandledMessageId: resolved.messageId,
					pendingRetry: null,
					pendingHandoff: null,
				},
				result,
			};
		}
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
	const handoffEligible =
		uncoveredEscalation &&
		classification.risk !== 'high' &&
		!options.dryRun &&
		!!deps.resolveProfile &&
		!!deps.requestJudgment;

	// A handoff already in flight for THIS prompt: do not re-hand-off. Wait for
	// Pianola to answer (the agent will move on, changing messageId), and time out
	// to a user escalation if it never does.
	if (handoffEligible && state.pendingHandoff && state.pendingHandoff.messageId === messageId) {
		const polls = state.pendingHandoff.polls + 1;
		if (polls < HANDOFF_TIMEOUT_POLLS) {
			const result: IterationResult = {
				classification,
				decision: null,
				record: null,
				acted: false,
				dispatched: false,
				skipped: `awaiting Pianola (${polls}/${HANDOFF_TIMEOUT_POLLS})`,
			};
			deps.log(describe(result));
			return {
				state: {
					...state,
					pendingHandoff: {
						messageId: messageId!,
						polls,
						classification: state.pendingHandoff.classification,
					},
				},
				result,
			};
		}
		// Timed out: Pianola never answered. Escalate to the user.
		const timeoutDecision: PianolaDecision = {
			action: 'escalate',
			matchedRuleId: null,
			reason: 'handoff to Pianola timed out; escalated to user',
		};
		const record = buildRecord(deps, target, classification, timeoutDecision, {
			id: deps.genId(),
			dispatched: false,
			dryRun: false,
		});
		deps.recordDecision(record);
		const notified = await safeNotify(deps, {
			kind: 'handoff_timeout',
			target,
			classification,
			highRisk: classification.risk === 'high',
		});
		const result: IterationResult = {
			classification,
			decision: timeoutDecision,
			record,
			acted: true,
			dispatched: false,
			handoffTimedOut: true,
			notified,
		};
		deps.log(describe(result));
		return {
			state: {
				lastHandledMessageId: messageId ?? state.lastHandledMessageId,
				pendingRetry: null,
				pendingHandoff: null,
			},
			result,
		};
	}

	// Fresh handoff: rules did not cover this ask, it is not high risk, a profile
	// exists, and Pianola is reachable. Hand the decision to Pianola to judge.
	if (handoffEligible) {
		const profile = deps.resolveProfile!(target.projectPath);
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
			const res = await deps.requestJudgment!({
				target,
				classification,
				profile,
				promptText: relevant?.awaitingInput?.prompt ?? relevant?.content,
				options: relevant?.awaitingInput?.options,
			});

			if (res.success) {
				const outcome = buildRecord(deps, target, classification, handoffDecision, {
					id,
					dispatched: false,
					dryRun: false,
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
				deps.log(describe(result));
				// Do NOT advance lastHandledMessageId: track the pending handoff so we
				// can time it out if Pianola never answers. The pending-handoff guard
				// above prevents re-handing-off the same prompt next poll.
				return {
					state: {
						lastHandledMessageId: state.lastHandledMessageId,
						pendingRetry: null,
						pendingHandoff: { messageId: messageId!, polls: 0, classification },
					},
					result,
				};
			}

			// Handoff delivery to Pianola failed: do NOT drop the ask. Fall back to a
			// user escalation, audited and notified, so the waiting agent is never
			// silently abandoned.
			const error = res.error ?? 'handoff failed';
			const fallbackDecision: PianolaDecision = {
				action: 'escalate',
				matchedRuleId: null,
				reason: `handoff to Pianola failed (${error}); escalated to user`,
			};
			const outcome = buildRecord(deps, target, classification, fallbackDecision, {
				id,
				dispatched: false,
				dryRun: false,
				error,
			});
			deps.recordDecision(outcome);
			const notified = await safeNotify(deps, {
				kind: 'handoff_failed',
				target,
				classification,
				highRisk: classification.risk === 'high',
			});
			const result: IterationResult = {
				classification,
				decision: fallbackDecision,
				record: outcome,
				acted: true,
				dispatched: false,
				handoffFailed: true,
				notified,
			};
			deps.log(describe(result, error));
			return {
				state: {
					lastHandledMessageId: messageId ?? state.lastHandledMessageId,
					pendingRetry: null,
					pendingHandoff: null,
				},
				result,
			};
		}
	}

	const willDispatch = decision.action === 'auto_answer' && !options.dryRun;

	// Non-dispatch decisions (escalate / ignore / dry-run auto-answer): a single
	// audit record, and the prompt is considered handled. A real escalation (not a
	// dry-run preview, not ignore) pushes a notification so the blocking ask reaches
	// the user instead of dying in the audit log.
	if (!willDispatch) {
		const record = buildRecord(deps, target, classification, decision, {
			id: deps.genId(),
			dispatched: false,
			dryRun: options.dryRun,
		});
		deps.recordDecision(record);
		let notified = false;
		if (decision.action === 'escalate' && !options.dryRun) {
			notified = await safeNotify(deps, {
				kind: 'escalate',
				target,
				classification,
				highRisk: classification.risk === 'high',
			});
		}
		const result: IterationResult = {
			classification,
			decision,
			record,
			acted: true,
			dispatched: false,
			notified,
		};
		deps.log(describe(result));
		return {
			state: {
				lastHandledMessageId: messageId ?? state.lastHandledMessageId,
				pendingRetry: null,
				pendingHandoff: null,
			},
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
			state: {
				lastHandledMessageId: messageId ?? state.lastHandledMessageId,
				pendingRetry: null,
				pendingHandoff: null,
			},
			result,
		};
	}

	// Dispatch failed at the attempt cap. Give up on retrying, but NEVER silently:
	// record an escalate decision and notify the user, because the dedup cursor is
	// about to advance past this prompt (so it will be skipped as "already handled"
	// forever). Without this the blocked agent dies in the audit log.
	if (!messageId || attempts >= MAX_DISPATCH_ATTEMPTS) {
		deps.log(`[pianola] giving up on prompt after ${attempts} dispatch attempt(s); escalating`);
		const giveUpDecision: PianolaDecision = {
			action: 'escalate',
			matchedRuleId: decision.matchedRuleId,
			reason: `auto-answer dispatch failed after ${attempts} attempt(s); escalating to user`,
		};
		const escalation = buildRecord(deps, target, classification, giveUpDecision, {
			id: deps.genId(),
			dispatched: false,
			dryRun: false,
			error,
		});
		deps.recordDecision(escalation);
		const notified = options.dryRun
			? false
			: await safeNotify(deps, {
					kind: 'handoff_failed',
					target,
					classification,
					highRisk: classification.risk === 'high',
				});
		return {
			state: {
				lastHandledMessageId: messageId ?? state.lastHandledMessageId,
				pendingRetry: null,
				pendingHandoff: null,
			},
			result: { ...result, decision: giveUpDecision, record: escalation, notified },
		};
	}
	return {
		state: {
			lastHandledMessageId: state.lastHandledMessageId,
			pendingRetry: { messageId, attempts },
			pendingHandoff: null,
		},
		result,
	};
}
