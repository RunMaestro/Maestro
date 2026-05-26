#!/usr/bin/env node
// maestro-p
// Standalone wrapper that mimics `claude -p` semantics by driving Claude's
// interactive TUI under the hood, so callers (Maestro, shells, pipelines)
// consume the interactive Claude Max quota instead of API billing.
//
// Two modes:
//   * run    — default. Send a prompt to claude, tail the JSONL transcript,
//              re-emit assistant / user / result envelopes on stdout, exit.
//   * status — `--status`. Spawn claude, send `/usage`, capture the panel,
//              parse it into a single `status` JSON object, exit.
//
// The structured JSONL transcript is the source of truth for run-mode output;
// the TUI screen is only used for startup readiness and quota-limit detection
// (and, in status mode, for the `/usage` panel itself which is screen-only).
// See MAESTRO-P-01-binary.md for the full contract.

import { Command } from 'commander';
import { EventEmitter } from 'node:events';
import * as os from 'os';
import * as path from 'path';

import { parseArgs, type ParsedArgs } from './args';
import { JsonEmitter, type EmitResultOptions } from './json-emitter';
import { JsonlTailer, type ParseErrorPayload } from './jsonl-tailer';
import { discoverSessionId, cwdSlug } from './session-watcher';
import { cleanupStreamJsonImages, translateStreamJsonInput } from './stream-json-input';
import { TuiDriver } from './tui-driver';
import { parseUsage } from './usage-parser';
import { VERSION } from './package-info';

// Watchdog tick. Cheap; the real budget lives in args.maxWaitSeconds.
const WATCHDOG_INTERVAL_MS = 1000;
// Grace window after an `end_turn` to let trailing tool-result rows flush.
const END_TURN_GRACE_MS = 600;
// `/usage` panel paints synchronously but trickles bytes for several hundred ms.
const STATUS_INITIAL_WAIT_MS = 1500;
// Then debounce on no-new-lines for this long before declaring the panel done.
const STATUS_QUIET_DEBOUNCE_MS = 800;
const STATUS_DEBOUNCE_POLL_MS = 100;
// Window for the new JSONL file to appear after a fresh-session spawn.
const DISCOVERY_TIMEOUT_MS = 10000;

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
			'  - maestro-p flags (consumed):    --status, --stream-thinking, --max-wait, --help, --version',
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
// else it returns and falls through to our own parseArgs walker — commander's
// option schema doesn't know about claude's flag surface, so we re-parse.
program.parse(process.argv);

function resolveConfigDir(): string {
	const envDir = process.env.CLAUDE_CONFIG_DIR;
	if (envDir && envDir.length > 0) return envDir;
	return path.join(os.homedir(), '.claude');
}

function resolveBinPath(): string {
	const envBin = process.env.MAESTRO_CLAUDE_BIN;
	return envBin && envBin.length > 0 ? envBin : 'claude';
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
// stdin — drop those.
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

	const driver = new TuiDriver({
		binPath,
		args: args.passThroughArgs,
		cwd,
		env: process.env,
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

		// Ignore other entry types (system/summary/etc.) — claude's internal
		// taxonomy.
	};

	const flushPending = (): void => {
		for (const entry of pendingEntries) {
			processEntry(entry);
		}
		pendingEntries.length = 0;
	};

	const handleEntry = (entry: unknown): void => {
		if (!initEmitted) {
			pendingEntries.push(entry);
			return;
		}
		processEntry(entry);
	};

	const handleParseError = (payload: ParseErrorPayload): void => {
		const snippet = payload.line.length > 200 ? `${payload.line.slice(0, 200)}…` : payload.line;
		process.stderr.write(
			`maestro-p: JSONL parse error: ${payload.error.message} — line: ${snippet}\n`
		);
	};

	driver.on('limit-hit', () => {
		limitHit = true;
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
	} else {
		// Fresh-session path: spawn-time recorded as startMs (above) so the
		// session-watcher won't pick up stale files. We start discovery and
		// send the prompt back-to-back, then attach the tailer once the
		// session id resolves.
		await waitForEvent(driver, 'ready');
		const discoveryPromise = discoverSessionId({
			configDir,
			cwd,
			spawnTimestamp: startMs,
			timeoutMs: DISCOVERY_TIMEOUT_MS,
		});
		driver.send(prompt);
		const { sessionId, jsonlPath } = await discoveryPromise;
		resolvedSessionId = sessionId;
		emitter.emitInit({ sessionId, model: null, cwd });
		initEmitted = true;
		tailer = new JsonlTailer({ path: jsonlPath, skipExisting: false });
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
		env: process.env,
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

	const raw = lines.join('\n');
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

main().catch((err) => {
	const message = err instanceof Error ? err.message : String(err);
	process.stderr.write(`maestro-p: ${message}\n`);
	process.exit(1);
});
