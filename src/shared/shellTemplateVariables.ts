/**
 * Template variables in a POSIX shell command, passed as data.
 *
 * `substituteTemplateVariables()` splices each value into the text. That is
 * right for a prompt and wrong for a shell command: a Cue `action: command`
 * handed GitHub and webhook text to `sh -c`, so a pull request titled
 * `"; touch /tmp/pwned #` ran as shell syntax. Quoting the value where it lands
 * (`shellEscape()`) holds only while the placeholder is unquoted. Written inside
 * the author's own quotes, `"{{CUE_GH_TITLE}}"`, the quoted value closes them
 * again, and a heredoc body or a comment has rules of its own.
 *
 * So no value enters the command. Each one travels in an environment variable,
 * and its placeholder becomes a parameter expansion, quoted for the place it
 * sits: `"${NAME}"` unquoted, `${NAME}` inside double quotes or a heredoc,
 * `'"${NAME}"'` inside single quotes. A shell never parses the result of an
 * expansion as syntax. The quote tracker below therefore decides only how tidy
 * the value arrives: where it misreads a command (inside `$(...)`, say), the
 * worst outcome is word splitting, never a command run.
 *
 * POSIX shells only (`sh -c`, `bash -c`, an SSH remote). cmd.exe expands
 * `%NAME%` before it parses the line, so this does not protect a Windows shell.
 */

import { substituteTemplateVariables, type TemplateContext } from './templateVariables';

/** Every value's environment variable starts with this. */
export const SHELL_TEMPLATE_ENV_PREFIX = 'MAESTRO_VAR_';

/**
 * Variables whose value IS shell syntax, written by Maestro itself.
 * `{{MAESTRO_CLI_PATH}}` is `node "<path to maestro-cli.js>"`, meant to be run;
 * quoted as one word, it would name a program that does not exist.
 */
const SHELL_SYNTAX_VARIABLES: ReadonlySet<string> = new Set(['MAESTRO_CLI_PATH']);

/** A command that cannot take its template values safely. Nothing ran. */
export class ShellTemplateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ShellTemplateError';
	}
}

export interface ShellTemplateResult {
	/** The author's command, each placeholder replaced by an expansion. */
	command: string;
	/** The values, under the names `command` expands. Set them in the shell's environment. */
	env: Record<string, string>;
}

/**
 * Substitute template variables into a POSIX shell command as data. The text
 * the author wrote is left as written; unknown placeholders stay literal, as
 * in `substituteTemplateVariables()`.
 *
 * @throws {ShellTemplateError} when a placeholder sits where no value can be
 * passed: inside a quoted heredoc (`<<'EOF'`, whose body expands nothing) or in
 * a heredoc delimiter.
 */
export function substituteShellTemplateVariables(
	template: string,
	context: TemplateContext
): ShellTemplateResult {
	const tracker = new ShellQuoteTracker();
	const env: Record<string, string> = {};
	const envNames = new Map<string, string>();
	let cursor = 0;

	const envNameFor = (name: string): string => {
		const known = envNames.get(name);
		if (known) return known;
		// Dynamic names (`CUE_OUTPUT_<agent>`) can hold any character.
		const base = SHELL_TEMPLATE_ENV_PREFIX + name.replace(/[^A-Z0-9_]/g, '_');
		let candidate = base;
		for (let n = 2; Object.prototype.hasOwnProperty.call(env, candidate); n++) {
			candidate = `${base}_${n}`;
		}
		envNames.set(name, candidate);
		return candidate;
	};

	const command = substituteTemplateVariables(template, context, {
		renderValue: (value, name, span) => {
			tracker.feed(template.slice(cursor, span.start));
			cursor = span.end;
			const placeholder = template.slice(span.start, span.end);
			const { where, escaped } = tracker.placeholder(placeholder);

			// A comment never runs, and a value with a newline would end it.
			if (where === 'comment') return placeholder;
			if (SHELL_SYNTAX_VARIABLES.has(name)) return value;
			if (where === 'quoted-heredoc') {
				throw new ShellTemplateError(
					`${placeholder} is inside a quoted heredoc (<<'EOF'), where the shell expands nothing, so its value cannot be passed. Use an unquoted delimiter (<<EOF).`
				);
			}
			// A backslash right before the placeholder escapes the first character
			// written in its place. Doubling it keeps that backslash literal.
			const lead = escaped ? '\\' : '';
			// An empty value needs no variable: it is one empty word unquoted and
			// nothing inside quotes. (An SSH remote would not export it either; a
			// value of only spaces is dropped there the same way and expands empty.)
			if (value === '') return where === 'plain' ? `${lead}''` : lead;
			const envName = envNameFor(name);
			env[envName] = value;
			const ref = `\${${envName}}`;
			if (where === 'plain') return `${lead}"${ref}"`;
			// Close the author's quote, expand inside double quotes, reopen it.
			if (where === 'single') return `'"${ref}"'`;
			if (where === 'ansi') return `${lead}'"${ref}"$'`;
			// Inside double quotes or an unquoted heredoc body an expansion is
			// already one literal piece of text.
			return lead + ref;
		},
	});

	return { command, env };
}

/** Where a placeholder sits in a shell command. */
type Where = 'plain' | 'single' | 'double' | 'ansi' | 'comment' | 'heredoc' | 'quoted-heredoc';

interface Heredoc {
	delimiter: string;
	/** A quoted delimiter (`<<'EOF'`) turns off every expansion in the body. */
	quoted: boolean;
	/** `<<-` strips leading tabs before a line is compared with the delimiter. */
	stripTabs: boolean;
}

/** The delimiter word after `<<`, while it is read. */
interface DelimiterWord {
	text: string;
	quoted: boolean;
	stripTabs: boolean;
	/** At the character right after `<<`, where `-` means `<<-`. */
	atStart: boolean;
	/** Some of the word was read (blanks before it are skipped). */
	started: boolean;
	/** The quote character open inside the word. */
	quote: string | null;
	escaped: boolean;
}

/** Characters that end a word, so a `#` after one starts a comment. */
const WORD_BREAK = /[\s;&|()<>]/;

/**
 * Follows a shell command one character at a time, far enough to tell where a
 * placeholder sits: quotes (single, double, `$'...'`), backslashes, comments,
 * and heredoc bodies. It does not follow `$(...)`, backticks or `${...}`.
 */
class ShellQuoteTracker {
	private mode: 'plain' | 'single' | 'double' | 'ansi' | 'comment' | 'heredoc' | 'delimiter' =
		'plain';
	/** The last character read, for `#` (a comment only where a word starts) and `$'`. */
	private prev = '\n';
	/** A backslash waits to escape the next character. */
	private escaped = false;
	/** How many `<` in a row end at `prev`: two make a heredoc, three a here-string. */
	private lessThans = 0;
	private word: DelimiterWord | null = null;
	/** Heredocs whose bodies start after the current line, in order. */
	private pending: Heredoc[] = [];
	private heredoc: Heredoc | null = null;
	/** The heredoc body line read so far, to find the delimiter line. */
	private line = '';
	private lineHasPlaceholder = false;

	feed(text: string): void {
		for (const ch of text) this.read(ch);
	}

	/**
	 * Where a placeholder at the current position sits, and whether a backslash
	 * waits to escape what replaces it. The replacement is part of one word, so
	 * it does not change the state.
	 */
	placeholder(placeholder: string): { where: Where; escaped: boolean } {
		const escaped = this.escaped;
		this.escaped = false;
		switch (this.mode) {
			case 'delimiter':
				throw delimiterError(placeholder);
			case 'heredoc':
				this.lineHasPlaceholder = true;
				return { where: this.heredoc?.quoted ? 'quoted-heredoc' : 'heredoc', escaped };
			case 'plain':
				if (this.lessThans === 2) throw delimiterError(placeholder);
				this.lessThans = 0;
				this.prev = 'a';
				return { where: 'plain', escaped };
			default:
				return { where: this.mode, escaped };
		}
	}

	private read(ch: string): void {
		switch (this.mode) {
			case 'plain':
				this.readPlain(ch);
				return;
			case 'delimiter':
				this.readDelimiter(ch);
				return;
			case 'heredoc':
				this.readHeredoc(ch);
				return;
			case 'single':
				if (ch === "'") this.mode = 'plain';
				break;
			case 'double':
			case 'ansi':
				if (this.escaped) this.escaped = false;
				else if (ch === '\\') this.escaped = true;
				else if (ch === (this.mode === 'double' ? '"' : "'")) this.mode = 'plain';
				break;
			case 'comment':
				if (ch === '\n') this.endLine();
				break;
		}
		this.prev = ch;
	}

	private readPlain(ch: string): void {
		if (this.escaped) {
			// Escaped, the character is part of a word (`\` + newline joins lines).
			this.escaped = false;
			this.lessThans = 0;
			this.prev = 'a';
			return;
		}
		if (this.lessThans === 2 && ch !== '<') {
			// The character after `<<` begins the heredoc delimiter.
			this.lessThans = 0;
			this.mode = 'delimiter';
			this.word = {
				text: '',
				quoted: false,
				stripTabs: false,
				atStart: true,
				started: false,
				quote: null,
				escaped: false,
			};
			this.readDelimiter(ch);
			return;
		}
		this.lessThans = ch === '<' ? this.lessThans + 1 : 0;
		if (ch === '\\') this.escaped = true;
		else if (ch === "'") this.mode = this.prev === '$' ? 'ansi' : 'single';
		else if (ch === '"') this.mode = 'double';
		else if (ch === '#' && WORD_BREAK.test(this.prev)) this.mode = 'comment';
		else if (ch === '\n') this.endLine();
		this.prev = ch;
	}

	private readDelimiter(ch: string): void {
		const word = this.word as DelimiterWord;
		if (word.quote) {
			if (ch === word.quote) word.quote = null;
			else word.text += ch;
			return;
		}
		if (word.escaped) {
			word.escaped = false;
			word.text += ch;
			return;
		}
		if (word.atStart) {
			word.atStart = false;
			if (ch === '-') {
				word.stripTabs = true;
				return;
			}
		}
		if (!word.started && (ch === ' ' || ch === '\t')) return;
		if (ch === "'" || ch === '"' || ch === '\\') {
			word.quoted = true;
			word.started = true;
			if (ch === '\\') word.escaped = true;
			else word.quote = ch;
			return;
		}
		if (WORD_BREAK.test(ch)) {
			// The word ended: its body starts after this line. Read the
			// character that ended it as plain text.
			if (word.started) {
				this.pending.push({
					delimiter: word.text,
					quoted: word.quoted,
					stripTabs: word.stripTabs,
				});
			}
			this.word = null;
			this.mode = 'plain';
			this.prev = 'a';
			this.readPlain(ch);
			return;
		}
		word.text += ch;
		word.started = true;
	}

	private readHeredoc(ch: string): void {
		const heredoc = this.heredoc as Heredoc;
		if (ch !== '\n') {
			this.line += ch;
			// An unquoted body still reads a backslash as an escape (`\$` is a literal `$`).
			this.escaped = !heredoc.quoted && !this.escaped && ch === '\\';
			return;
		}
		const line = heredoc.stripTabs ? this.line.replace(/^\t+/, '') : this.line;
		const ended = !this.lineHasPlaceholder && line === heredoc.delimiter;
		this.line = '';
		this.lineHasPlaceholder = false;
		this.escaped = false;
		if (!ended) return;
		this.heredoc = null;
		this.mode = 'plain';
		this.prev = '\n';
		this.startNextHeredoc();
	}

	/** An unquoted newline ends the line, and the first heredoc on it starts its body. */
	private endLine(): void {
		this.mode = 'plain';
		this.startNextHeredoc();
	}

	private startNextHeredoc(): void {
		const next = this.pending.shift();
		if (!next) return;
		this.heredoc = next;
		this.mode = 'heredoc';
		this.line = '';
		this.lineHasPlaceholder = false;
		this.escaped = false;
	}
}

function delimiterError(placeholder: string): ShellTemplateError {
	return new ShellTemplateError(
		`${placeholder} is part of a heredoc delimiter (<<). Write the delimiter as plain text.`
	);
}
