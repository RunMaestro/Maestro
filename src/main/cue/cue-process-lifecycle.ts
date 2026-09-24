/**
 * Cue Process Lifecycle - spawns child processes, manages stdio capture,
 * enforces timeout with SIGTERM → SIGKILL escalation, and tracks active
 * processes for the Process Monitor.
 *
 * Single responsibility: process spawning and lifecycle management.
 * Does NOT know about template variables, agent definitions, or SSH -
 * it receives a fully resolved SpawnSpec and executes it.
 */

import { spawn, execFile, execFileSync, type ChildProcess } from 'child_process';
import type { CueRunStatus } from './cue-types';
import type { SpawnSpec } from './cue-spawn-builder';
import type { ToolType, UsageStats } from '../../shared/types';
import { getOutputParser } from '../parsers';
import type { AgentOutputParser } from '../../shared/maestro-lib/parsers/agent-output-parser';
import { captureException } from '../utils/sentry';
import { isWindows } from '../../shared/platformDetection';
import { stripAnsiCodes } from '../../shared/stringUtils';
import { BufferedLineReader } from '../../shared/maestro-lib/streaming/buffered-line-reader';
import { UsageAccumulator } from '../../shared/maestro-lib/streaming/usage-accumulator';
import { hasCapability } from '../../shared/maestro-lib/providers/capabilities';
import { FALLBACK_CONTEXT_WINDOW } from '../../shared/agentConstants';

const SIGKILL_DELAY_MS = 5000;

// ─── Types ──────���────────────────────────────────────────────────────────────

/** Metadata stored alongside each active Cue process */
interface CueActiveProcess {
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
	return stats;
}

/**
 * Streaming capture for one Cue agent run: folds three things that used to be
 * three separate full-buffer passes (`extractCleanStdout`,
 * `extractProviderSessionId` in `cue-executor.ts`, and no usage capture at
 * all) into a single line-by-line pass fed by `BufferedLineReader` as stdout
 * chunks arrive, mirroring how desktop chat's `StdoutHandler` and the CLI's
 * `spawnAgent` already do this (Plans/maestro-lib-cli-migration.md, "Cue").
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
	private readonly parser: AgentOutputParser | null;
	private readonly reader = new BufferedLineReader();
	private readonly usageAccumulator: UsageAccumulator | undefined;
	private readonly resultParts: string[] = [];
	private readonly assistantTextByMessage = new Map<string, string>();
	private readonly assistantTextWithoutId: string[] = [];
	private rawFallback = '';
	providerSessionId: string | null = null;
	usage: UsageStats | null = null;

	constructor(toolType: string) {
		this.parser = getOutputParser(toolType as ToolType);
		if (this.parser && hasCapability(toolType, 'usesCombinedContextWindow')) {
			this.usageAccumulator = new UsageAccumulator({ attachesAbsoluteUsage: true });
		}
	}

	push(chunk: string): void {
		this.rawFallback += chunk;
		if (!this.parser) return;
		for (const line of this.reader.push(chunk)) {
			this.handleLine(line);
		}
	}

	/** Flush whatever partial line remains unterminated at process exit. */
	flush(): void {
		if (!this.parser) return;
		const remainder = this.reader.flush();
		if (remainder) this.handleLine(remainder);
	}

	private handleLine(line: string): void {
		const parser = this.parser;
		if (!parser) return;
		const event = parser.parseJsonLine(line);
		if (!event) return;

		if (event.type === 'result' && event.text) {
			this.resultParts.push(event.text);
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
			this.usage = this.usageAccumulator ? this.usageAccumulator.normalize(stats) : stats;
		}
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

/**
 * Kill a Cue child process, using taskkill on Windows to terminate the entire
 * process tree (POSIX signals don't work for shell-spawned processes on Windows).
 */
function killCueProcess(child: ChildProcess, sync = false): void {
	if (isWindows() && child.pid) {
		if (sync) {
			// During shutdown, block until taskkill completes so the process tree
			// is actually dead before Electron exits.
			try {
				execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
					timeout: 5000,
				});
			} catch {
				// taskkill returns non-zero if the process is already dead, which is fine
			}
		} else {
			execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], (error) => {
				if (!error) return;
				const msg = error.message.toLowerCase();
				const alreadyStopped = msg.includes('not found') || msg.includes('no running instance');
				if (alreadyStopped) return;

				captureException(error, {
					operation: 'cue:taskkill',
					pid: child.pid,
				});
			});
		}
	} else {
		child.kill('SIGTERM');

		// Escalate to SIGKILL after delay - only if the process hasn't actually exited.
		setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill('SIGKILL');
			}
		}, SIGKILL_DELAY_MS);
	}
}

// ─── Public API ─────────────���─────────────────────────���──────────────────────

/**
 * Spawn a process from a SpawnSpec, capture stdio, and enforce timeout.
 *
 * Returns a promise that resolves with the process result when the child
 * exits (or is killed due to timeout).
 */
export function runProcess(
	runId: string,
	spec: SpawnSpec,
	options: ProcessRunOptions
): Promise<ProcessRunResult> {
	const { toolType, timeoutMs, sshRemoteEnabled, sshStdinScript, stdinPrompt, onLog, onActivity } =
		options;

	return new Promise<ProcessRunResult>((resolve) => {
		let child: ChildProcess;
		// Only attach a writable stdin pipe when the SSH wrapper actually
		// needs to write a script or prompt down it. In local mode the prompt
		// is already passed as a CLI argument, and leaving stdin as an open
		// pipe causes some agents (notably Codex `exec`) to emit "Reading
		// additional input from stdin..." into the run output before they
		// observe EOF. `'ignore'` gives the child /dev/null for stdin so it
		// never tries to read - Claude already behaves correctly with either,
		// so this is safe across all agents.
		const needsStdinWrite = sshRemoteEnabled && (Boolean(sshStdinScript) || Boolean(stdinPrompt));
		const stdinMode: 'pipe' | 'ignore' = needsStdinWrite ? 'pipe' : 'ignore';
		try {
			// maestro-p (interactive token mode) self-allocates its own PTY via
			// node-pty internally, so plain pipe stdio here is sufficient; no
			// caller-side TTY is needed. The prompt rides as a CLI positional, so
			// 'ignore' stdin is fine even in interactive mode.
			child = spawn(spec.command, spec.args, {
				cwd: spec.cwd,
				env: spec.env,
				stdio: [stdinMode, 'pipe', 'pipe'],
			});
		} catch (err) {
			captureException(err, { operation: 'cue:spawn', runId, command: spec.command });
			resolve({
				stdout: '',
				stderr: `Spawn error: ${err instanceof Error ? err.message : String(err)}`,
				exitCode: null,
				status: 'failed',
				providerSessionId: null,
				usage: null,
			});
			return;
		}

		let stdout = '';
		let stderr = '';
		const capture = new CueRunStreamCapture(toolType);

		activeProcesses.set(runId, {
			child,
			command: spec.command,
			args: spec.args,
			cwd: spec.cwd,
			toolType,
			startTime: Date.now(),
			sshRemoteCommand: spec.sshRemoteCommand,
			getStdout: () => stdout,
			getStderr: () => stderr,
		});
		let settled = false;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

		const finish = (status: CueRunStatus, exitCode: number | null) => {
			if (settled) return;
			settled = true;

			activeProcesses.delete(runId);
			if (timeoutTimer) clearTimeout(timeoutTimer);
			capture.flush();

			resolve({
				stdout: capture.getCleanStdout(),
				stderr: extractCleanStderr(stderr, toolType),
				exitCode,
				status,
				providerSessionId: capture.providerSessionId,
				usage: capture.usage,
			});
		};

		// Capture stdout
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (data: string) => {
			stdout += data;
			capture.push(data);
			onActivity?.();
		});

		// Capture stderr
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (data: string) => {
			stderr += data;
			onActivity?.();
		});

		// Handle process exit.
		//
		// Deliberately NOT routed through maestro-lib's `resolveTurnOutcome`
		// (Plans/maestro-lib-cli-migration.md, "Cue", open question 3). Two
		// reasons, not an oversight:
		//
		//  1. `TurnOutcome` is four-valued (completed / completed-with-warning /
		//     interrupted / crashed) and has no slot for Cue's SYSTEM-initiated
		//     `'timeout'` - the run-length cap set by the subscription, handled
		//     below, not a user abort. Forcing it through would either drop the
		//     distinction (Cue's dashboard shows timeout as its own status,
		//     separate from a crash) or require widening the shared type with a
		//     `reason` sub-field, which is a decision made once, for every
		//     caller, not smuggled in here.
		//  2. Cue's status is exit-code-derived today and already has its own
		//     five-valued state machine (running/completed/failed/timeout/
		///    stopped, the last set by cue-run-manager.ts on a manual stop).
		//     Swapping the resolver in would change almost nothing it reports -
		//     a non-zero exit is already 'failed', a signal kill is already
		//     'failed' via this same branch - so the entire value of migrating
		//     is the two additions this stage makes (live usage capture above,
		//     and this comment), not a status-derivation rewrite.
		child.on('close', (code) => {
			const status: CueRunStatus = code === 0 ? 'completed' : 'failed';
			finish(status, code);
		});

		// Handle spawn errors (async - e.g. ENOENT after spawn returns)
		child.on('error', (error) => {
			captureException(error, {
				operation: 'cue:childProcess:error',
				runId,
				command: spec.command,
			});
			stderr += `\nSpawn error: ${error.message}`;
			finish('failed', null);
		});

		// Write to stdin based on execution mode
		if (sshStdinScript && sshRemoteEnabled) {
			// SSH stdin script mode - send the full bash script via stdin
			child.stdin?.write(sshStdinScript);
			child.stdin?.end();
		} else if (stdinPrompt && sshRemoteEnabled) {
			// SSH small prompt mode - send raw prompt via stdin
			child.stdin?.write(stdinPrompt);
			child.stdin?.end();
		} else {
			// Local mode - prompt is already in the args
			child.stdin?.end();
		}

		// Enforce timeout - use platform-appropriate kill
		if (timeoutMs > 0) {
			timeoutTimer = setTimeout(() => {
				if (settled) return;
				onLog('cue', `[CUE] Run ${runId} timed out after ${timeoutMs}ms, killing process`);
				killCueProcess(child);

				// If the process exits after kill, mark as timeout
				child.removeAllListeners('close');
				child.on('close', (code) => {
					finish('timeout', code);
				});
			}, timeoutMs);
		}
	});
}

/**
 * Stop a running Cue process by runId.
 * On Windows uses taskkill /t /f; on POSIX sends SIGTERM then SIGKILL after 5s.
 *
 * @returns true if the process was found and signaled, false if not found
 */
export function stopProcess(runId: string): boolean {
	const entry = activeProcesses.get(runId);
	if (!entry) return false;

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
