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
// Moved from src/main/process-manager/utils/shellEscape.ts, which re-exports
// it: the desktop spawners and every library launcher escape with the same code.
//
// References:
// - cmd.exe escaping: https://docs.microsoft.com/en-us/windows-server/administration/windows-commands/cmd
// - PowerShell escaping: https://docs.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_quoting_rules

/**
 * Characters that require quoting in cmd.exe.
 * Based on cmd.exe special characters: https://ss64.com/nt/syntax-esc.html
 */
const CMD_SPECIAL_CHARS = /[ &|<>^%!()"\n\r#?*]/;

/**
 * Characters that require quoting in PowerShell.
 * Based on PowerShell special characters: https://ss64.com/ps/syntax-esc.html
 */
const POWERSHELL_SPECIAL_CHARS = /[ &|<>^%!()"\n\r#?*`$@{}[\]';,]/;

/**
 * Escape a single argument for use in cmd.exe.
 *
 * Strategy:
 * 1. If the argument contains special characters or is long, wrap in double quotes
 * 2. Escape existing double quotes by doubling them
 * 3. Escape carets (^) as they're the escape character in cmd.exe
 *
 * @param arg - The argument to escape
 * @returns The escaped argument safe for cmd.exe
 */
export function escapeCmdArg(arg: string): string {
	// If no special characters and not too long, return as-is
	if (!CMD_SPECIAL_CHARS.test(arg) && arg.length <= 100) {
		return arg;
	}

	// Escape double quotes by doubling them, and carets by doubling
	const escaped = arg.replace(/"/g, '""').replace(/\^/g, '^^');

	// Wrap in double quotes
	return `"${escaped}"`;
}

/**
 * Escape a single argument for use in PowerShell.
 *
 * Strategy:
 * 1. If the argument contains special characters or is long, wrap in single quotes
 * 2. Escape existing single quotes by doubling them (PowerShell's single-quote escape)
 *
 * Single quotes in PowerShell treat the content as a literal string, which is
 * safer than double quotes (which allow variable expansion).
 *
 * @param arg - The argument to escape
 * @returns The escaped argument safe for PowerShell
 */
export function escapePowerShellArg(arg: string): string {
	// If no special characters and not too long, return as-is
	if (!POWERSHELL_SPECIAL_CHARS.test(arg) && arg.length <= 100) {
		return arg;
	}

	// Escape single quotes by doubling them (PowerShell's escape mechanism)
	const escaped = arg.replace(/'/g, "''");

	// Wrap in single quotes (prevents variable expansion)
	return `'${escaped}'`;
}

/**
 * Escape an array of arguments for use in cmd.exe.
 *
 * @param args - The arguments to escape
 * @returns The escaped arguments safe for cmd.exe
 */
export function escapeCmdArgs(args: string[]): string[] {
	return args.map(escapeCmdArg);
}

/**
 * Escape an array of arguments for use in PowerShell.
 *
 * @param args - The arguments to escape
 * @returns The escaped arguments safe for PowerShell
 */
export function escapePowerShellArgs(args: string[]): string[] {
	return args.map(escapePowerShellArg);
}

/**
 * Detect if a shell path refers to PowerShell.
 *
 * @param shellPath - The shell path to check
 * @returns True if the shell is PowerShell (either Windows PowerShell or PowerShell Core)
 */
export function isPowerShellShell(shellPath: string | undefined): boolean {
	if (!shellPath) return false;
	const lower = shellPath.toLowerCase();
	return lower.includes('powershell') || lower.includes('pwsh');
}

/**
 * Escape arguments based on the target shell.
 *
 * @param args - The arguments to escape
 * @param shell - The shell path or name (optional, defaults to cmd.exe behavior)
 * @returns The escaped arguments
 */
export function escapeArgsForShell(args: string[], shell?: string): string[] {
	if (isPowerShellShell(shell)) {
		return escapePowerShellArgs(args);
	}
	return escapeCmdArgs(args);
}

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
