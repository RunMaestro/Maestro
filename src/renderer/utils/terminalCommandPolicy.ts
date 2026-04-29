// Whitelist / blacklist policy for re-executing commands when a terminal tab
// is restored on app restart. Consumed by the restart re-execution flow in
// `TerminalView`: see Phase 5 of the terminal-persistence plan.
//
// Matching rules (in order):
//   1. Blacklist wins. If any blacklist pattern matches, return 'deny' — even
//      if the same command is also whitelisted. Safety first.
//   2. Whitelist next. If any whitelist pattern matches, return 'allow'.
//   3. Otherwise return 'ask' so the caller can prompt the user.
//
// A pattern matches when EITHER the full (trimmed) command line starts with
// the pattern, OR the first whitespace-separated token of the command equals
// the pattern. The dual rule lets users write either:
//   - `'rm '` (trailing space) → catches `rm -rf foo`, ignores `rmdir foo`
//   - `'btop'`                 → matches the binary name exactly, plus any
//                                 invocation that starts with `btop` (e.g.
//                                 `btop -t`)

export type CommandPolicy = 'allow' | 'deny' | 'ask';

/**
 * Decide whether a persisted command should be auto-executed, blocked, or
 * confirmed by the user when its terminal tab is restored on restart.
 *
 * @param command   - The command line captured by the OSC 133;B parser
 * @param whitelist - Patterns that auto-allow re-execution
 * @param blacklist - Patterns that auto-block re-execution (takes precedence)
 * @returns `'allow'`, `'deny'`, or `'ask'`
 */
export function checkCommandPolicy(
	command: string,
	whitelist: string[],
	blacklist: string[]
): CommandPolicy {
	const cmd = command.trim();
	const cmdBase = cmd.split(/\s+/)[0];

	for (const pattern of blacklist) {
		if (cmd.startsWith(pattern) || cmdBase === pattern) return 'deny';
	}
	for (const pattern of whitelist) {
		if (cmd.startsWith(pattern) || cmdBase === pattern) return 'allow';
	}
	return 'ask';
}
