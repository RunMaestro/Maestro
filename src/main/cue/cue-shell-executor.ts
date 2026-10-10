/**
 * Cue Shell Executor - runs an `action: command` subscription whose
 * `command.mode` is `'shell'`.
 *
 * The command string is substituted with template variables and then spawned
 * through the user's shell (`shell: true`) so PATH and quoting/pipes/globs
 * resolve as if typed in a terminal. cwd is the owning session's project root.
 * Output, exit code, and timeout handling mirror the agent executor so chained
 * `agent.completed` subscriptions can read shell stdout via {{CUE_SOURCE_OUTPUT}}.
 */

import { spawn, type ChildProcess } from 'child_process';
import type { CueEvent, CueRunResult, CueRunStatus, CueSubscription } from './cue-types';
import type { AgentSshRemoteConfig, SessionInfo } from '../../shared/types';
import { substituteTemplateVariables, type TemplateContext } from '../../shared/templateVariables';
import { buildCueTemplateContext } from './cue-template-context-builder';
import { captureException, captureMessage } from '../utils/sentry';
import {
	wrapSpawnWithSsh,
	sshUnresolvedRemoteMessage,
	type SshSpawnWrapResult,
} from '../utils/ssh-spawn-wrapper';
import type { SshRemoteSettingsStore } from '../utils/ssh-remote-resolver';
import { getShellPath } from '../runtime/getShellPath';
import { buildSpawnPath } from '../utils/spawnPath';
import { killCueProcess, trackCueProcess } from './cue-process-lifecycle';
import type { StopHandle } from '../../shared/maestro-lib/control/termination';

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
		pipelineName: subscription.pipeline_name,
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
	// still parses pipes/quotes/globs - mirroring local `shell: true` behavior.
	let spawnCommand = substitutedCommand;
	let spawnArgs: string[] = [];
	let spawnCwd = projectRoot;
	let spawnEnv: Record<string, string> = { ...process.env } as Record<string, string>;
	let useLocalShell = true;

	if (sshRemoteConfig?.enabled && sshStore) {
		let wrapped: SshSpawnWrapResult;
		try {
			wrapped = await wrapSpawnWithSsh(
				{
					command: 'bash',
					args: ['-c', substitutedCommand],
					cwd: projectRoot,
				},
				sshRemoteConfig,
				sshStore
			);
		} catch (err) {
			captureException(err, { operation: 'cue:shell:sshWrap', runId });
			return failedResult(`SSH wrap error: ${err instanceof Error ? err.message : String(err)}`);
		}
		// A missing or disabled remote comes back unwrapped. Running it locally
		// would execute the user's command on this machine in a cwd that is a
		// REMOTE path, so fail the run instead.
		if (!wrapped.sshRemoteUsed) {
			const message = sshUnresolvedRemoteMessage(sshRemoteConfig);
			onLog('error', `[CUE] Shell run ${runId} not started: ${message}`);
			return failedResult(message);
		}
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

	// macOS GUI apps inherit a minimal launchd PATH (no `~/.local/bin`,
	// `/opt/homebrew/bin`, etc.), so shell commands that rely on user-installed
	// binaries fail with "command not found". Source the user's login-shell PATH
	// to match terminal behavior. When the probe fails (a slow `.zshrc` blows its
	// 2s budget), fall back to the expanded spawn PATH rather than the inherited
	// one: that IS the launchd PATH, which is exactly what broke (#1573). SSH mode
	// is unaffected - the remote shell resolves PATH on its own host.
	if (useLocalShell) {
		let shellPath = '';
		try {
			shellPath = await getShellPath();
		} catch (err) {
			captureMessage(
				`cue:shell falling back to expanded PATH: ${err instanceof Error ? err.message : String(err)}`,
				'warning'
			);
		}
		spawnEnv.PATH = shellPath || buildSpawnPath();
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
				// and the outer spawn just invokes `ssh` - no local shell needed.
				shell: useLocalShell,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch (err) {
			captureException(err, { operation: 'cue:shell:spawn', runId, command: substitutedCommand });
			resolve(failedResult(`Spawn error: ${err instanceof Error ? err.message : String(err)}`));
			return;
		}

		let stdout = '';
		let stderr = '';

		// Registered with the shared Cue registry so the Process Monitor lists
		// the run and Stop reaches it. A shell command has no agent behind it,
		// so it reports as a terminal process.
		const untrack = trackCueProcess(runId, {
			child,
			command: spawnCommand,
			args: spawnArgs,
			cwd: spawnCwd,
			toolType: 'terminal',
			startTime,
			getStdout: () => stdout,
			getStderr: () => stderr,
		});
		let settled = false;
		let timedOut = false;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		let stopHandle: StopHandle | undefined;

		const finish = (status: CueRunStatus, exitCode: number | null) => {
			if (settled) return;
			settled = true;

			untrack();
			if (timeoutTimer) clearTimeout(timeoutTimer);
			stopHandle?.dispose();

			resolve({
				runId,
				sessionId: session.id,
				sessionName: session.name,
				subscriptionName: subscription.name,
				pipelineName: subscription.pipeline_name,
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
				stopHandle = killCueProcess(child);
			}, timeoutMs);
		}
	});
}
