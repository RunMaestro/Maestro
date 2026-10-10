/**
 * Cue CLI Executor - runs an `action: command` subscription whose
 * `command.mode` is `'cli'`.
 *
 * Delivers a message to a target session via
 * `maestro-cli dispatch <target> <message>`. Both `target` and `message`
 * (default: `{{CUE_SOURCE_OUTPUT}}`) go through Cue template substitution
 * before spawning. The same low-level {@link runMaestroCliSend} helper
 * backs the legacy `cli_output` Phase 3 post-completion side effect in
 * `cue-run-manager.ts` so both paths share one implementation.
 *
 * Historically this called `maestro-cli send <target> <message> --live`;
 * `--live` was renamed to the dedicated `dispatch` verb in PR1 of the CLI
 * surface refactor. The desktop `send_command` WebSocket message that
 * underlies the dispatch is unchanged, so behavior is identical.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import type { CueCommandCliCall, CueEvent, CueRunResult, CueSubscription } from './cue-types';
import type { SessionInfo } from '../../shared/types';
import { substituteTemplateVariables, type TemplateContext } from '../../shared/templateVariables';
import { buildCueTemplateContext } from './cue-template-context-builder';
import { captureException } from '../utils/sentry';
import { isWindows } from '../../shared/platformDetection';
import { killCueProcess, trackCueProcess } from './cue-process-lifecycle';

/** Timeout for a single maestro-cli send invocation. */
const CLI_SEND_TIMEOUT_MS = 30_000;
/**
 * Cap on how much of the source output we forward - protects the CLI argv.
 *
 * Platform-aware because `maestro-cli send <agent-id> <message>` takes the
 * message as a positional argv. On Windows, `CreateProcessW` imposes a hard
 * 32,767-char ceiling on the entire command line (process path + script
 * path + all argv + quoting), so a 100K message would fail with
 * `ENAMETOOLONG`/`EINVAL` before the CLI even runs. 30K leaves ~2.7K of
 * headroom for the rest of the argv. POSIX `ARG_MAX` is typically
 * 128K-2MB, so the historic 100K cap is preserved there.
 */
const CLI_SEND_OUTPUT_MAX_CHARS_POSIX = 100_000;
const CLI_SEND_OUTPUT_MAX_CHARS_WINDOWS = 30_000;
const CLI_SEND_OUTPUT_MAX_CHARS = isWindows()
	? CLI_SEND_OUTPUT_MAX_CHARS_WINDOWS
	: CLI_SEND_OUTPUT_MAX_CHARS_POSIX;
/** Default message body when the user didn't override it. */
const DEFAULT_CLI_MESSAGE_TEMPLATE = '{{CUE_SOURCE_OUTPUT}}';

export interface CueCliExecutionConfig {
	runId: string;
	session: SessionInfo;
	subscription: CueSubscription;
	event: CueEvent;
	/** The structured cli call (target, optional message override). */
	cli: CueCommandCliCall;
	templateContext: TemplateContext;
	timeoutMs: number;
	onLog: (level: string, message: string) => void;
}

export interface CliSendResult {
	ok: boolean;
	/** Exit code from execFileNoThrow - number when the process ran, string error code (e.g. 'ENOENT') when spawn failed. */
	exitCode: number | string;
	stdout: string;
	stderr: string;
	resolvedTarget: string;
	/** True when the run was killed by the timeout timer (vs exiting on its own). */
	timedOut?: boolean;
}

/**
 * Resolve the bundled `maestro-cli.js` script path. Mirrors the candidate list
 * in `maestro-cli-manager.ts` so dev/test environments (where
 * `process.resourcesPath` is undefined or points at electron's built-in
 * resources) still find the compiled script at `dist/cli/maestro-cli.js`.
 */
export function resolveMaestroCliScriptPath(): string {
	const candidates: string[] = [];
	if (process.resourcesPath) {
		candidates.push(path.join(process.resourcesPath, 'maestro-cli.js'));
	}
	// Dev/preserved-layout: this file compiles to dist/main/cue/cue-cli-executor.js,
	// while the CLI is built to dist/cli/maestro-cli.js - two levels up, then `cli`.
	candidates.push(path.resolve(__dirname, '..', '..', 'cli', 'maestro-cli.js'));
	// Legacy single-level fallback (kept for any flattened/bundled layout).
	candidates.push(path.resolve(__dirname, '..', 'cli', 'maestro-cli.js'));

	for (const candidate of candidates) {
		try {
			fs.accessSync(candidate, fs.constants.R_OK);
			return candidate;
		} catch {
			continue;
		}
	}
	// Fall back to the first candidate so execFile surfaces a clear ENOENT
	// with the attempted path rather than a bare filename.
	return candidates[0] ?? path.resolve(__dirname, '..', 'cli', 'maestro-cli.js');
}

/**
 * Spawn `node maestro-cli.js dispatch <target> <message>`. Used by both the
 * primary cli executor and the legacy cli_output Phase 3 path. When `runId`
 * is provided, the child joins the shared Cue registry
 * ({@link trackCueProcess}) so the Process Monitor lists it and Stop reaches
 * it. The legacy cli_output Phase 3 path passes no runId: it is a side effect of
 * an already-completed run, so it stays untracked.
 */
export async function runMaestroCliSend(
	target: string,
	message: string,
	timeoutMs: number = CLI_SEND_TIMEOUT_MS,
	runId?: string
): Promise<CliSendResult> {
	const cliScriptPath = resolveMaestroCliScriptPath();
	const truncated = message.substring(0, CLI_SEND_OUTPUT_MAX_CHARS);
	const effectiveTimeout = timeoutMs > 0 ? timeoutMs : CLI_SEND_TIMEOUT_MS;

	return new Promise<CliSendResult>((resolve) => {
		let child: ChildProcess;
		try {
			child = spawn(process.execPath, [cliScriptPath, 'dispatch', target, truncated], {
				stdio: ['ignore', 'pipe', 'pipe'],
				// In packaged Electron, `process.execPath` is the app binary, not
				// Node - without this flag the spawn would launch the app instead
				// of running maestro-cli.js. Mirrors the shims emitted by
				// maestro-cli-manager.ts for user-facing invocations.
				env: {
					...process.env,
					ELECTRON_RUN_AS_NODE: '1',
				},
			});
		} catch (err) {
			// Synchronous spawn throw is an unexpected process-launch failure
			// (permissions, bad ELECTRON_RUN_AS_NODE interaction, etc.). Report
			// to Sentry so it isn't lost - the caller still gets a `failed`
			// result so the run flow stays intact. ENOENT (bundle not found)
			// is already surfaced by the resolver and isn't captured.
			const errCode = (err as NodeJS.ErrnoException)?.code;
			if (errCode !== 'ENOENT') {
				captureException(err, {
					operation: 'cue:cli:spawn',
					cliScriptPath,
					target,
				});
			}
			resolve({
				ok: false,
				exitCode: errCode ?? 'spawnError',
				stdout: '',
				stderr: err instanceof Error ? err.message : String(err),
				resolvedTarget: target,
			});
			return;
		}

		let stdout = '';
		let stderr = '';

		const untrack = runId
			? trackCueProcess(runId, {
					child,
					command: process.execPath,
					args: [cliScriptPath, 'dispatch', target],
					cwd: process.cwd(),
					toolType: 'terminal',
					startTime: Date.now(),
					getStdout: () => stdout,
					getStderr: () => stderr,
				})
			: undefined;
		let settled = false;
		let timedOut = false;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

		const finish = (exitCode: number | string, sawError: Error | null) => {
			if (settled) return;
			settled = true;
			untrack?.();
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (sawError) stderr = stderr ? `${stderr}\n${sawError.message}` : sawError.message;
			resolve({
				ok: exitCode === 0,
				exitCode,
				stdout,
				stderr,
				resolvedTarget: target,
				timedOut,
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

		child.on('close', (code) => {
			finish(code ?? 'null', null);
		});
		child.on('error', (error) => {
			// Async child-process error (e.g. spawn succeeded but the child
			// failed before emitting any output). Treat like the sync throw
			// above - report to Sentry unless it's the expected ENOENT from
			// a missing CLI bundle, then funnel into the normal failed path.
			const errCode = (error as NodeJS.ErrnoException).code;
			if (errCode !== 'ENOENT') {
				captureException(error, {
					operation: 'cue:cli:childProcess:error',
					cliScriptPath,
					pid: child.pid,
					target,
				});
			}
			finish(errCode ?? 'spawnError', error);
		});

		if (effectiveTimeout > 0) {
			timeoutTimer = setTimeout(() => {
				if (settled) return;
				timedOut = true;
				killCueProcess(child);
			}, effectiveTimeout);
		}
	});
}

/**
 * Execute a Cue-triggered cli command (currently always `send`). Substitutes
 * `target` + `message` with template variables then invokes maestro-cli.
 */
export async function executeCueCli(config: CueCliExecutionConfig): Promise<CueRunResult> {
	const { runId, session, subscription, event, cli, templateContext, timeoutMs, onLog } = config;

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

	templateContext.cue = buildCueTemplateContext(event, subscription, runId);

	const resolvedTarget = substituteTemplateVariables(cli.target, templateContext).trim();
	if (!resolvedTarget) {
		const message = `Cue subscription "${subscription.name}" cli target resolved to empty string (raw="${cli.target}")`;
		onLog('warn', message);
		return failedResult(message);
	}

	const messageTemplate = cli.message ?? DEFAULT_CLI_MESSAGE_TEMPLATE;
	const resolvedMessage = substituteTemplateVariables(messageTemplate, templateContext);

	// Surface argv truncation so users notice when output is cut - on
	// Windows this cap is much tighter (30K vs 100K on POSIX) to stay
	// under the 32K CreateProcessW command-line ceiling.
	if (resolvedMessage.length > CLI_SEND_OUTPUT_MAX_CHARS) {
		onLog(
			'warn',
			`[CUE] "${subscription.name}" cli message truncated from ${resolvedMessage.length} to ${CLI_SEND_OUTPUT_MAX_CHARS} chars (platform argv cap)`
		);
	}

	onLog(
		'cue',
		`[CUE] Executing cli run ${runId}: "${subscription.name}" → maestro-cli dispatch ${resolvedTarget} (message length=${resolvedMessage.length})`
	);

	try {
		// Treat <=0 as "no explicit cap - use default" rather than clamping to
		// 1ms (which would kill the process almost immediately). When the
		// caller-supplied timeout exceeds our hard cap, log it so the clamp is
		// observable - a silent reduction would mask a surprising kill.
		if (timeoutMs > CLI_SEND_TIMEOUT_MS) {
			onLog(
				'warn',
				`[CUE] "${subscription.name}" cli timeout ${timeoutMs}ms clamped to ${CLI_SEND_TIMEOUT_MS}ms`
			);
		}
		const clampedTimeout =
			timeoutMs > 0 ? Math.min(timeoutMs, CLI_SEND_TIMEOUT_MS) : CLI_SEND_TIMEOUT_MS;
		const result = await runMaestroCliSend(resolvedTarget, resolvedMessage, clampedTimeout, runId);
		const status = result.timedOut ? 'timeout' : result.ok ? 'completed' : 'failed';
		if (result.timedOut) {
			onLog(
				'warn',
				`[CUE] "${subscription.name}" cli dispatch timed out after ${clampedTimeout}ms - process killed`
			);
		} else if (!result.ok) {
			onLog(
				'warn',
				`[CUE] "${subscription.name}" cli dispatch failed: exit=${result.exitCode} stderr=${result.stderr.slice(0, 500)}`
			);
		} else {
			onLog('cue', `[CUE] "${subscription.name}" cli dispatch delivered to ${resolvedTarget}`);
		}
		// CueRunResult only carries numeric exit codes; spawn-failure string codes
		// (ENOENT etc.) are reported in stderr and surface as exitCode=null.
		const numericExit = typeof result.exitCode === 'number' ? result.exitCode : null;
		return {
			runId,
			sessionId: session.id,
			sessionName: session.name,
			subscriptionName: subscription.name,
			pipelineName: subscription.pipeline_name,
			event,
			status,
			stdout: result.stdout,
			stderr: result.stderr,
			exitCode: numericExit,
			durationMs: Date.now() - startTime,
			startedAt,
			endedAt: new Date().toISOString(),
		};
	} catch (err) {
		captureException(err, {
			operation: 'cue:cliExecutor',
			subscription: subscription.name,
			target: resolvedTarget,
		});
		const message = `cli dispatch threw: ${err instanceof Error ? err.message : String(err)}`;
		onLog('warn', `[CUE] "${subscription.name}" ${message}`);
		return failedResult(message);
	}
}
