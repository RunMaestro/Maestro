/**
 * Cue Process Lifecycle - spawns child processes, manages stdio capture,
 * enforces timeout with SIGTERM → SIGKILL escalation, and tracks active
 * processes for the Process Monitor.
 *
 * Single responsibility: process spawning and lifecycle management.
 * Does NOT know about template variables, agent definitions, or SSH -
 * it receives a fully resolved SpawnSpec and executes it.
 */

import type { ChildProcess } from 'child_process';
import type { CueRunStatus } from './cue-types';
import type { SpawnSpec } from './cue-spawn-builder';
import type { AgentError, ToolType, UsageStats } from '../../shared/types';
import { createOutputParser } from '../parsers';
import type {
	AgentOutputParser,
	ParsedEvent,
} from '../../shared/maestro-lib/parsers/agent-output-parser';
import { captureException } from '../utils/sentry';
import { stripAnsiCodes } from '../../shared/stringUtils';
import { resolveTurnOutcome } from '../../shared/maestro-lib/streaming/turn-outcome';
import { cueStatusForTurn } from './cue-turn-status';
import { UsageAccumulator } from '../../shared/maestro-lib/streaming/usage-accumulator';
import { addUsageStats, replaceUsageStats } from '../../shared/maestro-lib/streaming/usage-totals';
import { FALLBACK_CONTEXT_WINDOW } from '../../shared/agentConstants';
import {
	stopProcess as runStopLadder,
	BACKGROUND_STOP_GRACE_MS,
	type StopHandle,
} from '../../shared/maestro-lib/control/termination';
import { startTurn, type TurnHandle } from '../../shared/maestro-lib/run/start-turn';
import { isLaunchCancelled } from './cue-launch-cancel';

// ─── Types ──────���────────────────────────────────────────────────────────────

/** Metadata stored alongside each active Cue process */
export interface CueActiveProcess {
	child: ChildProcess;
	command: string;
	args: string[];
	cwd: string;
	toolType: string;
	startTime: number;
	/** For SSH spawns: the agent invocation running on the remote host. */
	sshRemoteCommand?: string;
	/** Live ref to the accumulating stdout buffer - filled by the runProcess
	 *  closure as chunks arrive. Exposed via `getActiveProcessOutput` so the
	 *  renderer can poll for in-flight logs without a separate subscription
	 *  channel. */
	getStdout: () => string;
	/** Live ref to the accumulating stderr buffer. */
	getStderr: () => string;
	/** Marks a deliberate stop so the exit resolves as an interrupt, not a crash.
	 *  Only agent runs ({@link runProcess}) settle through the turn contract and
	 *  need it; shell and maestro-cli runs report their own exit and omit it. */
	requestStop?: () => void;
}

/** Serializable process info for the Process Monitor */
export interface CueProcessInfo {
	runId: string;
	pid: number;
	command: string;
	args: string[];
	cwd: string;
	toolType: string;
	startTime: number;
	/** For SSH spawns: the agent invocation running on the remote host. */
	sshRemoteCommand?: string;
}

/** Result of a process execution */
export interface ProcessRunResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	status: CueRunStatus;
	/** Provider session id parsed from stdout as it streamed. Null for command/shell runs (no parser) or output that never carried one. */
	providerSessionId: string | null;
	/** Usage delta-normalized from the stdout stream. See `CueRunResult.usage`. Null when the run produced no usage events or has no output parser. */
	usage: UsageStats | null;
}

/** Options controlling process execution */
export interface ProcessRunOptions {
	toolType: string;
	timeoutMs: number;
	sshRemoteEnabled?: boolean;
	sshStdinScript?: string;
	stdinPrompt?: string;
	onLog: (level: string, message: string) => void;
	/**
	 * Called on every stdout/stderr chunk while the agent is producing output.
	 * Used to drive WakaTime heartbeats for the duration of a run: a Cue run
	 * can last well past WakaTime's idle timeout, so a single beat at start or
	 * end would record a fraction of the real time. Must stay cheap and never
	 * throw - it fires on every chunk, and the callee debounces.
	 */
	onActivity?: () => void;
	/**
	 * Aborted when the run is stopped. Checked synchronously right before the
	 * spawn: a stopped run never starts a process (see cue-launch-cancel.ts).
	 */
	signal?: AbortSignal;
}

// ─── Module State ────────────────────────────────────────────────────────────

/** Map of active Cue processes by runId */
const activeProcesses = new Map<string, CueActiveProcess>();

// ─── Internal Helpers ─────────��──────────────────────────────────────────────

/**
 * Convert a parser's raw `extractUsage()` shape into `UsageStats`. A scoped
 * port of `StdoutHandler.buildUsageStats` - Cue has no per-process omp model
 * catalog to resolve against (that catalog only primes for interactive
 * sessions), so a model-dependent window falls back to the static per-agent
 * default rather than a runtime-resolved one. Every other field maps 1:1.
 */
function toCueUsageStats(
	usage: NonNullable<ReturnType<AgentOutputParser['extractUsage']>>
): UsageStats {
	const stats: UsageStats = {
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cacheReadInputTokens: usage.cacheReadTokens || 0,
		cacheCreationInputTokens: usage.cacheCreationTokens || 0,
		totalCostUsd: usage.costUsd || 0,
		absoluteUsage: usage.absoluteUsage,
		contextWindow: usage.contextWindow || FALLBACK_CONTEXT_WINDOW,
		reasoningTokens: usage.reasoningTokens,
	};
	if (usage.contextWindowReported && (usage.contextWindow || 0) > 0) {
		stats.contextWindowResolved = true;
	}
	if (usage.model) stats.contextWindowModel = usage.model;
	return stats;
}

/**
 * Streaming capture for one Cue agent run: folds three things that used to be
 * three separate full-buffer passes (`extractCleanStdout`,
 * `extractProviderSessionId` in `cue-executor.ts`, and no usage capture at
 * all) into a single pass over the events the run layer (`startTurn`) parses
 * as stdout chunks arrive, mirroring how desktop chat's `StdoutHandler` and the
 * CLI's `spawnAgent` already do this (Plans/maestro-lib-cli-migration.md, "Cue").
 *
 * Delta-normalization is gated on `usesCombinedContextWindow` (Part Two's
 * decision, `Plans/maestro-lib-cli-migration.md` §3) rather than desktop's
 * older `toolType === 'codex' || toolType === 'claude-code'` check - Codex
 * reports a running session total that must be delta-normalized or a run's
 * tokens grow with the square of its event count; Claude Code's Cue runs are
 * always fresh (no `--resume`), so its usage events are already per-turn and
 * summing/overwriting them needs no accumulator.
 */
class CueRunStreamCapture {
	/** This run's own parser instance (see the constructor). */
	readonly parser: AgentOutputParser | null;
	private readonly usageAccumulator: UsageAccumulator | undefined;
	private readonly usageLastWriteWins: boolean;
	private readonly resultParts: string[] = [];
	private readonly assistantTextByMessage = new Map<string, string>();
	private readonly assistantTextWithoutId: string[] = [];
	private rawFallback = '';
	providerSessionId: string | null = null;
	usage: UsageStats | null = null;
	/**
	 * Whether the provider emitted its terminal `result` event, regardless of
	 * whether that event carried text. `resolveTurnOutcome` reads it to tell a
	 * turn that finished and said nothing from one that was cut off.
	 */
	resultMessageSeen = false;
	/**
	 * The first failure the provider reported in its own stream, if any. Several
	 * providers report a failed turn in-band and then exit 0 (Claude Code's
	 * `result` flagged `is_error: true`, a structured `error` event), so without
	 * this the exit code alone settled those runs as completed.
	 */
	inBandError: AgentError | undefined;

	constructor(toolType: string) {
		// A fresh instance per run, never the shared registry parser: parsers keep
		// per-stream state (Codex's context window and usage baseline, Claude's
		// last-call occupancy), and concurrent Cue runs of one provider would
		// otherwise read each other's.
		this.parser = createOutputParser(toolType as ToolType);
		// How each provider reports usage, matching the CLI spawner:
		// - Codex sends a running session total on every event, so events are
		//   delta-normalized before summing.
		// - Claude's terminal `result` carries the whole turn's totals, so the
		//   last event wins; summing it onto the preceding per-call `assistant`
		//   usage would double-count.
		// - Everyone else (Copilot included) reports per-step values that sum.
		//
		// Named explicitly rather than gated on `usesCombinedContextWindow`:
		// that flag answers how the context GAUGE adds input and output, not how
		// usage arrives on the wire, and copilot-cli sets it while emitting
		// per-turn deltas. Gating on it under-reported Copilot (#1626).
		if (this.parser && toolType === 'codex') {
			this.usageAccumulator = new UsageAccumulator({ attachesAbsoluteUsage: true });
		}
		this.usageLastWriteWins = toolType === 'claude-code';
	}

	/** A raw stdout chunk, kept for agents whose output is not parsed. */
	pushRaw(chunk: string): void {
		this.rawFallback += chunk;
	}

	/** One event from the run layer, which frames and parses the stream. */
	handleEvent(event: ParsedEvent): void {
		const parser = this.parser;
		if (!parser) return;

		// The same classifier desktop chat runs on every line. An in-turn API
		// error notice is skipped: the provider may retry past it, and when it
		// does not, the failed envelope that ends the turn is caught instead.
		if (!this.inBandError) {
			const raw = event.raw ?? event;
			if (!parser.isProvisionalErrorNotice?.(raw)) {
				this.inBandError = parser.detectErrorFromParsed?.(raw) ?? undefined;
			}
		}

		if (event.type === 'result') {
			this.resultMessageSeen = true;
			if (event.text) this.resultParts.push(event.text);
		} else if (event.type === 'text' && event.isPartial && event.text) {
			const raw = event.raw as { message?: { id?: string } } | undefined;
			const msgId = raw?.message?.id;
			if (msgId) {
				const existing = this.assistantTextByMessage.get(msgId) ?? '';
				if (event.text.length > existing.length) {
					this.assistantTextByMessage.set(msgId, event.text);
				}
			} else {
				this.assistantTextWithoutId.push(event.text);
			}
		}

		// Optional chaining, not a plain call: a real `AgentOutputParser`
		// always implements both, but test doubles routinely mock only the
		// method the test cares about (`parseJsonLine`), and a strict call
		// here would throw on those rather than degrading gracefully.
		const sessionId = parser.extractSessionId?.(event);
		if (sessionId) this.providerSessionId = sessionId;

		const rawUsage = parser.extractUsage?.(event);
		if (rawUsage) {
			const stats = toCueUsageStats(rawUsage);
			// `normalize` returns the DELTA for this event, so the deltas are
			// summed. Keeping only the newest would report one step of a run.
			this.usage = this.usageLastWriteWins
				? replaceUsageStats(this.usage ?? undefined, stats)
				: addUsageStats(
						this.usage ?? undefined,
						this.usageAccumulator ? this.usageAccumulator.normalize(stats) : stats
					);
		}
	}

	/**
	 * The ANSWER the agent produced, which is not the same question as
	 * `getCleanStdout()`. A parser-less agent has none: its raw stdout is as
	 * likely to be an error message, and counting it as an answer would turn a
	 * non-zero exit into a success.
	 */
	getAnswerText(): string | undefined {
		if (!this.parser) return undefined;
		if (this.resultParts.length > 0) {
			const text = this.resultParts.join('\n');
			if (text.trim()) return text;
		}
		const deduped = [...this.assistantTextByMessage.values(), ...this.assistantTextWithoutId];
		const assistantText = deduped.join('\n');
		return assistantText.trim() ? assistantText : undefined;
	}

	/** Clean, human-readable text: prefers result events, then assistant text, then the raw buffer verbatim (plain-text agents, or a parser that never produced either). */
	getCleanStdout(): string {
		if (this.resultParts.length > 0) return this.resultParts.join('\n');
		const deduped = [...this.assistantTextByMessage.values(), ...this.assistantTextWithoutId];
		if (deduped.length > 0) return deduped.join('\n');
		return this.rawFallback;
	}
}

/**
 * Per-agent stderr noise prefixes. These are informational diagnostics the
 * agent CLI emits on stderr even for successful runs - e.g. Codex printing
 * "Reading additional input from stdin..." before it observes EOF. Including
 * them in the activity-log "Errors" panel is misleading (nothing's wrong), so
 * we filter them out before storing the run result.
 *
 * Matching is intentionally lenient: each entry is a lowercased prefix, tested
 * after stripping ANSI escapes and trimming whitespace. A line matches if its
 * normalised form starts with the prefix. This catches variations with
 * trailing dots, timestamps, extra whitespace, or ANSI dimming that a strict
 * whole-line regex would miss. Real errors from the agent don't start with
 * these prefixes, so false-positives are very unlikely.
 */
const BENIGN_STDERR_PREFIXES: Partial<Record<string, string[]>> = {
	codex: [
		// Codex `exec` writes this to stderr on every run because it supports
		// piping additional prompt text via stdin. When Cue passes the prompt
		// as a CLI argument and stdin is /dev/null the read returns EOF and
		// the message is pure noise. Observed variants include trailing dots
		// ("..."), ANSI dim codes, and the occasional "OK" suffix.
		'reading additional input from stdin',
	],
};

/**
 * Strip known-benign lines from stderr before we store it on the run result.
 * Only applied when the agent type has a matching filter; otherwise returns
 * stderr unchanged.
 *
 * We strip ANSI codes and trim each candidate line before the prefix match so
 * dimmed / coloured diagnostics are caught alongside plain text. The ORIGINAL
 * line (with its ANSI and whitespace preserved) is kept if it's NOT noise,
 * so real errors render with their original formatting.
 */
function extractCleanStderr(rawStderr: string, toolType: string): string {
	if (!rawStderr) return rawStderr;
	const prefixes = BENIGN_STDERR_PREFIXES[toolType];
	if (!prefixes || prefixes.length === 0) return rawStderr;

	const lines = rawStderr.split('\n');
	const kept: string[] = [];
	for (const line of lines) {
		const normalised = stripAnsiCodes(line).trim().toLowerCase();
		if (prefixes.some((prefix) => normalised.startsWith(prefix))) continue;
		kept.push(line);
	}
	const cleaned = kept.join('\n');
	// If all that's left is whitespace, collapse to empty so the UI hides the
	// Errors panel entirely instead of showing an empty red box.
	return cleaned.trim() ? cleaned : '';
}

// ─── Public API ─────────────���─────────────────────────���──────────────────────

/**
 * Stop a Cue child process through the shared stop ladder: SIGTERM, then
 * SIGKILL for its whole tree after a grace period, or `taskkill /t /f` on
 * Windows. Whatever the process started is stopped with it.
 *
 * The one kill path for every Cue spawn (agent prompts, shell commands,
 * maestro-cli calls). `sync` is the shutdown path: it runs every stage at once
 * and blocks on taskkill, because the event loop may drain before a deferred
 * timer fires. The ladder cancels itself when the child exits; the returned
 * handle is for a caller that settles without an exit (a spawn error).
 */
export function killCueProcess(child: ChildProcess, sync = false): StopHandle {
	return runStopLadder(
		{ child },
		{
			from: 'terminate',
			graceMs: BACKGROUND_STOP_GRACE_MS,
			immediate: sync,
			blocking: sync,
			label: 'cue',
		}
	);
}

/**
 * Register a running Cue child process. Every Cue spawn path registers here -
 * agent prompts ({@link runProcess}), `action: command` shell commands, and
 * maestro-cli calls - because this map is what the Process Monitor lists and
 * what Stop reaches. A spawn that skips it runs invisibly and cannot be stopped
 * from the UI.
 *
 * @returns Unregister function. Call it once the child settles; it only removes
 * this entry, so a stale call cannot drop a newer run under the same id.
 */
export function trackCueProcess(runId: string, entry: CueActiveProcess): () => void {
	activeProcesses.set(runId, entry);
	return () => {
		if (activeProcesses.get(runId) === entry) activeProcesses.delete(runId);
	};
}

/**
 * Spawn a process from a SpawnSpec, capture stdio, and enforce timeout.
 *
 * The process is started, streamed and framed by the library's run layer
 * (`startTurn`), the same one the CLI uses. What stays here is Cue's own:
 * its capture, its timeout, its registry entry, and how a finished turn maps
 * onto a Cue run status.
 *
 * Returns a promise that resolves with the process result when the child
 * exits (or is killed due to timeout).
 */
export async function runProcess(
	runId: string,
	spec: SpawnSpec,
	options: ProcessRunOptions
): Promise<ProcessRunResult> {
	const { toolType, timeoutMs, sshRemoteEnabled, sshStdinScript, stdinPrompt, onLog, onActivity } =
		options;

	// The last check before the spawn; nothing below awaits until the child
	// is started and registered, so a stop cannot slip in between.
	if (isLaunchCancelled(options.signal)) {
		return {
			stdout: '',
			stderr: '',
			exitCode: null,
			status: 'stopped',
			providerSessionId: null,
			usage: null,
		};
	}

	let stdout = '';
	let stderr = '';
	const capture = new CueRunStreamCapture(toolType);

	// What travels on stdin: the full bash script for an SSH run, else a prompt
	// the launch plan moved off the command line (SSH small-prompt mode, or a
	// local run on a Windows host; see resolvePromptDelivery).
	const stdin = sshStdinScript && sshRemoteEnabled ? sshStdinScript : stdinPrompt;

	let turn: TurnHandle;
	try {
		// maestro-p (interactive token mode) self-allocates its own PTY via
		// node-pty internally, so plain pipe stdio here is sufficient; no
		// caller-side TTY is needed.
		turn = startTurn(
			{ command: spec.command, args: spec.args, cwd: spec.cwd, env: spec.env, stdin },
			{
				onStdout: (text) => {
					stdout += text;
					capture.pushRaw(text);
					onActivity?.();
				},
				onStderr: (text) => {
					stderr += text;
					onActivity?.();
				},
				onEvent: (event) => capture.handleEvent(event),
			},
			{
				parser: capture.parser ?? undefined,
				stopGraceMs: BACKGROUND_STOP_GRACE_MS,
				// In local mode the prompt is already a CLI argument, and leaving
				// stdin as an open pipe causes some agents (notably Codex `exec`) to
				// emit "Reading additional input from stdin..." into the run output
				// before they observe EOF. `ignore` gives the child /dev/null so it
				// never tries to read - Claude already behaves correctly with either,
				// so this is safe across all agents.
				emptyStdin: 'ignore',
				// The run's own `stdout` and `stderr` above are what it reports.
				stdoutTailLimit: 0,
				stderrTailLimit: 0,
				sessionId: runId,
				label: 'cue',
			}
		);
	} catch (err) {
		captureException(err, { operation: 'cue:spawn', runId, command: spec.command });
		return {
			stdout: '',
			stderr: `Spawn error: ${err instanceof Error ? err.message : String(err)}`,
			exitCode: null,
			status: 'failed',
			providerSessionId: null,
			usage: null,
		};
	}

	// Set by `stopProcess` / `stopAllProcesses` before the kill, so the exit
	// that follows resolves as an interrupt rather than a crash.
	let stopRequested = false;
	let settled = false;
	// A flag rather than a swapped listener: a child that exits at nearly the
	// same instant as the timeout would otherwise have its exit re-routed.
	let timedOut = false;

	const untrack = trackCueProcess(runId, {
		child: turn.child,
		command: spec.command,
		args: spec.args,
		cwd: spec.cwd,
		toolType,
		startTime: Date.now(),
		sshRemoteCommand: spec.sshRemoteCommand,
		getStdout: () => stdout,
		getStderr: () => stderr,
		requestStop: () => {
			stopRequested = true;
		},
	});

	// Enforce timeout - use platform-appropriate kill
	const timeoutTimer =
		timeoutMs > 0
			? setTimeout(() => {
					if (settled) return;
					onLog('cue', `[CUE] Run ${runId} timed out after ${timeoutMs}ms, killing process`);
					timedOut = true;
					killCueProcess(turn.child);
				}, timeoutMs)
			: undefined;

	const exit = await turn.done;
	settled = true;
	untrack();
	if (timeoutTimer) clearTimeout(timeoutTimer);

	const finish = (status: CueRunStatus, exitCode: number | null): ProcessRunResult => ({
		stdout: capture.getCleanStdout(),
		stderr: extractCleanStderr(stderr, toolType),
		exitCode,
		status,
		providerSessionId: capture.providerSessionId,
		usage: capture.usage,
	});

	// Spawn errors that arrive after spawn returned (e.g. ENOENT).
	if (exit.spawnError) {
		if (timedOut) return finish('timeout', null);
		captureException(exit.spawnError, {
			operation: 'cue:childProcess:error',
			runId,
			command: spec.command,
		});
		stderr += `\nSpawn error: ${exit.spawnError.message}`;
		return finish('failed', null);
	}

	// Cue's own `'timeout'` is set without consulting the resolver, so the
	// four-valued `TurnOutcome` does not have to carry it.
	if (timedOut) return finish('timeout', exit.exitCode);

	// The shared resolver decides the outcome, so Cue agrees with desktop
	// chat and the CLI on what finished a turn.
	const answerText = capture.getAnswerText();
	const parser = capture.parser;
	const { outcome } = resolveTurnOutcome(
		{
			exitCode: exit.exitCode,
			signal: exit.signal,
			interrupted: stopRequested,
			stderrText: stderr,
			stdoutText: stdout,
			explicitError: capture.inBandError,
			stdinError: exit.stdinError,
			capturedAnswerText: answerText,
			resultMessageSeen: capture.resultMessageSeen,
		},
		{
			// Plain-text agents and command runs have no exit heuristic.
			detectErrorFromExit: (exitCode, stderrText, stdoutText) =>
				typeof parser?.detectErrorFromExit === 'function'
					? (parser.detectErrorFromExit(exitCode, stderrText, stdoutText) ?? null)
					: null,
		},
		{ providerId: toolType, sessionId: runId }
	);
	// Cue's two safety rules (a silent non-zero exit, an unrequested signal
	// kill) live in cueStatusForTurn so the desktop exit listener shares them.
	const status = cueStatusForTurn({
		outcome,
		exitCode: exit.exitCode,
		answerCaptured: Boolean(answerText?.trim()),
		killedBySignal: exit.signal !== null,
	});
	// An in-band failure has no stderr of its own, so name it there: that is
	// where a failed run's reason is read from.
	const inBandMessage = capture.inBandError?.message;
	if (status === 'failed' && inBandMessage && !stderr.includes(inBandMessage)) {
		stderr += `${stderr ? '\n' : ''}${inBandMessage}`;
	}
	return finish(status, exit.exitCode);
}

/**
 * Stop a running Cue process by runId, through the shared stop ladder.
 *
 * @returns true if the process was found and signaled, false if not found
 */
export function stopProcess(runId: string): boolean {
	const entry = activeProcesses.get(runId);
	if (!entry) return false;

	// Mark before killing, so the exit reads as an interrupt.
	entry.requestStop?.();
	killCueProcess(entry.child);
	return true;
}

/**
 * Stop all active Cue processes. Called during application shutdown to prevent
 * orphaned processes surviving after the main Electron process exits.
 */
export function stopAllProcesses(): void {
	for (const [runId, entry] of activeProcesses) {
		// Use sync kills so process trees are dead before the app exits.
		entry.requestStop?.();
		killCueProcess(entry.child, true);
		activeProcesses.delete(runId);
	}
}

/**
 * Get the map of currently active processes (for testing/monitoring).
 */
export function getActiveProcessMap(): Map<string, CueActiveProcess> {
	return activeProcesses;
}

/**
 * Snapshot the in-flight stdout/stderr for a still-running Cue process.
 * Returns null when the runId has no active process (already finished, never
 * started, or running on a different engine instance). Buffers are returned
 * raw - callers must trim/format for display.
 */
export function getActiveProcessOutput(runId: string): { stdout: string; stderr: string } | null {
	const entry = activeProcesses.get(runId);
	if (!entry) return null;
	return { stdout: entry.getStdout(), stderr: entry.getStderr() };
}

/**
 * Get serializable info about active Cue processes (for Process Monitor).
 * Filters out entries where the process PID is unavailable (spawn failure).
 */
export function getProcessList(): CueProcessInfo[] {
	const result: CueProcessInfo[] = [];
	for (const [runId, entry] of activeProcesses) {
		if (entry.child.pid) {
			result.push({
				runId,
				pid: entry.child.pid,
				command: entry.command,
				args: entry.args,
				cwd: entry.cwd,
				toolType: entry.toolType,
				startTime: entry.startTime,
				sshRemoteCommand: entry.sshRemoteCommand,
			});
		}
	}
	return result;
}
