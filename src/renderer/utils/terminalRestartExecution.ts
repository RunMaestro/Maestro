// Restart re-execution flow for persisted terminal commands.
//
// When Maestro restarts, terminal tabs that had a command running at shutdown
// are flagged with `persistCommand: true` (see Phase 4 of the
// terminal-persistence plan, `useDebouncedPersistence.ts`). This module
// decides what to do with each such tab once its PTY is back up:
//
//   - 'auto-execute' — pattern matched the user's whitelist; safe to replay
//   - 'skip'         — pattern matched the blacklist (e.g. `rm`), or the
//                       persisted command is empty / missing
//   - 'prompt'       — neither list matched; show a banner and pre-fill the
//                       command so the user can confirm with Enter or cancel
//                       with Ctrl+C
//
// The module is **pure** — it returns action descriptors rather than touching
// IPC, settings, or the DOM. The eventual `TerminalView` consumer (not yet
// in the codebase) is responsible for translating each action into the
// corresponding `window.maestro.process.write()` call, banner render, and
// `settingsStore.set('terminalRestartWhitelist', ...)` update on
// confirmation.
//
// This separation keeps the policy logic testable in isolation and lets the
// confirmation/auto-execution UX be re-skinned (modal, toast, in-terminal
// banner) without rewriting the policy core.

import type { TerminalTab } from '../types';
import { checkCommandPolicy } from './terminalCommandPolicy';

export type RestartAction =
	| { kind: 'auto-execute'; command: string; baseCommand: string }
	| { kind: 'skip'; reason: 'denied' | 'no-command'; command: string | null }
	| { kind: 'prompt'; command: string; baseCommand: string; banner: string };

/**
 * Decide what to do with a restored terminal tab whose previous session had
 * a command running. Returns `null` when the tab is not flagged for restart
 * (no-op — the caller can short-circuit).
 *
 * @param tab        - The restored terminal tab (only `persistCommand` and
 *                     `currentCommand` are read).
 * @param whitelist  - User-configured patterns that auto-allow re-execution.
 *                     Read from settings key `terminalRestartWhitelist`.
 * @param blacklist  - User-configured patterns that auto-block re-execution.
 *                     Takes precedence over the whitelist. Read from settings
 *                     key `terminalRestartBlacklist`.
 */
export function planRestartAction(
	tab: Pick<TerminalTab, 'persistCommand' | 'currentCommand'>,
	whitelist: string[],
	blacklist: string[]
): RestartAction | null {
	if (!tab.persistCommand) return null;

	const command = tab.currentCommand?.trim() ?? '';
	if (!command) return { kind: 'skip', reason: 'no-command', command: null };

	const baseCommand = command.split(/\s+/)[0];
	const policy = checkCommandPolicy(command, whitelist, blacklist);

	switch (policy) {
		case 'allow':
			return { kind: 'auto-execute', command, baseCommand };
		case 'deny':
			return { kind: 'skip', reason: 'denied', command };
		case 'ask':
			return { kind: 'prompt', command, baseCommand, banner: formatRestartBanner(command) };
	}
}

/**
 * ANSI-styled banner shown in-terminal when prompting the user to confirm a
 * persisted command. The caller writes this string directly to the PTY (via
 * `window.maestro.process.write(...)`) before pre-filling the command itself.
 *
 * Yellow + bold for the command body so it stands out against normal shell
 * output. `\r\n` line terminators (CR + LF) so the cursor returns to column
 * 0 across both raw-mode and cooked-mode shells.
 */
export function formatRestartBanner(command: string): string {
	return (
		'\r\n\x1b[33m⚠ This terminal was running: ' +
		`\x1b[1m${command}\x1b[0m` +
		'\r\n\x1b[33mPress Enter to re-execute, or type a new command.\x1b[0m\r\n'
	);
}

/**
 * Append a base command to the whitelist after the user confirms a 'prompt'
 * action. Reference-preserving: returns the original array when the command
 * is already present (or when the input is blank), so a settings write can
 * be skipped.
 *
 * Stored as the bare token (e.g. `btop`, `npm`) — `checkCommandPolicy()`
 * matches both exact-base and prefix, so a single entry covers both `btop`
 * and `btop -t`.
 */
export function addCommandToWhitelist(whitelist: string[], baseCommand: string): string[] {
	const trimmed = baseCommand.trim();
	if (!trimmed) return whitelist;
	if (whitelist.includes(trimmed)) return whitelist;
	return [...whitelist, trimmed];
}
