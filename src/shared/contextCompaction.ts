/**
 * Context compaction - asking a provider to summarize its own conversation in
 * place so the session keeps going under the same id.
 *
 * Used by Maestro's automatic recovery from a full context window (see
 * `retryStore.scheduleRetryForError`): when a turn is refused because the
 * conversation no longer fits the model, Maestro compacts the session and
 * resends the prompt instead of surfacing the error.
 */

import type { ToolType } from './types';

/**
 * The prompt that compacts a provider's session when sent as an ordinary
 * headless turn.
 *
 * Only providers verified to honor it are listed. A provider missing here gets
 * no automatic recovery and its context-limit error is surfaced as before:
 * sending an unsupported command would hand the literal text to the model.
 *
 * Claude Code, verified live: `claude --print --resume <id>` with the prompt
 * `/compact` emits `system/compact_boundary`, prints an EMPTY result, exits 0,
 * and keeps the same session id.
 */
const CONTEXT_COMPACT_COMMANDS: Partial<Record<ToolType, string>> = {
	'claude-code': '/compact',
};

/** The compaction prompt for a provider, or undefined when it has none. */
export function getContextCompactCommand(
	toolType: ToolType | string | undefined
): string | undefined {
	if (!toolType) return undefined;
	return CONTEXT_COMPACT_COMMANDS[toolType as ToolType];
}

/**
 * A provider whose context-limit recovery is a REQUIRED feature that has not
 * been qualified. Distinct from a provider that simply has no command: the
 * omission is a recorded blocker (a parity row says so), not a quiet default,
 * and the recovery reports it each time it declines.
 */
export interface ContextCompactionBlocker {
	reason: 'required-feature';
	feature: string;
	/** The parity rows that own the gap. */
	parityRows: readonly string[];
	detail: string;
}

/**
 * Grok: no native compaction operation is qualified. ACP wire 1 and the pinned
 * `_x.ai` extensions advertise no compaction method, a native slash command is
 * admitted only from a live catalog entry (never by name), and the hidden-turn
 * spawner the recovery uses carries no native-command intent. Sending `/compact`
 * as a prompt would hand the literal text to the model and could read as a
 * successful compaction when nothing was compacted.
 */
const CONTEXT_COMPACTION_BLOCKERS: Partial<Record<ToolType, ContextCompactionBlocker>> = {
	grok: {
		reason: 'required-feature',
		feature: 'grok-native-compaction',
		parityRows: ['S34', 'B03'],
		detail:
			'Grok has no qualified native compaction operation, so a conversation that outgrew the context window is not compacted and resent automatically.',
	},
};

/**
 * The required-feature blocker on a provider's context-limit recovery, or
 * undefined when it has none (it either has a command or was never in scope).
 * A provider with a verified command is never blocked.
 */
export function getContextCompactionBlocker(
	toolType: ToolType | string | undefined
): ContextCompactionBlocker | undefined {
	if (!toolType || getContextCompactCommand(toolType)) return undefined;
	return CONTEXT_COMPACTION_BLOCKERS[toolType as ToolType];
}
