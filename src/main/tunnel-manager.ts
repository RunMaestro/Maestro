import { ChildProcess, spawn } from 'child_process';
import { logger } from './utils/logger';
import { getCloudflaredPath, isCloudflaredInstalled } from './utils/cliDetection';

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

class TunnelManager {
	private process: ChildProcess | null = null;
	private url: string | null = null;
	private error: string | null = null;

	async start(port: number): Promise<TunnelResult> {
		// Validate port number
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			return { success: false, error: `Invalid port number: ${port}` };
		}

		// Stop any existing tunnel first
		await this.stop();

		// Ensure cloudflared is installed and get its path
		const installed = await isCloudflaredInstalled();
		if (!installed) {
			return { success: false, error: 'cloudflared is not installed' };
		}

		const cloudflaredBinary = getCloudflaredPath() || 'cloudflared';

		return new Promise((resolve) => {
			logger.info(
				`Starting cloudflared tunnel for port ${port} using ${cloudflaredBinary}`,
				'TunnelManager'
			);

			this.process = spawn(cloudflaredBinary, ['tunnel', '--url', `http://localhost:${port}`]);

			let resolved = false;
			let stderrBuffer = '';

			// Timeout after 30 seconds
			const timeout = setTimeout(() => {
				if (!resolved) {
					resolved = true;
					logger.error('Tunnel startup timed out', 'TunnelManager');
					this.stop();
					resolve({ success: false, error: 'Tunnel startup timed out (30s)' });
				}
			}, 30000);

			// Cloudflare outputs the URL to stderr
			// Accumulate buffer in case URL is split across chunks
			this.process.stderr?.on('data', (data: Buffer) => {
				const output = data.toString();
				stderrBuffer += output;
				logger.info(`cloudflared output: ${output}`, 'TunnelManager');

				// Look for the trycloudflare.com URL in accumulated buffer
				const urlMatch = stderrBuffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
				if (urlMatch && !resolved) {
					this.url = urlMatch[0];
					clearTimeout(timeout);
					resolved = true;
					logger.info(`Tunnel established: ${this.url}`, 'TunnelManager');
					resolve({ success: true, url: this.url });
				}
			});

			this.process.on('error', (err) => {
				clearTimeout(timeout);
				if (!resolved) {
					resolved = true;
					this.error = `Failed to start cloudflared: ${err.message}`;
					logger.error(this.error, 'TunnelManager');
					resolve({ success: false, error: this.error });
				}
			});

			this.process.on('exit', (code) => {
				logger.info(`cloudflared exited with code ${code}`, 'TunnelManager');
				if (!resolved) {
					resolved = true;
					clearTimeout(timeout);
					this.error = `cloudflared exited unexpectedly (code ${code})`;
					resolve({ success: false, error: this.error });
				}
				// Only clear process reference on exit, not URL
				// URL is cleared explicitly in stop() to preserve it for display
				this.process = null;
			});
		});
	}

	async stop(): Promise<void> {
		if (this.process) {
			logger.info('Stopping tunnel', 'TunnelManager');
			const proc = this.process;
			proc.kill('SIGTERM');

			// Wait for process to exit with timeout
			await new Promise<void>((resolve) => {
				const timeout = setTimeout(() => {
					// Force kill if SIGTERM didn't work
					try {
						proc.kill('SIGKILL');
					} catch {
						// Process may already be dead
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
