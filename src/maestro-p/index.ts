#!/usr/bin/env node
// maestro-p
// Standalone wrapper that mimics `claude -p` semantics by driving Claude's
// interactive TUI under the hood, so callers (Maestro, shells, pipelines)
// consume the interactive Claude Max quota instead of API billing.
//
// Two modes:
//   * run    - default. Send a prompt to claude, tail the JSONL transcript,
//              re-emit assistant / user / result envelopes on stdout, exit.
//   * status - `--status`. Spawn claude, send `/usage`, capture the panel,
//              parse it into a single `status` JSON object, exit.
//
// The structured JSONL transcript is the source of truth for run-mode output;
// the TUI screen is only used for startup readiness and quota-limit detection
// (and, in status mode, for the `/usage` panel itself which is screen-only).
// See MAESTRO-P-01-binary.md for the full contract.

import { Command } from 'commander';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'path';

import { parseArgs, type ParsedArgs } from './args';
import { JsonEmitter, type EmitResultOptions } from './json-emitter';
import { JsonlTailer, type ParseErrorPayload } from './jsonl-tailer';
import { extractExitPlanText } from './plan-mode';
import { discoverSessionId, cwdSlug } from './session-watcher';
import { cleanupStreamJsonImages, translateStreamJsonInput } from './stream-json-input';
import { TuiDriver } from './tui-driver';
import { parseUsage } from './usage-parser';
import { VERSION } from './package-info';

// Watchdog tick. Cheap; the real budget lives in args.maxWaitSeconds.
const WATCHDOG_INTERVAL_MS = 1000;

// Interval between Enter re-submits while waiting for the first transcript
// byte. send()'s initial burst all lands within ~3s; on agents that load
// MCP servers/plugins the editor can stay unable to accept a submit for
// 10-40s under morning IO contention, so we keep re-pressing Enter (text
// already typed) across the whole first-byte budget until the turn starts.
// 8s is tight enough to recover within a few seconds of MCP settling, loose
// enough that a healthy run (first byte in ~1s) never fires a stray tap.
const RESUBMIT_INTERVAL_MS = 8000;
// Grace window after an `end_turn` to let trailing tool-result rows flush.
const END_TURN_GRACE_MS = 600;
// `/usage` panel paints synchronously but trickles bytes for several hundred ms.
const STATUS_INITIAL_WAIT_MS = 1500;
// Then debounce on no-new-lines for this long before declaring the panel done.
const STATUS_QUIET_DEBOUNCE_MS = 800;
const STATUS_DEBOUNCE_POLL_MS = 100;
// Floor for how long to wait for the new JSONL file to appear after a
// fresh-session spawn. This is only a FLOOR: the actual discovery window is
// raised to the caller's `--max-wait` budget (see the fresh-session path
// below). A cold claude TUI - first launch, MCP-server handshake, model
// warmup - routinely needs well over 10s to flush its first session JSONL,
// so a hardcoded 10s ceiling made every fresh-session spawn (tab naming,
// background synopsis) flake while resume-based turns, which skip discovery,
// were unaffected. Discovery still resolves the instant the file appears, so
// a larger ceiling costs nothing on the happy path.
const DISCOVERY_TIMEOUT_FLOOR_MS = 10000;

const program = new Command();

program
	.name('maestro-p')
	.description(
		[
			'Wrap Claude Code so callers see `claude -p` semantics while the underlying',
			'session runs through the interactive TUI (Claude Max quota, not API billing).',
			'',
			'Argument handling:',
			'  - Prompt-input flags (consumed): -p, --print, --prompt',
			'  - maestro-p flags (consumed):    --status, --stream-thinking, --max-wait, --first-byte-timeout, --help, --version',
			'  - Stripped (dropped with warning): --output-format, --input-format, --verbose',
			'  - Everything else is forwarded verbatim to the spawned `claude` TUI.',
			'',
			'Environment:',
			'  MAESTRO_CLAUDE_BIN  Path to the claude binary (defaults to `claude` on PATH).',
			'  CLAUDE_CONFIG_DIR   Claude config directory (defaults to ~/.claude); inherited by the TUI.',
		].join('\n')
	)
	.version(VERSION, '-v, --version', 'Print the maestro-p version and exit')
	.helpOption('-h, --help', 'Show this help and exit')
	.allowUnknownOption(true)
	.allowExcessArguments(true);

// Commander handles --help/--version (prints and exits 0). For everything
// else it returns and falls through to our own parseArgs walker - commander's
// option schema doesn't know about claude's flag surface, so we re-parse.
program.parse(process.argv);

function resolveConfigDir(): string {
	const envDir = process.env.CLAUDE_CONFIG_DIR;
	if (envDir && envDir.length > 0) return envDir;
	return path.join(os.homedir(), '.claude');
}

/**
 * True when `p` points at maestro-p itself (by basename), so we never try to
 * drive maestro-p as if it were the claude TUI.
 */
function isMaestroPSelfPath(p: string): boolean {
	const base = p.replace(/\\/g, '/').split('/').pop() || p;
	return base === 'maestro-p' || base === 'maestro-p.js' || base === 'maestro-p.exe';
}

function resolveBinPath(): string {
	const envBin = process.env.MAESTRO_CLAUDE_BIN;
	// Self-reference guard: when an agent's configured binary IS maestro-p (the
	// supported "maestro-p Path" way to force the TUI), the desktop can pass that
	// same path through MAESTRO_CLAUDE_BIN. Honoring it would make maestro-p spawn
	// ITSELF in the PTY instead of claude - the child exits in ~tens of ms and the
	// turn dies as `tui_exited` (observed on SSH agents whose customPath is
	// maestro-p). Fall back to `claude` on PATH in that case.
	if (envBin && envBin.length > 0 && !isMaestroPSelfPath(envBin)) {
		return envBin;
	}
	return 'claude';
}

// Env vars that mark the CURRENT process as running inside a Claude Code
// session. When maestro-p is invoked from within a Claude agent (or any
// process that inherited these), they leak into the claude TUI we spawn and
// make that child claude believe it is a NESTED/child session: it then runs in
// an ephemeral mode and never writes its own `<session-id>.jsonl` transcript.
// Since the JSONL is maestro-p's only source of truth, the run produces no
// `assistant`/`result` envelopes and times out with `first_byte_timeout` even
// though the answer rendered on screen - the "synopsis/tab-naming returns
// empty in TUI mode" bug. Verified by A/B: keeping CLAUDE_CODE_SESSION_ID /
// CLAUDE_CODE_CHILD_SESSION reproduces the empty-result timeout; stripping both
// makes the TUI write its transcript and the run succeed. We strip the whole
// CLAUDE_CODE_* identity family plus the CLAUDECODE marker defensively; auth
// and config (CLAUDE_CONFIG_DIR, ANTHROPIC_*, MAESTRO_CLAUDE_BIN) are kept.
const CLAUDE_SESSION_IDENTITY_ENV_VARS = [
	'CLAUDECODE',
	'CLAUDE_CODE_SESSION_ID',
	'CLAUDE_CODE_CHILD_SESSION',
	'CLAUDE_CODE_ENTRYPOINT',
] as const;

/**
 * Return a copy of `process.env` with the Claude session-identity markers
 * removed, so the claude TUI maestro-p drives starts as a clean top-level
 * session that persists its own JSONL transcript. See
 * {@link CLAUDE_SESSION_IDENTITY_ENV_VARS} for the why.
 */
function sanitizeChildEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of CLAUDE_SESSION_IDENTITY_ENV_VARS) {
		delete env[key];
	}
	return env;
}

function waitForEvent(emitter: EventEmitter, event: string): Promise<void> {
	return new Promise<void>((resolve) => emitter.once(event, () => resolve()));
}

interface AggregateUsage {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens: number;
	cache_read_input_tokens: number;
}

function emptyUsage(): AggregateUsage {
	return {
		input_tokens: 0,
		output_tokens: 0,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
	};
}

function addUsage(agg: AggregateUsage, msgUsage: unknown): void {
	if (!msgUsage || typeof msgUsage !== 'object') return;
	const u = msgUsage as Record<string, unknown>;
	if (typeof u.input_tokens === 'number') agg.input_tokens += u.input_tokens;
	if (typeof u.output_tokens === 'number') agg.output_tokens += u.output_tokens;
	if (typeof u.cache_creation_input_tokens === 'number') {
		agg.cache_creation_input_tokens += u.cache_creation_input_tokens;
	}
	if (typeof u.cache_read_input_tokens === 'number') {
		agg.cache_read_input_tokens += u.cache_read_input_tokens;
	}
}

// Per the playbook tool_result filter: `user` entries pass through ONLY if
// their content array carries at least one tool_result block. Plain `text`
// user entries are the prompt echo claude writes immediately after we send
// stdin - drop those.
function hasToolResultBlock(message: unknown): boolean {
	if (!message || typeof message !== 'object') return false;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return false;
	return content.some(
		(b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_result'
	);
}

function collectAssistantText(message: unknown): string {
	if (!message || typeof message !== 'object') return '';
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return '';
	let out = '';
	for (const block of content) {
		if (
			block &&
			typeof block === 'object' &&
			(block as { type?: unknown }).type === 'text' &&
			typeof (block as { text?: unknown }).text === 'string'
		) {
			out += (block as { text: string }).text;
		}
	}
	return out;
}

async function runMode(args: ParsedArgs): Promise<never> {
	if (!args.prompt || args.prompt.length === 0) {
		process.stderr.write(
			'maestro-p: no prompt provided. Use a positional argument, -p/--prompt, or pipe a prompt on stdin.\n'
		);
		process.exit(1);
	}

	// `--input-format stream-json` mode: parse the Claude envelope Maestro
	// pipes in, save any embedded base64 images to /tmp, and rewrite the
	// prompt as `@path` mentions. Without this the JSON+base64 blob would
	// be typed into the TUI as keystrokes and no image would attach.
	let prompt = args.prompt;
	const tempImagePaths: string[] = [];
	if (args.streamJsonInput) {
		const translated = translateStreamJsonInput(args.prompt);
		if (translated) {
			prompt = translated.prompt;
			tempImagePaths.push(...translated.imagePaths);
		} else {
			process.stderr.write(
				'maestro-p: --input-format stream-json was set but stdin was not a valid Claude stream-json envelope; treating it as a plain-text prompt.\n'
			);
		}
	}

	const cwd = process.cwd();
	const configDir = resolveConfigDir();
	const binPath = resolveBinPath();
	const emitter = new JsonEmitter();
	const startMs = Date.now();

	// Fresh sessions: pre-assign the session id and tell the TUI to use it via
	// `claude --session-id <uuid>`. The watcher then polls for exactly
	// `<uuid>.jsonl` instead of guessing "the earliest new file", which is
	// race-free when several fresh-session TUIs run concurrently in the same
	// cwd (tab naming for multiple tabs in one project). Resume already knows
	// its id, so we leave that path untouched. claude 2.1.x honours
	// `--session-id` in interactive/TUI mode (verified: it writes exactly the
	// requested `<uuid>.jsonl`).
	const passThroughArgs = [...args.passThroughArgs];
	let freshSessionId: string | null = null;
	if (!args.resumeSessionId) {
		freshSessionId = randomUUID();
		passThroughArgs.push('--session-id', freshSessionId);
	}

	const driver = new TuiDriver({
		binPath,
		args: passThroughArgs,
		cwd,
		env: sanitizeChildEnv(),
	});

	if (args.streamThinking) {
		driver.on('line', (line: string) => {
			process.stderr.write(`${line}\n`);
		});
	}

	let tailer: JsonlTailer | null = null;
	let resolvedSessionId: string = args.resumeSessionId ?? '';
	let initEmitted = false;
	let finalized = false;
	let watchdogTimer: NodeJS.Timeout | null = null;
	let graceTimer: NodeJS.Timeout | null = null;
	// Fires if no JSONL entry has arrived within firstByteTimeoutSeconds of the
	// TUI starting. Distinct from the idle watchdog: this catches a turn that
	// NEVER produces output (prompt lost to a startup modal, claude wedged
	// pre-turn), failing fast instead of riding the full idle budget. Cleared
	// the moment the first entry lands (see handleEntry).
	let firstByteTimer: NodeJS.Timeout | null = null;
	// Re-presses Enter on an interval until the first transcript byte lands, so
	// a prompt parked behind slow MCP/plugin init still gets submitted. Cleared
	// the instant the turn starts (markFirstEntrySeen) and on any finalize.
	let resubmitTimer: NodeJS.Timeout | null = null;
	let firstEntrySeen = false;
	let limitHit = false;
	let aggregatedText = '';
	const usage = emptyUsage();
	// Buffer for entries that race ahead of emitInit. Should be empty in
	// the normal flow (tailer.start() / EOF-skip prevent racing), but keeps
	// us robust against weird PTY timing.
	const pendingEntries: unknown[] = [];

	const cleanupTimers = (): void => {
		if (watchdogTimer) {
			clearInterval(watchdogTimer);
			watchdogTimer = null;
		}
		if (graceTimer) {
			clearTimeout(graceTimer);
			graceTimer = null;
		}
		if (firstByteTimer) {
			clearTimeout(firstByteTimer);
			firstByteTimer = null;
		}
		if (resubmitTimer) {
			clearInterval(resubmitTimer);
			resubmitTimer = null;
		}
	};

	// Cancel the first-byte timer as soon as claude writes anything to the
	// transcript - any entry (even the prompt-echo user row) proves the turn
	// started, so from here only the idle watchdog governs the run.
	const markFirstEntrySeen = (): void => {
		if (firstEntrySeen) return;
		firstEntrySeen = true;
		if (firstByteTimer) {
			clearTimeout(firstByteTimer);
			firstByteTimer = null;
		}
		if (resubmitTimer) {
			clearInterval(resubmitTimer);
			resubmitTimer = null;
		}
	};

	// Spread Enter re-submits across the first-byte budget. Each tap is gated on
	// the turn not having started (and not finalized), so it stops itself the
	// moment any transcript byte arrives even before cleanupTimers runs.
	//
	// TUI-liveness gate: the JSONL "first entry" signal lags the turn - claude
	// can be demonstrably working (spinner animating, token counter rising) for
	// a long time before it writes its first transcript line. We must NOT keep
	// pressing Enter into a turn that has already started: stray taps risk
	// landing as interrupts or queued submits. So we only re-tap while the TUI
	// screen is STATIC (the prompt is genuinely parked behind slow MCP/plugin
	// init) and stop the instant the screen starts painting (proof the turn
	// began). We deliberately do NOT clear the first-byte timer here: liveness
	// stops the tapping, but only a real JSONL entry counts as first byte, so a
	// screen that animates for an unrelated reason degrades to "ride out the
	// first-byte budget", never a premature success. The tap's own echo is
	// folded into the baseline after each tap, so a tap never trips its own
	// gate; a no-op Enter on an already-parked input paints nothing, and a tap
	// that finally submits the parked prompt starts the spinner we then stop on.
	const startResubmitLoop = (): void => {
		if (resubmitTimer) return;
		let lastScreen: string | null = null;
		resubmitTimer = setInterval(() => {
			if (finalized || firstEntrySeen) {
				if (resubmitTimer) {
					clearInterval(resubmitTimer);
					resubmitTimer = null;
				}
				return;
			}
			if (lastScreen !== null && driver.getScreenTail() !== lastScreen) {
				// Screen painted since our last tap with no JSONL entry yet - the
				// working spinner is animating, so the turn has started. Stop
				// tapping and let the first-byte/idle timers govern from here.
				if (resubmitTimer) {
					clearInterval(resubmitTimer);
					resubmitTimer = null;
				}
				return;
			}
			driver.resubmit();
			lastScreen = driver.getScreenTail();
		}, RESUBMIT_INTERVAL_MS);
	};

	const finalize = (options: { isError: boolean; error?: string; exitCode: number }): void => {
		if (finalized) return;
		finalized = true;
		cleanupTimers();
		tailer?.stop();
		// Best-effort: synchronous so claude (which has long-since consumed
		// these via the @path Read tool) doesn't leave them behind.
		cleanupStreamJsonImages(tempImagePaths);

		// Ensure init is emitted so emitResult doesn't throw on pre-discovery
		// failure paths (timeout before discovery, etc.).
		if (!initEmitted) {
			emitter.emitInit({ sessionId: resolvedSessionId, model: null, cwd });
			initEmitted = true;
		}

		// limitHit overrides exit code (2) and tags the result as a limit
		// error while preserving the assistant text we collected before the
		// quota line was painted.
		const errorIsLimit = limitHit && !options.isError;
		const finalIsError = options.isError || limitHit;
		const finalError = options.error ?? (errorIsLimit ? 'limit' : undefined);
		const resultOpts: EmitResultOptions = {
			sessionId: resolvedSessionId,
			durationMs: Date.now() - startMs,
			isError: finalIsError,
		};
		if (finalError !== undefined) resultOpts.error = finalError;
		// Carry aggregated text/usage on success and on the limit-drain path
		// (assistant emitted text BEFORE the limit was hit). Pure error paths
		// (timeout, tui_exited) omit them.
		if (!options.isError || errorIsLimit) {
			resultOpts.result = aggregatedText;
			resultOpts.usage = usage;
		}
		try {
			emitter.emitResult(resultOpts);
		} catch (err) {
			process.stderr.write(
				`maestro-p: failed to emit result envelope: ${(err as Error).message}\n`
			);
		}

		const exitCode = limitHit ? 2 : options.exitCode;
		void driver
			.quit()
			.catch(() => {
				/* already gone; nothing to escalate against */
			})
			.finally(() => {
				process.exit(exitCode);
			});
	};

	const processEntry = (entry: unknown): void => {
		if (finalized || !entry || typeof entry !== 'object') return;
		const e = entry as Record<string, unknown>;
		const message = e.message as Record<string, unknown> | undefined;

		// Synthetic-model bookkeeping rows ("No response requested.") never
		// reach the wire.
		if (message && message.model === '<synthetic>') return;

		if (e.type === 'assistant' && message) {
			// Any new entry invalidates a pending end_turn grace timer.
			if (graceTimer) {
				clearTimeout(graceTimer);
				graceTimer = null;
			}
			aggregatedText += collectAssistantText(message);
			addUsage(usage, message.usage);
			emitter.emitAssistantMessage(message);

			// Plan/read-only mode (`--permission-mode plan`) ends the turn with an
			// ExitPlanMode tool call that parks the TUI on a blocking approval
			// dialog maestro-p can't answer, so `end_turn` never arrives and the
			// idle watchdog would otherwise kill the turn at --max-wait (exitCode 3,
			// dropping the plan we captured). The plan is the deliverable here, just
			// like `claude --print --permission-mode plan`: fold its body into the
			// result and finalize cleanly.
			const planText = extractExitPlanText(message);
			if (planText !== null) {
				if (planText && !aggregatedText.includes(planText)) {
					aggregatedText += (aggregatedText ? '\n\n' : '') + planText;
				}
				finalize({ isError: false, exitCode: 0 });
				return;
			}

			if (message.stop_reason === 'end_turn') {
				graceTimer = setTimeout(() => {
					if (!finalized) {
						finalize({ isError: false, exitCode: 0 });
					}
				}, END_TURN_GRACE_MS);
			}
			return;
		}

		if (e.type === 'user' && message) {
			// A user entry after end_turn is typically a tool_result row;
			// restart the grace so we don't truncate the turn mid-drain.
			if (graceTimer) {
				clearTimeout(graceTimer);
				graceTimer = null;
			}
			if (hasToolResultBlock(message)) {
				emitter.emitUserMessage(message);
			}
			// Otherwise it's the prompt echo claude logs on receipt; drop it.
			return;
		}

		// Ignore other entry types (system/summary/etc.) - claude's internal
		// taxonomy.
	};

	const flushPending = (): void => {
		for (const entry of pendingEntries) {
			processEntry(entry);
		}
		pendingEntries.length = 0;
	};

	const handleEntry = (entry: unknown): void => {
		// Any transcript line means claude started the turn - cancel the
		// first-byte timer before the init-gating buffer logic so a pre-init
		// entry still counts as "first byte".
		markFirstEntrySeen();
		if (!initEmitted) {
			pendingEntries.push(entry);
			return;
		}
		processEntry(entry);
	};

	const handleParseError = (payload: ParseErrorPayload): void => {
		const snippet = payload.line.length > 200 ? `${payload.line.slice(0, 200)}…` : payload.line;
		process.stderr.write(
			`maestro-p: JSONL parse error: ${payload.error.message} - line: ${snippet}\n`
		);
	};

	driver.on('limit-hit', () => {
		limitHit = true;
		// A quota limit means claude paints the limit line on the TUI and sits -
		// it won't emit (further) transcript output this turn. Don't wait for the
		// first-byte / idle timeout (up to 120s) to settle: that long stall is what
		// makes a Dynamic-mode turn look like it produced "no response" after the
		// mode-switch banner. Finalize after the same short drain grace used for
		// end_turn (so any assistant text painted BEFORE the limit still flushes),
		// then exit. `limitHit` forces exit code 2, which fires the desktop's
		// interactive→API replay so the user's prompt is promptly re-sent under
		// `claude --print` and actually gets answered.
		setTimeout(() => {
			if (!finalized) {
				finalize({ isError: false, exitCode: 2 });
			}
		}, END_TURN_GRACE_MS);
	});
	driver.on('exit', () => {
		if (finalized) return;
		finalize({ isError: true, error: 'tui_exited', exitCode: 1 });
	});
	driver.on('ready-timeout', () => {
		if (finalized) return;
		// Distinct from 'tui_exited': the PTY is still alive, but the
		// startup handshake (READY_REGEX or blind taps) never cleared
		// whatever modal the TUI is parked on. finalize() drives quit()
		// which will SIGTERM the PTY if it doesn't /quit gracefully.
		finalize({ isError: true, error: 'ready_timeout', exitCode: 4 });
	});

	await driver.start();

	// Arm the first-byte timer the moment the TUI is up. It spans the ready
	// handshake, session discovery, and the wait for claude's first transcript
	// entry - any of which stalling indefinitely (a prompt swallowed by a
	// startup modal is the canonical case) trips it. The ready-timeout (exit 4)
	// covers a TUI that never reaches its prompt; this covers a TUI that reaches
	// the prompt but never starts a turn.
	const firstByteTimeoutMs = args.firstByteTimeoutSeconds * 1000;
	firstByteTimer = setTimeout(() => {
		if (finalized || firstEntrySeen) return;
		// Dump the last screenful so the failure is diagnosable from stderr
		// alone: an MCP-connecting banner, a blocking modal, or un-submitted
		// prompt text each point at a different remaining fix.
		const screenTail = driver.getScreenTail();
		process.stderr.write(
			`maestro-p: no transcript output within ${args.firstByteTimeoutSeconds}s of sending the prompt - claude never started the turn (prompt may have been swallowed by a startup modal). Failing with first_byte_timeout.\n` +
				`maestro-p: last screen at timeout (ANSI-stripped tail):\n${screenTail}\n`
		);
		finalize({ isError: true, error: 'first_byte_timeout', exitCode: 5 });
	}, firstByteTimeoutMs);

	if (args.resumeSessionId) {
		// Resume path: the JSONL already exists from the prior turn(s); tail
		// from EOF so we don't replay history to stdout. The wait-for-ready
		// step ensures the TUI is accepting input before we send our reply.
		const jsonlPath = path.join(
			configDir,
			'projects',
			cwdSlug(cwd),
			`${args.resumeSessionId}.jsonl`
		);
		tailer = new JsonlTailer({ path: jsonlPath, skipExisting: true });
		tailer.on('entry', handleEntry);
		tailer.on('parse-error', handleParseError);
		await tailer.start();
		await waitForEvent(driver, 'ready');
		emitter.emitInit({ sessionId: args.resumeSessionId, model: null, cwd });
		initEmitted = true;
		flushPending();
		driver.send(prompt);
		startResubmitLoop();
	} else {
		// Fresh-session path: we pre-assigned `freshSessionId` and passed it to
		// the TUI via `--session-id`, so discovery polls for exactly that file
		// (race-free across concurrent same-cwd spawns). spawnTimestamp is still
		// passed for the legacy earliest-new fallback, but expectSessionId takes
		// precedence. We start discovery and send the prompt back-to-back, then
		// attach the tailer once the file appears.
		await waitForEvent(driver, 'ready');
		const discoveryPromise = discoverSessionId({
			configDir,
			cwd,
			spawnTimestamp: startMs,
			expectSessionId: freshSessionId ?? undefined,
			// Bound discovery by the first-byte budget, not the (much larger)
			// idle budget. The session file only appears once claude actually
			// starts the turn, so "file never showed up" is the same failure as
			// "no first byte" - both should fail fast rather than ride the full
			// --max-wait window. The FLOOR still covers a slow cold start.
			timeoutMs: Math.max(DISCOVERY_TIMEOUT_FLOOR_MS, firstByteTimeoutMs),
		});
		driver.send(prompt);
		startResubmitLoop();
		let discovered: { sessionId: string; jsonlPath: string };
		try {
			discovered = await discoveryPromise;
		} catch (err) {
			// Discovery timed out (or failed): claude never wrote a session
			// transcript, i.e. the turn never started. Finalize with the same
			// first_byte_timeout contract instead of letting the rejection
			// bubble to main()'s catch (a bare exit 1 with no result envelope).
			if (!finalized) {
				process.stderr.write(
					`maestro-p: session discovery failed: ${err instanceof Error ? err.message : String(err)}\n` +
						`maestro-p: last screen at timeout (ANSI-stripped tail):\n${driver.getScreenTail()}\n`
				);
				finalize({ isError: true, error: 'first_byte_timeout', exitCode: 5 });
			}
			return new Promise<never>(() => undefined);
		}
		resolvedSessionId = discovered.sessionId;
		emitter.emitInit({ sessionId: discovered.sessionId, model: null, cwd });
		initEmitted = true;
		tailer = new JsonlTailer({ path: discovered.jsonlPath, skipExisting: false });
		tailer.on('entry', handleEntry);
		tailer.on('parse-error', handleParseError);
		await tailer.start();
		flushPending();
	}

	// Watchdog: trips when no JSONL bytes have arrived for maxWaitSeconds.
	// JsonlTailer seeds lastByteAt at start() time, so a fresh tailer with
	// no data still gets the full window before timeout.
	watchdogTimer = setInterval(() => {
		if (finalized || !tailer) return;
		const idleMs = Date.now() - tailer.getLastByteAt();
		if (idleMs > args.maxWaitSeconds * 1000) {
			finalize({ isError: true, error: 'timeout', exitCode: 3 });
		}
	}, WATCHDOG_INTERVAL_MS);

	// Settles via process.exit() inside finalize(). The watchdog setInterval
	// (ref'd by default) keeps the event loop alive while we wait.
	return new Promise<never>(() => undefined);
}

async function statusMode(args: ParsedArgs): Promise<never> {
	const cwd = process.cwd();
	const configDir = resolveConfigDir();
	const binPath = resolveBinPath();

	const driver = new TuiDriver({
		binPath,
		args: args.passThroughArgs,
		cwd,
		env: sanitizeChildEnv(),
		// Parse the /usage panel from the full raw screen, not the `\n`-delimited
		// 'line' events: heavier panels paint via cursor-addressing with no line
		// feeds, so the 'line' stream is empty and the content would be lost.
		captureScreen: true,
	});

	const lines: string[] = [];
	let lastLineAt = 0;
	driver.on('line', (line: string) => {
		lines.push(line);
		lastLineAt = Date.now();
		if (args.streamThinking) {
			process.stderr.write(`${line}\n`);
		}
	});

	let statusFinalized = false;
	driver.on('exit', () => {
		if (statusFinalized) return;
		statusFinalized = true;
		process.stderr.write('maestro-p: claude TUI exited before /usage panel could render\n');
		process.exit(1);
	});

	await driver.start();
	await waitForEvent(driver, 'ready');

	driver.send('/usage');

	// Initial hold so the panel has time to start rendering.
	await new Promise<void>((resolve) => setTimeout(resolve, STATUS_INITIAL_WAIT_MS));

	// Then debounce on no-new-lines: keep polling until the line stream has
	// been quiet for STATUS_QUIET_DEBOUNCE_MS straight.
	let quietSince = Date.now();
	let lastSeenAt = lastLineAt;
	while (Date.now() - quietSince < STATUS_QUIET_DEBOUNCE_MS) {
		await new Promise<void>((resolve) => setTimeout(resolve, STATUS_DEBOUNCE_POLL_MS));
		if (lastLineAt !== lastSeenAt) {
			lastSeenAt = lastLineAt;
			quietSince = Date.now();
		}
	}

	// Parse from the full raw screen capture, not the `\n`-delimited 'line'
	// events: heavier /usage panels (Team/Enterprise accounts, or any account
	// with a long "what's contributing" breakdown) paint via cursor-addressing
	// with no line feeds, leaving the 'line' stream empty. The screen capture is
	// a superset that always carries the panel; fall back to the joined lines
	// only if capture was somehow empty.
	const raw = driver.getScreenCapture() || lines.join('\n');

	// Diagnostic hook: when MAESTRO_P_DUMP_RAW points at a file, write the raw
	// captured screen there before parsing. The /usage layout drifts by plan
	// type (personal Max vs Team/Enterprise vs API-billing), and parse failures
	// are screen-only - there's no transcript to inspect after the fact. This
	// lets a maintainer capture the exact panel a given account renders without
	// rebuilding an instrumented binary. Best-effort: a write failure must never
	// derail the status probe itself.
	const dumpPath = process.env.MAESTRO_P_DUMP_RAW;
	if (dumpPath) {
		try {
			fs.writeFileSync(dumpPath, raw, 'utf8');
		} catch {
			// ignore - diagnostics are non-fatal
		}
	}

	const parsed = parseUsage(raw, new Date().toISOString(), configDir);
	statusFinalized = true;
	if (parsed) {
		const emitter = new JsonEmitter();
		emitter.emitStatus(parsed);
		await driver.quit();
		process.exit(0);
	}

	process.stderr.write('maestro-p: failed to parse /usage output\n');
	await driver.quit();
	process.exit(1);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.mode === 'status') {
		await statusMode(args);
		return;
	}
	await runMode(args);
}

// A dead stdout/stderr reader (the desktop interrupted the turn, closed the tab,
// or killed us) surfaces as an async EPIPE on the stream. With no listener Node
// promotes it to an uncaught exception - and because maestro-p runs under
// ELECTRON_RUN_AS_NODE that pops Electron's GUI "A JavaScript error occurred in
// the main process" dialog. There's nothing left to write to, so exit quietly.
for (const stream of [process.stdout, process.stderr]) {
	stream.on('error', (err: NodeJS.ErrnoException) => {
		if (err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED') {
			process.exit(0);
		}
		throw err;
	});
}

main().catch((err) => {
	const message = err instanceof Error ? err.message : String(err);
	process.stderr.write(`maestro-p: ${message}\n`);
	process.exit(1);
});
