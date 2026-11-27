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
 * **The forward is a private ControlMaster.** ssh offers no way to drop the
 * `LocalForward` / `DynamicForward` / `RemoteForward` lines the user's ssh
 * config sets for a host but keep a command-line `-L`: `ClearAllForwardings=yes`
 * runs after all parsing and removes the `-L` too. With `no`, every config
 * forward rides along, so a VNC `LocalForward` whose port another ssh holds
 * breaks the forward, and while Maestro's always-on forward holds that port,
 * the user's own tunnel cannot bind it. So the forward runs in two steps:
 *
 * 1. `ssh -N -o ClearAllForwardings=yes -o ControlMaster=yes -S <socket>`
 *    (`buildSshForwardMasterArgs()`) opens the connection with no forwards.
 *    The socket sits in a private 0700 directory made for this one forward
 *    (`createForwardControlSocket()`), never the user's `~/.ssh` masters:
 *    tailcat remotes fail when two connections share one.
 * 2. Once `ssh -O check` answers, `ssh -F none -S <socket> -O forward -L ...`
 *    (`buildSshMuxArgs()`) adds Maestro's port at runtime. A runtime forward
 *    is not subject to `ClearAllForwardings`, and the request exits non-zero
 *    when the bind fails. `-F none` keeps the config forwards out of the
 *    request itself. These requests talk to the local socket only and never
 *    dial the remote, so they do not break the one-ssh-per-remote rule.
 *
 * The master is the supervised process: stopping it ends the forward, and the
 * socket directory goes with it.
 *
 * Windows OpenSSH has no ControlMaster. There the forward stays one process
 * (`buildSshForwardArgs()`: `ClearAllForwardings=no`, `-L`,
 * `ExitOnForwardFailure=no`), so a config forward still rides along on
 * Windows: a config forward that cannot bind is only a warning, and the
 * forward fails when ssh says its OWN port could not bind
 * (`ownForwardBindFailed()`), or that port never starts listening.
 *
 * Nothing here runs until a caller acquires a lease, so a remote that opted
 * out of Federation never gets a process. The caller checks the remote's own
 * `federation` flag (`isFederationRemote()`) before acquiring.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';

import { isWindows } from '../../platformDetection';
import { redactSecrets } from '../../redactSecrets';
import { buildSshConnectionArgs, describeSshConnectionError } from '../../sshConnection';
import type { SshRemoteConfig } from '../../types';
import { BACKGROUND_STOP_GRACE_MS, stopProcess } from '../control/termination';
import { execFileNoThrow, type ExecResult } from '../launch/exec-file';
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
	/**
	 * The retry delay ceiling of this remote's forward while it stays down, in place of the
	 * manager's `backoffMaxMs`: a longer one for a host nothing on this machine uses, so a host that
	 * stays down is dialed less and less often. `undefined` is the manager's own again; a forward
	 * waiting longer than that then dials at once. Optional: a caller's own lease may not have it.
	 */
	setBackoffCeiling?(ms: number | undefined): void;
	/** Drop this lease. The forward stops with the last one. Safe to call twice. */
	release(): Promise<void>;
}

export type SshForwardSpawn = (
	command: string,
	args: readonly string[],
	options: { stdio: ['ignore', 'ignore', 'pipe']; windowsHide: true; shell: false }
) => ChildProcess;

/** A private directory holding one forward's ControlMaster socket. */
export interface ForwardControlSocket {
	/** The socket path, handed to ssh with `-S`. */
	readonly path: string;
	/** Remove the socket and its directory. */
	dispose(): Promise<void>;
}

/** Runs one `ssh -O` request against a forward's master. */
export type SshForwardControl = (
	command: string,
	args: readonly string[]
) => Promise<Pick<ExecResult, 'exitCode' | 'stderr'>>;

export interface SshForwardManagerOptions {
	/**
	 * Run a private ControlMaster and add the forward through it (see the header).
	 * Default: everywhere but Windows, whose OpenSSH has no ControlMaster.
	 */
	useControlMaster?: boolean;
	/** Default `createForwardControlSocket()`. */
	controlSocket?: () => Promise<ForwardControlSocket>;
	/** Default `execFileNoThrow()` with a 10 s timeout. */
	control?: SshForwardControl;
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
/** Pause between `ssh -O check` probes while the master connects. */
const MASTER_POLL_MS = 250;
/** One `ssh -O` request talks to a local socket; it never needs long. */
const CONTROL_TIMEOUT_MS = 10_000;
/**
 * The longest control socket path that fits a unix socket address: macOS caps it at 104 bytes,
 * and the master first binds `<path>.<16 random characters>`, then renames it.
 */
const MAX_CONTROL_PATH_LENGTH = 104 - 18;

/** What ssh logs when a forwarded connection finds nothing listening on the remote port. */
const HOST_GONE_PATTERN = /open failed: connect failed/i;

/** The ports ssh names when a local forward cannot bind: `bind [addr]:port` and `cannot listen to port: port`. */
const BIND_FAILURE_PATTERN = /\bbind \[[^\]]*\]:(\d+)|cannot listen to port: (\d+)/gi;

/**
 * Whether ssh's stderr says the forward's own local port could not bind. A bind failure on any
 * other port belongs to a `LocalForward` in the user's ssh config and does not stop the forward.
 */
export function ownForwardBindFailed(stderr: string, localPort: number): boolean {
	for (const match of stderr.matchAll(BIND_FAILURE_PATTERN)) {
		if (Number(match[1] ?? match[2]) === localPort) return true;
	}
	return false;
}

function forwardSpec(localPort: number, remotePort: number): string {
	for (const port of [localPort, remotePort]) {
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			throw new Error(`Invalid forward port: ${String(port)}`);
		}
	}
	return `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`;
}

/** Keepalive, unless the remote sets its own `ServerAliveInterval`. */
function keepaliveArgs(remote: SshRemoteConfig): string[] {
	return Object.keys(remote.sshOptions ?? {}).some(
		(key) => key.toLowerCase() === 'serveraliveinterval'
	)
		? []
		: ['-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
}

/** A control path as ssh reads it: ssh expands `%` tokens in it, so a literal `%` is doubled. */
function controlPathArg(controlPath: string): string {
	return controlPath.replace(/%/g, '%%');
}

/**
 * The `ssh` argv (after the binary) for a forward's private ControlMaster: the connection to
 * `remote` with no forwards at all, listening for requests on `controlPath`. The forward's own
 * options come first: ssh applies `-o` first-wins, so they hold against the remote's overrides,
 * and `-S` beats any `ControlPath` the remote or its ssh config sets.
 */
export function buildSshForwardMasterArgs(remote: SshRemoteConfig, controlPath: string): string[] {
	return [
		'-N',
		// Drops every forward the user's ssh config sets for the host (see the header).
		'-o',
		'ClearAllForwardings=yes',
		'-o',
		'ControlMaster=yes',
		'-o',
		'ControlPersist=no',
		'-S',
		controlPathArg(controlPath),
		// INFO, so the `open failed: connect failed` that reveals a moved host reaches stderr.
		'-o',
		'LogLevel=INFO',
		...keepaliveArgs(remote),
		...buildSshConnectionArgs(remote),
	];
}

/** A request to a forward's master: is it up, or add the forward. */
export type SshMuxRequest =
	| { op: 'check' }
	| { op: 'forward'; localPort: number; remotePort: number };

/**
 * The `ssh` argv (after the binary) for one request to the master on `controlPath`. `-F none`
 * reads no ssh config: a `-O forward` request carries every forward the config names for the
 * host, and the master already holds the connection, so nothing else in the config applies.
 */
export function buildSshMuxArgs(
	remote: SshRemoteConfig,
	controlPath: string,
	request: SshMuxRequest
): string[] {
	const args = ['-F', 'none', '-S', controlPathArg(controlPath), '-O', request.op];
	if (request.op === 'forward') {
		args.push('-L', forwardSpec(request.localPort, request.remotePort));
	}
	args.push(remote.host);
	return args;
}

/**
 * The single-process `ssh` argv (after the binary) that forwards 127.0.0.1:`localPort` to the
 * remote's 127.0.0.1:`remotePort`, for Windows, whose OpenSSH has no ControlMaster. The
 * forward's own options come first: ssh applies `-o` first-wins, so they hold against the
 * remote's overrides. `ClearAllForwardings=no` keeps the `-L`, so the config's forwards ride
 * along here (see the header).
 */
export function buildSshForwardArgs(
	remote: SshRemoteConfig,
	localPort: number,
	remotePort: number
): string[] {
	const spec = forwardSpec(localPort, remotePort);
	return [
		'-N',
		// A config `LocalForward` that cannot bind must not kill the forward (see the header).
		'-o',
		'ExitOnForwardFailure=no',
		'-o',
		'ClearAllForwardings=no',
		'-o',
		'ControlMaster=no',
		'-o',
		'ControlPath=none',
		// INFO, so the `open failed: connect failed` that reveals a moved host reaches stderr.
		'-o',
		'LogLevel=INFO',
		...keepaliveArgs(remote),
		'-L',
		spec,
		...buildSshConnectionArgs(remote),
	];
}

/**
 * A fresh private directory for one forward's ControlMaster socket, under `baseDir` (default the
 * OS temp folder), or under `/tmp` when that path would be too long for a unix socket.
 */
export async function createForwardControlSocket(
	baseDir = os.tmpdir()
): Promise<ForwardControlSocket> {
	const fits = path.join(baseDir, 'mfwd-XXXXXX', 'ssh').length <= MAX_CONTROL_PATH_LENGTH;
	// mkdtemp creates the directory 0700, so no other user can reach the socket.
	const dir = await mkdtemp(path.join(fits ? baseDir : '/tmp', 'mfwd-'));
	return {
		path: path.join(dir, 'ssh'),
		dispose: () => rm(dir, { recursive: true, force: true }),
	};
}

/**
 * Poll the master on `controlPath` with `ssh -O check` until it answers. False on the timeout or
 * when `shouldStop` says so; the caller tells those apart by its own state.
 */
async function waitForControlMaster(
	control: SshForwardControl,
	sshPath: string,
	args: readonly string[],
	{ timeoutMs, shouldStop }: { timeoutMs: number; shouldStop: () => boolean }
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (shouldStop()) return false;
		if ((await control(sshPath, args)).exitCode === 0) return true;
		if (shouldStop()) return false;
		const delay = Promise.withResolvers<void>();
		setTimeout(delay.resolve, MASTER_POLL_MS);
		await delay.promise;
	}
	return false;
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
	/** The forward's ssh: the ControlMaster, or on Windows the single forwarding process. */
	private child: ChildProcess | undefined;
	/** The master's socket directory, removed once the master has exited. */
	private controlSocket: ForwardControlSocket | undefined;
	/** Settles when the last forward process this instance stopped has exited and its socket is gone. */
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
	/** `SshForwardLease.setBackoffCeiling()`: the retry delay ceiling in place of `backoffMaxMs`. */
	private ceilingMs: number | undefined;

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
		// A forward waiting out a backoff dials now: it reads `starting` at once, so a `ready()`
		// asked right after this waits for that dial instead of rejecting with the last error.
		if (this.current.status === 'down') this.setState({ status: 'starting' });
		this.start();
	}

	setBackoffCeiling(ms: number | undefined): void {
		const ceiling = ms !== undefined && Number.isFinite(ms) && ms > 0 ? ms : undefined;
		if (ceiling === this.ceilingMs) return;
		this.ceilingMs = ceiling;
		// A wait longer than the new ceiling is cut short: the forward dials now.
		const state = this.current;
		if (state.status === 'down' && this.retryTimer && state.retryInMs > this.ceilingFor()) {
			this.restart();
		}
	}

	private ceilingFor(): number {
		return this.ceilingMs ?? this.options.backoffMaxMs;
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

	/**
	 * Stop the forward process, if any, then remove its control socket. Resolves once the last
	 * one stopped has exited and its socket is gone.
	 */
	private stopChild(): Promise<void> {
		const child = this.child;
		const socket = this.controlSocket;
		this.child = undefined;
		this.controlSocket = undefined;
		this.upSince = undefined;
		if (child) {
			stopProcess(
				{ child },
				{ from: 'terminate', graceMs: this.options.stopGraceMs, label: 'federation ssh forward' }
			);
			this.childExit = exited(child);
		}
		if (socket) {
			// `rm` with `force` fails only when the 0700 directory this forward made turned
			// unwritable. A stray directory in the temp folder must not wedge every later restart.
			this.childExit = this.childExit.then(() => socket.dispose().catch(() => undefined));
		}
		return this.childExit;
	}

	private backoffDelay(attempt: number): number {
		const { backoffInitialMs } = this.options;
		const ceiling = this.ceilingFor();
		const base = Math.min(ceiling, backoffInitialMs * 2 ** (attempt - 1));
		const jitter = 1 + (Math.random() * 0.4 - 0.2);
		return Math.min(ceiling, Math.round(base * jitter));
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
			let socket: ForwardControlSocket | undefined;
			if (this.options.useControlMaster) {
				socket = await this.options.controlSocket();
				// Owned from here on: the next stopChild() removes it, current or not.
				this.controlSocket = socket;
				if (!isCurrent()) return;
			}

			const args = socket
				? buildSshForwardMasterArgs(remote, socket.path)
				: buildSshForwardArgs(remote, localPort, host.port);
			const child = this.options.spawn(sshPath, args, {
				stdio: ['ignore', 'ignore', 'pipe'],
				windowsHide: true,
				shell: false,
			});
			this.child = child;
			let stderr = '';
			// Set when ssh says the forward's own port could not bind. Without a master,
			// ExitOnForwardFailure=no keeps ssh up without the forward.
			let ownPortRefused = false;
			child.stderr?.on('data', (data: Buffer) => {
				const text = data.toString();
				stderr = (stderr + text).slice(-STDERR_TAIL_BYTES);
				if (ownForwardBindFailed(stderr, localPort)) ownPortRefused = true;
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

			/** Why the forward did not come up: a timeout while ssh still runs, or what ssh said. */
			const notStarted = (timedOut: string) => {
				const detail = spawnError ? spawnError.message : describeStderr(stderr);
				return new SshForwardError(
					'forward-failed',
					isRunning(child) && !spawnError && !ownPortRefused
						? `The SSH forward to ${label} did not ${timedOut} within ${Math.round(this.options.readyTimeoutMs / 1000)}s.`
						: `The SSH forward to ${label} failed${detail ? `: ${detail}` : '.'}`
				);
			};
			const shouldStop = () =>
				!isCurrent() || !isRunning(child) || spawnError !== undefined || ownPortRefused;

			if (socket) {
				const masterUp = await waitForControlMaster(
					this.options.control,
					sshPath,
					buildSshMuxArgs(remote, socket.path, { op: 'check' }),
					{ timeoutMs: this.options.readyTimeoutMs, shouldStop }
				);
				if (!isCurrent()) return;
				if (!masterUp) throw notStarted('connect');
				const added = await this.options.control(
					sshPath,
					buildSshMuxArgs(remote, socket.path, {
						op: 'forward',
						localPort,
						remotePort: host.port,
					})
				);
				if (!isCurrent()) return;
				if (added.exitCode !== 0) {
					const detail = describeStderr(added.stderr) || `ssh -O forward exited ${added.exitCode}`;
					throw new SshForwardError(
						'forward-failed',
						`The SSH forward to ${label} could not add port ${localPort}: ${detail}`
					);
				}
			}

			const listening = await this.options.waitForPort(localPort, {
				timeoutMs: this.options.readyTimeoutMs,
				shouldStop,
			});
			if (!isCurrent()) return;
			if (!listening || ownPortRefused) throw notStarted('start listening');

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
			useControlMaster: options.useControlMaster ?? !isWindows(),
			controlSocket: options.controlSocket ?? (() => createForwardControlSocket()),
			control:
				options.control ??
				((command, args) =>
					execFileNoThrow(command, [...args], undefined, { timeout: CONTROL_TIMEOUT_MS })),
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
			setBackoffCeiling: (ms) => {
				if (!released) forward.setBackoffCeiling(ms);
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
