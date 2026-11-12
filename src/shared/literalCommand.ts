/**
 * Reading ONE shell command the way a shell would, without running it.
 *
 * A caller that wants to say what a command did (which program ran, with which
 * arguments, whether two calls were the same) cannot match its text. The text
 * `rg 'npm test' checks.log` contains a test runner's name and runs `rg`; the
 * text `npm test -- -t 'a  b'` and `npm test -- -t 'a b'` differ by one space
 * and are two different test selections. A shell reads quotes and operators
 * before it decides what a word is, so this reads them too, and says nothing
 * when it cannot be sure.
 *
 * Pure: no process, file or shell access. Nothing here evaluates the command.
 */

/**
 * Read a single literal shell invocation, never evaluate it. Custom-args
 * splitters accept incomplete quotes/operators, so they cannot establish this
 * evidence. Expansions, compound commands and unsupported syntax stay unknown.
 *
 * `assignments` receives the index of every token that was written as an
 * unquoted `NAME=value` word.
 */
export function literalCommandTokens(
	command: string,
	assignments: Set<number> = new Set()
): string[] | null {
	if (/[\r\n\0]/.test(command)) return null;
	const tokens: string[] = [];
	let token = '';
	let started = false;
	let quote = '';
	for (let at = 0; at < command.length; at++) {
		const char = command[at];
		// Quoting/escaping the name or '=' makes a word, not a shell assignment.
		if (!started && /^[A-Za-z_][A-Za-z0-9_]*=/.test(command.slice(at))) {
			assignments.add(tokens.length);
		}
		if (char === quote) {
			quote = '';
			continue;
		}
		if (quote === "'") {
			token += char;
			continue;
		}
		if (char === '\\') {
			const next = command[++at];
			if (next === undefined) return null;
			token += quote === '"' && !'\\"$`'.includes(next) ? `\\${next}` : next;
			started = true;
			continue;
		}
		if (char === '$' || char === '`') return null;
		if (!quote && (char === '"' || char === "'")) {
			quote = char;
			started = true;
		} else if (!quote && /[;&|<>()#*?\[\]{}~]/.test(char)) {
			return null;
		} else if (!quote && (char === ' ' || char === '\t')) {
			if (started) tokens.push(token);
			token = '';
			started = false;
		} else {
			token += char;
			started = true;
		}
	}
	if (quote) return null;
	if (started) tokens.push(token);
	return tokens;
}

/**
 * `cd <literal path> &&`, in front of the command. It changes the directory and
 * prints nothing, and `&&` runs what follows only if it worked, so the output
 * and the exit status that follow belong to the next command alone. Any other
 * chaining (`;`, `||`, a pipe) gives no such guarantee and is not accepted.
 */
const CD_PREFIX = /^\s*cd\s+('[^'\n]*'|"[^"$`\\\n]*"|[\w./@+-]+)\s*&&\s*/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export interface LiteralCommand {
	/**
	 * Equal keys are the same invocation: the same directories and the same
	 * arguments with the quoting resolved. A space inside a quoted argument is
	 * part of the argument; a space between two arguments is not.
	 */
	key: string;
	/** The program and its arguments, after any leading `NAME=value` assignments. */
	words: string[];
}

/**
 * The one command `command` runs, or null when that cannot be established: a
 * pipe, a redirection, `;`, `||`, a comment, a glob, an expansion, a line
 * break, or an unclosed quote. A leading run of `cd <literal path> &&` is read
 * past (see `CD_PREFIX`).
 */
export function readLiteralCommand(command: string): LiteralCommand | null {
	let rest = command.trim();
	const dirs: string[] = [];
	for (let match = CD_PREFIX.exec(rest); match; match = CD_PREFIX.exec(rest)) {
		dirs.push(literalCommandTokens(match[1])?.[0] ?? match[1]);
		rest = rest.slice(match[0].length);
	}
	const assignments = new Set<number>();
	const tokens = literalCommandTokens(rest, assignments);
	if (!tokens?.length) return null;
	let at = 0;
	while (ASSIGNMENT.test(tokens[at] ?? '') && assignments.has(at)) at++;
	return at < tokens.length
		? { key: JSON.stringify([dirs, tokens]), words: tokens.slice(at) }
		: null;
}
