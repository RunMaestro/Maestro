/**
 * Shared label/title helper for the Claude "token source" pill.
 *
 * A single source of truth for how a Claude turn's interface is described so the
 * live chat pill (`TerminalOutput`), the History panel pill (`HistoryEntryItem`),
 * and any future consumer can never drift. Intentionally dependency-free (no
 * React, no theme) so it can be imported from renderer, main, or CLI code.
 *
 * Token source meaning:
 * - `interactive` => the turn was captured via maestro-p driving the Claude TUI
 *   (Max plan quota, ~$0 per token).
 * - `api` => the turn was captured via `claude --print` (per-token API billing).
 */

export interface TokenSourcePillInput {
	/** Which interface produced the turn. */
	mode: 'interactive' | 'api';
	/**
	 * Why the mode was chosen. `auto` = user/usage selected; `limit` = forced
	 * API fallback because the Max plan quota was exhausted. Omit when unknown
	 * (e.g. the live chat pill, which has no per-turn reason in scope).
	 */
	reason?: 'auto' | 'limit';
	/**
	 * When true, prefix the label with "Dynamic " and note Dynamic Mode in the
	 * tooltip - mirrors the live chat pill's existing behavior.
	 */
	adaptive?: boolean;
}

export interface TokenSourcePill {
	/** Short pill text, e.g. `TUI Wrapper`, `claude -p`, `Dynamic TUI Wrapper`. */
	label: string;
	/** Tooltip describing how the turn was captured (or why it fell back). */
	title: string;
	/** Convenience flag: true for the maestro-p TUI source. */
	isTui: boolean;
}

/**
 * Build the label, tooltip, and `isTui` flag for a Claude token-source pill.
 * Pure function - same input always yields the same output.
 */
export function getTokenSourcePill(input: TokenSourcePillInput): TokenSourcePill {
	const isTui = input.mode === 'interactive';
	const adaptive = input.adaptive === true;
	const label = `${adaptive ? 'Dynamic ' : ''}${isTui ? 'TUI Wrapper' : 'claude -p'}`;

	let title: string;
	if (input.reason === 'limit') {
		// Forced fallback wording mirrors the AgentConfigPanel pill.
		title = 'Forced fallback: Max plan 5-hour or weekly quota is exhausted.';
	} else if (isTui) {
		title = `Captured via maestro-p driving the Claude TUI${adaptive ? ' (Dynamic Mode enabled)' : ''}`;
	} else {
		title = `Captured via claude --print${adaptive ? ' (Dynamic Mode enabled - fell back to API)' : ''}`;
	}

	return { label, title, isTui };
}
