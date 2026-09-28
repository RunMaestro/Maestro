/**
 * Stall detection for Auto Run documents: deciding when an agent has stopped
 * making progress and the engine should give up on a document.
 *
 * Both Auto Run engines dispatch tasks in a loop whose only natural exit is the
 * unchecked-task count reaching zero. An agent that cannot finish a task leaves
 * it unchecked, so without a second exit the same task is dispatched forever.
 * That is what makes this shared rather than a renderer detail: the CLI engine
 * (`src/cli/services/batch-processor.ts`) cannot import from `src/renderer`,
 * and for a long time it simply had no stall guard at all. The observable cost
 * was not just wasted tokens - it pushed the halt marker into service as the
 * only way out of a stuck run, which is why halt kept turning up in playbooks
 * where nothing was actually wrong.
 *
 * The heuristic is deliberately TASK-based, not content-based. An agent that
 * cannot do the work will often write an explanation into the document instead,
 * so any comparison of document bytes sees "the file changed" and resets the
 * counter, hiding the stall indefinitely. Counting checkboxes ignores that
 * churn: real progress means a box got ticked, or the task list itself grew or
 * shrank.
 *
 * @see countMarkdownTasks for the counting the two engines share
 */

/** How many consecutive no-progress runs a document gets before it is skipped. */
export const MAX_CONSECUTIVE_NO_CHANGES = 3;

/** Checkbox counts for one document, before and after a task ran. */
export interface TaskProgressSnapshot {
	checked: number;
	unchecked: number;
}

export interface StallEvaluation {
	/** The counter to carry into the next iteration. */
	consecutiveNoChangeCount: number;
	/** True once the counter reaches {@link MAX_CONSECUTIVE_NO_CHANGES}. */
	stalled: boolean;
	/** Whether the task set moved at all - useful for logging the near-misses. */
	taskSetChanged: boolean;
	/** Human-readable reason, set only when `stalled`. */
	reason?: string;
}

export interface EvaluateStallInput {
	/** Counts read before the task was dispatched. */
	before: TaskProgressSnapshot;
	/** Counts read after the agent returned. */
	after: TaskProgressSnapshot;
	/** The counter carried in from the previous iteration. */
	consecutiveNoChangeCount: number;
	/**
	 * Set when the agent hung or blew its time budget. A watchdog failure is not
	 * a slow start, it is a dead run, so it trips the threshold immediately
	 * rather than burning two more dispatches to reach the same conclusion.
	 */
	watchdogFailure?: boolean;
}

/**
 * Decide whether a document has stalled, given one iteration's task counts.
 *
 * Progress is any movement in the task set: a box ticked (checked went up), or
 * tasks added or removed (either count changed). Anything else - including a
 * document that grew by a thousand words of apology - is no progress.
 */
export function evaluateStall({
	before,
	after,
	consecutiveNoChangeCount,
	watchdogFailure = false,
}: EvaluateStallInput): StallEvaluation {
	const taskSetChanged = after.checked !== before.checked || after.unchecked !== before.unchecked;
	const tasksCompleted = after.checked - before.checked;

	let next: number;
	if (watchdogFailure) {
		next = MAX_CONSECUTIVE_NO_CHANGES;
	} else if (tasksCompleted <= 0 && !taskSetChanged) {
		next = consecutiveNoChangeCount + 1;
	} else {
		next = 0;
	}

	const stalled = next >= MAX_CONSECUTIVE_NO_CHANGES;
	return {
		consecutiveNoChangeCount: next,
		stalled,
		taskSetChanged,
		reason: stalled ? describeStall(next, watchdogFailure) : undefined,
	};
}

/** The sentence shown in history entries, toasts, and CLI output. */
export function describeStall(count: number, watchdogFailure = false): string {
	return watchdogFailure
		? 'agent hung or exceeded its time budget'
		: `${count} consecutive runs with no progress`;
}
