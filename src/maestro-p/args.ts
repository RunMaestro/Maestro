// Argument resolution for maestro-p.
//
// Walks argv once and partitions tokens into three buckets:
//   (a) consumed   - maestro-p's own flags (-p/--print/--prompt, --status,
//                    --stream-thinking, --max-wait, --help, --version) and
//                    their values.
//   (b) stripped   - headless-mode flags that would corrupt the TUI spawn
//                    (--output-format, --input-format, --verbose). Dropped
//                    silently with a one-line stderr warning.
//   (c) passthrough - everything else, forwarded verbatim to the spawned
//                    `claude` TUI.
//
// `--resume <id>` is special: it is forwarded to claude AND surfaced on a
// typed `resumeSessionId` field so the runner can attach the JSONL tailer
// without re-parsing argv.
//
// Prompt source resolution order:
//   1. -p / --print / --prompt <value>
//   2. first non-flag positional argument
//   3. stdin (only if not a TTY)
// `--status` mode ignores the prompt entirely.
//
// Pass-through arity heuristic
// ----------------------------
// We don't know claude's full flag schema, so we can't perfectly distinguish
// `--model opus` (one flag with a value) from `--continue "prompt"` (boolean
// flag followed by a true positional). Default behavior: assume every unknown
// long flag (`--foo`) consumes the next argv slot as its value. Known claude
// booleans are listed in `KNOWN_CLAUDE_BOOLEAN_LONG_FLAGS` and excluded from
// that consumption. Short flags (`-x`) are assumed to be booleans (claude's
// short-flag surface is small and bool-only). Users wanting to disambiguate
// should reach for `-p / --prompt` explicitly.
//
// Flag-guard for value-taking maestro-p flags
// -------------------------------------------
// `consumeValue()` (used by `-p`/`--print`/`--prompt`, `--max-wait`, and
// `--input-format`) refuses to swallow a next-slot token that itself starts
// with `-`. This is what protects the opt-in maestro-p route: when a user
// points their Claude Code custom path at `maestro-p`, Maestro spawns it with
// the full API-mode arg sequence `--print --verbose --output-format
// stream-json --dangerously-skip-permissions <prompt>` - and without the
// guard, `--print` greedily eats `--verbose` as its prompt value, the real
// prompt sloshes into passthrough, and the TUI types "--verbose" as the
// user message. Callers that genuinely need a flag-looking value must use
// the inline form (`--prompt=--foo`).

import fs from 'fs';

export interface ParsedArgs {
	prompt: string | null;
	mode: 'run' | 'status';
	passThroughArgs: string[];
	streamThinking: boolean;
	maxWaitSeconds: number;
	/**
	 * Budget for the FIRST JSONL entry to arrive after the prompt is sent
	 * (handshake + cold start + claude beginning the turn). Distinct from
	 * `maxWaitSeconds`, which governs the gap BETWEEN bytes once output is
	 * already flowing. A turn that never produces any output (e.g. the prompt
	 * was lost into a startup modal) fails at this bound with a `first_byte_timeout`
	 * instead of burning the full idle budget. Always <= maxWaitSeconds.
	 */
	firstByteTimeoutSeconds: number;
	resumeSessionId: string | null;
	/**
	 * True when invoked with `--input-format stream-json`. Maestro sets this
	 * whenever it pipes a Claude stream-json envelope on stdin (the only path
	 * that carries attached images). The runner uses it to JSON-parse stdin
	 * and rewrite the prompt as `@path` mentions instead of typing the raw
	 * JSON+base64 blob into the TUI.
	 */
	streamJsonInput: boolean;
}

export interface ParseArgsOptions {
	/** Override the TTY check (defaults to `process.stdin.isTTY`). */
	stdinIsTTY?: boolean;
	/** Override the synchronous stdin reader (defaults to `fs.readFileSync(0, 'utf-8')`). */
	readStdin?: () => string;
	/** Override the warning sink for stripped flags (defaults to `process.stderr.write`). */
	warn?: (message: string) => void;
}

export const DEFAULT_MAX_WAIT_SECONDS = 300;

// How long to wait for claude to produce its FIRST JSONL entry after the prompt
// is sent, before giving up with `first_byte_timeout`. Must cover a cold TUI
// start + MCP handshake + model warmup AND the turn's own pre-transcript work:
// heavy scheduled prompts (full news analysis + web search + extended thinking)
// can keep the working spinner animating for minutes BEFORE claude writes its
// first transcript line, and the `--resume` path additionally reloads a large
// prior conversation before new output begins. At the old 120s, those healthy
// turns were being killed mid-think. 240s clears them while still sitting a
// real margin below the 300s idle budget, so a turn that genuinely never starts
// still fails before the whole `--max-wait` window. Overridable via
// `--first-byte-timeout`.
export const DEFAULT_FIRST_BYTE_TIMEOUT_SECONDS = 240;

const PROMPT_VALUE_FLAGS = new Set(['-p', '--print', '--prompt']);
const CONSUMED_BOOLEAN_FLAGS = new Set(['-h', '--help', '-v', '--version']);
// `--input-format` is handled specially below: `stream-json` flips
// streamJsonInput on so runMode JSON-parses stdin and rewrites the prompt
// with `@path` image mentions; other values are stripped with a warning
// (same as the legacy behavior for the rest of the headless-only flags).
const STRIPPED_VALUE_FLAGS = new Set(['--output-format']);
const STRIPPED_BOOLEAN_FLAGS = new Set(['--verbose']);

// Long flags that claude treats as booleans - the parser must NOT swallow the
// next argv slot when one of these appears. Out-of-date entries here only cause
// a UX glitch (a true positional after the unknown boolean gets misclassified
// as the flag's value); the runner still works if the user uses `-p`.
const KNOWN_CLAUDE_BOOLEAN_LONG_FLAGS = new Set([
	'--continue',
	'--debug',
	'--ide',
	'--strict-mcp-config',
	'--dangerously-skip-permissions',
]);

/** Blocking sleep with no event loop, used to back off on EAGAIN. */
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function defaultReadStdin(): string {
	// `fs.readFileSync(0)` throws EAGAIN when stdin is a NON-BLOCKING pipe that
	// isn't fully buffered yet - which is exactly how Electron's `process.execPath`
	// (ELECTRON_RUN_AS_NODE) hands us stdin. Small payloads fit the initial buffer
	// and never hit it; a large stream-json image envelope (multiple MB) does, and
	// the bare readFileSync crashed maestro-p with "EAGAIN ... read" - surfaced to
	// the user as "Agent exited with code 1" on any TUI turn with an attached image.
	// Read in a loop, backing off on EAGAIN until EOF.
	const CHUNK = 65536;
	const buf = Buffer.alloc(CHUNK);
	const out: Buffer[] = [];
	for (;;) {
		let bytesRead: number;
		try {
			bytesRead = fs.readSync(0, buf, 0, CHUNK, null);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === 'EAGAIN') {
				sleepSync(5);
				continue;
			}
			// Some platforms surface end-of-pipe as EOF rather than a 0-byte read.
			if (code === 'EOF') break;
			throw err;
		}
		if (bytesRead === 0) break;
		out.push(Buffer.from(buf.subarray(0, bytesRead)));
	}
	return Buffer.concat(out).toString('utf-8');
}

function defaultWarn(message: string): void {
	process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
}

interface SplitFlag {
	flag: string;
	inlineValue: string | undefined;
}

// Long-form flags can be written `--foo=bar`; split on the first `=`.
// Short flags (`-p`) don't get this treatment.
function splitFlag(arg: string): SplitFlag {
	if (!arg.startsWith('--')) return { flag: arg, inlineValue: undefined };
	const eq = arg.indexOf('=');
	if (eq < 0) return { flag: arg, inlineValue: undefined };
	return { flag: arg.slice(0, eq), inlineValue: arg.slice(eq + 1) };
}

export function parseArgs(argv: string[], options: ParseArgsOptions = {}): ParsedArgs {
	const stdinIsTTY = options.stdinIsTTY ?? !!process.stdin.isTTY;
	const readStdin = options.readStdin ?? defaultReadStdin;
	const warn = options.warn ?? defaultWarn;

	let mode: 'run' | 'status' = 'run';
	let promptFromFlag: string | null = null;
	let promptFromPositional: string | null = null;
	let streamThinking = false;
	let maxWaitSeconds = DEFAULT_MAX_WAIT_SECONDS;
	let firstByteTimeoutSeconds = DEFAULT_FIRST_BYTE_TIMEOUT_SECONDS;
	let resumeSessionId: string | null = null;
	let streamJsonInput = false;
	const passThroughArgs: string[] = [];

	let i = 0;
	while (i < argv.length) {
		const raw = argv[i];
		const { flag, inlineValue } = splitFlag(raw);

		// Pull a value for value-taking flags: prefer the inline `--flag=value`
		// form, otherwise consume the next argv slot. Returns undefined if
		// neither is present.
		//
		// Flag-guard: refuse to swallow a next-slot token that itself looks
		// like a flag (`-x` / `--foo`). When Maestro forwards its API-mode
		// claude args verbatim to a custom-path maestro-p (the opt-in route),
		// the argv looks like `--print --verbose --output-format stream-json
		// … <prompt>`. Without this guard, `--print` greedily consumes
		// `--verbose` as its prompt value and the real positional prompt
		// gets dropped into passthrough. Callers that legitimately need a
		// flag-looking value must use the inline `--flag=value` form.
		const consumeValue = (): string | undefined => {
			if (inlineValue !== undefined) return inlineValue;
			if (i + 1 >= argv.length) return undefined;
			const next = argv[i + 1];
			if (next.startsWith('-') && next.length > 1) return undefined;
			i += 1;
			return next;
		};

		if (flag === '--status') {
			mode = 'status';
			i += 1;
			continue;
		}

		// `--` is the POSIX end-of-options marker: every remaining token is a
		// positional, never a flag. Maestro's API-mode spawn line ends with
		// `… --dangerously-skip-permissions -- <prompt>`; without this branch
		// the generic long-flag handler below would treat `--` as an unknown
		// flag and consume the prompt as its "value", leaving promptFromPositional
		// empty and the runner aborting with "no prompt provided".
		if (raw === '--') {
			i += 1;
			while (i < argv.length) {
				const tok = argv[i];
				if (promptFromPositional === null) {
					promptFromPositional = tok;
				} else {
					passThroughArgs.push(tok);
				}
				i += 1;
			}
			continue;
		}

		if (PROMPT_VALUE_FLAGS.has(flag)) {
			const value = consumeValue();
			if (value === undefined) {
				warn(`maestro-p: ${flag} requires a value; ignoring.`);
			} else {
				promptFromFlag = value;
			}
			i += 1;
			continue;
		}

		if (flag === '--stream-thinking') {
			streamThinking = true;
			i += 1;
			continue;
		}

		if (flag === '--max-wait') {
			const value = consumeValue();
			if (value === undefined) {
				warn(`maestro-p: --max-wait requires a value; using default ${DEFAULT_MAX_WAIT_SECONDS}s.`);
			} else {
				const parsed = Number.parseInt(value, 10);
				if (Number.isFinite(parsed) && parsed > 0) {
					maxWaitSeconds = parsed;
				} else {
					warn(
						`maestro-p: --max-wait "${value}" is not a positive integer; using default ${DEFAULT_MAX_WAIT_SECONDS}s.`
					);
				}
			}
			i += 1;
			continue;
		}

		if (flag === '--first-byte-timeout') {
			const value = consumeValue();
			if (value === undefined) {
				warn(
					`maestro-p: --first-byte-timeout requires a value; using default ${DEFAULT_FIRST_BYTE_TIMEOUT_SECONDS}s.`
				);
			} else {
				const parsed = Number.parseInt(value, 10);
				if (Number.isFinite(parsed) && parsed > 0) {
					firstByteTimeoutSeconds = parsed;
				} else {
					warn(
						`maestro-p: --first-byte-timeout "${value}" is not a positive integer; using default ${DEFAULT_FIRST_BYTE_TIMEOUT_SECONDS}s.`
					);
				}
			}
			i += 1;
			continue;
		}

		if (CONSUMED_BOOLEAN_FLAGS.has(flag)) {
			// commander in index.ts prints the actual --help/--version output
			// before parseArgs runs in production; consume here so bare
			// invocations of parseArgs (and tests) drop them from passthrough.
			i += 1;
			continue;
		}

		if (STRIPPED_VALUE_FLAGS.has(flag)) {
			warn(`maestro-p: ignoring ${flag} - headless-mode flag, not forwarded to the TUI.`);
			if (inlineValue === undefined && i + 1 < argv.length) {
				i += 1;
			}
			i += 1;
			continue;
		}

		if (flag === '--input-format') {
			const value = consumeValue();
			if (value === 'stream-json') {
				// Don't forward to the TUI (claude TUI doesn't accept this flag -
				// it's --print-only). Instead, record the intent so runMode
				// JSON-parses stdin and rewrites the prompt with @path image
				// mentions before sending to the TUI.
				streamJsonInput = true;
			} else if (value === undefined) {
				warn(`maestro-p: --input-format requires a value; ignoring.`);
			} else {
				warn(
					`maestro-p: ignoring --input-format ${value} - only stream-json is recognized; stdin will be treated as plain text.`
				);
			}
			i += 1;
			continue;
		}
		if (STRIPPED_BOOLEAN_FLAGS.has(flag)) {
			warn(`maestro-p: ignoring ${flag} - headless-mode flag, not forwarded to the TUI.`);
			i += 1;
			continue;
		}

		if (flag === '--resume') {
			if (inlineValue !== undefined) {
				resumeSessionId = inlineValue;
				passThroughArgs.push(raw);
			} else if (i + 1 < argv.length) {
				resumeSessionId = argv[i + 1];
				passThroughArgs.push(raw, argv[i + 1]);
				i += 1;
			} else {
				// No value - pass the bare flag through and let claude error.
				passThroughArgs.push(raw);
			}
			i += 1;
			continue;
		}

		// Pass-through long flag. Apply the value-arity heuristic: assume the
		// next argv slot is its value unless this is a known boolean.
		if (raw.startsWith('--')) {
			passThroughArgs.push(raw);
			const isKnownBoolean = KNOWN_CLAUDE_BOOLEAN_LONG_FLAGS.has(flag);
			if (!isKnownBoolean && inlineValue === undefined && i + 1 < argv.length) {
				i += 1;
				passThroughArgs.push(argv[i]);
			}
			i += 1;
			continue;
		}

		// Pass-through short flag - always treated as boolean (claude's short
		// flags are bool-only at time of writing).
		if (raw.startsWith('-') && raw.length > 1) {
			passThroughArgs.push(raw);
			i += 1;
			continue;
		}

		// Positional argument. The first one is a candidate for the prompt;
		// the rest fall straight to passthrough so we never silently drop
		// arbitrary user input.
		if (promptFromPositional === null) {
			promptFromPositional = raw;
		} else {
			passThroughArgs.push(raw);
		}
		i += 1;
	}

	let prompt: string | null = null;
	if (mode === 'status') {
		// `--status` ignores prompt input entirely; positional candidate (if
		// any) is dropped rather than forwarded to confuse the TUI.
		prompt = null;
	} else if (promptFromFlag !== null) {
		prompt = promptFromFlag;
		// Positional was a candidate but `-p` won; preserve user input by
		// passing the positional through verbatim.
		if (promptFromPositional !== null) {
			passThroughArgs.push(promptFromPositional);
		}
	} else if (promptFromPositional !== null) {
		prompt = promptFromPositional;
	} else if (!stdinIsTTY) {
		const stdinData = readStdin();
		const trimmed = stdinData.trim();
		if (trimmed.length > 0) {
			prompt = trimmed;
		}
	}

	// The first-byte budget never exceeds the overall idle budget: if a caller
	// sets a tight `--max-wait` (shorter than the first-byte default), the
	// overall budget wins so we don't keep waiting for a first byte past the
	// point the caller wanted the whole run abandoned.
	if (firstByteTimeoutSeconds > maxWaitSeconds) {
		firstByteTimeoutSeconds = maxWaitSeconds;
	}

	return {
		prompt,
		mode,
		passThroughArgs,
		streamThinking,
		maxWaitSeconds,
		firstByteTimeoutSeconds,
		resumeSessionId,
		streamJsonInput,
	};
}
