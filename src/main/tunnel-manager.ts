import { ChildProcess, spawn, execFileSync } from 'child_process';
import { logger } from './utils/logger';
import { getCloudflaredPath, isCloudflaredInstalled, getExpandedEnv } from './utils/cliDetection';
import { isWindows } from '../shared/platformDetection';

export interface TunnelStatus {
	isRunning: boolean;
	url: string | null;
	error: string | null;
}

export interface TunnelResult {
	success: boolean;
	url?: string;
	error?: string;
}

// Supervision tuning. Quick tunnels (trycloudflare.com) are ephemeral: Cloudflare
// tears them down on network changes, Wi-Fi roams, and sleep/wake, and the process
// exits. Without a supervisor the app is left displaying a dead hostname that no
// longer resolves (ERR_NAME_NOT_RESOLVED). We respawn with exponential backoff and
// give up only after a run of consecutive failures (e.g. cloudflared removed).
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const MAX_CONSECUTIVE_FAILURES = 6;
const STARTUP_TIMEOUT_MS = 30000;

class TunnelManager {
	private process: ChildProcess | null = null;
	private url: string | null = null;
	private error: string | null = null;
	private stopping = false;

	// Supervision state. When `supervise` is true, an unexpected process exit
	// triggers an automatic restart. `stop()` clears it so a user-initiated stop
	// stays stopped.
	private supervise = false;
	private supervisedPort: number | null = null;
	private restartTimer: NodeJS.Timeout | null = null;
	private backoffMs = INITIAL_BACKOFF_MS;
	private consecutiveFailures = 0;

	async start(port: number): Promise<TunnelResult> {
		// Validate port number
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			return { success: false, error: `Invalid port number: ${port}` };
		}

		// Stop any existing tunnel first (also cancels supervision + timers)
		await this.stop();

		// Ensure cloudflared is installed and get its path
		const installed = await isCloudflaredInstalled();
		if (!installed) {
			return { success: false, error: 'cloudflared is not installed' };
		}

		// Enable supervision for this port before the first spawn so an early
		// death (network flap during startup) is retried rather than left dead.
		this.supervise = true;
		this.supervisedPort = port;
		this.backoffMs = INITIAL_BACKOFF_MS;
		this.consecutiveFailures = 0;

		return this.spawnTunnel(port);
	}

	/**
	 * Spawn a single cloudflared quick tunnel for `port`. Resolves once the
	 * trycloudflare.com URL is parsed (success) or on timeout/early-exit
	 * (failure). Unexpected exits while supervising trigger an automatic
	 * restart via the exit handler; the returned promise reflects only this
	 * individual attempt.
	 */
	private spawnTunnel(port: number): Promise<TunnelResult> {
		const cloudflaredBinary = getCloudflaredPath() || 'cloudflared';

		return new Promise((resolve) => {
			this.stopping = false;
			logger.info(
				`Starting cloudflared tunnel for port ${port} using ${cloudflaredBinary}`,
				'TunnelManager'
			);

			// Pass the expanded env so the fallback bare 'cloudflared' name resolves
			// even when the app was launched from the Dock (no shell PATH). The
			// absolute path from detection already works; this is belt-and-braces.
			this.process = spawn(
				cloudflaredBinary,
				['tunnel', '--url', `http://localhost:${port}`, '--protocol', 'http2'],
				{ env: getExpandedEnv() }
			);

			let resolved = false;
			let outputBuffer = '';

			// Timeout after STARTUP_TIMEOUT_MS
			const timeout = setTimeout(() => {
				if (!resolved) {
					resolved = true;
					logger.error('Tunnel startup timed out', 'TunnelManager');
					// Kill just this process; the exit handler decides whether to
					// schedule a supervised restart. Do NOT call stop() here - that
					// would cancel supervision.
					this.killCurrentProcess();
					resolve({ success: false, error: 'Tunnel startup timed out (30s)' });
				}
			}, STARTUP_TIMEOUT_MS);

			const handleOutput = (data: Buffer) => {
				const output = data.toString();
				outputBuffer += output;
				logger.info(`cloudflared output: ${output}`, 'TunnelManager');

				// Look for the trycloudflare.com URL in accumulated buffer
				const urlMatch = outputBuffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
				if (urlMatch && !resolved) {
					this.url = urlMatch[0];
					this.error = null;
					// A fresh URL means the tunnel established - reset backoff so a
					// later drop recovers quickly instead of inheriting stale delay.
					this.consecutiveFailures = 0;
					this.backoffMs = INITIAL_BACKOFF_MS;
					clearTimeout(timeout);
					resolved = true;
					this.process?.stderr?.off('data', handleOutput);
					this.process?.stdout?.off('data', handleOutput);
					logger.info(`Tunnel established: ${this.url}`, 'TunnelManager');
					resolve({ success: true, url: this.url });
				}
			};

			// cloudflared outputs the URL to stderr, but also listen on stdout as a fallback
			this.process.stderr?.on('data', handleOutput);
			this.process.stdout?.on('data', handleOutput);

			this.process.on('error', (err) => {
				clearTimeout(timeout);
				if (!resolved) {
					resolved = true;
					this.error = `Failed to start cloudflared: ${err.message}`;
					logger.error(this.error, 'TunnelManager');
					resolve({ success: false, error: this.error });
				}
				// If already resolved, an 'exit' will follow and drive supervision.
			});

			this.process.on('exit', (code) => {
				logger.info(`cloudflared exited with code ${code}`, 'TunnelManager');
				if (!resolved) {
					resolved = true;
					clearTimeout(timeout);
					this.error = `cloudflared exited unexpectedly (code ${code})`;
					resolve({ success: false, error: this.error });
				} else if (!this.stopping) {
					this.error = `cloudflared exited unexpectedly (code ${code})`;
					logger.error(this.error, 'TunnelManager');
				}

				const wasStopping = this.stopping;
				this.process = null;
				this.stopping = false;

				// Unexpected exit while supervising: the stale URL is now invalid
				// (its DNS record is gone), so clear it and schedule a restart.
				if (this.supervise && !wasStopping) {
					this.url = null;
					this.onUnexpectedExit();
				}
			});
		});
	}

	/** Increment failure count and schedule a restart, or give up after too many. */
	private onUnexpectedExit(): void {
		this.consecutiveFailures += 1;
		if (this.consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
			this.error = `Tunnel failed to reconnect after ${MAX_CONSECUTIVE_FAILURES} attempts`;
			logger.error(this.error, 'TunnelManager');
			this.supervise = false;
			this.supervisedPort = null;
			return;
		}
		this.scheduleRestart();
	}

	/** Schedule one delayed respawn with exponential backoff. */
	private scheduleRestart(): void {
		if (this.restartTimer || !this.supervise || this.supervisedPort === null) {
			return;
		}
		const delay = this.backoffMs;
		this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
		logger.info(
			`Scheduling tunnel restart in ${delay}ms (failure ${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
			'TunnelManager'
		);
		this.restartTimer = setTimeout(() => {
			this.restartTimer = null;
			if (!this.supervise || this.supervisedPort === null) {
				return;
			}
			// Fire and forget: success resets counters in handleOutput; failure
			// exits and re-enters onUnexpectedExit via the exit handler.
			void this.spawnTunnel(this.supervisedPort);
		}, delay);
	}

	/** Kill the current cloudflared process without touching supervision state. */
	private killCurrentProcess(): void {
		const proc = this.process;
		if (!proc) return;
		if (isWindows() && proc.pid) {
			try {
				execFileSync('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { timeout: 5000 });
			} catch {
				// Already dead - fine.
			}
		} else {
			try {
				proc.kill('SIGTERM');
			} catch {
				// Already dead - fine.
			}
		}
	}

	async stop(): Promise<void> {
		// Cancel supervision first so the impending exit is treated as intentional.
		this.supervise = false;
		this.supervisedPort = null;
		this.backoffMs = INITIAL_BACKOFF_MS;
		this.consecutiveFailures = 0;
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}

		if (this.process) {
			logger.info('Stopping tunnel', 'TunnelManager');
			this.stopping = true;
			const proc = this.process;

			if (isWindows() && proc.pid) {
				// On Windows, POSIX signals don't terminate process trees.
				// Use taskkill /t /f synchronously to ensure the process tree is
				// dead before the app exits (stop() is called during shutdown).
				try {
					execFileSync('taskkill', ['/pid', String(proc.pid), '/t', '/f'], {
						timeout: 5000,
					});
				} catch {
					// taskkill returns non-zero if the process is already dead, which is fine
				}
			} else {
				proc.kill('SIGTERM');
			}

			// Wait for process to exit with timeout
			await new Promise<void>((resolve) => {
				const timeout = setTimeout(() => {
					// Force kill if SIGTERM didn't work (POSIX only; Windows already used taskkill)
					if (!isWindows()) {
						try {
							proc.kill('SIGKILL');
						} catch {
							// Process may already be dead
						}
					}
					resolve();
				}, 3000);

				proc.once('exit', () => {
					clearTimeout(timeout);
					resolve();
				});
			});

			this.process = null;
		}
		this.stopping = false;
		this.url = null;
		this.error = null;
	}

	getStatus(): TunnelStatus {
		return {
			isRunning: this.process !== null && this.url !== null,
			url: this.url,
			error: this.error,
		};
	}
}

export const tunnelManager = new TunnelManager();
