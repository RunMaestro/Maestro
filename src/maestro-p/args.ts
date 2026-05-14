// Argument resolver for the maestro-p wrapper binary.
//
// We can't lean on commander for the full parse: the contract is to forward
// most flags verbatim to the underlying `claude` TUI invocation, including
// flags maestro-p has never seen. Commander wants every flag declared up front
// and would error (or silently drop) on unknown ones. So this is a hand-rolled
// argv walker that classifies each token into one of three buckets:
//
//   - consumed   — maestro-p uses it (prompt source, mode, timing knobs)
//   - stripped   — claude headless flags (-p / --output-format / --verbose)
//                  that would corrupt the TUI spawn; dropped with a warning
//   - passthrough — everything else, preserved in original order
//
// Prompt resolution priority is fixed: explicit -p / --print / --prompt wins,
// then the first non-flag positional, then stdin (when piped, not a TTY).

import * as fs from 'fs';

export type ParsedMode = 'run' | 'status';

export interface ParsedArgs {
	prompt: string | null;
	mode: ParsedMode;
	passThroughArgs: string[];
	streamThinking: boolean;
	maxWaitSeconds: number;
}

// Default hard timeout (seconds since the last received byte from claude).
// Mirrors the value documented in the playbook.
export const DEFAULT_MAX_WAIT_SECONDS = 300;

// Flags maestro-p owns. Listed separately so the loop can detect them
// regardless of whether the value is space- or `=`-separated.
const PROMPT_FLAGS = new Set(['-p', '--print', '--prompt']);
const MAX_WAIT_FLAGS = new Set(['--max-wait']);
const STATUS_FLAGS = new Set(['--status']);
const STREAM_THINKING_FLAGS = new Set(['--stream-thinking']);
// --help / --version are listed in the playbook as "consumed" but parseArgs
// has nowhere to put them in its return type. The wrapping CLI surface
// (commander in index.ts) renders help/version itself, so we just swallow
// these tokens here without acting on them.
const HELP_VERSION_FLAGS = new Set(['--help', '-h', '--version', '-V']);

// Headless-mode flags that would corrupt the TUI spawn if forwarded.
// --output-format / --input-format take a value; --verbose is boolean.
const STRIPPED_VALUE_FLAGS = new Set(['--output-format', '--input-format']);
const STRIPPED_BOOL_FLAGS = new Set(['--verbose']);

interface ParseOptions {
	// Injection seam for tests: lets us simulate piped stdin without spawning
	// a real subprocess. Defaults to process.stdin.isTTY / fs.readFileSync(0).
	stdinIsTTY?: boolean;
	readStdin?: () => string;
	stderr?: (message: string) => void;
}

export function parseArgs(argv: string[], options: ParseOptions = {}): ParsedArgs {
	const stderr = options.stderr ?? ((msg: string) => process.stderr.write(msg));

	let promptFromFlag: string | null = null;
	let firstPositional: string | null = null;
	let mode: ParsedMode = 'run';
	let streamThinking = false;
	let maxWaitSeconds = DEFAULT_MAX_WAIT_SECONDS;
	const passThroughArgs: string[] = [];
	const extraPositionals: string[] = [];

	let i = 0;
	while (i < argv.length) {
		const raw = argv[i];

		// Split --flag=value into flag + inline value. Short flags don't get
		// the inline-value treatment — `-p=value` is non-standard for claude.
		let flag = raw;
		let inlineValue: string | null = null;
		if (raw.startsWith('--') && raw.includes('=')) {
			const eq = raw.indexOf('=');
			flag = raw.slice(0, eq);
			inlineValue = raw.slice(eq + 1);
		}

		// --- Consumed flags -------------------------------------------------
		if (PROMPT_FLAGS.has(flag)) {
			const value = consumeValue(argv, i, inlineValue, flag);
			// First -p wins; any later one is treated as user error and ignored
			// silently rather than erroring out, matching commander's behavior.
			if (promptFromFlag === null) {
				promptFromFlag = value.value;
			}
			i = value.nextIndex;
			continue;
		}

		if (MAX_WAIT_FLAGS.has(flag)) {
			const value = consumeValue(argv, i, inlineValue, flag);
			const parsed = Number.parseInt(value.value, 10);
			if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== value.value.trim()) {
				throw new Error(`maestro-p: ${flag} must be a positive integer (got "${value.value}")`);
			}
			maxWaitSeconds = parsed;
			i = value.nextIndex;
			continue;
		}

		if (STATUS_FLAGS.has(flag)) {
			mode = 'status';
			i++;
			continue;
		}

		if (STREAM_THINKING_FLAGS.has(flag)) {
			streamThinking = true;
			i++;
			continue;
		}

		if (HELP_VERSION_FLAGS.has(flag)) {
			// Silently consumed — index.ts handles --help / --version via commander.
			i++;
			continue;
		}

		// --- Stripped flags -------------------------------------------------
		if (STRIPPED_VALUE_FLAGS.has(flag)) {
			stderr(
				`maestro-p: warning: ${flag} stripped — headless-mode flag would corrupt the TUI spawn\n`
			);
			// Skip the attached value too (inline if present, else the next token).
			if (inlineValue === null && i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
				i += 2;
			} else {
				i++;
			}
			continue;
		}

		if (STRIPPED_BOOL_FLAGS.has(flag)) {
			stderr(
				`maestro-p: warning: ${flag} stripped — headless-mode flag would corrupt the TUI spawn\n`
			);
			i++;
			continue;
		}

		// --- Pass-through ---------------------------------------------------
		if (raw.startsWith('-')) {
			// Unknown flag — forward verbatim. If the next token is non-flag
			// and we didn't already have an inline value, assume it's this
			// flag's value (e.g., `--resume <id>`, `--model opus`) and forward
			// both together. This keeps known claude flags like `--model`,
			// `--resume`, `--cwd` intact without us hard-coding the list.
			passThroughArgs.push(raw);
			i++;
			if (inlineValue === null && i < argv.length && !argv[i].startsWith('-')) {
				passThroughArgs.push(argv[i]);
				i++;
			}
			continue;
		}

		// Bare positional. The first one is the prompt candidate; later ones
		// are forwarded to claude (claude itself rarely takes positionals, but
		// that's claude's problem to surface).
		if (firstPositional === null) {
			firstPositional = raw;
		} else {
			extraPositionals.push(raw);
		}
		i++;
	}

	// Resolve prompt source. Status mode never carries a prompt.
	let prompt: string | null = null;
	if (mode === 'status') {
		// Drop any positional we collected — status mode ignores prompt input.
		// Other pass-through flags (--cwd, --model, etc.) still flow through.
	} else if (promptFromFlag !== null) {
		prompt = promptFromFlag;
		// If both -p and a positional were given, the positional is now
		// orphaned. Forward it so claude sees it (likely user error, but
		// surfacing it loudly via claude beats silently dropping it).
		if (firstPositional !== null) {
			extraPositionals.unshift(firstPositional);
		}
	} else if (firstPositional !== null) {
		prompt = firstPositional;
	} else {
		// Last resort: piped stdin.
		const stdinIsTTY = options.stdinIsTTY ?? Boolean(process.stdin.isTTY);
		if (!stdinIsTTY) {
			const reader = options.readStdin ?? defaultReadStdin;
			const piped = reader();
			const trimmed = piped.replace(/\r?\n$/, '');
			if (trimmed.length > 0) {
				prompt = trimmed;
			}
		}
	}

	// Append any leftover positionals to the pass-through bucket so they
	// follow the rest of the forwarded flags. Order doesn't matter much for
	// claude's CLI shape, but we keep them at the tail to minimize surprise.
	for (const extra of extraPositionals) {
		passThroughArgs.push(extra);
	}

	return {
		prompt,
		mode,
		passThroughArgs,
		streamThinking,
		maxWaitSeconds,
	};
}

interface ConsumedValue {
	value: string;
	nextIndex: number;
}

function consumeValue(
	argv: string[],
	index: number,
	inlineValue: string | null,
	flag: string
): ConsumedValue {
	if (inlineValue !== null) {
		return { value: inlineValue, nextIndex: index + 1 };
	}
	const next = argv[index + 1];
	if (next === undefined) {
		throw new Error(`maestro-p: ${flag} requires a value`);
	}
	return { value: next, nextIndex: index + 2 };
}

function defaultReadStdin(): string {
	try {
		return fs.readFileSync(0, 'utf-8');
	} catch {
		return '';
	}
}
