/**
 * Cue Shell Executor — runs an `action: command` subscription whose
 * `command.mode` is `'shell'`.
 *
 * The command string is substituted with template variables and then spawned
 * through the user's shell (`shell: true`) so PATH and quoting/pipes/globs
 * resolve as if typed in a terminal. cwd is the owning session's project root.
 * Output, exit code, and timeout handling mirror the agent executor so chained
 * `agent.completed` subscriptions can read shell stdout via {{CUE_SOURCE_OUTPUT}}.
 */

import { spawn, execFile, execFileSync, type ChildProcess } from 'child_process';
import type { CueEvent, CueRunResult, CueRunStatus, CueSubscription } from './cue-types';
import type { AgentSshRemoteConfig, SessionInfo } from '../../shared/types';
import { substituteTemplateVariables, type TemplateContext } from '../../shared/templateVariables';
import { buildCueTemplateContext } from './cue-template-context-builder';
import { captureException } from '../utils/sentry';
import { isWindows } from '../../shared/platformDetection';
import { wrapSpawnWithSsh } from '../utils/ssh-spawn-wrapper';
import type { SshRemoteSettingsStore } from '../utils/ssh-remote-resolver';

const SIGKILL_DELAY_MS = 5000;

export interface CueShellExecutionConfig {
	runId: string;
	session: SessionInfo;
	subscription: CueSubscription;
	event: CueEvent;
	/** Shell command, pre-template-substitution. */
	shellCommand: string;
	projectRoot: string;
	templateContext: TemplateContext;
	timeoutMs: number;
	onLog: (level: string, message: string) => void;
	/**
	 * Session-level SSH remote config. When `enabled`, the shell command runs
	 * on the remote host (via `bash -c` through the SSH wrapper) with
	 * `projectRoot` as the remote cwd.
	 */
	sshRemoteConfig?: AgentSshRemoteConfig;
	/** Store adapter used by {@link wrapSpawnWithSsh}. Required for SSH mode. */
	sshStore?: SshRemoteSettingsStore;
}

interface ActiveShellProcess {
	child: ChildProcess;
	startTime: number;
}

const activeShellProcesses = new Map<string, ActiveShellProcess>();

function killShellProcess(
	child: ChildProcess,
	sync = false
): ReturnType<typeof setTimeout> | undefined {
	if (isWindows() && child.pid) {
		if (sync) {
			try {
				execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { timeout: 5000 });
			} catch {
				// taskkill returns non-zero when the process is already dead — fine.
			}
		} else {
			execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], (error) => {
				if (!error) return;
				// If the child has already exited by the time taskkill runs, the
				// non-zero exit is just "process already dead" — benign. Checking
				// `child.exitCode` is locale-independent, unlike matching the
				// error message text.
				if (child.exitCode !== null || child.signalCode !== null) return;
				captureException(error, { operation: 'cue:shell:taskkill', pid: child.pid });
			});
		}
		return undefined;
	}
	child.kill('SIGTERM');
	if (sync) {
		// Shutdown path: the event loop may drain before a deferred timer
		// fires, leaving any child that ignores SIGTERM alive. Escalate
		// immediately so the child is guaranteed to be reaped.
		if (child.exitCode === null && child.signalCode === null) {
			child.kill('SIGKILL');
		}
		return undefined;
	}
	return setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill('SIGKILL');
		}
	}, SIGKILL_DELAY_MS);
}

/**
 * Execute a Cue-triggered shell command. Spawns via `shell: true` in
 * `projectRoot`, captures stdout/stderr/exitCode, and enforces timeout
 * (SIGTERM → SIGKILL after 5s).
 */
export async function executeCueShell(config: CueShellExecutionConfig): Promise<CueRunResult> {
	const {
		runId,
		session,
		subscription,
		event,
		shellCommand,
		projectRoot,
		templateContext,
		timeoutMs,
		onLog,
		sshRemoteConfig,
		sshStore,
	} = config;

	const startedAt = new Date().toISOString();
	const startTime = Date.now();

	const failedResult = (message: string): CueRunResult => ({
		runId,
		sessionId: session.id,
		sessionName: session.name,
		subscriptionName: subscription.name,
		event,
		status: 'failed',
		stdout: '',
		stderr: message,
		exitCode: null,
		durationMs: Date.now() - startTime,
		startedAt,
		endedAt: new Date().toISOString(),
	});

	const trimmed = shellCommand?.trim();
	if (!trimmed) {
		const message = `Cue subscription "${subscription.name}" has no shell command`;
		onLog('error', message);
		return failedResult(message);
	}

	templateContext.cue = buildCueTemplateContext(event, subscription, runId);
	const substitutedCommand = substituteTemplateVariables(trimmed, templateContext);

	onLog(
		'cue',
		`[CUE] Executing shell run ${runId}: "${subscription.name}" → ${substitutedCommand} (${event.type})`
	);

	// Resolve spawn parameters. For SSH-remote sessions, wrap the command so it
	// executes on the remote host inside `projectRoot` (which is a remote path).
	// We pass the user's shell string as `bash -c <cmd>` so the remote shell
	// still parses pipes/quotes/globs — mirroring local `shell: true` behavior.
	let spawnCommand = substitutedCommand;
	let spawnArgs: string[] = [];
	let spawnCwd = projectRoot;
	let spawnEnv: Record<string, string> = { ...process.env } as Record<string, string>;
	let useLocalShell = true;

	if (sshRemoteConfig?.enabled && sshStore) {
		try {
			const wrapped = await wrapSpawnWithSsh(
				{
					command: 'bash',
					args: ['-c', substitutedCommand],
					cwd: projectRoot,
				},
				sshRemoteConfig,
				sshStore
			);
			if (wrapped.sshRemoteUsed) {
				spawnCommand = wrapped.command;
				spawnArgs = wrapped.args;
				spawnCwd = wrapped.cwd;
				spawnEnv = { ...process.env, ...(wrapped.customEnvVars || {}) } as Record<string, string>;
				useLocalShell = false;
				onLog(
					'cue',
					`[CUE] Shell run ${runId} executing on SSH remote "${wrapped.sshRemoteUsed.name}"`
				);
			}
		} catch (err) {
			captureException(err, { operation: 'cue:shell:sshWrap', runId });
			return failedResult(`SSH wrap error: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return new Promise<CueRunResult>((resolve) => {
		let child: ChildProcess;
		try {
			child = spawn(spawnCommand, spawnArgs, {
				cwd: spawnCwd,
				env: spawnEnv,
				// For local mode, `shell: true` makes the user's shell resolve
				// PATH and handle quoting/pipes/globs. For SSH mode, the remote
				// `/bin/bash -c` inside the wrapper already parses the command,
				// and the outer spawn just invokes `ssh` — no local shell needed.
				shell: useLocalShell,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch (err) {
			captureException(err, { operation: 'cue:shell:spawn', runId, command: substitutedCommand });
			resolve(failedResult(`Spawn error: ${err instanceof Error ? err.message : String(err)}`));
			return;
		}

		activeShellProcesses.set(runId, { child, startTime });

		let stdout = '';
		let stderr = '';
		let settled = false;
		let timedOut = false;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

		const finish = (status: CueRunStatus, exitCode: number | null) => {
			if (settled) return;
			settled = true;

			activeShellProcesses.delete(runId);
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (sigkillTimer) clearTimeout(sigkillTimer);

			resolve({
				runId,
				sessionId: session.id,
				sessionName: session.name,
				subscriptionName: subscription.name,
				event,
				status,
				stdout,
				stderr,
				exitCode,
				durationMs: Date.now() - startTime,
				startedAt,
				endedAt: new Date().toISOString(),
			});
		};

		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (data: string) => {
			stdout += data;
		});

		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (data: string) => {
			stderr += data;
		});

		// Use a `timedOut` flag rather than swapping listeners. Swapping races
		// with a queued 'close' event: Node timers fire in the timers phase
		// before the I/O phase, so a child that exits naturally at nearly the
		// same instant as the timeout can have its 'close' event re-routed to
		// the new handler, falsely reporting a timeout.
		child.on('close', (code) => {
			finish(timedOut ? 'timeout' : code === 0 ? 'completed' : 'failed', code);
		});

		child.on('error', (error) => {
			// During a timeout-triggered kill the OS/process may emit 'error'
			// before 'close'. Short-circuit so the run is reported as 'timeout'
			// rather than 'failed'.
			if (timedOut) return;
			captureException(error, {
				operation: 'cue:shell:childProcess:error',
				runId,
				command: substitutedCommand,
			});
			stderr += `\nSpawn error: ${error.message}`;
			finish('failed', null);
		});

		if (timeoutMs > 0) {
			timeoutTimer = setTimeout(() => {
				if (settled) return;
				onLog('cue', `[CUE] Shell run ${runId} timed out after ${timeoutMs}ms, killing process`);
				timedOut = true;
				sigkillTimer = killShellProcess(child);
			}, timeoutMs);
		}
	});
}

/** Stop a running shell process by runId. Returns true if found. */
export function stopCueShellRun(runId: string): boolean {
	const entry = activeShellProcesses.get(runId);
	if (!entry) return false;
	killShellProcess(entry.child);
	return true;
}

/** Stop all active shell processes (called on app shutdown). */
export function stopAllCueShellRuns(): void {
	for (const [runId, entry] of activeShellProcesses) {
		killShellProcess(entry.child, true);
		activeShellProcesses.delete(runId);
	}
}
