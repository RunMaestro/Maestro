/**
 * The one runner a provider probe goes through.
 *
 * A probe starts a provider's own executable to read what it knows (the
 * models a CLI lists, the effort levels its flag validator names, what
 * `grok inspect --json` says a launch inherits) and sends it no prompt of the
 * person's.
 *
 * With no limits and no cancellation a probe runs through `execFileNoThrow`
 * exactly as discovery always did. A caller that asks for limits or a signal
 * gets the shared `startTurn` lifecycle instead: an absolute time budget, a
 * combined output cap, cancellation through the shared stop ladder,
 * observed-descendant cleanup, sanitized failures and no partial output.
 *
 * Grok exec probes are refused before any process starts. Polling can miss a
 * rapid fork and exit, and `taskkill` cannot recover the children of an exited
 * Windows parent, so this host cannot guarantee a finite Grok probe lifetime
 * after spawning. The refusal is a `ProviderProbeRefusedError`; callers keep
 * their configured fallback (a cache on disk, an owned ACP observation)
 * instead of treating it as an empty catalog.
 */

import { execFileNoThrow, type ExecResult } from '../utils/execFile';
import { startTurn, type TurnProcessSpec } from '../../shared/maestro-lib/run/start-turn';
import { planSpawnShell } from '../process-manager/utils/windowsSpawnShell';
import { createIdleWatchdog } from '../utils/idle-watchdog';

/** One probe: which provider, what it reads, and exactly what to run. */
export interface ProviderProbeRequest {
	providerId: string;
	/** What the probe reads (`models`, `effort-levels`, `inspect`): the stop label. */
	kind: string;
	command: string;
	args: string[];
	/** Where to run; the process's own directory when absent. */
	cwd?: string;
	/** The full environment for the probe; the process's own when absent. */
	env?: NodeJS.ProcessEnv;
	/**
	 * Opt-in process limits. These trigger stopping, not a guaranteed completion
	 * deadline: observed-tree cleanup cannot contain unobserved forks or Windows orphans.
	 */
	limits?: {
		/** Absolute run budget in milliseconds, never extended by output. */
		timeoutMs: number;
		/** Combined UTF-8 bytes from stdout and stderr, including unterminated lines. */
		maxOutputBytes: number;
	};
	/** Cancel before launch or stop the owned process through the shared stop ladder. */
	signal?: AbortSignal;
}

/** A probe this host refused before starting anything. */
export class ProviderProbeRefusedError extends Error {
	readonly state = 'unavailable' as const;
	readonly code = 'runtime-unavailable' as const;
	constructor(message: string) {
		super(message);
		this.name = 'ProviderProbeRefusedError';
	}
}

/** The spec `startTurn` is handed: the command planned for this platform's shell. */
export function providerProbeSpec(
	request: Pick<ProviderProbeRequest, 'command' | 'args' | 'cwd' | 'env'>
): TurnProcessSpec {
	const shellPlan = planSpawnShell(request.command, request.args, {});
	return {
		command: shellPlan.command,
		args: shellPlan.args,
		shell: shellPlan.shell,
		cwd: request.cwd ?? process.cwd(),
		env: request.env ?? process.env,
	};
}

async function startedProbe(request: ProviderProbeRequest): Promise<ExecResult> {
	const spec = providerProbeSpec(request);
	const { limits, signal } = request;
	let stdout = '';
	let outputBytes = 0;
	let failure: ExecResult | undefined;
	const controller = new AbortController();
	const fail = (exitCode: string, message: string): void => {
		if (failure) return;
		failure = { stdout: '', stderr: message, exitCode };
		stdout = '';
		controller.abort();
	};
	const onAbort = (): void => fail('ECANCELED', 'Provider probe canceled.');
	signal?.addEventListener('abort', onAbort, { once: true });
	const watchdog = limits
		? createIdleWatchdog({
				idleMs: limits.timeoutMs,
				maxMs: limits.timeoutMs,
				onIdle: () => fail('ETIMEDOUT', 'Provider probe exceeded its time budget.'),
			})
		: undefined;
	const collect = (text: string, stream: 'stdout' | 'stderr'): void => {
		if (failure) return;
		if (limits) {
			const bytes = Buffer.byteLength(text, 'utf8');
			if (bytes > limits.maxOutputBytes - outputBytes) {
				fail('ENOBUFS', 'Provider probe exceeded its output limit.');
				return;
			}
			outputBytes += bytes;
		}
		watchdog?.touch();
		// stderr counts toward the output budget but is never returned.
		if (stream === 'stdout') stdout += text;
	};
	try {
		let turn: ReturnType<typeof startTurn>;
		try {
			turn = startTurn(
				spec,
				{
					onStdout: (text) => collect(text, 'stdout'),
					onStderr: (text) => collect(text, 'stderr'),
				},
				{
					signal: controller.signal,
					trackDescendants: true,
					stopGraceMs: 250,
					stdoutTailLimit: 0,
					stderrTailLimit: 0,
					label: `${request.providerId}-probe:${request.kind}`,
				}
			);
		} catch {
			throw new Error('Provider probe could not be started.');
		}
		// Never settle by racing a timer: startTurn drains the pipes and joins
		// observed-descendant cleanup first. Observation is not containment.
		const exit = await turn.done;
		if (failure) return failure;
		if (exit.interrupted) {
			return { stdout: '', stderr: 'Provider probe stopped.', exitCode: 'ECANCELED' };
		}
		if (exit.spawnError || exit.stdinError || exit.exitCode !== 0) {
			return {
				stdout: '',
				stderr: 'Provider probe failed.',
				exitCode: exit.spawnError ? 'ESPAWN' : exit.stdinError ? 'EPIPE' : (exit.exitCode ?? 1),
			};
		}
		return { stdout, stderr: '', exitCode: 0 };
	} finally {
		watchdog?.disarm();
		signal?.removeEventListener('abort', onAbort);
	}
}

/**
 * Run one probe and hand back what it printed, in the `ExecResult` shape the
 * callers already read. Without limits or a signal: `execFileNoThrow` with the
 * same arguments as before (the environment passed as `{ env }` when one is
 * given). With either: the bounded `startTurn` lifecycle described above.
 * A Grok probe throws `ProviderProbeRefusedError` before anything starts,
 * whether or not the caller asked for limits.
 */
export async function runProviderProbe(request: ProviderProbeRequest): Promise<ExecResult> {
	if (request.limits) {
		const { timeoutMs, maxOutputBytes } = request.limits;
		if (
			!Number.isInteger(timeoutMs) ||
			timeoutMs <= 0 ||
			timeoutMs > 2 ** 31 - 1 ||
			!Number.isSafeInteger(maxOutputBytes) ||
			maxOutputBytes <= 0
		) {
			throw new RangeError('Provider probe limits must be finite positive integers within range.');
		}
		request = { ...request, limits: { timeoutMs, maxOutputBytes } };
	}
	if (request.signal?.aborted) {
		return { stdout: '', stderr: 'Provider probe canceled.', exitCode: 'ECANCELED' };
	}
	// No request data in the diagnostic: the refusal is about this host, not the call.
	if (request.providerId === 'grok') {
		throw new ProviderProbeRefusedError(
			'Grok discovery unavailable: this host cannot guarantee finite probe lifetime. Nothing was started.'
		);
	}
	if (request.limits || request.signal) return startedProbe(request);
	return request.env === undefined
		? execFileNoThrow(request.command, request.args, request.cwd)
		: execFileNoThrow(request.command, request.args, request.cwd, { env: request.env });
}
