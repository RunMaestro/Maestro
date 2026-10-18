/**
 * Shell escaping utilities for SSH remote execution.
 *
 * These utilities ensure safe command construction when building
 * shell commands for remote execution via SSH. Critical for preventing
 * shell injection attacks.
 */

/**
 * Escape a string for safe inclusion in a shell command.
 *
 * Uses single quotes and escapes any single quotes within the string.
 * This is the safest method for shell escaping as single-quoted strings
 * are treated literally in POSIX shells (no variable expansion, no
 * command substitution).
 *
 * @param str The string to escape
 * @returns The escaped string, wrapped in single quotes
 *
 * @example
 * shellEscape("hello world") // => "'hello world'"
 * shellEscape("it's fine")   // => "'it'\\''s fine'"
 * shellEscape("$HOME")       // => "'$HOME'" (no expansion)
 */
export function shellEscape(str: string): string {
	// Handle empty string
	if (str === '') {
		return "''";
	}

	// Use single quotes and escape any single quotes within
	// The pattern 'text'\''more' breaks out of single quotes,
	// adds an escaped single quote, then re-enters single quotes
	return `'${str.replace(/'/g, "'\\''")}'`;
}

/**
 * Escape multiple strings for shell inclusion.
 *
 * @param args Array of strings to escape
 * @returns Array of escaped strings
 */
function shellEscapeArgs(args: string[]): string[] {
	return args.map(shellEscape);
}

/**
 * Build a shell command string from a command and arguments.
 *
 * @param command The command to run
 * @param args Arguments to the command
 * @returns A properly escaped shell command string
 *
 * @example
 * buildShellCommand("echo", ["hello", "world"])
 * // => "echo 'hello' 'world'"
 */
export function buildShellCommand(command: string, args: string[]): string {
	return [command, ...shellEscapeArgs(args)].join(' ');
}

/**
 * Escape a string for inclusion in double-quoted shell context.
 *
 * Escapes characters that have special meaning within double quotes:
 * - $ (variable expansion)
 * - ` (command substitution)
 * - \ (escape character)
 * - " (quote terminator)
 * - ! (history expansion in some shells)
 *
 * Use this when the outer command needs double quotes (e.g., for $SHELL expansion)
 * but the inner content should be treated literally.
 *
 * @param str The string to escape
 * @returns The escaped string (without surrounding quotes)
 */
export function shellEscapeForDoubleQuotes(str: string): string {
	return str
		.replace(/\\/g, '\\\\') // Escape backslashes first
		.replace(/"/g, '\\"') // Escape double quotes
		.replace(/\$/g, '\\$') // Escape dollar signs
		.replace(/`/g, '\\`') // Escape backticks
		.replace(/!/g, '\\!'); // Escape history expansion
}

/**
 * Escape a path that will be handed to a REMOTE shell (`cd`, `stat`, `ls`
 * over SSH), keeping a leading `~` or `$HOME` expandable.
 *
 * `shellEscape()` single-quotes its argument, and a single-quoted `'~/proj'`
 * never expands: the remote shell looks for a directory literally named `~`
 * and every `cd` into a home-relative path fails. Nothing on the local side
 * can resolve it either, because the remote user's home is not the local one
 * (`expandTilde()` turned `~/git-projects` into `/Users/<local>/git-projects`
 * and the agent then failed to start on the remote host).
 *
 * So a home-relative path is rendered as `"$HOME/rest"`, with `rest` escaped
 * for the double-quoted context, and every other path falls through to
 * `shellEscape()` unchanged. Use this for every remote path, never the plain
 * escaper - four builders had grown four private copies of this rule and one
 * of them (`SshCommandRunner`) defaulted to a quoted `'~'` that could not work.
 *
 * @param remotePath The path as the user typed it (may start with `~` or `$HOME`)
 * @returns A shell-safe token that expands the home prefix on the remote
 */
export function shellEscapeRemotePath(remotePath: string): string {
	if (remotePath === '~' || remotePath === '$HOME') {
		return '"$HOME"';
	}

	if (remotePath.startsWith('~/')) {
		return `"$HOME/${shellEscapeForDoubleQuotes(remotePath.slice(2))}"`;
	}

	if (remotePath.startsWith('$HOME/')) {
		return `"$HOME/${shellEscapeForDoubleQuotes(remotePath.slice('$HOME/'.length))}"`;
	}

	return shellEscape(remotePath);
}
