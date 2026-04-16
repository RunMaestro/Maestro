/**
 * Cue Process Lifecycle — spawns child processes, manages stdio capture,
 * enforces timeout with SIGTERM → SIGKILL escalation, and tracks active
 * processes for the Process Monitor.
 *
 * Single responsibility: process spawning and lifecycle management.
 * Does NOT know about template variables, agent definitions, or SSH —
 * it receives a fully resolved SpawnSpec and executes it.
 */

import { spawn, execFile, execFileSync, type ChildProcess } from 'child_process';
import type { CueRunStatus } from './cue-types';
import type { SpawnSpec } from './cue-spawn-builder';
import type { ToolType } from '../../shared/types';
import { getOutputParser } from '../parsers';
import { captureException } from '../utils/sentry';
import { isWindows } from '../../shared/platformDetection';
import { stripAnsiCodes } from '../../shared/stringUtils';

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
}

/** Result of a process execution */
export interface ProcessRunResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	status: CueRunStatus;
}

/** Options controlling process execution */
export interface ProcessRunOptions {
	toolType: string;
	timeoutMs: number;
	sshRemoteEnabled?: boolean;
	sshStdinScript?: string;
	stdinPrompt?: string;
	onLog: (level: string, message: string) => void;
}

// ─── Module State ────────────────────────────────────────────────────────────

/** Map of active Cue processes by runId */
const activeProcesses = new Map<string, CueActiveProcess>();

// ─── Internal Helpers ─────────��──────────────────────────────────────────────

/**
 * Extract clean human-readable text from agent stdout.
 * For agents that output JSON/NDJSON (like OpenCode --format json), parses each
 * line and collects text from 'result' events. Falls back to raw stdout when no
 * parser is available or no result-text events are found (e.g. plain-text agents).
 */
function extractCleanStdout(rawStdout: string, toolType: string): string {
	if (!rawStdout.trim()) {
		return rawStdout;
	}

	const parser = getOutputParser(toolType as ToolType);
	if (!parser) {
		return rawStdout;
	}

	const textParts: string[] = [];
	for (const line of rawStdout.split('\n')) {
		if (!line.trim()) continue;
		const event = parser.parseJsonLine(line);
		if (event?.type === 'result' && event.text) {
			textParts.push(event.text);
		}
	}

	return textParts.length > 0 ? textParts.join('\n') : rawStdout;
}

/**
 * Per-agent stderr noise prefixes. These are informational diagnostics the
 * agent CLI emits on stderr even for successful runs — e.g. Codex printing
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

		// Escalate to SIGKILL after delay — only if the process hasn't actually exited.
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
	const { toolType, timeoutMs, sshRemoteEnabled, sshStdinScript, stdinPrompt, onLog } = options;

	return new Promise<ProcessRunResult>((resolve) => {
		let child: ChildProcess;
		// Only attach a writable stdin pipe when the SSH wrapper actually
		// needs to write a script or prompt down it. In local mode the prompt
		// is already passed as a CLI argument, and leaving stdin as an open
		// pipe causes some agents (notably Codex `exec`) to emit "Reading
		// additional input from stdin..." into the run output before they
		// observe EOF. `'ignore'` gives the child /dev/null for stdin so it
		// never tries to read — Claude already behaves correctly with either,
		// so this is safe across all agents.
		const needsStdinWrite = sshRemoteEnabled && (Boolean(sshStdinScript) || Boolean(stdinPrompt));
		const stdinMode: 'pipe' | 'ignore' = needsStdinWrite ? 'pipe' : 'ignore';
		try {
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
			});
			return;
		}

		activeProcesses.set(runId, {
			child,
			command: spec.command,
			args: spec.args,
			cwd: spec.cwd,
			toolType,
			startTime: Date.now(),
		});

		let stdout = '';
		let stderr = '';
		let settled = false;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

		const finish = (status: CueRunStatus, exitCode: number | null) => {
			if (settled) return;
			settled = true;

			activeProcesses.delete(runId);
			if (timeoutTimer) clearTimeout(timeoutTimer);

			resolve({
				stdout: extractCleanStdout(stdout, toolType),
				stderr: extractCleanStderr(stderr, toolType),
				exitCode,
				status,
			});
		};

		// Capture stdout
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (data: string) => {
			stdout += data;
		});

		// Capture stderr
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (data: string) => {
			stderr += data;
		});

		// Handle process exit
		child.on('close', (code) => {
			const status: CueRunStatus = code === 0 ? 'completed' : 'failed';
			finish(status, code);
		});

		// Handle spawn errors (async — e.g. ENOENT after spawn returns)
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
			// SSH stdin script mode — send the full bash script via stdin
			child.stdin?.write(sshStdinScript);
			child.stdin?.end();
		} else if (stdinPrompt && sshRemoteEnabled) {
			// SSH small prompt mode — send raw prompt via stdin
			child.stdin?.write(stdinPrompt);
			child.stdin?.end();
		} else {
			// Local mode — prompt is already in the args
			child.stdin?.end();
		}

		// Enforce timeout — use platform-appropriate kill
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
			});
		}
	}
	return result;
}
