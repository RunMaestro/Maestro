/**
 * WakaTime heartbeat manager.
 * Detects wakatime-cli on the user's PATH and sends heartbeats
 * when AI agent activity (query-complete events) occurs.
 *
 * Heartbeats are debounced per session (max 1 per 2 minutes) to match
 * WakaTime's own deduplication window.
 *
 * If the CLI is not found, it is automatically downloaded and installed
 * from GitHub releases to ~/.wakatime/.
 */

import { app } from 'electron';
import { execFileNoThrow } from './utils/execFile';
import { logger } from './utils/logger';
import os from 'os';
import path from 'path';
import fs from 'fs';
import https from 'https';
import type Store from 'electron-store';
import type { MaestroSettings } from './stores/types';

const LOG_CONTEXT = '[WakaTime]';
const HEARTBEAT_DEBOUNCE_MS = 120_000; // 2 minutes - WakaTime deduplicates within this window
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // Check for CLI updates once per day

/** Map Node.js platform to WakaTime release naming */
function getWakaTimePlatform(): string | null {
	switch (process.platform) {
		case 'darwin': return 'darwin';
		case 'win32': return 'windows';
		case 'linux': return 'linux';
		default: return null;
	}
}

/** Map Node.js arch to WakaTime release naming */
function getWakaTimeArch(): string | null {
	switch (process.arch) {
		case 'arm64': return 'arm64';
		case 'x64': return 'amd64';
		case 'ia32': return '386';
		default: return null;
	}
}

/** Download a URL to a file, following redirects (GitHub → S3) */
function downloadFile(url: string, destPath: string, maxRedirects = 5): Promise<void> {
	return new Promise((resolve, reject) => {
		if (maxRedirects <= 0) {
			reject(new Error('Too many redirects'));
			return;
		}
		https.get(url, (response) => {
			// Follow redirects (GitHub releases redirect to S3)
			if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
				response.resume(); // consume response to free up memory
				downloadFile(response.headers.location, destPath, maxRedirects - 1).then(resolve, reject);
				return;
			}

			if (response.statusCode !== 200) {
				response.resume();
				reject(new Error(`Download failed with status ${response.statusCode}`));
				return;
			}

			const fileStream = fs.createWriteStream(destPath);
			response.pipe(fileStream);
			fileStream.on('finish', () => {
				fileStream.close();
				resolve();
			});
			fileStream.on('error', (err) => {
				fs.unlink(destPath, () => {}); // clean up partial file
				reject(err);
			});
		}).on('error', reject);
	});
}

/** Fetch JSON from a URL, following redirects */
function fetchJson(url: string, maxRedirects = 5): Promise<unknown> {
	return new Promise((resolve, reject) => {
		if (maxRedirects <= 0) {
			reject(new Error('Too many redirects'));
			return;
		}
		const parsedUrl = new URL(url);
		const options = {
			hostname: parsedUrl.hostname,
			path: parsedUrl.pathname + parsedUrl.search,
			headers: { 'User-Agent': 'maestro-wakatime' },
		};
		https.get(options, (response) => {
			if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
				response.resume();
				fetchJson(response.headers.location, maxRedirects - 1).then(resolve, reject);
				return;
			}
			if (response.statusCode !== 200) {
				response.resume();
				reject(new Error(`HTTP ${response.statusCode}`));
				return;
			}
			let data = '';
			response.on('data', (chunk: Buffer) => { data += chunk.toString(); });
			response.on('end', () => {
				try { resolve(JSON.parse(data)); }
				catch (err) { reject(err); }
			});
		}).on('error', reject);
	});
}

export class WakaTimeManager {
	private settingsStore: Store<MaestroSettings>;
	private lastHeartbeatPerSession: Map<string, number> = new Map();
	private branchCache: Map<string, string> = new Map();
	private languageCache: Map<string, string> = new Map();
	private cliPath: string | null = null;
	private cliDetected = false;
	private installing: Promise<boolean> | null = null;
	private lastUpdateCheck = 0;

	constructor(settingsStore: Store<MaestroSettings>) {
		this.settingsStore = settingsStore;
	}

	/** Get the expected local install path for the WakaTime CLI binary */
	private getLocalBinaryPath(): string | null {
		const plat = getWakaTimePlatform();
		const arch = getWakaTimeArch();
		if (!plat || !arch) return null;
		const binaryName = `wakatime-cli-${plat}-${arch}${process.platform === 'win32' ? '.exe' : ''}`;
		return path.join(os.homedir(), '.wakatime', binaryName);
	}

	/** Detect wakatime-cli on PATH or in ~/.wakatime/ */
	async detectCli(): Promise<boolean> {
		if (this.cliDetected) return this.cliPath !== null;
		this.cliDetected = true;

		// Try common binary names on PATH
		for (const cmd of ['wakatime-cli', 'wakatime']) {
			const result = await execFileNoThrow(cmd, ['--version']);
			if (result.exitCode === 0) {
				this.cliPath = cmd;
				logger.info(`Found WakaTime CLI: ${cmd} (${result.stdout.trim()})`, LOG_CONTEXT);
				return true;
			}
		}

		// Check the auto-installed binary in ~/.wakatime/
		const localPath = this.getLocalBinaryPath();
		if (localPath && fs.existsSync(localPath)) {
			const result = await execFileNoThrow(localPath, ['--version']);
			if (result.exitCode === 0) {
				this.cliPath = localPath;
				logger.info(`Found WakaTime CLI: ${localPath} (${result.stdout.trim()})`, LOG_CONTEXT);
				return true;
			}
		}

		logger.debug('WakaTime CLI not found on PATH or in ~/.wakatime/', LOG_CONTEXT);
		return false;
	}

	/**
	 * Ensure the WakaTime CLI is installed.
	 * If already available (on PATH or in ~/.wakatime/), returns true immediately.
	 * Otherwise, downloads and installs it from GitHub releases.
	 * Guards against concurrent installation attempts.
	 */
	async ensureCliInstalled(): Promise<boolean> {
		// If already detected, return early
		if (await this.detectCli()) {
			// Fire-and-forget background update check (at most once per day)
			const now = Date.now();
			if (now - this.lastUpdateCheck >= UPDATE_CHECK_INTERVAL_MS) {
				this.lastUpdateCheck = now;
				this.checkForUpdate().catch(() => {});
			}
			return true;
		}

		// Guard against concurrent installs
		if (this.installing) return this.installing;

		this.installing = this.doInstall();
		try {
			return await this.installing;
		} finally {
			this.installing = null;
		}
	}

	private async doInstall(): Promise<boolean> {
		const plat = getWakaTimePlatform();
		const arch = getWakaTimeArch();
		if (!plat || !arch) {
			logger.warn(`Unsupported platform/arch for WakaTime CLI auto-install: ${process.platform}/${process.arch}`, LOG_CONTEXT);
			return false;
		}

		const binaryName = `wakatime-cli-${plat}-${arch}${process.platform === 'win32' ? '.exe' : ''}`;
		const zipName = `wakatime-cli-${plat}-${arch}.zip`;
		const downloadUrl = `https://github.com/wakatime/wakatime-cli/releases/latest/download/${zipName}`;
		const installDir = path.join(os.homedir(), '.wakatime');
		const zipPath = path.join(os.tmpdir(), zipName);

		try {
			logger.info(`Downloading WakaTime CLI from ${downloadUrl}`, LOG_CONTEXT);

			// Ensure install directory exists
			fs.mkdirSync(installDir, { recursive: true });

			// Download the zip
			await downloadFile(downloadUrl, zipPath);
			logger.info('WakaTime CLI download complete, extracting...', LOG_CONTEXT);

			// Extract
			if (process.platform === 'win32') {
				// Use PowerShell to extract on Windows
				const extractResult = await execFileNoThrow(
					'powershell',
					['-Command', `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${installDir}'`]
				);
				if (extractResult.exitCode !== 0) {
					logger.warn(`Failed to extract WakaTime CLI: ${extractResult.stderr}`, LOG_CONTEXT);
					return false;
				}
			} else {
				// Use unzip on macOS/Linux
				const extractResult = await execFileNoThrow('unzip', ['-o', zipPath, '-d', installDir]);
				if (extractResult.exitCode !== 0) {
					logger.warn(`Failed to extract WakaTime CLI: ${extractResult.stderr}`, LOG_CONTEXT);
					return false;
				}
			}

			// Make executable on macOS/Linux
			const binaryPath = path.join(installDir, binaryName);
			if (process.platform !== 'win32') {
				fs.chmodSync(binaryPath, 0o755);
			}

			// Update state
			this.cliPath = binaryPath;
			this.cliDetected = false; // Reset so next detectCli() re-checks
			logger.info(`WakaTime CLI installed successfully at ${binaryPath}`, LOG_CONTEXT);

			return true;
		} catch (err) {
			logger.warn(`Failed to auto-install WakaTime CLI: ${err instanceof Error ? err.message : String(err)}`, LOG_CONTEXT);
			return false;
		} finally {
			// Clean up zip file
			try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
		}
	}

	/**
	 * Check if the installed CLI is outdated and update if needed.
	 * Fetches the latest release tag from GitHub and compares it to the
	 * currently installed version. If they differ, re-downloads the CLI.
	 */
	private async checkForUpdate(): Promise<void> {
		try {
			// Get the latest release tag from GitHub
			const release = await fetchJson('https://api.github.com/repos/wakatime/wakatime-cli/releases/latest') as { tag_name?: string };
			const latestTag = release?.tag_name;
			if (!latestTag) {
				logger.debug('Could not determine latest WakaTime CLI version from GitHub', LOG_CONTEXT);
				return;
			}

			// Get the currently installed version
			if (!this.cliPath) return;
			const result = await execFileNoThrow(this.cliPath, ['--version']);
			if (result.exitCode !== 0) return;
			const currentVersion = result.stdout.trim();

			// Compare — latestTag is like "v1.73.1", currentVersion is like "wakatime-cli 1.73.1" or "v1.73.1"
			// Normalize both to just the numeric version
			const normalize = (v: string) => v.replace(/^(wakatime-cli\s+|v)/i, '').trim();
			const latest = normalize(latestTag);
			const current = normalize(currentVersion);

			if (latest === current) {
				logger.debug(`WakaTime CLI is up to date (${current})`, LOG_CONTEXT);
				return;
			}

			logger.info(`WakaTime CLI update available: ${current} → ${latest}`, LOG_CONTEXT);

			// Reset detection state and re-install
			this.cliDetected = false;
			this.cliPath = null;
			await this.doInstall();
		} catch (err) {
			logger.debug(`WakaTime CLI update check failed: ${err instanceof Error ? err.message : String(err)}`, LOG_CONTEXT);
		}
	}

	/**
	 * Read the WakaTime API key from ~/.wakatime.cfg (INI format).
	 * Falls back to empty string if the file doesn't exist or can't be parsed.
	 */
	private readApiKeyFromConfig(): string {
		try {
			const cfgPath = path.join(os.homedir(), '.wakatime.cfg');
			if (!fs.existsSync(cfgPath)) return '';
			const content = fs.readFileSync(cfgPath, 'utf-8');
			const match = content.match(/^api_key\s*=\s*(.+)$/m);
			return match ? match[1].trim() : '';
		} catch {
			return '';
		}
	}

	/**
	 * Detect the primary programming language for a project directory by checking
	 * for well-known config/manifest files. Result is cached per session.
	 */
	private detectLanguage(sessionId: string, cwd: string): string | null {
		const cached = this.languageCache.get(sessionId);
		if (cached !== undefined) return cached || null;

		// Ordered by specificity — first match wins
		const markers: [string, string][] = [
			['tsconfig.json', 'TypeScript'],
			['package.json', 'JavaScript'],
			['Cargo.toml', 'Rust'],
			['go.mod', 'Go'],
			['pyproject.toml', 'Python'],
			['setup.py', 'Python'],
			['requirements.txt', 'Python'],
			['Gemfile', 'Ruby'],
			['pom.xml', 'Java'],
			['build.gradle', 'Java'],
			['build.gradle.kts', 'Kotlin'],
			['*.csproj', 'C#'],
			['Package.swift', 'Swift'],
			['CMakeLists.txt', 'C++'],
			['Makefile', 'C'],
			['composer.json', 'PHP'],
			['mix.exs', 'Elixir'],
			['pubspec.yaml', 'Dart'],
			['deno.json', 'TypeScript'],
		];

		for (const [file, language] of markers) {
			if (file.startsWith('*')) {
				// Glob-style: check if any file matches the extension
				try {
					const ext = file.slice(1); // e.g., '.csproj'
					const entries = fs.readdirSync(cwd);
					if (entries.some(e => e.endsWith(ext))) {
						this.languageCache.set(sessionId, language);
						return language;
					}
				} catch { /* ignore */ }
			} else {
				if (fs.existsSync(path.join(cwd, file))) {
					this.languageCache.set(sessionId, language);
					return language;
				}
			}
		}

		this.languageCache.set(sessionId, '');
		return null;
	}

	/**
	 * Detect the current git branch for a project directory.
	 * Result is cached per session to avoid running git on every heartbeat.
	 */
	private async detectBranch(sessionId: string, cwd: string): Promise<string | null> {
		const cached = this.branchCache.get(sessionId);
		if (cached !== undefined) return cached || null;

		const result = await execFileNoThrow('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
		const branch = result.exitCode === 0 ? result.stdout.trim() : '';
		this.branchCache.set(sessionId, branch);
		return branch || null;
	}

	/** Send a heartbeat for a session's activity */
	async sendHeartbeat(sessionId: string, projectName: string, projectCwd?: string): Promise<void> {
		// Check if enabled
		const enabled = this.settingsStore.get('wakatimeEnabled', false);
		if (!enabled) return;

		let apiKey = this.settingsStore.get('wakatimeApiKey', '') as string;
		if (!apiKey) {
			apiKey = this.readApiKeyFromConfig();
		}
		if (!apiKey) return;

		// Debounce per session
		const now = Date.now();
		const lastBeat = this.lastHeartbeatPerSession.get(sessionId) || 0;
		if (now - lastBeat < HEARTBEAT_DEBOUNCE_MS) return;

		// Ensure CLI is available (auto-installs if needed)
		if (!await this.ensureCliInstalled()) {
			logger.warn('WakaTime CLI not available — skipping heartbeat', LOG_CONTEXT);
			return;
		}

		this.lastHeartbeatPerSession.set(sessionId, now);

		const args = [
			'--key', apiKey,
			'--entity', 'Maestro',
			'--entity-type', 'app',
			'--project', projectName,
			'--plugin', `maestro/${app.getVersion()} maestro-wakatime/${app.getVersion()}`,
			'--category', 'ai coding',
		];

		// Detect project language from manifest files in cwd
		if (projectCwd) {
			const language = this.detectLanguage(sessionId, projectCwd);
			if (language) {
				args.push('--language', language);
			}
		}

		// Add branch info if we can detect it from the project directory
		if (projectCwd) {
			const branch = await this.detectBranch(sessionId, projectCwd);
			if (branch) {
				args.push('--alternate-branch', branch);
			}
		}

		const result = await execFileNoThrow(this.cliPath!, args);
		if (result.exitCode === 0) {
			logger.debug(`Heartbeat sent for session ${sessionId} (${projectName})`, LOG_CONTEXT);
		} else {
			logger.warn(`Heartbeat failed for ${sessionId}: ${result.stderr}`, LOG_CONTEXT);
		}
	}

	/** Get the resolved CLI path (null if not yet detected/installed) */
	getCliPath(): string | null {
		return this.cliPath;
	}

	/** Clean up stale session entries */
	removeSession(sessionId: string): void {
		this.lastHeartbeatPerSession.delete(sessionId);
		this.branchCache.delete(sessionId);
		this.languageCache.delete(sessionId);
	}
}
