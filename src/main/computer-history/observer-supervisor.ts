/**
 * Computer History - supervisor for the `maestro-observer` helper.
 *
 * The helper is a long-lived child of the main process (never detached, so it
 * dies with the app; it also exits within 1 s of stdin EOF). Argv is FIXED:
 * nothing user- or plugin-controlled reaches the command line. All control
 * goes over stdin as NDJSON commands; all data comes back as NDJSON events on
 * stdout; stderr is diagnostics only and is never parsed.
 *
 * Restart policy copies PianolaSupervisor: exponential backoff from 1 s,
 * capped at 30 s, giving up after 5 consecutive failures; a run of 60 s or
 * more resets the streak. A missing binary is a reported state
 * (`binary-missing`), not an exception: dev checkouts without the Rust
 * toolchain must still boot.
 *
 * Hostile-output guard: a line longer than `maxLineBytes` is discarded up to
 * its newline instead of growing a buffer without bound.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import type { HelperCommand } from '../../shared/computer-history/types';
import type {
	ObserverProcessState,
	ObserverProcessStatus,
} from '../../shared/computer-history/status';

const MAX_RESTARTS = 5;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;
const STABLE_RUN_MS = 60_000;
const SIGKILL_DELAY_MS = 3000;
const MAX_STDERR_LINES = 50;
/** Snapshots are capped at 32 KB of text; JSON escaping can roughly double it. */
export const DEFAULT_MAX_LINE_BYTES = 256 * 1024;

export const OBSERVER_BINARY_BASENAME = 'maestro-observer';

export type ObserverChildSpawner = (
	command: string,
	args: readonly string[],
	opts: SpawnOptions
) => ChildProcess;

export interface ObserverSupervisorDeps {
	/** Absolute path of the helper, or null when none is installed. */
	resolveBinary: () => string | null;
	/** One parsed JSON value per stdout line. */
	onMessage: (message: unknown) => void;
	/** The child is up; the caller sends `configure` here. */
	onSpawned?: () => void;
	/** Any state transition (for status broadcasts). */
	onStateChange?: () => void;
	spawnChild?: ObserverChildSpawner;
	maxLineBytes?: number;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/** Platform/arch folder name the build script writes into. */
export function observerPlatformDir(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch
): string {
	return `${platform}-${arch}`;
}

export function observerBinaryName(platform: NodeJS.Platform = process.platform): string {
	return platform === 'win32' ? `${OBSERVER_BINARY_BASENAME}.exe` : OBSERVER_BINARY_BASENAME;
}

/**
 * Candidate helper locations, most specific first:
 * packaged `resources/native/`, then the dev build output
 * `dist/native/<platform>-<arch>/` (relative to this module and to cwd), then
 * a local cargo release build.
 */
export function observerBinaryCandidates(opts: {
	resourcesPath?: string;
	moduleDir: string;
	cwd: string;
	platform?: NodeJS.Platform;
	arch?: string;
}): string[] {
	const name = observerBinaryName(opts.platform);
	const dir = observerPlatformDir(opts.platform, opts.arch);
	const out: string[] = [];
	if (opts.resourcesPath) out.push(path.join(opts.resourcesPath, 'native', name));
	// dist/main/computer-history/*.js -> dist/native/<platform>-<arch>/
	out.push(path.resolve(opts.moduleDir, '..', '..', 'native', dir, name));
	out.push(path.resolve(opts.cwd, 'dist', 'native', dir, name));
	out.push(path.resolve(opts.cwd, 'native', 'maestro-observer', 'target', 'release', name));
	return out;
}

/** First candidate that exists and (on POSIX) is executable, or null. */
export function resolveObserverBinary(candidates: readonly string[]): string | null {
	const mode = process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK;
	for (const candidate of candidates) {
		try {
			fs.accessSync(candidate, mode);
			if (fs.statSync(candidate).isFile()) return candidate;
		} catch {
			continue;
		}
	}
	return null;
}

export class ObserverSupervisor {
	private readonly deps: ObserverSupervisorDeps;
	private readonly spawnChild: ObserverChildSpawner;
	private readonly maxLineBytes: number;
	private child: ChildProcess | null = null;
	private state: ObserverProcessState = 'stopped';
	private restarts = 0;
	private lastError: string | undefined;
	private startedAt: number | undefined;
	private binaryPath: string | null = null;
	private backoffTimer: ReturnType<typeof setTimeout> | undefined;
	private stderr: string[] = [];
	private wanted = false;
	private stdoutBuffer = '';
	private discarding = false;

	constructor(deps: ObserverSupervisorDeps) {
		this.deps = deps;
		this.spawnChild = deps.spawnChild ?? ((command, args, opts) => spawn(command, args, opts));
		this.maxLineBytes = deps.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
	}

	/** Start (or keep) the helper running. Idempotent. */
	start(): void {
		this.wanted = true;
		if (this.child || this.state === 'backing-off') return;
		this.restarts = 0;
		this.spawn();
	}

	/** Stop the helper and cancel any pending restart. Idempotent. */
	stop(): void {
		this.wanted = false;
		if (this.backoffTimer) {
			clearTimeout(this.backoffTimer);
			this.backoffTimer = undefined;
		}
		const child = this.child;
		this.child = null;
		if (child && child.exitCode === null && child.signalCode === null) {
			// Ask nicely (the helper exits on `shutdown` or stdin EOF), then make sure.
			try {
				child.stdin?.write(`${JSON.stringify({ cmd: 'shutdown' } satisfies HelperCommand)}\n`);
				child.stdin?.end();
			} catch {
				// stdin already closed; the kill below covers it.
			}
			const timer = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
			}, SIGKILL_DELAY_MS);
			timer.unref?.();
			child.once('exit', () => clearTimeout(timer));
		}
		this.setState('stopped');
	}

	/** Write one command to the helper. False when it is not running. */
	send(command: HelperCommand): boolean {
		const stdin = this.child?.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable) return false;
		stdin.write(`${JSON.stringify(command)}\n`);
		return true;
	}

	isRunning(): boolean {
		return this.child !== null && this.state === 'running';
	}

	status(): ObserverProcessStatus {
		const out: ObserverProcessStatus = {
			state: this.state,
			restarts: this.restarts,
			binaryPath: this.binaryPath,
			recentStderr: [...this.stderr],
		};
		if (typeof this.child?.pid === 'number') out.pid = this.child.pid;
		if (this.lastError) out.lastError = this.lastError;
		if (this.startedAt) out.startedAt = this.startedAt;
		return out;
	}

	private setState(state: ObserverProcessState): void {
		if (this.state === state) return;
		this.state = state;
		this.deps.onStateChange?.();
	}

	private spawn(): void {
		const binary = this.deps.resolveBinary();
		this.binaryPath = binary;
		if (!binary) {
			this.lastError = 'maestro-observer is not installed for this platform';
			this.setState('binary-missing');
			return;
		}
		let child: ChildProcess;
		try {
			child = this.spawnChild(binary, [], {
				stdio: ['pipe', 'pipe', 'pipe'],
				windowsHide: true,
				// Not detached: the helper must die with the app.
			});
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			this.scheduleRestart();
			return;
		}
		this.child = child;
		this.startedAt = Date.now();
		this.stdoutBuffer = '';
		this.discarding = false;
		this.setState('running');

		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (chunk: string) => this.onStderr(chunk));
		// EPIPE on a dying child's stdin must not crash the main process.
		child.stdin?.on('error', (err) => {
			this.deps.log?.('warn', `observer stdin error: ${err.message}`);
		});
		child.on('error', (err) => {
			this.lastError = err.message;
			this.deps.log?.('warn', `observer process error: ${err.message}`);
			// 'exit' may never follow a spawn failure (ENOENT, EACCES).
			if (this.child === child && child.pid === undefined) {
				this.child = null;
				this.scheduleRestart();
			}
		});
		child.on('exit', (code, signal) => {
			if (this.child !== child) return; // stop() already let go of it
			this.child = null;
			this.flushStdout();
			if (!this.wanted) {
				this.setState('stopped');
				return;
			}
			if (this.startedAt && Date.now() - this.startedAt >= STABLE_RUN_MS) this.restarts = 0;
			this.lastError = signal ? `killed by signal ${signal}` : `exited with code ${code ?? 'null'}`;
			this.deps.log?.('warn', `maestro-observer ${this.lastError}`);
			this.scheduleRestart();
		});

		this.deps.onSpawned?.();
	}

	private scheduleRestart(): void {
		if (!this.wanted) {
			this.setState('stopped');
			return;
		}
		this.restarts += 1;
		if (this.restarts > MAX_RESTARTS) {
			this.setState('failed');
			this.deps.log?.('error', `maestro-observer failed after ${MAX_RESTARTS} restarts; giving up`);
			return;
		}
		const delay = Math.min(BACKOFF_BASE_MS * 2 ** (this.restarts - 1), BACKOFF_CAP_MS);
		this.setState('backing-off');
		this.backoffTimer = setTimeout(() => {
			this.backoffTimer = undefined;
			if (!this.wanted) {
				this.setState('stopped');
				return;
			}
			this.spawn();
		}, delay);
	}

	private onStdout(chunk: string): void {
		let data = chunk;
		while (data.length > 0) {
			const nl = data.indexOf('\n');
			if (this.discarding) {
				if (nl === -1) return;
				this.discarding = false;
				data = data.slice(nl + 1);
				continue;
			}
			if (nl === -1) {
				this.stdoutBuffer += data;
				if (this.stdoutBuffer.length > this.maxLineBytes) {
					this.deps.log?.('warn', 'observer line exceeded the length cap; discarded');
					this.stdoutBuffer = '';
					this.discarding = true;
				}
				return;
			}
			const line = this.stdoutBuffer + data.slice(0, nl);
			this.stdoutBuffer = '';
			data = data.slice(nl + 1);
			if (line.length > this.maxLineBytes) {
				this.deps.log?.('warn', 'observer line exceeded the length cap; discarded');
				continue;
			}
			this.dispatchLine(line);
		}
	}

	private flushStdout(): void {
		const rest = this.stdoutBuffer;
		this.stdoutBuffer = '';
		if (rest && !this.discarding) this.dispatchLine(rest);
		this.discarding = false;
	}

	private dispatchLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			this.deps.log?.('warn', 'observer emitted a line that is not JSON; ignored');
			return;
		}
		this.deps.onMessage(parsed);
	}

	private onStderr(chunk: string): void {
		for (const line of chunk.split('\n')) {
			if (!line.trim()) continue;
			this.stderr.push(line.length > 500 ? `${line.slice(0, 500)}...` : line);
		}
		if (this.stderr.length > MAX_STDERR_LINES) {
			this.stderr = this.stderr.slice(this.stderr.length - MAX_STDERR_LINES);
		}
	}
}
