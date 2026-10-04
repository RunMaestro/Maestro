/** Terminal size rules for the shell layout (spec section 5.1). */

export const MIN_COLUMNS = 80;
export const MIN_ROWS = 24;
/** Below this width the Agents pane starts hidden; a key brings it back. */
export const AGENTS_PANE_AUTO_HIDE_BELOW = 100;
/** The Conversation pane never gets less than this, whatever the pane width setting says. */
export const MIN_CONVERSATION_COLUMNS = 40;

export interface TerminalSize {
	columns: number;
	rows: number;
}

export function isTerminalTooSmall(size: TerminalSize): boolean {
	return size.columns < MIN_COLUMNS || size.rows < MIN_ROWS;
}

/**
 * Is the Agents pane drawn? `override` is the user's toggle for this session:
 * unset means "by width" (shown from 100 columns up), set means "as asked".
 */
export function isAgentsPaneVisible(columns: number, override: boolean | undefined): boolean {
	return override ?? columns >= AGENTS_PANE_AUTO_HIDE_BELOW;
}

/** The Agents pane's width after leaving the Conversation pane its minimum. */
export function effectiveAgentsPaneWidth(columns: number, preferred: number): number {
	return Math.max(0, Math.min(preferred, columns - MIN_CONVERSATION_COLUMNS));
}

export type PaneId = 'agents' | 'conversation';

/** The panes on screen, left to right. Tab cycles through exactly these. */
export function visiblePanes(agentsPaneVisible: boolean): PaneId[] {
	return agentsPaneVisible ? ['agents', 'conversation'] : ['conversation'];
}

/**
 * The pane `delta` steps from `current`, wrapping. A pane that is not on screen
 * cannot hold focus, so focus on a hidden pane counts as the first visible one.
 */
export function cyclePane(panes: readonly PaneId[], current: PaneId, delta: number): PaneId {
	const index = Math.max(0, panes.indexOf(current));
	return panes[(index + delta + panes.length) % panes.length];
}
