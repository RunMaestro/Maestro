/**
 * Cue Process Lifecycle — spawns child processes, manages stdio capture,
 * enforces timeout with SIGTERM → SIGKILL escalation, and tracks active
 * processes for the Process Monitor.
 *
 * Single responsibility: process spawning and lifecycle management.
 * Does NOT know about template variables, agent definitions, or SSH —
 * it receives a fully resolved SpawnSpec and executes it.
 */

import { spawn, execFile, type ChildProcess } from 'child_process';
import type { CueRunStatus } from './cue-types';
import type { SpawnSpec } from './cue-spawn-builder';
import type { ToolType } from '../../shared/types';
import { getOutputParser } from '../parsers';
import { captureException } from '../utils/sentry';
import { isWindows } from '../../shared/platformDetection';

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
 * Kill a Cue child process, using taskkill on Windows to terminate the entire
 * process tree (POSIX signals don't work for shell-spawned processes on Windows).
 */
function killCueProcess(child: ChildProcess): void {
	if (isWindows() && child.pid) {
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
		try {
			child = spawn(spec.command, spec.args, {
				cwd: spec.cwd,
				env: spec.env,
				stdio: ['pipe', 'pipe', 'pipe'],
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
				stderr,
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
		killCueProcess(entry.child);
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
