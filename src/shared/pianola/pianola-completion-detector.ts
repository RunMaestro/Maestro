/**
 * Pianola completion detector - PURE.
 *
 * This is the missing trigger the Pianola orchestrator uses to advance its task
 * DAG. Given an agent's previous and current run state plus the tail of its
 * transcript, it decides whether a dispatched task is `done`, `failed`, or still
 * `working`. The coordinator polls nothing and does no I/O here: it feeds state
 * and recent messages in, gets a verdict out, then starts dependents on `done`
 * and flags botched tasks on `failed`.
 *
 * The success/failure heuristics mirror the Cue completion path
 * (src/main/cue/cue-completion-service.ts): a run that drops out of a working
 * state with no error is a success, and an error status or a failure marker in
 * the output is a failure. The failure-marker patterns are ported from the
 * agent error lexicon (src/main/parsers/error-patterns.ts) using the same
 * word-boundary style as pianola-risk.ts so everyday prose does not trip them.
 *
 * Runtime-agnostic by contract: no fs, no Electron, no Node, no app state, and
 * no renderer types. The state union is declared locally on purpose so this
 * module stays portable across main, renderer, and CLI.
 */

import type { PianolaMessage } from './types';

/** Verdict for a dispatched task. */
export type TaskOutcome = 'done' | 'failed' | 'working';

/**
 * Runtime-agnostic agent run state. Declared here (not imported from the
 * renderer) so the detector stays pure and portable. Mirrors the lifecycle the
 * orchestrator observes: idle (settled), busy (running), waiting_input (asking
 * the user), connecting (spinning up), error (broke).
 */
export type AgentRunState = 'idle' | 'busy' | 'waiting_input' | 'connecting' | 'error';

/** Inputs the detector reasons over. All read-only; nothing is mutated. */
export interface CompletionInput {
	/** State observed on the previous tick, if any. */
	previousState?: AgentRunState;
	/** State observed now. */
	currentState: AgentRunState;
	/** Tail of the transcript, chronological (oldest first). */
	recentMessages: readonly PianolaMessage[];
}

/**
 * Failure markers in agent output. Tool/exit-shaped signals ONLY: an `error`-role
 * message (handled in hasFailureMarker), an `error:`/`fatal:` lead-in, a crash, a
 * non-zero process exit, or a "command failed/not found". We deliberately do NOT
 * match bare `failed`/`failure`/`aborted`: those words appear constantly in
 * successful narration ("0 failed", "the test failed earlier but now passes", "I
 * aborted the old approach and finished"), and a false failure here cascades
 * propagateBlocked() across a task's dependents and stalls the whole plan. For
 * the same reason `exception` only counts in failure-shaped context, and the
 * `error:`/`fatal:` lead-in is guarded against benign negations ("no error:").
 */
export const FAILURE_MARKER_PATTERNS: readonly RegExp[] = [
	// General agent error (verbatim from error-patterns.ts unknown_error tier).
	/\b(fatal|unexpected|internal|unhandled)\s+error\b/i,
	// "error: ..." / "fatal: ..." lead-in: the classic tool/compiler/git prefix.
	// The negative lookbehinds keep benign negations ("no error: ...", "without
	// error: ...") from tripping a false failure while a real prefix still fires.
	/(?<!\bno\s)(?<!\bwithout\s)\b(error|fatal):\s/i,
	// Runtime crashes. `exception` is matched ONLY in failure-shaped context - an
	// uncaught/unhandled/fatal exception, a thrown/raised/throwing one, or an
	// "Exception:" line prefix - so benign prose ("added exception handling",
	// "completed without exception") does NOT fire. Traceback/panic/segfault are
	// strong signals on their own.
	/\b(uncaught|unhandled|fatal)\s+exception\b/i,
	/\b(threw|raised|throwing)\s+(an?\s+)?exception\b/i,
	/(^|\n)\s*exception:\s/i,
	/\b(traceback|stack\s*trace)\b/i,
	/\bpanic(ked)?\b/i,
	/\bsegmentation\s+fault\b/i,
	// Process exit signals.
	/\bnon-?zero\s+exit\b/i,
	/\bexit\s+code\s+[1-9]\b/i,
	/\bcommand\s+(not\s+found|failed)\b/i,
	// Report-shaped "<subject> failed" - immediately followed by `:`, `(`, "with",
	// or end-of-string - so a tool/build report ("Build failed:", "compilation
	// failed: see log") counts, but mid-sentence success narration ("the test
	// failed earlier but now passes", "0 failed") does NOT.
	/\b(build|compil\w+|tests?|lint|typecheck|command|task|job|deploy\w*|install\w*|migration)\s+failed\b(?=\s*[:(]|\s+with\b|\s*$)/i,
];

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
	return patterns.some((re) => re.test(text));
}

/** Is this the assistant speaking (vs user/tool/system)? */
function isAssistant(message: PianolaMessage): boolean {
	return message.role === 'assistant' || message.source === 'ai';
}

/**
 * Find the latest message that is either the assistant or an error entry. The
 * completion verdict only cares about the most recent relevant turn, the same
 * way the classifier keys off the last assistant message.
 */
function lastAssistantOrErrorMessage(messages: readonly PianolaMessage[]): PianolaMessage | null {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const m = messages[i];
		if (m.role === 'error' || isAssistant(m)) return m;
	}
	return null;
}

/**
 * True if the tail shows a failure. An `error`-role message is itself a failure
 * marker (the parser only emits that role for broken runs). Otherwise the latest
 * assistant message is scanned against FAILURE_MARKER_PATTERNS. Exported so the
 * orchestrator and tests can reuse the exact same heuristic.
 */
export function hasFailureMarker(messages: readonly PianolaMessage[]): boolean {
	const latest = lastAssistantOrErrorMessage(messages);
	if (!latest) return false;
	if (latest.role === 'error') return true;
	return matchesAny(latest.content ?? '', FAILURE_MARKER_PATTERNS);
}

/** A working state means the agent is actively running or spinning up. */
function isWorkingState(state: AgentRunState | undefined): boolean {
	return state === 'busy' || state === 'connecting';
}

/**
 * Decide whether a dispatched task is done, failed, or still working. Pure: same
 * input always yields the same verdict. Every branch returns a short, human
 * readable `reason` for the audit log and UI.
 */
export function detectTaskOutcome(input: CompletionInput): {
	outcome: TaskOutcome;
	reason: string;
} {
	const { previousState, currentState, recentMessages } = input;

	// 1. An error state is an unconditional failure.
	if (currentState === 'error') {
		return { outcome: 'failed', reason: 'agent entered error state' };
	}

	// 2. A failure marker in the latest output fails the task even if the agent
	//    otherwise settled to idle (a botched run that exited cleanly).
	if (hasFailureMarker(recentMessages)) {
		return { outcome: 'failed', reason: 'failure marker found in recent output' };
	}

	// 3. A transition out of a working state into idle, with no failure, is a
	//    successful completion - the signal the coordinator advances the DAG on.
	if (isWorkingState(previousState) && currentState === 'idle') {
		return {
			outcome: 'done',
			reason: 'transitioned from working state to idle with no failure',
		};
	}

	// 4. Still running or spinning up.
	if (isWorkingState(currentState)) {
		return { outcome: 'working', reason: 'agent is still busy or connecting' };
	}

	// 5. Awaiting the user. The watcher handles the ask; this is neither done nor
	//    failed from the orchestrator's point of view.
	if (currentState === 'waiting_input') {
		return { outcome: 'working', reason: 'agent is waiting on user input' };
	}

	// 6. Idle with no observed working-to-idle transition: nothing to report yet.
	return { outcome: 'working', reason: 'no completion transition observed' };
}
