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
 * Text cmd.exe treats as a variable reference on a command line: a `%`, at
 * least one character, and the next `%`.
 *
 * cmd.exe takes everything between two `%` signs as the name, so a name is not
 * limited to letters and digits (`%ProgramFiles(x86)%`, `%a b%`, `%=C:%`), and
 * the substring and substitution forms (`%PATH:~0,3%`, `%X:a=b%`) are the same
 * shape. On a command line (unlike in a batch file) an undefined name is left
 * as it is and `%%` has no special meaning, so `%%PATH%%` still expands the
 * inner `%PATH%`; the pair is found wherever it sits. The pattern does not ask
 * whether the name is defined: dynamic variables (`%CD%`, `%RANDOM%`,
 * `%ERRORLEVEL%`) are never in the spawn environment, names match without
 * regard to case, and a pair with a name nobody defines costs only a refusal.
 */
const CMD_PERCENT_PAIR = /%[^%]+%/;

/**
 * Why `arg` cannot reach the program intact as one argument of a cmd.exe
 * command line built with `escapeCmdArg()`, or null when it can.
 *
 * - A line break ends the command line, so the rest of the argument is lost
 *   (or runs as a second command).
 * - A `%NAME%` pair (`CMD_PERCENT_PAIR`) is expanded inside double quotes,
 *   and there is no escape for it on a command line.
 * - `^` is literal inside double quotes, so the `^^` that `escapeCmdArg()`
 *   writes arrives doubled. The escaper stays as it is: the desktop spawners
 *   use it byte for byte.
 *
 * A `%` with no partner (`100%`, `%20`, `50% off`) and an empty `%%` pass
 * unchanged: cmd.exe leaves them alone on a command line, and npm's `.cmd`
 * shim forwards its arguments with a bare `%*`, which is not expanded a second
 * time. A shim that forwards through `CALL` would expand them again; that is
 * the shim's own parsing, outside what this rule can see. Two lone `%` in
 * DIFFERENT arguments do form a pair on the joined line, but `escapeCmdArg()`
 * quotes every argument holding a `%`, so that name always contains a `"`,
 * which no variable Windows defines has.
 *
 * A launcher that runs through cmd.exe sends a prompt like this over stdin
 * instead, when the provider reads it there.
 */
export function cmdShellArgProblem(arg: string): string | null {
	if (/[\r\n]/.test(arg)) return 'it contains a line break, which ends a cmd.exe command line';
	if (CMD_PERCENT_PAIR.test(arg)) {
		return 'it contains a %NAME% pair, which cmd.exe expands as a variable';
	}
	if (arg.includes('^')) return 'it contains ^, which cmd.exe would pass on doubled';
	return null;
}

/**
 * A bare flag name: `--long-name` or a single-letter `-c`. Anything else that
 * starts with `-` can carry a value of its own (`-pSECRET`, a value that
 * happens to start with a dash), so it is never named in a message.
 */
const CMD_SHELL_FLAG_NAME = /^(--[A-Za-z][A-Za-z0-9-]*|-[A-Za-z])$/;

/**
 * Name `args[index]` for a refusal message without quoting it. A value can be
 * a credential (a custom `--api-key=...`), and the message lands in logs and
 * run history; a bare flag name is not a secret, so a value is named by the
 * flag it belongs to, and anything else by its position.
 */
function describeCmdShellArg(
	args: readonly string[],
	index: number,
	promptArgs: ReadonlySet<string>
): string {
	const arg = args[index];
	if (promptArgs.has(arg)) return 'the prompt';
	const eq = arg.indexOf('=');
	if (eq > 0 && CMD_SHELL_FLAG_NAME.test(arg.slice(0, eq))) {
		return `the value of ${arg.slice(0, eq)}`;
	}
	const previous = index > 0 ? args[index - 1] : undefined;
	if (previous !== undefined && CMD_SHELL_FLAG_NAME.test(previous)) {
		return `the value of ${previous}`;
	}
	return `argument ${index + 1}`;
}

/**
 * The first argument cmd.exe cannot carry intact (`cmdShellArgProblem()`),
 * phrased for a refusal - "cannot pass the value of --api-key intact: it
 * contains ..." - or null when every argument is safe. The argument is named
 * by the flag it belongs to, by its position, or as "the prompt" when it is
 * one of `promptArgs`, and never quoted, because it can be a credential.
 * Callers prefix who refused: "<agent> at <path> only starts through cmd.exe,
 * which ...".
 */
export function cmdShellArgsRefusal(
	args: readonly string[],
	promptArgs: ReadonlySet<string> = new Set()
): string | null {
	for (const [index, arg] of args.entries()) {
		const problem = cmdShellArgProblem(arg);
		if (!problem) continue;
		return `cannot pass ${describeCmdShellArg(args, index, promptArgs)} intact: ${problem}`;
	}
	return null;
}
