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
