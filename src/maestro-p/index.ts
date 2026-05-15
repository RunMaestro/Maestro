#!/usr/bin/env node
// maestro-p — wrapper binary that mimics `claude -p` semantics on the outside
// but drives Claude's interactive TUI on the inside, so usage falls under the
// user's Claude Max interactive quota instead of API billing.
//
// Phase 1 task 8: wires together args / TuiDriver / JsonEmitter /
// session-watcher / usage-parser into the two top-level modes (`run` and
// `--status`). See playbook MAESTRO-P-01-binary.md for the full contract.

import * as os from 'os';
import * as path from 'path';

import { parseArgs, type ParsedArgs } from './args';
import { TuiDriver } from './tui-driver';
import { JsonEmitter } from './json-emitter';
import { JsonlTailer } from './jsonl-tailer';
import { DEFAULT_TIMEOUT_MS, discoverSessionId } from './session-watcher';
import { parseUsage } from './usage-parser';
import { VERSION } from './package-info';
import { encodeClaudeProjectPath } from '../shared/pathUtils';

// Help text is hand-written rather than commander-generated so it stays in
// lockstep with the consumed / stripped / passthrough rules implemented in
// args.ts. Commander would over-claim ownership of unknown flags and silently
// drop the ones we want to forward to claude verbatim.
const HELP_TEXT = [
	'Usage: maestro-p [prompt] [...claude-flags]',
	'       maestro-p -p "<prompt>" [...claude-flags]',
	'       echo "<prompt>" | maestro-p [...claude-flags]',
	'       maestro-p --status [...claude-flags]',
	'',
	'Drive Claude Code interactively while emitting stream-json on stdout.',
	'',
	'Options:',
	'  -p, --print <text>     Prompt text (alias: --prompt). Mirrors `claude -p`.',
	'      --prompt <text>    Prompt text (alias for -p / --print).',
	'      --status           Run /usage in the TUI, emit one status JSON, exit.',
	'      --stream-thinking  Mirror ANSI-stripped TUI lines to stderr.',
	'      --max-wait <secs>  Hard timeout since last received byte (default 300).',
	'  -h, --help             Show this help and exit.',
	'  -V, --version          Print the maestro-p version and exit.',
	'',
	'Flag handling:',
	'  Consumed by maestro-p (not forwarded): -p, --print, --prompt, --status,',
	'    --stream-thinking, --max-wait, --help, --version.',
	'  Stripped with a warning (headless flags that would corrupt the TUI spawn):',
	'    --output-format, --input-format, --verbose.',
	'  Everything else is forwarded verbatim to the underlying `claude` invocation.',
	'',
	'Environment:',
	'  MAESTRO_CLAUDE_BIN  Override the `claude` binary location (default: PATH).',
	'  CLAUDE_CONFIG_DIR   Inherited by the spawned claude; switch Max accounts.',
	'',
	'Exit codes:',
	'  0  success',
	'  1  general failure (no prompt, parser error, TUI crashed, ...)',
	'  2  Claude quota limit hit during the run',
	'  3  --max-wait timeout (no bytes received for the configured window)',
	'',
].join('\n');

// `/usage` renders inline without a spinner cycle, so we can't lean on the
// TuiDriver's spinner-stop transition to know when the panel is done. Wait
// for this many ms of zero line events after sending /usage and treat that
// as "panel rendered." 1500ms covers a slow remote-account fetch comfortably.
const STATUS_QUIESCENCE_MS = 1500;

// Once we see an assistant entry with stop_reason=end_turn in the jsonl tail,
// wait this many ms before finalizing. Gives any trailing entries already in
// flight (usage stats, final tool acks) a chance to land in the same envelope.
const END_TURN_IDLE_MS = 600;

interface RuntimeOptions {
	binPath: string;
	cwd: string;
	configDir: string;
	parsed: ParsedArgs;
}

async function main(argv: string[]): Promise<number> {
	// Help/version take precedence over everything else and short-circuit
	// before parseArgs runs (parseArgs silently consumes those flags and has
	// no slot for them in its return type, matching commander's behavior).
	if (argv.includes('--help') || argv.includes('-h')) {
		process.stdout.write(HELP_TEXT);
		return 0;
	}
	if (argv.includes('--version') || argv.includes('-V')) {
		process.stdout.write(`${VERSION}\n`);
		return 0;
	}

	let parsed: ParsedArgs;
	try {
		parsed = parseArgs(argv);
	} catch (err) {
		process.stderr.write(`${(err as Error).message}\n`);
		return 1;
	}

	const opts: RuntimeOptions = {
		binPath: process.env.MAESTRO_CLAUDE_BIN ?? 'claude',
		cwd: process.cwd(),
		configDir: process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'),
		parsed,
	};

	if (parsed.mode === 'status') {
		return runStatus(opts);
	}
	return runPrompt(opts);
}

async function runStatus(opts: RuntimeOptions): Promise<number> {
	const emitter = new JsonEmitter();
	const driver = new TuiDriver({
		binPath: opts.binPath,
		args: opts.parsed.passThroughArgs,
		cwd: opts.cwd,
		env: process.env,
	});

	const captured: string[] = [];
	driver.on('line', (line: string) => {
		captured.push(line);
		if (opts.parsed.streamThinking) {
			process.stderr.write(`${line}\n`);
		}
	});

	let exitedEarly = false;
	driver.on('exit', () => {
		exitedEarly = true;
	});

	try {
		await driver.start();
	} catch (err) {
		process.stderr.write(`maestro-p: failed to spawn claude: ${describeError(err)}\n`);
		return 1;
	}

	try {
		await waitForReady(driver);
	} catch {
		process.stderr.write('maestro-p: claude TUI exited before reaching ready state\n');
		return 1;
	}

	if (exitedEarly) {
		process.stderr.write('maestro-p: claude TUI exited before --status could run\n');
		return 1;
	}

	// Reset the buffer — only post-/usage lines feed the parser. Anything
	// captured during startup is chrome (welcome banner, MOTD, etc.).
	captured.length = 0;

	driver.send('/usage');
	await waitForQuiescence(driver, STATUS_QUIESCENCE_MS);

	const snapshot = parseUsage(captured.join('\n'), new Date().toISOString(), opts.configDir);

	if (snapshot === null) {
		process.stderr.write(
			'maestro-p: could not parse /usage output (expected three usage sections)\n'
		);
		await driver.quit();
		return 1;
	}

	emitter.emitStatus(snapshot);
	await driver.quit();
	return 0;
}

async function runPrompt(opts: RuntimeOptions): Promise<number> {
	if (opts.parsed.prompt === null || opts.parsed.prompt.trim() === '') {
		process.stderr.write(
			'maestro-p: no prompt provided (use -p, a positional arg, or pipe via stdin)\n'
		);
		return 1;
	}
	const prompt = opts.parsed.prompt;

	const emitter = new JsonEmitter();
	const startTime = Date.now();
	const spawnTimestamp = Date.now();

	// Honor an explicit --resume <id> in forwarded args. The id IS the
	// session_id by definition; we skip fs-watch discovery and tail the
	// existing jsonl from current-end so we don't replay history.
	const resumeSessionId = findResumeId(opts.parsed.passThroughArgs);

	const driver = new TuiDriver({
		binPath: opts.binPath,
		args: opts.parsed.passThroughArgs,
		cwd: opts.cwd,
		env: process.env,
	});

	let finalized = false;
	let watchdog: NodeJS.Timeout | null = null;
	let endTurnTimer: NodeJS.Timeout | null = null;
	let tailer: JsonlTailer | null = null;
	let resolvedSessionId: string | null = resumeSessionId;
	let lastAssistantText = '';
	let lastAssistantUsage: Record<string, unknown> | undefined;
	let limitHit = false;

	const finalize = async (state: {
		isError: boolean;
		error?: string;
		exitCode: number;
	}): Promise<void> => {
		if (finalized) return;
		finalized = true;
		if (watchdog) clearTimeout(watchdog);
		if (endTurnTimer) clearTimeout(endTurnTimer);
		if (tailer) tailer.stop();

		// Init has either already fired (happy path) or never fired (failed
		// before session-id discovery). emitInit is idempotent, so a redundant
		// call here is a no-op; the early-failure call ensures the stream
		// envelope is always valid.
		emitter.emitInit({
			sessionId: resolvedSessionId ?? 'unknown',
			cwd: opts.cwd,
		});

		emitter.emitResult({
			sessionId: resolvedSessionId ?? 'unknown',
			durationMs: Date.now() - startTime,
			isError: state.isError,
			error: state.error,
			result: lastAssistantText || undefined,
			usage: lastAssistantUsage,
		});

		await driver.quit();
		process.exit(state.exitCode);
	};

	const maxWaitMs = opts.parsed.maxWaitSeconds * 1000;
	const resetWatchdog = (): void => {
		if (finalized) return;
		if (watchdog) clearTimeout(watchdog);
		watchdog = setTimeout(() => {
			void finalize({
				isError: true,
				error: limitHit ? 'limit_hit' : 'timeout',
				exitCode: limitHit ? 2 : 3,
			});
		}, maxWaitMs);
	};

	const scheduleEndTurnFinalize = (): void => {
		if (finalized) return;
		if (endTurnTimer) clearTimeout(endTurnTimer);
		endTurnTimer = setTimeout(() => {
			void finalize({
				isError: limitHit,
				error: limitHit ? 'limit_hit' : undefined,
				exitCode: limitHit ? 2 : 0,
			});
		}, END_TURN_IDLE_MS);
	};

	const handleTailerEntry = (entry: unknown): void => {
		if (finalized) return;
		resetWatchdog();
		if (!entry || typeof entry !== 'object') return;
		const e = entry as Record<string, unknown>;

		if (e.type === 'assistant' && e.message && typeof e.message === 'object') {
			const msg = e.message as Record<string, unknown>;

			// Claude writes a synthetic "No response requested." entry into
			// the jsonl when --resume picks up a session that had nothing
			// pending. It's an internal bookkeeping artifact, not part of the
			// conversation — model: '<synthetic>' is claude's own marker.
			// Skip so downstream consumers don't see phantom turns.
			if (msg.model === '<synthetic>') {
				return;
			}

			// Cancel any previous end-turn timer — a new assistant entry means
			// the generation is still going (e.g., post-tool follow-up turn).
			if (endTurnTimer) {
				clearTimeout(endTurnTimer);
				endTurnTimer = null;
			}
			emitter.emitAssistantMessage(msg);

			// Accumulate the latest text block(s) for the final result envelope.
			const content = msg.content;
			if (Array.isArray(content)) {
				const textParts: string[] = [];
				for (const c of content) {
					if (
						c &&
						typeof c === 'object' &&
						(c as Record<string, unknown>).type === 'text' &&
						typeof (c as Record<string, unknown>).text === 'string'
					) {
						textParts.push((c as Record<string, unknown>).text as string);
					}
				}
				if (textParts.length > 0) {
					lastAssistantText = textParts.join('\n');
				}
			}
			if (msg.usage && typeof msg.usage === 'object') {
				lastAssistantUsage = msg.usage as Record<string, unknown>;
			}

			// end_turn means claude is finished responding to this prompt and
			// won't follow up with another turn (vs. tool_use, which signals
			// a tool round-trip is mid-flight). Schedule finalize after a
			// short idle so any trailing entries already buffered land first.
			if (msg.stop_reason === 'end_turn') {
				scheduleEndTurnFinalize();
			}
			return;
		}

		if (e.type === 'user' && e.message && typeof e.message === 'object') {
			const msg = e.message as Record<string, unknown>;
			const content = msg.content;
			// Skip the entry that records the prompt the user just sent — the
			// downstream consumer already knows what was sent. Only forward
			// user messages that carry tool_result blocks (claude executing a
			// tool inside its agentic loop).
			let hasToolResult = false;
			if (Array.isArray(content)) {
				for (const c of content) {
					if (c && typeof c === 'object' && (c as Record<string, unknown>).type === 'tool_result') {
						hasToolResult = true;
						break;
					}
				}
			}
			if (hasToolResult) {
				emitter.emitUserMessage(msg);
			}
		}
	};

	// Limit-hit detection still leans on the TUI's text stream — claude
	// renders the human-readable "weekly limit reached" line in the panel
	// before it shows up (if at all) in the jsonl. Cheap to keep around.
	driver.on('limit-hit', () => {
		limitHit = true;
	});

	driver.on('exit', (exitCode: number) => {
		if (!finalized) {
			void finalize({
				isError: true,
				error: `tui exited unexpectedly (code ${exitCode})`,
				exitCode: 1,
			});
		}
	});

	try {
		await driver.start();
	} catch (err) {
		process.stderr.write(`maestro-p: failed to spawn claude: ${describeError(err)}\n`);
		return 1;
	}

	try {
		await waitForReady(driver);
	} catch {
		// TUI exited before reaching the input prompt. The 'exit' listener
		// above has already initiated finalize(); the never-resolving promise
		// below keeps the function alive until process.exit runs.
		return new Promise<number>(() => {
			/* never resolves — finalize() exits */
		});
	}

	// Resume path: jsonl already exists. Tail it from current end so prior
	// turns don't get replayed through stdout, then send the new prompt.
	if (resumeSessionId !== null) {
		const slug = encodeClaudeProjectPath(opts.cwd);
		const jsonlPath = path.join(opts.configDir, 'projects', slug, `${resumeSessionId}.jsonl`);
		tailer = new JsonlTailer({ filePath: jsonlPath, skipExisting: true });
		tailer.on('entry', handleTailerEntry);
		tailer.start();

		emitter.emitInit({ sessionId: resumeSessionId, cwd: opts.cwd });
		resetWatchdog();
		driver.send(prompt);

		return new Promise<number>(() => {
			/* never resolves — finalize() exits */
		});
	}

	// Fresh path: kick off session-id discovery, send the prompt so claude
	// starts writing its jsonl, then attach the tailer once we know the file.
	const discoveryPromise = discoverSessionId({
		configDir: opts.configDir,
		cwd: opts.cwd,
		spawnTimestamp,
		timeoutMs: DEFAULT_TIMEOUT_MS,
	}).catch(() => null as string | null);

	resetWatchdog();
	driver.send(prompt);

	discoveryPromise
		.then((sessionId) => {
			if (finalized) return;
			if (sessionId === null) {
				// Discovery timed out — emit init with 'unknown' so the
				// downstream envelope is still well-formed; the eventual
				// watchdog timeout will produce a result.
				emitter.emitInit({ sessionId: 'unknown', cwd: opts.cwd });
				return;
			}
			resolvedSessionId = sessionId;
			emitter.emitInit({ sessionId, cwd: opts.cwd });

			const slug = encodeClaudeProjectPath(opts.cwd);
			const jsonlPath = path.join(opts.configDir, 'projects', slug, `${sessionId}.jsonl`);
			tailer = new JsonlTailer({ filePath: jsonlPath });
			tailer.on('entry', handleTailerEntry);
			tailer.start();
		})
		.catch(() => {
			// Defense in depth: discoveryPromise is already .catch'd above to
			// resolve null, but a programming error inside the .then handler
			// would surface here.
		});

	return new Promise<number>(() => {
		/* never resolves — finalize() exits */
	});
}

function findResumeId(args: string[]): string | null {
	const prefix = '--resume=';
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--resume' && i + 1 < args.length) {
			return args[i + 1];
		}
		if (args[i].startsWith(prefix)) {
			return args[i].slice(prefix.length);
		}
	}
	return null;
}

function waitForReady(driver: TuiDriver): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const onReady = (): void => {
			cleanup();
			resolve();
		};
		const onExit = (): void => {
			cleanup();
			reject(new Error('TUI exited before ready'));
		};
		const cleanup = (): void => {
			driver.off('ready', onReady);
			driver.off('exit', onExit);
		};
		driver.once('ready', onReady);
		driver.once('exit', onExit);
	});
}

function waitForQuiescence(driver: TuiDriver, idleMs: number): Promise<void> {
	return new Promise<void>((resolve) => {
		let timer: NodeJS.Timeout | null = null;
		let resolved = false;

		const finish = (): void => {
			if (resolved) return;
			resolved = true;
			if (timer) clearTimeout(timer);
			driver.off('line', onLine);
			driver.off('ready', onReady);
			driver.off('exit', onExit);
			resolve();
		};

		const onLine = (): void => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(finish, idleMs);
		};
		const onReady = (): void => finish();
		const onExit = (): void => finish();

		driver.on('line', onLine);
		driver.on('ready', onReady);
		driver.on('exit', onExit);

		timer = setTimeout(finish, idleMs);
	});
}

function describeError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

main(process.argv.slice(2))
	.then((code) => process.exit(code))
	.catch((err) => {
		process.stderr.write(`maestro-p: ${describeError(err)}\n`);
		process.exit(1);
	});
