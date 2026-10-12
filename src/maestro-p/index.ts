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

import { isRateLimitErrorRow, terminalApiErrorTag } from './api-error-row';
import { parseArgs, type ParsedArgs } from './args';
import { diagnoseApiUsageBilling } from './billing-mode';
import { buildChildEnv } from './child-env';
import { JsonEmitter, type EmitResultOptions } from './json-emitter';
import { JsonlTailer, type ParseErrorPayload } from './jsonl-tailer';
import { isSlashCommandPrompt, localCommandOutput } from './local-command-row';
import { extractExitPlanText } from './plan-mode';
import { checkPromptEcho, isPromptEchoVerifiable, promptEchoText } from './prompt-echo';
import { collectAssistantText, ReplyText } from './reply-text';
import {
	discoverSessionId,
	findLatestSessionId,
	noConversationFoundMessage,
	sessionTranscriptPath,
} from './session-watcher';
import { installStopSignalHandlers, STOP_EXIT_CODES } from './stop-signals';
import {
	classifyQueueOperation,
	STEERING_SOCKET_ENV_VAR,
	steeringTextMatches,
	type SteeringResultFrame,
} from '../shared/chatSteering';
import { startSteeringServer, type SteeringServer } from './steering-server';
import { cleanupStreamJsonImages, translateStreamJsonInput } from './stream-json-input';
import { formatScreenTailReport, idleTimeoutMessage, readyTimeoutMessage } from './timeout-report';
import { PROMPT_TAB_SPACES, TuiDriver } from './tui-driver';
import { OpenToolCalls, skipsPermissionPrompts, withPermissionBypass } from './open-tool-calls';
import { parseCostStateRow, type CostState } from './cost-state';
import { TurnUsage } from './turn-usage';
import { hasBlockOfType, SubagentStream, SubagentWatcher } from './subagent-watcher';
import { initModelFromEntry, lastModelAttachment, resolveInitModel } from './init-model';
import { parseUsage } from './usage-parser';
import { VERSION } from './package-info';

// Watchdog tick. Cheap; the real budget lives in args.maxWaitSeconds.
const WATCHDOG_INTERVAL_MS = 1000;

// Longest transcript silence the watchdog tolerates while a tool call runs
// unattended. Claude bounds its own Bash calls well under this; the ceiling
// is for a call nothing else bounds, such as a hung MCP tool.
const OPEN_TOOL_SILENCE_CEILING_MS = 60 * 60 * 1000;

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
// How long a finished turn is held open for a steer that was delivered but not yet
// answered. A steer typed just as the turn ends becomes a fresh prompt, and claude
// can take longer than END_TURN_GRACE_MS to log it: measured, the grace fired
// 0.5s after delivery and quit the TUI with the user's message unanswered.
const STEER_VERDICT_HOLD_MS = 5000;
// How long finalize() waits for a steer that is mid-injection when the turn ends.
// The driver aborts an injection at its next checkpoint once shutdown begins, so
// this normally settles in well under a second; the cap only keeps a wedged PTY
// from holding the exit open.
const STEER_SETTLE_ON_FINALIZE_MS = 2000;
// `/usage` panel paints synchronously but trickles bytes for several hundred ms.
const STATUS_INITIAL_WAIT_MS = 1500;
// Then debounce on no-new-lines for this long before declaring the panel done.
const STATUS_QUIET_DEBOUNCE_MS = 800;
const STATUS_DEBOUNCE_POLL_MS = 100;
// ── /usage retry ────────────────────────────────────────────────────────────
// A /usage panel that does not parse is USUALLY transient. Measured over 204
// scripted --status runs across three plan accounts, one account's probe failed
// 11.8% of runs (19.0% over the trailing week) while six consecutive SERIAL
// probes all succeeded: the failures track concurrency (the desktop Usage
// Dashboard auto-refreshes every 15 min onto the same scrape, and a scheduled
// poller hits it too), not plan layout and not auth.
//
// The blast radius is far larger than the error rate, which is why one attempt
// is not enough. A consumer cannot tell "probe failed" from "account has no
// measurable quota", so it has to drop that account as both a source and a
// destination - one transient flake degrades a whole balancing pass into a
// no-op that reads exactly like a considered decision.
//
// Retry the /usage SEND, not the spawn: the TUI is still alive at the parse
// point, so a re-send costs ~2.4s against a full claude boot.
//
// Wall-clock deadline measured from process start, NOT an attempt count. The
// ceiling that actually matters is the caller's: claude-usage-sampler.ts kills
// the probe at DEFAULT_TIMEOUT_MS (30s), and blowing through that turns a parse
// flake into classifySpawnError -> 'timeout' - the same no-op for the consumer
// with a worse diagnosis. Boot time varies by seconds, so only a deadline keeps
// the total honest. 25s leaves room for driver.quit()'s QUIT_GRACE_MS on top.
const STATUS_RETRY_DEADLINE_MS = 25_000;
// First re-send waits this long. Deliberately longer than the previous send's
// last Enter re-tap (SEND_ENTER_DELAY_MS + SUBMIT_ENTER_RETRIES *
// SUBMIT_ENTER_RETRY_INTERVAL_MS = 3080ms after the send, i.e. ~780ms after an
// attempt ends), so a stray tap cannot land mid-type on the next attempt.
const STATUS_RETRY_INITIAL_DELAY_MS = 800;
const STATUS_RETRY_MAX_DELAY_MS = 1600;
// What one attempt costs, for deciding whether another still fits the deadline.
// Never start an attempt that cannot finish - a truncated attempt is a timeout
// kill, which is strictly worse than giving up with a diagnosis.
const STATUS_ATTEMPT_COST_MS = STATUS_INITIAL_WAIT_MS + STATUS_QUIET_DEBOUNCE_MS + 100;
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
			'session runs through the interactive TUI, on the Claude login it is signed in with.',
			'',
			'Argument handling:',
			'  - Prompt-input flags (consumed): -p, --print, --prompt',
			'  - maestro-p flags (consumed):    --status, --stream-thinking, --max-wait, --first-byte-timeout, --ready-timeout, --help, --version',
			'  - Stripped (dropped with warning): --output-format, --input-format, --verbose',
			'  - Permissions: --dangerously-skip-permissions is added, as `claude -p` never stops on a',
			'    permission prompt; an explicit --permission-mode (e.g. plan, for read-only) is kept.',
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

// Explicit opt-in to answer claude's folder-trust dialog with "Yes". Maestro's
// usage sampler sets it for the empty probe folder it owns; a user can set it
// for a folder they mean to trust. Trust persists in claude for that folder.
function acceptsWorkspaceTrust(): boolean {
	return process.env.MAESTRO_P_ACCEPT_WORKSPACE_TRUST === '1';
}

// What to tell the caller when claude's trust dialog defaulted to "No, exit"
// (the home dir and the system temp dir, never-trusted folders). Without this
// the TUI quit on the blind Enter and the only signal was `tui_exited`.
function workspaceUntrustedHint(cwd: string): string {
	return `maestro-p: claude has not been trusted to work in ${cwd}, and its folder-trust prompt defaults to "No, exit" there. Open claude in that folder once and choose "Yes, I trust this folder", or set MAESTRO_P_ACCEPT_WORKSPACE_TRUST=1 to have maestro-p accept it. Failing with workspace_untrusted.\n`;
}

function waitForEvent(emitter: EventEmitter, event: string): Promise<void> {
	return new Promise<void>((resolve) => emitter.once(event, () => resolve()));
}

// Per the playbook tool_result filter: `user` entries pass through ONLY if
// their content array carries at least one tool_result block. Plain `text`
// user entries are the prompt echo claude writes immediately after we send
// stdin - drop those.
function hasToolResultBlock(message: unknown): boolean {
	return hasBlockOfType(message, 'tool_result');
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

	// claude's input editor cannot carry a tab, so the driver types each one as
	// spaces (see PROMPT_TAB_SPACES). That changes the prompt, and the echo
	// check ignores whitespace so it would never notice - say so here instead.
	if (prompt.includes('\t')) {
		process.stderr.write(
			`maestro-p: warning: the prompt contains tab characters; claude's TUI input cannot hold a literal tab, so each one is sent as ${PROMPT_TAB_SPACES} spaces.\n`
		);
	}

	const cwd = process.cwd();
	const configDir = resolveConfigDir();
	const binPath = resolveBinPath();
	const emitter = new JsonEmitter();
	const startMs = Date.now();

	// Resuming an id with no transcript behind it cannot work: claude's TUI quits
	// on it and the turn dies as an anonymous `tui_exited`. That is every tab of
	// an agent moved to another host (the transcripts stayed on the old one), or
	// of a transcript that was pruned. Fail before spawning, in claude's own
	// words, so the desktop recovers it as session_not_found.
	if (args.resumeSessionId) {
		const transcriptPath = sessionTranscriptPath(configDir, cwd, args.resumeSessionId);
		if (!fs.existsSync(transcriptPath)) {
			const message = noConversationFoundMessage(args.resumeSessionId);
			process.stderr.write(`maestro-p: ${message} (no transcript at ${transcriptPath})\n`);
			emitter.emitInit({ sessionId: args.resumeSessionId, model: null, cwd });
			emitter.emitResult({
				sessionId: args.resumeSessionId,
				durationMs: Date.now() - startMs,
				isError: true,
				error: message,
			});
			cleanupStreamJsonImages(tempImagePaths);
			// stdout is asynchronous on a macOS pipe: exit once the envelope drains.
			process.stdout.write('', () => process.exit(9));
			return new Promise<never>(() => undefined);
		}
	}

	// Fresh sessions: pre-assign the session id and tell the TUI to use it via
	// `claude --session-id <uuid>`. The watcher then polls for exactly
	// `<uuid>.jsonl` instead of guessing "the earliest new file", which is
	// race-free when several fresh-session TUIs run concurrently in the same
	// cwd (tab naming for multiple tabs in one project). Resume already knows
	// its id, so we leave that path untouched. claude 2.1.x honours
	// `--session-id` in interactive/TUI mode (verified: it writes exactly the
	// requested `<uuid>.jsonl`).
	// Always bypass permission prompts, as `claude -p` cannot stop on one (see
	// withPermissionBypass for the read-only exception).
	let passThroughArgs = withPermissionBypass(args.passThroughArgs);
	let resumeSessionId = args.resumeSessionId;

	// `--continue` cannot reach claude as-is: every fresh TUI gets a
	// pre-assigned `--session-id` below, and claude refuses the two together
	// and exits before painting anything. Resolve the session `--continue`
	// would pick (the newest transcript for this cwd) and run it as a resume.
	if (!resumeSessionId && passThroughArgs.some((a) => a === '--continue' || a === '-c')) {
		const latest = await findLatestSessionId(configDir, cwd);
		if (!latest) {
			process.stderr.write(
				`maestro-p: --continue found no earlier conversation for ${cwd}. Failing with no_conversation.\n`
			);
			emitter.emitInit({ sessionId: '', model: null, cwd });
			emitter.emitResult({
				sessionId: '',
				durationMs: Date.now() - startMs,
				isError: true,
				error: 'no_conversation',
			});
			// stdout is asynchronous on a macOS pipe: exit once the envelope drains.
			process.stdout.write('', () => process.exit(1));
			return new Promise<never>(() => undefined);
		}
		resumeSessionId = latest;
		passThroughArgs = passThroughArgs.filter((a) => a !== '--continue' && a !== '-c');
		passThroughArgs.push('--resume', latest);
	}

	let freshSessionId: string | null = null;
	if (!resumeSessionId) {
		freshSessionId = randomUUID();
		passThroughArgs.push('--session-id', freshSessionId);
	}

	const childEnv = buildChildEnv();
	// Steering has to READ the screen before it types (see TuiDriver.inject), and
	// the check needs a replayed grid, which only the raw stream can produce - the
	// ANSI-stripped rolling buffer cannot show the editor box's structure. Run mode
	// otherwise leaves this off, so it is enabled exactly when a steering socket was
	// named rather than unconditionally: the capture is bounded but not free.
	const steeringEnabled = !!process.env[STEERING_SOCKET_ENV_VAR]?.trim();
	const driver = new TuiDriver({
		binPath,
		args: passThroughArgs,
		cwd,
		env: childEnv,
		captureScreen: steeringEnabled,
		acceptWorkspaceTrust: acceptsWorkspaceTrust(),
		readyTimeoutMs: args.readyTimeoutSeconds * 1000,
	});

	// A turn on API Usage Billing still completes, so nothing downstream would
	// ever notice it billed per-token credit instead of plan quota. Say so on
	// stderr, unless the environment asked for API billing on purpose.
	driver.on('api-billing', () => {
		const diagnosis = diagnoseApiUsageBilling(childEnv, configDir);
		if (diagnosis.expected) return;
		process.stderr.write(
			`maestro-p: warning: ${diagnosis.reason} This turn is billed as per-token API credit, not plan quota.\n`
		);
	});

	if (args.streamThinking) {
		driver.on('line', (line: string) => {
			process.stderr.write(`${line}\n`);
		});
	}

	let tailer: JsonlTailer | null = null;
	// Tails the session a slash command rotated claude onto (see
	// watchRotatedSession).
	let rotatedTailer: JsonlTailer | null = null;
	let resolvedSessionId: string = resumeSessionId ?? '';
	let initEmitted = false;
	// finalize() has BEGUN: nothing new may start (no steer, no second finalize).
	let finalized = false;
	// The one-shot result envelope is out, so nothing more may be written to stdout.
	// Separate from `finalized` because finalize() can wait (see
	// STEER_SETTLE_ON_FINALIZE_MS) between beginning and emitting, and the steers it
	// waits on still have verdicts to report in that window.
	let resultEmitted = false;
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
	// Set once the first prompt-echo row has been compared with what we typed.
	let promptEchoChecked = false;
	// That first prompt-echo row, so its replay from pendingEntries is not read
	// as a steered message.
	let promptEchoRow: unknown = null;
	// Tool calls claude has issued and not yet answered; see the idle watchdog.
	const openToolCalls = new OpenToolCalls();
	const permissionsBypassed = skipsPermissionPrompts(passThroughArgs);
	const slashCommandPrompt = isSlashCommandPrompt(prompt);
	let limitHit = false;
	const reply = new ReplyText();
	const turnUsage = new TurnUsage();
	// claude's own spend tracker, from the cost-state row it writes on exit.
	let costState: CostState | null = null;
	// Follows the session's subagent transcripts once the session is known.
	let subagents: SubagentWatcher | null = null;
	// Set once the session id is known. init then waits for the first row that
	// names the model (see init-model.ts), as `claude -p`'s init names it.
	let initSessionId: string | null = null;
	// The model an earlier turn of a resumed session named; see init-model.ts.
	let resumedModel: string | null = null;
	// Buffer for entries that race ahead of emitInit. Should be empty in
	// the normal flow (tailer.start() / EOF-skip prevent racing), but keeps
	// us robust against weird PTY timing.
	const pendingEntries: unknown[] = [];

	// Chat steering (see steering.ts). Injections delivered into the running turn
	// and still waiting for the transcript to say what claude did with them, oldest
	// first - the order matters, because a bare `dequeue` row carries no content and
	// can only be attributed positionally.
	const awaitingVerdict: Array<{ id: string; text: string }> = [];
	let steeringServer: SteeringServer | null = null;
	// onSteer calls still running. finalize() waits for these so a steer that was
	// mid-injection when the turn ended still gets its `dropped` verdict on stdout
	// before the result envelope, instead of a socket `delivered` and then silence.
	const steersInFlight = new Set<Promise<unknown>>();

	// Report a verdict on stdout. Silently dropped once the result has been
	// emitted: the `result` envelope is one-shot and a verdict arriving after it
	// describes a turn already reported, so emitting would throw and take the
	// process down over an accessory.
	const reportSteering = (frame: SteeringResultFrame): void => {
		if (resultEmitted || !initEmitted) return;
		emitter.emitSteering(frame);
	};

	// Resolve a delivered injection from a `queue-operation` row. Returns true when
	// the row settled something, so the caller knows it was consumed.
	const settleSteeringFromRow = (row: unknown): boolean => {
		if (awaitingVerdict.length === 0) return false;
		for (let i = 0; i < awaitingVerdict.length; i += 1) {
			const pending = awaitingVerdict[i];
			const classified = classifyQueueOperation(row, pending.text);
			if (!classified) continue;
			// A content-matched row names its own injection. A bare `dequeue` does
			// not, so it is attributed to the OLDEST outstanding one - claude drains
			// its queue in order, so position is the only evidence available, and
			// guessing the newest would mislabel the common single-steer case whenever
			// two are in flight.
			if (!classified.matchedContent && i !== 0) continue;
			awaitingVerdict.splice(i, 1);
			reportSteering({ type: 'steering', id: pending.id, verdict: classified.verdict });
			return true;
		}
		return false;
	};

	// Resolve a delivered injection from an ordinary `user` entry. A steer that
	// lands after `end_turn` finds the editor idle, so claude takes it as a fresh
	// prompt: no queue-operation rows at all, just the message and a follow-up turn
	// (measured on claude 2.1.296). That is `queued`, not `dropped`.
	const settleSteeringFromUserText = (text: string): void => {
		const i = awaitingVerdict.findIndex((pending) => steeringTextMatches(text, pending.text));
		if (i < 0) return;
		const [pending] = awaitingVerdict.splice(i, 1);
		reportSteering({ type: 'steering', id: pending.id, verdict: 'queued' });
	};

	// Delivery time of the newest steer still awaiting a verdict; see
	// STEER_VERDICT_HOLD_MS.
	let lastSteerDeliveredAt = 0;

	// The end_turn grace, held open (bounded) while a delivered steer is still
	// unanswered. The steer's own `user` entry clears the timer and its follow-up
	// turn re-arms it, by which point nothing is outstanding.
	const armEndTurnGrace = (): void => {
		const onGrace = (): void => {
			if (finalized) return;
			if (awaitingVerdict.length > 0 && Date.now() - lastSteerDeliveredAt < STEER_VERDICT_HOLD_MS) {
				graceTimer = setTimeout(onGrace, END_TURN_GRACE_MS);
				return;
			}
			finalize({ isError: false, exitCode: 0 });
		};
		graceTimer = setTimeout(onGrace, END_TURN_GRACE_MS);
	};

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
		// The prompt is in, so send()'s remaining submit taps have nothing left to
		// submit - and this is also the moment the steer gate opens, after which a
		// stray tap would land inside a half-typed steer.
		driver.cancelSubmitRetries();
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

	type FinalizeOptions = {
		isError: boolean;
		error?: string;
		exitCode: number;
		// A Stop keeps its own exit code even after a quota limit: exit 2 makes
		// the desktop replay the prompt through the API, which is the opposite of
		// what the user just asked for.
		stopped?: boolean;
	};

	const finalize = (options: FinalizeOptions): void => {
		if (finalized) return;
		finalized = true;
		// Stop steering first. No new steer may start, and one mid-injection stops
		// before its Enter, so `/quit` can never be typed into the same composer as
		// half a steer (see TuiDriver.beginShutdown). The server stops accepting
		// connections; replies on the ones already open still go out.
		driver.beginShutdown();
		steeringServer?.close();
		cleanupTimers();
		if (steersInFlight.size === 0) {
			completeFinalize(options);
			return;
		}
		let capTimer: NodeJS.Timeout | null = null;
		void Promise.race([
			Promise.allSettled([...steersInFlight]),
			new Promise<void>((resolve) => {
				capTimer = setTimeout(resolve, STEER_SETTLE_ON_FINALIZE_MS);
			}),
		]).then(() => {
			if (capTimer) clearTimeout(capTimer);
			completeFinalize(options);
		});
	};

	const completeFinalize = (options: FinalizeOptions): void => {
		// Report every still-outstanding steer BEFORE the result envelope, after
		// which reportSteering is closed. Silence here would be the worst outcome: the
		// caller is holding these pending an answer, and never hearing back reads as
		// delivered-and-fine.
		//
		// `dropped`, not `queued`: nothing was ever observed resolving these, and the
		// run is ending regardless, so the text is gone and the caller has to re-send
		// it. This is the uncommon path - a normally-parked steer resolves itself,
		// because the dequeued message invalidates the end_turn grace and maestro-p
		// lives to see it (see SteeringVerdict). What lands here is a run cut short:
		// the TUI exited, a timeout fired, or the limit drain won the race.
		for (const pending of awaitingVerdict) {
			reportSteering({
				type: 'steering',
				id: pending.id,
				verdict: 'dropped',
				detail: 'the turn ended without claude absorbing this message, so it was not delivered',
			});
		}
		awaitingVerdict.length = 0;
		resultEmitted = true;
		const exitCode = limitHit && !options.stopped ? 2 : options.exitCode;

		const stopTailers = (): void => {
			tailer?.stop();
			rotatedTailer?.stop();
			subagents?.stop();
		};

		const emitFinalResult = (): void => {
			// Best-effort: synchronous so claude (which has long-since consumed
			// these via the @path Read tool) doesn't leave them behind.
			cleanupStreamJsonImages(tempImagePaths);

			// Ensure init is emitted so emitResult doesn't throw on pre-discovery
			// failure paths (timeout before discovery, etc.).
			if (!initEmitted) emitInitNow();

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
				resultOpts.result = reply.text;
				resultOpts.usage = turnUsage.totals();
			}
			// Spend is reported on every path, as `claude -p` does: a turn that
			// failed still cost what it ran. claude's own tracker when it wrote
			// one, otherwise this turn's main thread priced from the rate table.
			const modelUsage = costState?.modelUsage ?? turnUsage.estimatedModelUsage();
			if (Object.keys(modelUsage).length > 0) {
				resultOpts.modelUsage = modelUsage;
				resultOpts.totalCostUsd =
					costState?.totalCostUSD ??
					Object.values(modelUsage).reduce((sum, entry) => sum + entry.costUSD, 0);
			}
			try {
				emitter.emitResult(resultOpts);
			} catch (err) {
				process.stderr.write(
					`maestro-p: failed to emit result envelope: ${(err as Error).message}\n`
				);
			}
		};

		// stdout is asynchronous on a macOS pipe: exit once the envelope drains.
		// The timer covers a reader that went away, whose write never settles.
		const exitAfterStdout = (): void => {
			setTimeout(() => process.exit(exitCode), 1000);
			process.stdout.write('', () => process.exit(exitCode));
		};

		// A Stop answers at once: the caller asked for the turn to end now, and
		// the spend of an abandoned turn is not worth holding the result for.
		if (options.stopped) {
			stopTailers();
			emitFinalResult();
			void driver
				.quit()
				.catch(() => {
					/* already gone; nothing to escalate against */
				})
				.finally(exitAfterStdout);
			return;
		}

		// Every other ending quits claude BEFORE reporting: claude writes its
		// cost-state row to the transcript as it exits, and that row is the only
		// record of what the session spent. Drain the tailers once it has gone so
		// the row is read, then report.
		void driver
			.quit()
			.catch(() => {
				/* already gone; nothing to escalate against */
			})
			.finally(() => {
				try {
					tailer?.drain();
					subagents?.drain();
				} catch (err) {
					// The result still goes out; it just falls back to the estimate.
					process.stderr.write(
						`maestro-p: could not read claude's final transcript rows: ${(err as Error).message}\n`
					);
				}
				stopTailers();
				emitFinalResult();
				exitAfterStdout();
			});
	};

	// A quota limit means claude reports the limit and sits - it won't emit
	// (further) transcript output this turn. Don't wait for the first-byte /
	// idle timeout to settle: that long stall is what makes a Dynamic-mode turn
	// look like it produced "no response" after the mode-switch banner, and what
	// makes a headless caller burn its whole --max-wait. Finalize after the same
	// short drain grace used for end_turn (so any assistant text written BEFORE
	// the limit still flushes), then exit. `limitHit` forces exit code 2, which
	// fires the desktop's interactive→API replay so the user's prompt is promptly
	// re-sent under `claude --print` and actually gets answered.
	//
	// Two sources report a limit - the TUI banner and the transcript's
	// rate_limit row - and either can fire alone, so both land here. The first
	// one wins; the second is a no-op.
	const markLimitHit = (): void => {
		if (limitHit) return;
		limitHit = true;
		setTimeout(() => {
			if (!finalized) {
				finalize({ isError: false, exitCode: 2 });
			}
		}, END_TURN_GRACE_MS);
	};

	const processEntry = (entry: unknown): void => {
		if (finalized || !entry || typeof entry !== 'object') return;
		const e = entry as Record<string, unknown>;
		const message = e.message as Record<string, unknown> | undefined;

		// Claude's plan-limit notice is a synthetic row too, so it has to be
		// caught before the bookkeeping filter below drops it (see
		// api-error-row.ts).
		if (isRateLimitErrorRow(e)) {
			markLimitHit();
			return;
		}

		// A bad model, rejected credential, or refused request is the same kind
		// of synthetic row, and claude goes idle after it just the same. Fail now
		// with claude's own wording rather than waiting out `--max-wait` and
		// reporting a timeout (#1753). Exit 8 rather than 2: replaying the turn
		// under `claude --print` cannot fix a model name that does not exist.
		const apiErrorTag = terminalApiErrorTag(e);
		if (apiErrorTag !== null) {
			const errorText = collectAssistantText(message).trim() || apiErrorTag;
			process.stderr.write(
				`maestro-p: claude reported a terminal API error (${apiErrorTag}): ${errorText}\n`
			);
			finalize({ isError: true, error: errorText, exitCode: 8 });
			return;
		}

		// A local slash command (`/compact`, `/clear`) ends with its output row
		// instead of an `end_turn`, so that row is the end of the turn (see
		// local-command-row.ts). The result carries the session id the row was
		// written under: `/clear` rotates claude onto a new session.
		if (slashCommandPrompt) {
			const commandOutput = localCommandOutput(e);
			if (commandOutput !== null) {
				if (graceTimer) clearTimeout(graceTimer);
				reply.setIfEmpty(commandOutput);
				if (typeof e.sessionId === 'string' && e.sessionId) resolvedSessionId = e.sessionId;
				graceTimer = setTimeout(() => {
					if (!finalized) {
						finalize({ isError: false, exitCode: 0 });
					}
				}, END_TURN_GRACE_MS);
				return;
			}
		}

		// Steering bookkeeping. These rows are how claude reports what it did with
		// input typed mid-turn, and they are the ONLY evidence for it - nothing on
		// the screen distinguishes an absorbed steer from a parked one. They carry no
		// `message`, so without this they would fall through to the ignore-unknown
		// branch at the bottom. Never emitted onto the wire as transcript content:
		// this is claude's own queue bookkeeping, not a turn the user sent.
		if (e.type === 'queue-operation') {
			settleSteeringFromRow(e);
			return;
		}

		// Synthetic-model bookkeeping rows ("No response requested.") never
		// reach the wire.
		if (message && message.model === '<synthetic>') return;

		if (e.type === 'assistant' && message) {
			// Any new entry invalidates a pending end_turn grace timer.
			if (graceTimer) {
				clearTimeout(graceTimer);
				graceTimer = null;
			}
			reply.addAssistant(message);
			turnUsage.note(message);
			emitter.emitAssistantMessage(message);
			openToolCalls.noteAssistant(message);

			// Plan/read-only mode (`--permission-mode plan`) ends the turn with an
			// ExitPlanMode tool call that parks the TUI on a blocking approval
			// dialog maestro-p can't answer, so `end_turn` never arrives and the
			// idle watchdog would otherwise kill the turn at --max-wait (exitCode 3,
			// dropping the plan we captured). The plan is the deliverable here, just
			// like `claude --print --permission-mode plan`: fold its body into the
			// result and finalize cleanly.
			const planText = extractExitPlanText(message);
			if (planText !== null) {
				reply.appendIfMissing(planText);
				finalize({ isError: false, exitCode: 0 });
				return;
			}

			if (message.stop_reason === 'end_turn') armEndTurnGrace();
			return;
		}

		if (e.type === 'user' && message) {
			// A user entry after end_turn is typically a tool_result row;
			// restart the grace so we don't truncate the turn mid-drain.
			//
			// Chat steering depends on this clear too, so do not narrow it to
			// tool_result rows. When claude parks a steer rather than absorbing it, it
			// drains the queue by writing the message as an ordinary `user` entry after
			// `end_turn`; this is what keeps the process alive long enough to capture
			// the follow-up turn instead of quitting the TUI with the user's words
			// unanswered. See SteeringVerdict's note on `queued`.
			if (graceTimer) {
				clearTimeout(graceTimer);
				graceTimer = null;
			}
			if (hasToolResultBlock(message)) {
				openToolCalls.noteToolResult(message);
				reply.addToolResult();
				emitter.emitUserMessage(message);
				return;
			}
			// Otherwise it's the prompt echo claude logs on receipt. It is never
			// re-emitted (see checkPromptEchoRow). Echoes after the first one are
			// steered messages claude absorbed into the turn.
			if (promptEchoChecked && e !== promptEchoRow) {
				const later = promptEchoText(e);
				if (later !== null) settleSteeringFromUserText(later);
			} else {
				checkPromptEchoRow(e);
			}
			return;
		}

		// Ignore other entry types (system/summary/etc.) - claude's internal
		// taxonomy.
	};

	// The first prompt echo is proof of what claude actually received: if the
	// PTY lost part of the prompt on the way in (see prompt-echo.ts), stop the
	// turn before it acts on a damaged prompt. Checked as the row arrives, even
	// while init is still waiting on the model, so the check is never deferred
	// past the point where claude starts acting.
	const checkPromptEchoRow = (e: Record<string, unknown>): void => {
		if (promptEchoChecked || finalized || e.type !== 'user') return;
		const echo = promptEchoText(e);
		if (echo === null) return;
		promptEchoChecked = true;
		promptEchoRow = e;
		const mismatch = isPromptEchoVerifiable(prompt) ? checkPromptEcho(prompt, echo) : null;
		if (mismatch) {
			process.stderr.write(
				`maestro-p: claude received a damaged prompt (${mismatch.receivedBytes} of ${mismatch.sentBytes} bytes; first missing text: "${mismatch.missingFrom}"). The terminal dropped part of the input. Stopping the turn and failing with prompt_truncated.\n`
			);
			driver.kill('SIGTERM');
			finalize({ isError: true, error: 'prompt_truncated', exitCode: 6 });
		}
	};

	// A subagent's rows, tagged with the Task call that started it, filtered the
	// way `claude -p` streams them (see SubagentStream). Its usage is not the
	// turn's `usage`, which `claude -p` reports for the main thread alone.
	const subagentStream = new SubagentStream();
	const processSubagentEntry = (entry: unknown, parentToolUseId: string): void => {
		if (finalized || !initEmitted) return;
		const forwarded = subagentStream.forward(entry, parentToolUseId);
		if (forwarded?.type === 'assistant') {
			emitter.emitAssistantMessage(forwarded.message, parentToolUseId);
		} else if (forwarded?.type === 'user') {
			emitter.emitUserMessage(forwarded.message, parentToolUseId);
		}
	};

	const flushPending = (): void => {
		for (const entry of pendingEntries) {
			processEntry(entry);
		}
		pendingEntries.length = 0;
	};

	const emitInitNow = (model: string | null = null): void => {
		if (initEmitted) return;
		emitter.emitInit({
			sessionId: initSessionId ?? resolvedSessionId,
			model: resolveInitModel(model, resumedModel),
			cwd,
		});
		initEmitted = true;
		flushPending();
	};

	// Once the session id is known, init goes out with the first row that names
	// the model (see init-model.ts). Rows that arrived before that are held and
	// replayed in order.
	const armInit = (sessionId: string): void => {
		initSessionId = sessionId;
		for (const pending of pendingEntries) {
			const trigger = initModelFromEntry(pending);
			if (trigger) {
				emitInitNow(trigger.model);
				return;
			}
		}
	};

	// Subagents write beside the session transcript; follow them from the
	// moment the session is known so none of a Task call's work is missed.
	const watchSubagents = (jsonlPath: string): void => {
		subagents = new SubagentWatcher({ sessionTranscriptPath: jsonlPath });
		subagents.on('entry', processSubagentEntry);
		subagents.on('parse-error', handleParseError);
		subagents.start();
	};

	const handleEntry = (entry: unknown): void => {
		// claude writes its spend tracker as it exits, after the turn: record it,
		// even once finalize has begun (that is when it arrives), and nothing else.
		const cost = parseCostStateRow(entry);
		if (cost) {
			costState = cost;
			return;
		}
		// Any transcript line means claude started the turn - cancel the
		// first-byte timer before the init-gating buffer logic so a pre-init
		// entry still counts as "first byte".
		markFirstEntrySeen();
		if (!initEmitted) {
			if (entry && typeof entry === 'object') {
				checkPromptEchoRow(entry as Record<string, unknown>);
			}
			pendingEntries.push(entry);
			if (initSessionId !== null) {
				const trigger = initModelFromEntry(entry);
				if (trigger) emitInitNow(trigger.model);
			}
			return;
		}
		processEntry(entry);
	};

	// `/clear` (and its `/reset` and `/new` aliases) moves claude onto a brand-new
	// session and writes the command's output row THERE, so the transcript this
	// run tails never sees the end of the turn and it rode out `--max-wait`.
	// For a slash-command prompt, also watch the project folder for a session
	// that appears after the prompt was sent, and let its local-command output
	// row end the turn like any other. An ordinary command never rotates, so
	// the watch just expires unused.
	const watchRotatedSession = (currentSessionId: string, sentAt: number): void => {
		if (!slashCommandPrompt) return;
		discoverSessionId({
			configDir,
			cwd,
			spawnTimestamp: sentAt,
			excludeSessionIds: new Set([currentSessionId]),
			timeoutMs: args.maxWaitSeconds * 1000,
		}).then(
			async (rotated) => {
				if (finalized) return;
				rotatedTailer = new JsonlTailer({ path: rotated.jsonlPath, skipExisting: false });
				rotatedTailer.on('entry', (entry: unknown) => {
					markFirstEntrySeen();
					if (!initEmitted) {
						initSessionId = rotated.sessionId;
						emitInitNow();
					}
					// Only the command's own output row: the rest of the new
					// session (its caveat and command-name rows) is not this turn's
					// output.
					if (localCommandOutput(entry) !== null) processEntry(entry);
				});
				rotatedTailer.on('parse-error', handleParseError);
				await rotatedTailer.start();
			},
			() => {
				// No new session: the command finished in the one being tailed.
			}
		);
	};

	const handleParseError = (payload: ParseErrorPayload): void => {
		const snippet = payload.line.length > 200 ? `${payload.line.slice(0, 200)}…` : payload.line;
		process.stderr.write(
			`maestro-p: JSONL parse error: ${payload.error.message} - line: ${snippet}\n`
		);
	};

	// One steer, start to finish. See the server registration below.
	const handleSteer = async (id: string, text: string): Promise<SteeringResultFrame> => {
		// A turn that has not started cannot be steered, and typing into a
		// not-yet-submitted prompt would CORRUPT it: the text would land in the
		// same editor still holding the original prompt and be submitted as one
		// merged message. The prompt-echo check would then fail the turn as
		// `prompt_truncated`, which is a confusing way to report "you steered
		// too early".
		if (!firstEntrySeen) {
			return {
				type: 'steering',
				id,
				verdict: 'refused',
				refusal: 'not-running',
				detail: 'the turn has not started yet, so there is nothing to steer',
			};
		}
		if (finalized) {
			return {
				type: 'steering',
				id,
				verdict: 'refused',
				refusal: 'not-running',
				detail: 'the turn has already finished',
			};
		}
		const outcome = await driver.inject(text);
		if (outcome.submitted && resultEmitted) {
			// Typed and submitted, but finalize() stopped waiting (its cap ran out)
			// and the result is already out, so no verdict can follow on stdout.
			// Say so here rather than claim a delivery nothing will ever settle.
			return {
				type: 'steering',
				id,
				verdict: 'dropped',
				detail: 'the turn ended while this message was being submitted',
			};
		}
		if (!outcome.submitted) {
			const frame: SteeringResultFrame = {
				type: 'steering',
				id,
				verdict: 'refused',
				refusal: outcome.refusal,
				detail: outcome.detail,
			};
			reportSteering(frame);
			return frame;
		}
		// Delivered. What claude DOES with it is only knowable from the
		// transcript, on a clock this reply cannot wait for (see
		// SteeringVerdict), so the refinement is emitted on stdout later by
		// settleSteeringFromRow.
		// Match on what was TYPED: claude records the normalized text (tabs as
		// spaces), so the raw request text never matches its own row.
		awaitingVerdict.push({ id, text: outcome.typed ?? text });
		lastSteerDeliveredAt = Date.now();
		const frame: SteeringResultFrame = { type: 'steering', id, verdict: 'delivered' };
		reportSteering(frame);
		return frame;
	};

	// Chat steering: open the control channel only when the caller named a socket.
	// Absent means this turn is not steerable, which is the default - a channel
	// nobody asked for is an attack surface and a socket file to clean up.
	const steeringSocketPath = steeringEnabled
		? process.env[STEERING_SOCKET_ENV_VAR]?.trim()
		: undefined;
	if (steeringSocketPath) {
		steeringServer = startSteeringServer({
			socketPath: steeringSocketPath,
			onSteer: (id, text): Promise<SteeringResultFrame> => {
				const handling = handleSteer(id, text);
				steersInFlight.add(handling);
				const forget = (): void => {
					steersInFlight.delete(handling);
				};
				handling.then(forget, forget);
				return handling;
			},
		});
	}

	driver.on('limit-hit', markLimitHit);
	driver.on('exit', () => {
		if (finalized) return;
		// claude prints why it quit (a rejected flag, a crash, a config error)
		// to the screen it just left, which is the only evidence there is.
		process.stderr.write(
			formatScreenTailReport(
				'claude exited before the turn finished. Failing with tui_exited.',
				driver.getScreenTail()
			)
		);
		finalize({ isError: true, error: 'tui_exited', exitCode: 1 });
	});
	driver.on('workspace-untrusted', () => {
		if (finalized) return;
		process.stderr.write(workspaceUntrustedHint(cwd));
		finalize({ isError: true, error: 'workspace_untrusted', exitCode: 7 });
	});
	driver.on('ready-timeout', () => {
		if (finalized) return;
		// Distinct from 'tui_exited': the PTY is still alive, but the
		// startup handshake (READY_REGEX or blind taps) never cleared
		// whatever modal the TUI is parked on. finalize() drives quit()
		// which will SIGTERM the PTY if it doesn't /quit gracefully.
		// Dump the screen first: a still-painting boot and a stuck modal look
		// different, and the screen is gone once finalize() quits the TUI.
		process.stderr.write(
			formatScreenTailReport(readyTimeoutMessage(args.readyTimeoutSeconds), driver.getScreenTail())
		);
		finalize({ isError: true, error: 'ready_timeout', exitCode: 4 });
	});

	// A Stop (SIGINT from the desktop's interrupt, or SIGTERM) ends the turn like
	// any other ending: result envelope, `/quit`, then exit. Installed before
	// start() so a Stop during boot or session discovery is handled too.
	installStopSignalHandlers({
		onStop: (signal) => {
			// Already ending (a normal end, a timeout): that path is quitting the
			// TUI and exits within QUIT_GRACE_MS, so let it finish.
			if (finalized) return;
			finalize({
				isError: true,
				error: 'interrupted',
				exitCode: STOP_EXIT_CODES[signal],
				stopped: true,
			});
		},
		onForce: (signal) => {
			driver.kill('SIGKILL');
			cleanupStreamJsonImages(tempImagePaths);
			// close() is synchronous, so the socket file is gone before the exit. A
			// leftover one is not just litter: the next run on this tab has to probe
			// it before it can reclaim the path (see startSteeringServer).
			steeringServer?.close();
			process.exit(STOP_EXIT_CODES[signal]);
		},
	});

	// Once finalize() has run, the flow below must not carry on (emitting a
	// second init envelope, attaching a tailer) while the exit is pending.
	const settled = (): Promise<never> => new Promise<never>(() => undefined);

	await driver.start();
	if (finalized) return settled();

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
		process.stderr.write(
			formatScreenTailReport(
				`no transcript output within ${args.firstByteTimeoutSeconds}s of sending the prompt - claude never started the turn (prompt may have been swallowed by a startup modal). Failing with first_byte_timeout.`,
				driver.getScreenTail()
			)
		);
		finalize({ isError: true, error: 'first_byte_timeout', exitCode: 5 });
	}, firstByteTimeoutMs);

	if (resumeSessionId) {
		// Resume path: the JSONL already exists from the prior turn(s); tail
		// from EOF so we don't replay history to stdout. The wait-for-ready
		// step ensures the TUI is accepting input before we send our reply.
		const jsonlPath = sessionTranscriptPath(configDir, cwd, resumeSessionId);
		tailer = new JsonlTailer({ path: jsonlPath, skipExisting: true });
		tailer.on('entry', handleEntry);
		tailer.on('parse-error', handleParseError);
		await tailer.start();
		await waitForEvent(driver, 'ready');
		if (finalized) return settled();
		resumedModel = lastModelAttachment(jsonlPath);
		watchSubagents(jsonlPath);
		armInit(resumeSessionId);
		watchRotatedSession(resumeSessionId, Date.now());
		// Await the whole paced prompt before the resubmit loop can press Enter.
		await driver.send(prompt);
		if (finalized) return settled();
		startResubmitLoop();
	} else {
		// Fresh-session path: we pre-assigned `freshSessionId` and passed it to
		// the TUI via `--session-id`, so discovery polls for exactly that file
		// (race-free across concurrent same-cwd spawns). spawnTimestamp is still
		// passed for the legacy earliest-new fallback, but expectSessionId takes
		// precedence. We start discovery and send the prompt back-to-back, then
		// attach the tailer once the file appears.
		await waitForEvent(driver, 'ready');
		if (finalized) return settled();
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
		if (freshSessionId) watchRotatedSession(freshSessionId, Date.now());
		// Await the whole paced prompt before the resubmit loop can press Enter.
		await driver.send(prompt);
		if (finalized) return settled();
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
					formatScreenTailReport(
						`session discovery failed: ${err instanceof Error ? err.message : String(err)}`,
						driver.getScreenTail()
					)
				);
				finalize({ isError: true, error: 'first_byte_timeout', exitCode: 5 });
			}
			return new Promise<never>(() => undefined);
		}
		if (finalized) return settled();
		resolvedSessionId = discovered.sessionId;
		tailer = new JsonlTailer({ path: discovered.jsonlPath, skipExisting: false });
		tailer.on('entry', handleEntry);
		tailer.on('parse-error', handleParseError);
		await tailer.start();
		watchSubagents(discovered.jsonlPath);
		armInit(discovered.sessionId);
	}
	if (finalized) return settled();

	// Watchdog: trips when no JSONL bytes have arrived for maxWaitSeconds.
	// JsonlTailer seeds lastByteAt at start() time, so a fresh tailer with
	// no data still gets the full window before timeout.
	watchdogTimer = setInterval(() => {
		if (finalized || !tailer) return;
		// A subagent writing its own transcript is the turn making progress too.
		const lastByteAt = Math.max(tailer.getLastByteAt(), subagents?.getLastByteAt() ?? 0);
		const idleMs = Date.now() - lastByteAt;
		if (idleMs > args.maxWaitSeconds * 1000) {
			// A tool still running unattended (a long `npm test`, a subagent) is
			// expected silence, not a stall, up to the ceiling (see open-tool-calls.ts).
			if (
				idleMs < OPEN_TOOL_SILENCE_CEILING_MS &&
				openToolCalls.runningUnattended(permissionsBypassed)
			) {
				return;
			}
			// Dump the screen before finalize() quits the TUI: a turn that goes
			// silent mid-turn is parked on something (a permission prompt, a
			// modal, a hung tool or API call), and the screen is the only record
			// of which one.
			process.stderr.write(
				formatScreenTailReport(
					idleTimeoutMessage(idleMs, args.maxWaitSeconds),
					driver.getScreenTail()
				)
			);
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

	const childEnv = buildChildEnv();
	const driver = new TuiDriver({
		binPath,
		args: args.passThroughArgs,
		cwd,
		env: childEnv,
		// Parse the /usage panel from the full raw screen, not the `\n`-delimited
		// 'line' events: heavier panels paint via cursor-addressing with no line
		// feeds, so the 'line' stream is empty and the content would be lost.
		captureScreen: true,
		// Set by Maestro's usage sampler, which runs this from a dedicated folder
		// it owns and keeps empty. In the home or temp dir claude's trust prompt
		// defaults to "No, exit", so without this the probe cannot reach /usage.
		// Never honored implicitly: trust persists for that folder.
		acceptWorkspaceTrust: acceptsWorkspaceTrust(),
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

	// On API Usage Billing the /usage panel has no plan windows, so the parse
	// below fails. Remember why, so the failure names the billing mode rather
	// than blaming the parser.
	let apiBilling = false;
	driver.on('api-billing', () => {
		apiBilling = true;
	});

	let statusFinalized = false;
	driver.on('workspace-untrusted', () => {
		if (statusFinalized) return;
		statusFinalized = true;
		process.stderr.write(workspaceUntrustedHint(cwd));
		driver.kill('SIGTERM');
		process.exit(1);
	});
	driver.on('exit', () => {
		if (statusFinalized) return;
		statusFinalized = true;
		process.stderr.write('maestro-p: claude TUI exited before /usage panel could render\n');
		process.exit(1);
	});

	// Same Stop contract as run mode: quit the TUI, then exit with the stop code.
	// The probe has no result envelope to write, so there is nothing to settle.
	installStopSignalHandlers({
		onStop: (signal) => {
			if (statusFinalized) return;
			statusFinalized = true;
			void driver
				.quit()
				.catch(() => {
					/* already gone; nothing to escalate against */
				})
				.finally(() => {
					process.exit(STOP_EXIT_CODES[signal]);
				});
		},
		onForce: (signal) => {
			driver.kill('SIGKILL');
			process.exit(STOP_EXIT_CODES[signal]);
		},
	});
	// A Stop may land mid-probe: stop sending /usage and wait for its exit.
	const stopped = (): Promise<never> => new Promise<never>(() => undefined);

	// Measured before start() so the retry budget below covers claude's boot too:
	// the caller's 30s kill timer starts when this process does, not when the TUI
	// becomes ready.
	const startedAt = Date.now();
	const deadline = startedAt + STATUS_RETRY_DEADLINE_MS;

	await driver.start();
	await waitForEvent(driver, 'ready');
	if (statusFinalized) return stopped();

	// Wait out one /usage paint: an initial hold to let it start rendering, then
	// debounce on no-new-lines until the stream has been quiet for
	// STATUS_QUIET_DEBOUNCE_MS straight. Bounded by the deadline so a panel that
	// never stops trickling gives up with a diagnosis instead of being killed
	// mid-sentence by the sampler's timeout.
	const settleUsagePanel = async (): Promise<void> => {
		await new Promise<void>((resolve) => setTimeout(resolve, STATUS_INITIAL_WAIT_MS));
		let quietSince = Date.now();
		let lastSeenAt = lastLineAt;
		while (Date.now() - quietSince < STATUS_QUIET_DEBOUNCE_MS && Date.now() < deadline) {
			await new Promise<void>((resolve) => setTimeout(resolve, STATUS_DEBOUNCE_POLL_MS));
			if (lastLineAt !== lastSeenAt) {
				lastSeenAt = lastLineAt;
				quietSince = Date.now();
			}
		}
	};

	// Diagnostic hook: when MAESTRO_P_DUMP_RAW points at a file, write the raw
	// captured screen there before parsing. The /usage layout drifts by plan
	// type (personal Max vs Team/Enterprise vs API-billing), and parse failures
	// are screen-only - there's no transcript to inspect after the fact. This
	// lets a maintainer capture the exact panel a given account renders without
	// rebuilding an instrumented binary. Best-effort: a write failure must never
	// derail the status probe itself.
	//
	// Attempt 1 keeps the plain configured path so the existing single-file
	// contract is unchanged; a retry writes alongside it as `.attempt2`, `.attempt3`
	// and so on, because diagnosing a flake needs the screen that FLAKED, not just
	// the last one.
	const dumpRaw = (raw: string, attempt: number): void => {
		const dumpPath = process.env.MAESTRO_P_DUMP_RAW;
		if (!dumpPath) return;
		try {
			fs.writeFileSync(attempt === 1 ? dumpPath : `${dumpPath}.attempt${attempt}`, raw, 'utf8');
		} catch {
			// ignore - diagnostics are non-fatal
		}
	};

	let attempts = 0;
	let retryDelay = STATUS_RETRY_INITIAL_DELAY_MS;
	let parsed: ReturnType<typeof parseUsage> = null;

	for (;;) {
		attempts += 1;

		// NOTE: neither the screen capture nor `lines` is cleared between attempts,
		// and that is load-bearing rather than an oversight. Both accumulate, so a
		// retry's panel lands appended to the previous one - which is exactly the
		// shape parseUsage already expects: sliceToFinalPanel() anchors on the LAST
		// `Current session` header and reads forward from there, so the newest panel
		// wins and the stale one is ignored. Clearing would break claude's
		// differential repaints, where only the changed cells arrive and no fresh
		// section header is painted: a cleared buffer would hold anchorless
		// fragments and parse to null on every retry. Verified in
		// usage-parser.test.ts, "stacked /usage panels".
		driver.send('/usage');
		await settleUsagePanel();
		if (statusFinalized) return stopped();

		// Parse from the full raw screen capture, not the `\n`-delimited 'line'
		// events: heavier /usage panels (Team/Enterprise accounts, or any account
		// with a long "what's contributing" breakdown) paint via cursor-addressing
		// with no line feeds, leaving the 'line' stream empty. The screen capture is
		// a superset that always carries the panel; fall back to the joined lines
		// only if capture was somehow empty.
		const raw = driver.getScreenCapture() || lines.join('\n');
		dumpRaw(raw, attempts);

		parsed = parseUsage(raw, new Date().toISOString(), configDir);
		if (parsed) break;

		// An API Usage Billing account has no plan windows to render, so this panel
		// will never parse no matter how often it is asked. Retrying a structurally
		// unmeasurable account burns the whole budget on every single run for an
		// answer that cannot change. Fail fast and name the billing mode.
		if (apiBilling) break;

		if (Date.now() + retryDelay + STATUS_ATTEMPT_COST_MS > deadline) break;
		await new Promise<void>((resolve) => setTimeout(resolve, retryDelay));
		if (statusFinalized) return stopped();
		retryDelay = Math.min(retryDelay * 2, STATUS_RETRY_MAX_DELAY_MS);
	}

	statusFinalized = true;
	if (parsed) {
		const emitter = new JsonEmitter();
		emitter.emitStatus(parsed);
		await driver.quit();
		process.exit(0);
	}

	if (apiBilling) {
		const { reason } = diagnoseApiUsageBilling(childEnv, configDir);
		process.stderr.write(`maestro-p: ${reason} There is no plan usage to report.\n`);
	} else {
		// Report the attempt count and elapsed time, not just the failure. A
		// consumer reading this has to decide whether the account is flaky or
		// genuinely unparseable, and "gave up after 5 attempts" is a different
		// diagnosis from "failed on the only attempt there was time for".
		const elapsedMs = Date.now() - startedAt;
		process.stderr.write(
			`maestro-p: failed to parse /usage output after ${attempts} ` +
				`attempt${attempts === 1 ? '' : 's'} over ${Math.round(elapsedMs / 100) / 10}s\n`
		);
	}
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
