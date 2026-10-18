/**
 * Windows command rules for spawning an agent binary through child_process.
 *
 * Extracted from ChildProcessSpawner (Plans/maestro-lib-launch-and-control.md,
 * D10) so every caller that launches an agent on Windows can apply the same
 * rules: whether a command needs a shell, how to quote the command and escape
 * its arguments for that shell, and which arguments cmd.exe cannot carry. The
 * caller keeps its own logging, and only asks about a command when it runs on
 * Windows and has not already chosen a shell. `applyWindowsShellRules()` in
 * `run/start-turn.ts` applies all of them to a turn's process spec.
 */

import * as fs from 'fs';
import * as path from 'path';

export type WindowsShellReason = 'bare-exe' | 'batch-file' | 'shebang-script';

export interface WindowsShellDecision {
	/** Why the command must be launched through a shell, or null when it can spawn directly. */
	reason: WindowsShellReason | null;
	/** The script's first line, set only for a shebang script (useful in a log line). */
	shebang?: string;
}

/**
 * Decide whether a command can only be launched through a shell on Windows.
 * The rules are checked in order and the first match wins:
 *
 * 1. A bare `.exe` name (no directory): only a shell resolves it on PATH, so
 *    spawning it directly fails with ENOENT when a caller passes a basename.
 * 2. A `.cmd` or `.bat` file: Node refuses to spawn these directly ("spawn
 *    EINVAL") since the CVE-2024-27980 fix, and npm-installed agent CLIs
 *    resolve to exactly such shims (claude.cmd, codex.cmd, opencode.cmd).
 * 3. An extensionless file with a path whose first bytes are `#!`: a shell
 *    script, as some npm installs ship (OpenCode). A file that cannot be read
 *    gets no special handling.
 */
export function windowsShellReason(command: string): WindowsShellDecision {
	const commandHasPath = /\\|\//.test(command);
	const commandExt = path.extname(command).toLowerCase();

	if (!commandHasPath && commandExt === '.exe') {
		return { reason: 'bare-exe' };
	}

	if (commandExt === '.cmd' || commandExt === '.bat') {
		return { reason: 'batch-file' };
	}

	if (!commandExt && commandHasPath) {
		try {
			const fileContent = fs.readFileSync(command, 'utf8');
			if (fileContent.startsWith('#!')) {
				return { reason: 'shebang-script', shebang: fileContent.split('\n')[0] };
			}
		} catch {
			// If we can't read the file, just continue without special handling
		}
	}

	return { reason: null };
}

/**
 * Quote a command path for the default Windows shell (cmd.exe via ComSpec).
 *
 * Node concatenates the command and its args into one command line without
 * quoting the command itself, so a path with spaces - an npm shim under
 * "C:\Users\First Last\AppData\Roaming\npm\claude.cmd" - is split by cmd.exe
 * and fails. Only for the boolean (cmd.exe) shell: an explicit shell string
 * carries its own quoting rules and is the caller's responsibility.
 */
export function quoteCommandForCmdShell(command: string): string {
	if (/\s/.test(command) && !command.startsWith('"')) {
		return `"${command}"`;
	}
	return command;
}

// ─── Argument escaping ───────────────────────────────────────────────────────
//
// The cmd.exe and PowerShell escapers live in `./windows-shell-escape.ts`, which
// the desktop's `src/main/process-manager/utils/shellEscape.ts` re-exports.

/**
 * Why `arg` cannot reach the program intact as one argument of a cmd.exe
 * command line built with `escapeCmdArg()`, or null when it can.
 *
 * - A line break ends the command line, so the rest of the argument is lost
 *   (or runs as a second command).
 * - `%NAME%` is expanded inside double quotes, and there is no escape for it
 *   on a command line.
 * - `^` is literal inside double quotes, so the `^^` that `escapeCmdArg()`
 *   writes arrives doubled. The escaper stays as it is: the desktop spawners
 *   use it byte for byte.
 *
 * A launcher that runs through cmd.exe sends a prompt like this over stdin
 * instead, when the provider reads it there.
 */
export function cmdShellArgProblem(arg: string): string | null {
	if (/[\r\n]/.test(arg)) return 'it contains a line break, which ends a cmd.exe command line';
	if (arg.includes('%')) return 'it contains %, which cmd.exe expands as a variable';
	if (arg.includes('^')) return 'it contains ^, which cmd.exe would pass on doubled';
	return null;
}
