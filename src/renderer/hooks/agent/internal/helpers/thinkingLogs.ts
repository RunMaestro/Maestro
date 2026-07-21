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

/**
 * Whether a tab's tool-execution log entries are actually recorded.
 *
 * Tool visibility is a distinct concern from reasoning visibility: a user can
 * want to see which tools ran without streaming thinking text. `showTools`
 * governs it independently of `showThinking`. When `showTools` is absent (tabs
 * persisted before the field existed) we fall back to the tab's thinking state
 * so upgrades see no behavior change; new tabs default `showTools` to `true`.
 */
export function toolLogsRecorded(
	showTools: boolean | undefined,
	showThinking: ThinkingMode | boolean | undefined
): boolean {
	return showTools ?? thinkingLogsRecorded(showThinking);
}
