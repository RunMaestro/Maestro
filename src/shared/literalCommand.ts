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
 * Two calls are also not the same when only their surroundings differ: `npm
 * test` in two directories, or with and without `CI=1`, tests two different
 * things, and an argv array `['npm', 'test', '-t', 'a b']` has four arguments
 * where the line `npm test -t a b` has five. `readCommandCall` reads a call
 * with all of that, and its `key` is built with `canonicalJson`, so equal keys
 * mean equal invocations and nothing compares display text.
 *
 * Pure: no process, file or shell access. Nothing here evaluates the command.
 */

import { canonicalJson } from './canonicalJson';

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

/** A command read into what makes it the same invocation, and the words to act on. */
interface Reading {
	/** JSON-safe. Equal identities are the same invocation. */
	identity: Record<string, unknown>;
	words: string[];
}

/** One command line, read the way a shell would. */
function readCommandLine(command: string): Reading | null {
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
	if (at >= tokens.length) return null;
	const words = tokens.slice(at);
	return {
		// The assignments are their own member: the program `CI=1` of an argv array
		// is not the assignment `CI=1` of a command line.
		identity: {
			argv: words,
			...(dirs.length ? { cd: dirs } : {}),
			...(at ? { set: tokens.slice(0, at) } : {}),
		},
		words,
	};
}

/**
 * An argv array, read as it is. No shell reads it, so nothing in it is quoted,
 * split, expanded or an assignment: each element is one argument, whatever it
 * holds, and a space inside an element does not make two arguments.
 */
function readArgv(argv: readonly string[]): Reading | null {
	return argv.length ? { identity: { argv }, words: [...argv] } : null;
}

/**
 * The one command `command` runs, or null when that cannot be established: a
 * pipe, a redirection, `;`, `||`, a comment, a glob, an expansion, a line
 * break, or an unclosed quote. A leading run of `cd <literal path> &&` is read
 * past (see `CD_PREFIX`).
 */
export function readLiteralCommand(command: string): LiteralCommand | null {
	const read = readCommandLine(command);
	return read && { key: canonicalJson(read.identity), words: read.words };
}

/** A command a tool was asked to run, and what it was asked to run it with. */
export interface CommandCall {
	/**
	 * The command on one line, as shown. When `argv` is set this is a display
	 * of it: the identity comes from `argv`, never from this text.
	 */
	text: string;
	/** The argv array the caller sent. Each element is one argument, whatever it holds. */
	argv?: readonly string[];
	/** The directory the caller asked it to run in. Absent when it named none. */
	cwd?: string;
	/** The variables the caller asked to add. Absent when it named none. */
	env?: Readonly<Record<string, string>>;
}

export interface CommandReading {
	/**
	 * Equal keys are the same invocation: the same arguments (see
	 * `LiteralCommand.key`) run in the same directory with the same added
	 * variables. A directory or variable one call names and the other leaves
	 * out makes two keys, because what an unnamed call ran in is not known. A
	 * call that cannot be read is keyed by its exact text and the same context.
	 */
	key: string;
	/** The program and its arguments, or null when the call cannot be read (see `readLiteralCommand`). */
	words: string[] | null;
}

/**
 * Read a command call: its words, when they can be established, and the key
 * that says which calls are the same invocation.
 */
export function readCommandCall(call: CommandCall): CommandReading {
	const read = call.argv ? readArgv(call.argv) : readCommandLine(call.text);
	return {
		key: canonicalJson({
			...(read?.identity ?? { text: call.text.trim() }),
			cwd: call.cwd || undefined,
			env: call.env && Object.keys(call.env).length ? call.env : undefined,
		}),
		words: read?.words ?? null,
	};
}
