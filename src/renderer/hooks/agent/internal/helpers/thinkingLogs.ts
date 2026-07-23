import type { ThinkingMode } from '../../../../types';

/**
 * Whether a tab's per-turn thinking and tool log entries are actually recorded.
 *
 * `useAgentToolExecutionListener` and `useAgentThinkingListener` drop tool and
 * thinking logs when a tab's thinking display is off, to keep memory bounded on
 * tabs the user isn't watching. The synopsis activity gate
 * (`turnDidMeaningfulWork`) keys off those same tool logs, so it MUST consult
 * this predicate: an absent tool log means "no work happened" only when thinking
 * is visible. When thinking is off the log was never written, so absence proves
 * nothing and the gate must not suppress the synopsis (and its History entry).
 *
 * Keep all three call sites in lockstep by routing them through this one
 * predicate. Tolerates the legacy persisted shapes (`boolean` / `undefined`)
 * that predate the `ThinkingMode` string union.
 */
export function thinkingLogsRecorded(showThinking: ThinkingMode | boolean | undefined): boolean {
	return !!showThinking && showThinking !== 'off';
}
