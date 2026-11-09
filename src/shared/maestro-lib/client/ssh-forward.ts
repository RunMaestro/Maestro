/**
 * One SSH port forward per Federation remote, shared by every caller (the
 * `federation.ssh-forward` background service).
 *
 * A remote's `maestro-cli host` serves its bridge on the remote's 127.0.0.1
 * only. The laptop reaches it through `ssh -N -L 127.0.0.1:<free>:127.0.0.1:<host port>`,
 * built from the remote's own SSH arguments, and hands callers the local end
 * plus the host's token and CLI secret. Those stay in memory (decision D1).
 *
 * Rules this module owns:
 *
 * - **One forward per remote, refcounted.** `acquire()` returns a lease; the
 *   forward starts with the first lease and stops when the last one is released.
 * - **One SSH process per remote at a time.** Discovery (one ssh call) finishes
 *   before the forward is spawned, a restart stops the old forward before it
 *   rediscovers, and a forward re-acquired while its predecessor is still
 *   stopping waits for it. Tailcat `ProxyCommand` remotes fail under
 *   concurrent dials.
 * - **Every (re)start rediscovers.** The host picks a new port each time it
 *   starts, so a cached port is a dead forward.
 * - **Restarts back off.** A dropped forward, a failed discovery, or a host
 *   that is not running retries with exponential backoff and jitter. The
 *   attempt count resets once a forward has stayed up for `stableAfterMs`.
 * - **A moved host restarts the forward.** ssh logging `open failed: connect
 *   failed` means nothing listens on the forwarded port anymore: the host
 *   stopped or restarted on another port.
 * - **Stopping goes through `stopProcess()`.**
 *
 * The forward owns its ssh process (`ControlMaster=no`, `ControlPath=none`):
 * riding a ControlMaster would park the forward inside the master and let the
 * client exit at once, leaving nothing to supervise. `ClearAllForwardings=no`
 * undoes Maestro's default, which would otherwise drop the `-L` itself.
 *
 * Nothing here runs until a caller acquires a lease, so a switched-off
 * Federation leaves no process behind (decision D8). The caller checks the
 * Encore Feature and the remote's own `federation` flag before acquiring.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'child_process';

import { redactSecrets } from '../../redactSecrets';
import { buildSshConnectionArgs, describeSshConnectionError } from '../../sshConnection';
import type { SshRemoteConfig } from '../../types';
import { BACKGROUND_STOP_GRACE_MS, stopProcess } from '../control/termination';
import { resolveSshPath } from '../launch/ssh-path';
import type { HostEndpoint } from './discovery';
import { availableLocalPort, waitForLocalPort } from './local-port';
import {
	discoverRemoteHost,
	type RemoteDiscoveryError,
	type RemoteHostDiscovery,
} from './remote-discovery';

/** A remote host's endpoint as the laptop dials it: `port` is the LOCAL end of the forward. */
export interface ForwardedHostEndpoint extends HostEndpoint {
	/** The host's own port on the remote, the far end of the forward. */
	remotePort: number;
}

export type SshForwardErrorCode =
	/** The remote has no usable `maestro-cli`. The message names the fix. */
	| 'not-installed'
	/** The CLI is there, but no host serves its data directory. */
	| 'not-running'
	/** ssh exited, or never started listening on the local port. */
	| 'forward-failed'
	/** The forward was up and the host behind it went away. */
	| 'host-gone';

export class SshForwardError extends Error {
	readonly code: SshForwardErrorCode;
	constructor(code: SshForwardErrorCode, message: string) {
		super(message);
		this.name = 'SshForwardError';
		this.code = code;
	}
}

export type SshForwardState =
	| { status: 'starting' }
	| { status: 'up'; endpoint: ForwardedHostEndpoint }
	| {
			status: 'down';
			error: SshForwardError | RemoteDiscoveryError | Error;
			/** Consecutive failed attempts, counting this one. */
			attempt: number;
			retryInMs: number;
	  }
	| { status: 'stopped' };

export interface SshForwardLease {
	readonly remoteId: string;
	state(): SshForwardState;
	/**
	 * The endpoint once the forward is up. Resolves at once when it already is,
	 * rejects with the last error when the forward is waiting to retry, and
	 * otherwise settles on the outcome of the attempt in progress.
	 */
	ready(): Promise<ForwardedHostEndpoint>;
	/** Called on every state change. Returns the unsubscribe. */
	onChange(listener: (state: SshForwardState) => void): () => void;
	/** Stop the forward and start over with a fresh discovery now, skipping any backoff. */
	restart(): void;
	/** Drop this lease. The forward stops with the last one. Safe to call twice. */
	release(): Promise<void>;
}

export type SshForwardSpawn = (
	command: string,
	args: readonly string[],
	options: { stdio: ['ignore', 'ignore', 'pipe']; windowsHide: true; shell: false }
) => ChildProcess;

export interface SshForwardManagerOptions {
	/** Default `discoverRemoteHost()`. */
	discover?: (remote: SshRemoteConfig) => Promise<RemoteHostDiscovery>;
	/** Default `child_process.spawn`. */
	spawn?: SshForwardSpawn;
	/** The `ssh` binary. Default `resolveSshPath()`. */
	sshPath?: string;
	/** Default `availableLocalPort()`. */
	allocatePort?: () => Promise<number>;
	/** Default `waitForLocalPort()`. */
	waitForPort?: typeof waitForLocalPort;
	/** How long ssh gets to start listening. Default 60 s, a slow tunnel's connect included. */
	readyTimeoutMs?: number;
	/** First retry delay. Default 1 s. */
	backoffInitialMs?: number;
	/** Retry delay ceiling. Default 30 s. */
	backoffMaxMs?: number;
	/** Uptime after which a drop counts as a first failure again. Default 60 s. */
	stableAfterMs?: number;
	/** Grace between stop stages. Default `BACKGROUND_STOP_GRACE_MS`. */
	stopGraceMs?: number;
}

type ResolvedOptions = Required<Omit<SshForwardManagerOptions, 'sshPath'>> & { sshPath?: string };

const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_BACKOFF_INITIAL_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 30_000;
const DEFAULT_STABLE_AFTER_MS = 60_000;
const STDERR_TAIL_BYTES = 8192;

/** What ssh logs when a forwarded connection finds nothing listening on the remote port. */
const HOST_GONE_PATTERN = /open failed: connect failed/i;

/**
 * The `ssh` argv (after the binary) that forwards 127.0.0.1:`localPort` to the
 * remote's 127.0.0.1:`remotePort`. The forward's own options come first:
 * ssh applies `-o` first-wins, so they hold against the remote's overrides.
 */
export function buildSshForwardArgs(
	remote: SshRemoteConfig,
	localPort: number,
	remotePort: number
): string[] {
	for (const port of [localPort, remotePort]) {
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			throw new Error(`Invalid forward port: ${String(port)}`);
		}
	}
	const keepalive = Object.keys(remote.sshOptions ?? {}).some(
		(key) => key.toLowerCase() === 'serveraliveinterval'
	)
		? []
		: ['-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
	return [
		'-N',
		'-o',
		'ExitOnForwardFailure=yes',
		'-o',
		'ClearAllForwardings=no',
		'-o',
		'ControlMaster=no',
		'-o',
		'ControlPath=none',
		// INFO, so the `open failed: connect failed` that reveals a moved host reaches stderr.
		'-o',
		'LogLevel=INFO',
		...keepalive,
		'-L',
		`127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
		...buildSshConnectionArgs(remote),
	];
}

function remoteLabel(remote: SshRemoteConfig): string {
	return remote.name || remote.host;
}

function isRunning(child: ChildProcess): boolean {
	return child.exitCode === null && child.signalCode === null;
}

/** Resolves once `child` has exited, at once when it already has. */
function exited(child: ChildProcess): Promise<void> {
	if (!isRunning(child)) return Promise.resolve();
	return new Promise((resolve) => {
		child.once('exit', () => resolve());
		child.once('error', () => resolve());
	});
}

/** ssh's stderr as something safe to put in an error message. */
function describeStderr(stderr: string): string {
	const safe = redactSecrets(stderr, { hexBlobs: true }).text.trim();
	return describeSshConnectionError(safe) ?? safe.split(/\r?\n/).slice(-3).join(' ');
}

/** What discovery found, as an endpoint, or the error that says why there is none. */
function endpointOf(remote: SshRemoteConfig, found: RemoteHostDiscovery): HostEndpoint {
	if (!found.installed) throw new SshForwardError('not-installed', found.fix);
	if (!found.running) {
		throw new SshForwardError(
			'not-running',
			`No maestro-cli host is running on ${remoteLabel(remote)}. Start one with \`maestro-cli remote-host start ${remoteLabel(remote)}\`.`
		);
	}
	return found.endpoint;
}

interface Waiter {
	resolve(endpoint: ForwardedHostEndpoint): void;
	reject(error: Error): void;
}

/** The forward for one remote. Owned by the manager; callers hold leases. */
class RemoteForward {
	refs = 0;
	private remote: SshRemoteConfig;
	private current: SshForwardState = { status: 'starting' };
	private readonly listeners = new Set<(state: SshForwardState) => void>();
	private waiters: Waiter[] = [];
	private child: ChildProcess | undefined;
	/** Settles when the last forward process this instance stopped has exited. */
	private childExit: Promise<void> = Promise.resolve();
	/**
	 * The attempt chain. Each attempt waits for the one before it to return, so
	 * a restart during a discovery never dials while that discovery's ssh runs.
	 */
	private running: Promise<void>;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	/** Bumped by every stop and restart, so a stale attempt drops its result. */
	private generation = 0;
	private attempts = 0;
	private upSince: number | undefined;
	private stopped = false;

	constructor(
		remote: SshRemoteConfig,
		private readonly options: ResolvedOptions,
		/** A predecessor for the same remote that is still stopping. */
		after: Promise<void>
	) {
		this.remote = remote;
		this.running = after;
	}

	state(): SshForwardState {
		return this.current;
	}

	updateRemote(remote: SshRemoteConfig): void {
		this.remote = remote;
	}

	onChange(listener: (state: SshForwardState) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	ready(): Promise<ForwardedHostEndpoint> {
		const state = this.current;
		if (state.status === 'up') return Promise.resolve(state.endpoint);
		if (state.status === 'down') return Promise.reject(state.error);
		if (state.status === 'stopped') {
			return Promise.reject(new Error('The SSH forward was stopped.'));
		}
		return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
	}

	start(): void {
		const generation = ++this.generation;
		this.running = this.running.then(() => this.run(generation));
	}

	restart(): void {
		if (this.stopped) return;
		this.clearRetry();
		this.attempts = 0;
		this.start();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.generation++;
		this.clearRetry();
		await this.stopChild();
		// An attempt in flight returns once it sees it is stale; a discovery
		// still holds its ssh until then.
		await this.running;
		await this.stopChild();
		this.setState({ status: 'stopped' });
		this.listeners.clear();
	}

	private setState(state: SshForwardState): void {
		this.current = state;
		if (state.status === 'up') {
			for (const waiter of this.waiters.splice(0)) waiter.resolve(state.endpoint);
		} else if (state.status === 'down') {
			for (const waiter of this.waiters.splice(0)) waiter.reject(state.error);
		} else if (state.status === 'stopped') {
			const error = new Error('The SSH forward was stopped.');
			for (const waiter of this.waiters.splice(0)) waiter.reject(error);
		}
		for (const listener of [...this.listeners]) listener(state);
	}

	private clearRetry(): void {
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
	}

	/** Stop the forward process, if any. Resolves once the last one stopped has exited. */
	private stopChild(): Promise<void> {
		const child = this.child;
		this.child = undefined;
		this.upSince = undefined;
		if (child) {
			stopProcess(
				{ child },
				{ from: 'terminate', graceMs: this.options.stopGraceMs, label: 'federation ssh forward' }
			);
			this.childExit = exited(child);
		}
		return this.childExit;
	}

	private backoffDelay(attempt: number): number {
		const { backoffInitialMs, backoffMaxMs } = this.options;
		const base = Math.min(backoffMaxMs, backoffInitialMs * 2 ** (attempt - 1));
		const jitter = 1 + (Math.random() * 0.4 - 0.2);
		return Math.min(backoffMaxMs, Math.round(base * jitter));
	}

	private fail(generation: number, error: Error): void {
		if (generation !== this.generation || this.stopped) return;
		if (this.upSince !== undefined && Date.now() - this.upSince >= this.options.stableAfterMs) {
			this.attempts = 0;
		}
		void this.stopChild();
		const attempt = ++this.attempts;
		const retryInMs = this.backoffDelay(attempt);
		this.setState({ status: 'down', error, attempt, retryInMs });
		this.clearRetry();
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			this.start();
		}, retryInMs);
		this.retryTimer.unref?.();
	}

	private async run(generation: number): Promise<void> {
		const isCurrent = () => generation === this.generation && !this.stopped;
		// A restart replaces the forward that is up, and a retry follows one that
		// is still exiting: either way, the old ssh is gone before the next dial.
		await this.stopChild();
		if (!isCurrent()) return;
		this.setState({ status: 'starting' });

		const remote = this.remote;
		const label = remoteLabel(remote);
		try {
			const host = endpointOf(remote, await this.options.discover(remote));
			if (!isCurrent()) return;
			const localPort = await this.options.allocatePort();
			const sshPath = this.options.sshPath ?? (await resolveSshPath());
			if (!isCurrent()) return;

			const child = this.options.spawn(sshPath, buildSshForwardArgs(remote, localPort, host.port), {
				stdio: ['ignore', 'ignore', 'pipe'],
				windowsHide: true,
				shell: false,
			});
			this.child = child;
			let stderr = '';
			child.stderr?.on('data', (data: Buffer) => {
				const text = data.toString();
				stderr = (stderr + text).slice(-STDERR_TAIL_BYTES);
				if (this.child === child && this.current.status === 'up' && HOST_GONE_PATTERN.test(text)) {
					this.fail(
						generation,
						new SshForwardError(
							'host-gone',
							`The maestro-cli host on ${label} stopped answering on port ${host.port}. Looking for it again.`
						)
					);
				}
			});
			let spawnError: Error | undefined;
			child.once('error', (error) => {
				spawnError = error;
			});
			child.once('exit', (code, signal) => {
				if (this.child !== child || this.current.status !== 'up') return;
				const detail = describeStderr(stderr);
				this.fail(
					generation,
					new SshForwardError(
						'forward-failed',
						`The SSH forward to ${label} ended (${code ?? signal ?? 'unknown'})${detail ? `: ${detail}` : '.'}`
					)
				);
			});

			const listening = await this.options.waitForPort(localPort, {
				timeoutMs: this.options.readyTimeoutMs,
				shouldStop: () => !isCurrent() || !isRunning(child) || spawnError !== undefined,
			});
			if (!isCurrent()) return;
			if (!listening) {
				const detail = spawnError ? spawnError.message : describeStderr(stderr);
				throw new SshForwardError(
					'forward-failed',
					isRunning(child) && !spawnError
						? `The SSH forward to ${label} did not start listening within ${Math.round(this.options.readyTimeoutMs / 1000)}s.`
						: `The SSH forward to ${label} failed${detail ? `: ${detail}` : '.'}`
				);
			}

			this.upSince = Date.now();
			this.setState({
				status: 'up',
				endpoint: { ...host, port: localPort, remotePort: host.port },
			});
		} catch (error) {
			this.fail(generation, error instanceof Error ? error : new Error(String(error)));
		}
	}
}

/**
 * Hands out leases on per-remote SSH forwards. One manager per process: get it
 * with `getSshForwardManager()`; tests build their own with injected seams.
 */
export class SshForwardManager {
	private readonly forwards = new Map<string, RemoteForward>();
	/** Forwards whose last lease went away and whose ssh has not exited yet. */
	private readonly stopping = new Map<string, Promise<void>>();
	private readonly options: ResolvedOptions;
	private disposed = false;

	constructor(options: SshForwardManagerOptions = {}) {
		this.options = {
			discover: options.discover ?? ((remote) => discoverRemoteHost(remote)),
			spawn: options.spawn ?? ((command, args, opts) => nodeSpawn(command, [...args], opts)),
			sshPath: options.sshPath,
			allocatePort: options.allocatePort ?? (() => availableLocalPort()),
			waitForPort: options.waitForPort ?? waitForLocalPort,
			readyTimeoutMs: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
			backoffInitialMs: options.backoffInitialMs ?? DEFAULT_BACKOFF_INITIAL_MS,
			backoffMaxMs: options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS,
			stableAfterMs: options.stableAfterMs ?? DEFAULT_STABLE_AFTER_MS,
			stopGraceMs: options.stopGraceMs ?? BACKGROUND_STOP_GRACE_MS,
		};
	}

	/**
	 * A lease on `remote`'s forward, starting it when this is the first. A
	 * later acquire with an edited record for the same remote id keeps the
	 * running forward and uses the new record from its next (re)start.
	 */
	acquire(remote: SshRemoteConfig): SshForwardLease {
		if (this.disposed) throw new Error('The SSH forward manager was disposed.');
		let forward = this.forwards.get(remote.id);
		if (forward) {
			forward.updateRemote(remote);
		} else {
			forward = new RemoteForward(
				remote,
				this.options,
				this.stopping.get(remote.id) ?? Promise.resolve()
			);
			this.forwards.set(remote.id, forward);
			forward.start();
		}
		forward.refs++;
		return this.leaseOn(remote.id, forward);
	}

	/** Remote ids with a live forward. */
	activeRemoteIds(): string[] {
		return [...this.forwards.keys()];
	}

	/** Stop every forward. Later acquires throw. */
	async dispose(): Promise<void> {
		this.disposed = true;
		const forwards = [...this.forwards.values()];
		this.forwards.clear();
		await Promise.all([...forwards.map((forward) => forward.stop()), ...this.stopping.values()]);
	}

	private leaseOn(remoteId: string, forward: RemoteForward): SshForwardLease {
		let released = false;
		const unsubscribes = new Set<() => void>();
		return {
			remoteId,
			state: () => forward.state(),
			ready: () => forward.ready(),
			onChange: (listener) => {
				const unsubscribe = forward.onChange(listener);
				unsubscribes.add(unsubscribe);
				return () => {
					unsubscribes.delete(unsubscribe);
					unsubscribe();
				};
			},
			restart: () => {
				if (!released) forward.restart();
			},
			release: async () => {
				if (released) return;
				released = true;
				for (const unsubscribe of unsubscribes) unsubscribe();
				unsubscribes.clear();
				if (--forward.refs > 0) return;
				if (this.forwards.get(remoteId) === forward) this.forwards.delete(remoteId);
				const stop = forward.stop().finally(() => {
					if (this.stopping.get(remoteId) === stop) this.stopping.delete(remoteId);
				});
				this.stopping.set(remoteId, stop);
				await stop;
			},
		};
	}
}

let shared: SshForwardManager | undefined;

/** The process-wide manager, created on first use so nothing runs before a caller needs it. */
export function getSshForwardManager(): SshForwardManager {
	shared ??= new SshForwardManager();
	return shared;
}

/** Stop the process-wide manager's forwards and forget it (feature switched off, process exit). */
export async function disposeSshForwardManager(): Promise<void> {
	const manager = shared;
	shared = undefined;
	await manager?.dispose();
}
