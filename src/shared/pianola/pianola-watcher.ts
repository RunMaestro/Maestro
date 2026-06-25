/**
 * Pianola watcher - one iteration of the watch loop, with all I/O injected.
 *
 * This is the orchestration that ties the brain together: enrich a transcript
 * with structured awaiting-input signals, classify it, decide via the rules,
 * and (for an auto-answer that isn't a dry run) dispatch. It records every
 * actionable decision. All side effects come in through `WatchDeps`, so the loop
 * is unit-testable without a desktop app, network, or filesystem, and the same
 * logic can back both the CLI watcher and a future in-app engine.
 */

import type { PianolaClassification, PianolaDecision, PianolaMessage, PianolaRule } from './types';
import type { PianolaDecisionRecord } from './storage';
import { classifyMessages } from './pianola-classifier';
import { enrichWithAwaitingInput } from './pianola-awaiting-detector';
import { decide } from './pianola-policy';

/** The tab Pianola is watching and the agent it would dispatch to. */
export interface WatchTarget {
	tabId: string;
	agentId: string;
	projectPath?: string;
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
}

/** Per-tab loop state, carried between iterations. */
export interface WatchState {
	/** Id of the last assistant message we already acted on (dedup guard). */
	lastHandledMessageId: string | null;
}

export function initialWatchState(): WatchState {
	return { lastHandledMessageId: null };
}

export interface IterationResult {
	classification: PianolaClassification;
	/** The decision taken, or null when nothing actionable / already handled. */
	decision: PianolaDecision | null;
	record: PianolaDecisionRecord | null;
	/** True when this iteration produced a new decision. */
	acted: boolean;
	/** Reason an actionable prompt was skipped (e.g. already handled). */
	skipped?: string;
}

function describe(result: IterationResult): string {
	const { classification: c, decision } = result;
	if (!decision) {
		return result.skipped
			? `[pianola] skip (${result.skipped})`
			: `[pianola] none (${c.evidence.reason})`;
	}
	const detail = c.topic ? `: ${c.topic}` : '';
	return `[pianola] ${c.kind}/${c.risk} -> ${decision.action}${detail}`;
}

/**
 * Run one watch iteration over the latest transcript for a tab. Returns the next
 * state and a structured result. Pure aside from the injected deps; never throws
 * for an expected dispatch failure (it is recorded on the audit entry instead).
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
		const result: IterationResult = { classification, decision: null, record: null, acted: false };
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

	let dispatched = false;
	let error: string | undefined;
	if (decision.action === 'auto_answer' && !options.dryRun) {
		const res = await deps.dispatch(target, decision.answer);
		dispatched = res.success;
		if (!res.success) error = res.error ?? 'dispatch failed';
	}

	const record: PianolaDecisionRecord = {
		id: deps.genId(),
		timestamp: deps.now(),
		tabId: target.tabId,
		agentId: target.agentId,
		projectPath: target.projectPath,
		classification,
		decision,
		dispatched,
		dryRun: options.dryRun,
		...(error ? { error } : {}),
	};
	deps.recordDecision(record);

	const result: IterationResult = { classification, decision, record, acted: true };
	deps.log(describe(result) + (error ? ` (dispatch error: ${error})` : ''));

	// Advance the dedup cursor so we don't re-handle the same prompt next poll.
	const nextState: WatchState = {
		lastHandledMessageId: messageId ?? state.lastHandledMessageId,
	};
	return { state: nextState, result };
}
