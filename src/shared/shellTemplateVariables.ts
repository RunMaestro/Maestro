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
 * passed safely: inside a quoted heredoc (`<<'EOF'`, whose body expands
 * nothing), in a heredoc delimiter, or inside a shell arithmetic context
 * (`$((...))` or `((...))`, where values are evaluated as arithmetic syntax).
 */
export function substituteShellTemplateVariables(
	template: string,
	context: TemplateContext
): ShellTemplateResult {
	const tracker = new ShellQuoteTracker(template);
	const env: Record<string, string> = {};
	const envNames = new Map<string, string>();

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
			tracker.advanceTo(span.start);
			tracker.skipTo(span.end);
			const placeholder = template.slice(span.start, span.end);
			const { where, escaped } = tracker.placeholder(placeholder);

			// A comment never runs, and a value with a newline would end it.
			if (where === 'comment') return placeholder;
			if (where === 'quoted-heredoc') {
				throw new ShellTemplateError(
					`${placeholder} is inside a quoted heredoc (<<'EOF'), where the shell expands nothing, so its value cannot be passed. Use an unquoted delimiter (<<EOF).`
				);
			}
			if (where === 'arithmetic') {
				throw new ShellTemplateError(
					`${placeholder} is inside a shell arithmetic expression ($((...)) or ((...))), where values are evaluated as syntax rather than literal data. Compute outside arithmetic evaluation or pass values as plain arguments.`
				);
			}
			if (SHELL_SYNTAX_VARIABLES.has(name)) return value;
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
type Where =
	| 'plain'
	| 'single'
	| 'double'
	| 'ansi'
	| 'comment'
	| 'heredoc'
	| 'quoted-heredoc'
	| 'arithmetic';

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

/** An open `$((...))` or `((...))` arithmetic evaluation frame. */
interface ArithmeticFrame {
	innerParens: number;
	closingParen: boolean;
	returnMode: 'plain' | 'double' | 'heredoc' | 'arithmetic';
}

/** Characters that end a word, so a `#` after one starts a comment. */
const WORD_BREAK = /[\s;&|()<>]/;

/**
 * Whether an unquoted `((` starting at `start` (the index right after `((`)
 * closes with a matching `))` at paren depth 0, like Bash's `(( ... ))`
 * arithmetic compound command (as opposed to grouped subshells `((a) || b)`).
 */
function closesWithDoubleParen(text: string, start: number): boolean {
	let depth = 0;
	let quote: "'" | '"' | null = null;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (quote === "'") {
			if (ch === "'") quote = null;
			continue;
		}
		if (ch === '\\') {
			i++;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === '(') depth++;
		else if (ch === ')') {
			if (depth === 0) return text[i + 1] === ')';
			depth--;
		}
	}
	return false;
}

/**
 * Follows a shell command one character at a time, far enough to tell where a
 * placeholder sits: quotes (single, double, `$'...'`), backslashes, comments,
 * heredoc bodies, and arithmetic contexts (`$((...))` / `((...))`). It does
 * not follow `$(...)`, backticks or `${...}`.
 */
class ShellQuoteTracker {
	private mode:
		| 'plain'
		| 'single'
		| 'double'
		| 'ansi'
		| 'comment'
		| 'heredoc'
		| 'delimiter'
		| 'arithmetic' = 'plain';
	private pos = 0;
	/** The last character read, for `#` (a comment only where a word starts) and `$'`. */
	private prev = '\n';
	/** A backslash waits to escape the next character. */
	private escaped = false;
	/** An unescaped `$` was just read (looking for `$((`). */
	private pendingDollar = false;
	/** An unescaped `$(` was just read (looking for `$((`). */
	private pendingDollarParen = false;
	/** An unescaped `(` at a word boundary in plain mode was just read (looking for `((`). */
	private pendingWordOpenParen = false;
	/** Active nested `$((...))` / `((...))` frames. */
	private arithmeticFrames: ArithmeticFrame[] = [];
	/** How many `<` in a row end at `prev`: two make a heredoc, three a here-string. */
	private lessThans = 0;
	private word: DelimiterWord | null = null;
	/** Heredocs whose bodies start after the current line, in order. */
	private pending: Heredoc[] = [];
	private heredoc: Heredoc | null = null;
	/** The heredoc body line read so far, to find the delimiter line. */
	private line = '';
	private lineHasPlaceholder = false;

	constructor(private readonly template: string) {}

	advanceTo(end: number): void {
		while (this.pos < end) {
			const idx = this.pos;
			const ch = this.template[idx];
			this.pos++;
			this.read(ch, idx);
		}
	}

	skipTo(end: number): void {
		this.pos = end;
	}

	/**
	 * Where a placeholder at the current position sits, and whether a backslash
	 * waits to escape what replaces it. The replacement is part of one word, so
	 * it does not change the state.
	 */
	placeholder(placeholder: string): { where: Where; escaped: boolean } {
		const escaped = this.escaped;
		this.escaped = false;
		this.pendingDollar = false;
		this.pendingDollarParen = false;
		this.pendingWordOpenParen = false;
		switch (this.mode) {
			case 'delimiter':
				throw delimiterError(placeholder);
			case 'heredoc':
				this.lineHasPlaceholder = true;
				return { where: this.heredoc?.quoted ? 'quoted-heredoc' : 'heredoc', escaped };
			case 'arithmetic':
				if (this.heredoc) this.lineHasPlaceholder = true;
				return { where: 'arithmetic', escaped };
			case 'plain':
				if (this.lessThans === 2) throw delimiterError(placeholder);
				this.lessThans = 0;
				this.prev = 'a';
				return { where: 'plain', escaped };
			default:
				return { where: this.mode, escaped };
		}
	}

	private read(ch: string, idx: number): void {
		switch (this.mode) {
			case 'plain':
				this.readPlain(ch, idx);
				return;
			case 'delimiter':
				this.readDelimiter(ch, idx);
				return;
			case 'heredoc':
				this.readHeredoc(ch);
				return;
			case 'arithmetic':
				this.readArithmetic(ch);
				return;
			case 'single':
				if (ch === "'") this.mode = 'plain';
				break;
			case 'double':
				this.readDouble(ch);
				return;
			case 'ansi':
				if (this.escaped) this.escaped = false;
				else if (ch === '\\') this.escaped = true;
				else if (ch === "'") this.mode = 'plain';
				break;
			case 'comment':
				if (ch === '\n') this.endLine();
				break;
		}
		this.prev = ch;
	}

	private readDouble(ch: string): void {
		if (this.escaped) {
			this.escaped = false;
			this.pendingDollar = false;
			this.pendingDollarParen = false;
			this.prev = 'a';
			return;
		}
		if (ch === '\\') {
			this.escaped = true;
			this.pendingDollar = false;
			this.pendingDollarParen = false;
		} else if (ch === '"') {
			this.mode = 'plain';
			this.pendingDollar = false;
			this.pendingDollarParen = false;
		} else if (ch === '$') {
			this.pendingDollar = true;
			this.pendingDollarParen = false;
		} else if (ch === '(' && this.pendingDollar) {
			this.pendingDollar = false;
			this.pendingDollarParen = true;
		} else if (ch === '(' && this.pendingDollarParen) {
			this.pendingDollarParen = false;
			this.enterArithmetic('double');
		} else {
			this.pendingDollar = false;
			this.pendingDollarParen = false;
		}
		this.prev = ch;
	}

	private readPlain(ch: string, idx: number): void {
		if (this.escaped) {
			// Escaped, the character is part of a word (`\` + newline joins lines).
			this.escaped = false;
			this.pendingDollar = false;
			this.pendingDollarParen = false;
			this.pendingWordOpenParen = false;
			this.lessThans = 0;
			this.prev = 'a';
			return;
		}
		if (this.lessThans === 2 && ch !== '<') {
			// The character after `<<` begins the heredoc delimiter.
			this.lessThans = 0;
			this.pendingDollar = false;
			this.pendingDollarParen = false;
			this.pendingWordOpenParen = false;
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
			this.readDelimiter(ch, idx);
			return;
		}
		this.lessThans = ch === '<' ? this.lessThans + 1 : 0;
		if (ch === '(' && this.pendingDollarParen) {
			this.pendingDollarParen = false;
			this.pendingWordOpenParen = false;
			this.enterArithmetic('plain');
			this.prev = ch;
			return;
		}
		if (ch === '(' && this.pendingWordOpenParen) {
			this.pendingWordOpenParen = false;
			if (closesWithDoubleParen(this.template, idx + 1)) {
				this.enterArithmetic('plain');
				this.prev = ch;
				return;
			}
		}
		const wasDollar = this.pendingDollar;
		this.pendingDollar = ch === '$';
		this.pendingDollarParen = ch === '(' && wasDollar;
		this.pendingWordOpenParen = ch === '(' && !wasDollar && WORD_BREAK.test(this.prev);

		if (ch === '\\') this.escaped = true;
		else if (ch === "'") this.mode = this.prev === '$' ? 'ansi' : 'single';
		else if (ch === '"') this.mode = 'double';
		else if (ch === '#' && WORD_BREAK.test(this.prev)) this.mode = 'comment';
		else if (ch === '\n') this.endLine();
		this.prev = ch;
	}

	private readDelimiter(ch: string, idx: number): void {
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
			this.readPlain(ch, idx);
			return;
		}
		word.text += ch;
		word.started = true;
	}

	private readHeredoc(ch: string): void {
		const heredoc = this.heredoc as Heredoc;
		if (ch !== '\n') {
			this.line += ch;
			if (heredoc.quoted) return;
			if (this.escaped) {
				this.escaped = false;
				this.pendingDollar = false;
				this.pendingDollarParen = false;
				return;
			}
			if (ch === '\\') {
				this.escaped = true;
				this.pendingDollar = false;
				this.pendingDollarParen = false;
			} else if (ch === '$') {
				this.pendingDollar = true;
				this.pendingDollarParen = false;
			} else if (ch === '(' && this.pendingDollar) {
				this.pendingDollar = false;
				this.pendingDollarParen = true;
			} else if (ch === '(' && this.pendingDollarParen) {
				this.pendingDollarParen = false;
				this.enterArithmetic('heredoc');
			} else {
				this.pendingDollar = false;
				this.pendingDollarParen = false;
			}
			return;
		}
		// In an unquoted heredoc, an unescaped trailing backslash joins the
		// next line onto the current one, so a delimiter word on the next line
		// is part of that line unless removing `\` + newline leaves only the delimiter.
		if (!heredoc.quoted && this.escaped) {
			this.line = this.line.slice(0, -1);
			this.escaped = false;
			this.pendingDollar = false;
			this.pendingDollarParen = false;
			return;
		}
		this.finishHeredocLine(heredoc);
	}

	private finishHeredocLine(heredoc: Heredoc): boolean {
		const line = heredoc.stripTabs ? this.line.replace(/^\t+/, '') : this.line;
		const ended = !this.lineHasPlaceholder && line === heredoc.delimiter;
		this.line = '';
		this.lineHasPlaceholder = false;
		this.escaped = false;
		this.pendingDollar = false;
		this.pendingDollarParen = false;
		if (!ended) return false;
		this.arithmeticFrames = [];
		this.heredoc = null;
		this.mode = 'plain';
		this.prev = '\n';
		this.startNextHeredoc();
		return true;
	}

	private enterArithmetic(returnMode: ArithmeticFrame['returnMode']): void {
		this.arithmeticFrames.push({
			innerParens: 0,
			closingParen: false,
			returnMode,
		});
		this.mode = 'arithmetic';
		this.lessThans = 0;
	}

	private readArithmetic(ch: string): void {
		// When arithmetic sits inside an unquoted heredoc, the shell still scans
		// raw lines for the heredoc delimiter before evaluating the body.
		if (this.heredoc) {
			if (ch === '\n') {
				if (this.escaped) {
					this.line = this.line.slice(0, -1);
					this.escaped = false;
					this.pendingDollar = false;
					this.pendingDollarParen = false;
					return;
				}
				if (this.finishHeredocLine(this.heredoc)) return;
			} else {
				this.line += ch;
			}
		}

		const frame = this.arithmeticFrames[this.arithmeticFrames.length - 1];
		if (this.escaped) {
			this.escaped = false;
			this.pendingDollar = false;
			this.pendingDollarParen = false;
			frame.closingParen = false;
			this.prev = 'a';
			return;
		}
		if (ch === '\\') {
			this.escaped = true;
			this.pendingDollar = false;
			this.pendingDollarParen = false;
			frame.closingParen = false;
			this.prev = ch;
			return;
		}
		if (ch === '$') {
			if (this.pendingDollarParen) {
				// `$(` was a command substitution, not `$((`.
				frame.innerParens++;
				this.pendingDollarParen = false;
			}
			this.pendingDollar = true;
			frame.closingParen = false;
			this.prev = ch;
			return;
		}
		if (ch === '(') {
			frame.closingParen = false;
			if (this.pendingDollarParen) {
				this.pendingDollarParen = false;
				this.enterArithmetic('arithmetic');
			} else if (this.pendingDollar) {
				this.pendingDollar = false;
				this.pendingDollarParen = true;
			} else {
				frame.innerParens++;
			}
			this.prev = ch;
			return;
		}
		if (ch === ')') {
			this.pendingDollar = false;
			if (this.pendingDollarParen) {
				// Empty `$()` command substitution closes itself.
				this.pendingDollarParen = false;
				frame.closingParen = false;
			} else if (frame.innerParens > 0) {
				frame.innerParens--;
				frame.closingParen = false;
			} else if (frame.closingParen) {
				const popped = this.arithmeticFrames.pop()!;
				this.mode = popped.returnMode;
				this.lessThans = 0;
			} else {
				frame.closingParen = true;
			}
			this.prev = ch;
			return;
		}
		if (this.pendingDollarParen) {
			// `$(` followed by a non-`(` char is command substitution `$(...)`.
			frame.innerParens++;
			this.pendingDollarParen = false;
		}
		this.pendingDollar = false;
		frame.closingParen = false;
		if (ch === '\n' && !this.heredoc && this.pending.length > 0) {
			// Newline inside top-level arithmetic does not consume heredocs until command ends,
			// but stays in arithmetic mode.
		}
		this.prev = ch;
	}

	/** An unquoted newline ends the line, and the first heredoc on it starts its body. */
	private endLine(): void {
		this.mode = 'plain';
		this.pendingDollar = false;
		this.pendingDollarParen = false;
		this.pendingWordOpenParen = false;
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
		this.pendingDollar = false;
		this.pendingDollarParen = false;
	}
}

function delimiterError(placeholder: string): ShellTemplateError {
	return new ShellTemplateError(
		`${placeholder} is part of a heredoc delimiter (<<). Write the delimiter as plain text.`
	);
}
