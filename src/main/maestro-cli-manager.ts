import { app } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileNoThrow } from './utils/execFile';
import { atomicWriteFile } from './utils/atomic-json-store';
import { shellEscape } from './utils/shell-escape';
import { getWhichCommand, isWindows } from '../shared/platformDetection';
import { compareVersions } from '../shared/pathUtils';
import { getExpandedEnv } from './utils/cliDetection';
import { logger } from './utils/logger';
import type { MaestroCliStatus, MaestroCliInstallResult } from '../shared/maestro-cli';

const CLI_BINARY_NAME = 'maestro-cli';
const BOOTSTRAP_FILE_NAME = `${CLI_BINARY_NAME}-bootstrap.js`;
const LOG_CONTEXT = 'MaestroCliManager';

/**
 * Marker in a shim this installer wrote for the Linux AppImage. Startup repair
 * rewrites such a shim when the recorded AppImage path changes, and leaves any
 * shim without the marker alone.
 */
const APPIMAGE_SHIM_MARKER = '# Maestro CLI shim for the Linux AppImage build.';

/**
 * Script the AppImage shim runs. It rebuilds argv so the CLI reads its own
 * script path at `argv[1]`, then requires the bundled CLI resolved from the
 * mount the current AppImage run created. A real script file (not `-e`) keeps
 * `--version` and `--help` out of Electron's own argument parser.
 */
const APPIMAGE_BOOTSTRAP_SOURCE =
	`// Maestro CLI bootstrap for the Linux AppImage build.\n` +
	`// The app mounts at a new /tmp/.mount_* path on every launch.\n` +
	`const path = require('path');\n` +
	`const cli = path.join(path.dirname(process.execPath), 'resources', 'maestro-cli.js');\n` +
	`process.argv = [process.execPath, cli, ...process.argv.slice(2)];\n` +
	`require(cli);\n`;

export function normalizeVersion(raw: string): string {
	const lines = splitOutputLines(raw);
	const exactVersionLine = lines.find((line) => /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(line));
	if (exactVersionLine) return exactVersionLine.replace(/^v/i, '');

	const firstLine = lines[0] || '';
	const semverMatch = firstLine.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
	return semverMatch?.[1] || firstLine.replace(/^v/i, '').trim();
}

function splitOutputLines(output: string): string[] {
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

/** The filesystem refused a write the app has no way to grant itself. */
const PERMISSION_ERROR_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);

function isPermissionError(err: unknown): boolean {
	const code = (err as { code?: unknown } | null)?.code;
	return typeof code === 'string' && PERMISSION_ERROR_CODES.has(code);
}

/**
 * Candidate on-disk locations for the bundled maestro-cli.js, most-specific
 * first: packaged resources, the built dev output (`dist/cli`), and a path
 * relative to the compiled main bundle. Shared by the async resolver and the
 * sync one below so the two never drift.
 */
export function getBundledCliCandidates(): string[] {
	const candidates: string[] = [];
	// `process.resourcesPath` and `app.getAppPath()` only exist in a real Electron
	// runtime; guard each so this never throws in a plain-Node context (tests) and
	// degrades to just the __dirname-relative candidate instead.
	if (typeof process.resourcesPath === 'string') {
		candidates.push(path.join(process.resourcesPath, 'maestro-cli.js'));
	}
	try {
		candidates.push(path.resolve(app.getAppPath(), 'dist', 'cli', 'maestro-cli.js'));
	} catch {
		// app not ready or not in Electron - skip this candidate.
	}
	candidates.push(path.resolve(__dirname, '..', 'cli', 'maestro-cli.js'));
	return candidates;
}

/**
 * Synchronously resolve the first bundled maestro-cli.js that exists on disk,
 * or null if none do. Used at window-creation time to hand the renderer the
 * real CLI path (dev vs packaged) via preload, so `{{MAESTRO_CLI_PATH}}` in
 * agent prompts points at a file that actually exists.
 */
export function resolveBundledCliPathSync(): string | null {
	for (const candidate of getBundledCliCandidates()) {
		try {
			fs.accessSync(candidate, fs.constants.R_OK);
			return candidate;
		} catch {
			continue;
		}
	}
	return null;
}

export class MaestroCliManager {
	private readonly posixPathMarker = '# Added by Maestro CLI installer';

	private escapeForWindowsCmd(value: string): string {
		return value.replace(/"/g, '""');
	}

	private escapeForPowerShellSingleQuoted(value: string): string {
		return value.replace(/'/g, "''");
	}

	private getInstallDir(): string {
		return path.join(os.homedir(), '.local', 'bin');
	}

	private getInstallPath(): string {
		if (isWindows()) {
			return path.join(this.getInstallDir(), `${CLI_BINARY_NAME}.cmd`);
		}
		return path.join(this.getInstallDir(), CLI_BINARY_NAME);
	}

	/** The bootstrap sits beside the shim, so both move together. */
	private getBootstrapPath(installPath: string): string {
		return path.join(path.dirname(installPath), BOOTSTRAP_FILE_NAME);
	}

	/**
	 * The AppImage file this process runs from, or null. `APPIMAGE` alone is not
	 * enough: the AppImage runtime exports it, so every child process (a dev
	 * run, a test run, a shell command) inherits it. Require `APPDIR` as well,
	 * and require the running binary to sit inside that mount.
	 */
	private resolveAppImagePath(): string | null {
		const appImagePath = process.env.APPIMAGE;
		const appDir = process.env.APPDIR;
		if (!appImagePath || !appDir) return null;
		const execDir = path.resolve(path.dirname(process.execPath));
		return execDir === path.resolve(appDir) ? appImagePath : null;
	}

	private async resolveBundledCliPath(): Promise<string | null> {
		const candidates = getBundledCliCandidates();
		logger.debug('Resolving bundled maestro-cli.js path', LOG_CONTEXT, { candidates });
		for (const candidate of candidates) {
			try {
				await fs.promises.access(candidate, fs.constants.R_OK);
				logger.info('Resolved bundled maestro-cli.js', LOG_CONTEXT, { path: candidate });
				return candidate;
			} catch (err) {
				logger.debug('Bundled CLI candidate not accessible', LOG_CONTEXT, {
					candidate,
					error: err instanceof Error ? err.message : String(err),
				});
				continue;
			}
		}
		logger.warn('No bundled maestro-cli.js candidate was readable', LOG_CONTEXT, { candidates });
		return null;
	}

	private isPathEntryPresent(pathValue: string | undefined, dir: string): boolean {
		if (!pathValue) return false;
		const expected = isWindows() ? path.normalize(dir).toLowerCase() : path.normalize(dir);
		return pathValue.split(path.delimiter).some((entry) => {
			const normalized = isWindows()
				? path.normalize(entry.trim()).toLowerCase()
				: path.normalize(entry.trim());
			return normalized === expected;
		});
	}

	private async detectCliPath(useExpandedEnv: boolean): Promise<string | null> {
		const env = useExpandedEnv ? getExpandedEnv() : process.env;
		const whichCommand = getWhichCommand();
		const whichResult = await execFileNoThrow(whichCommand, [CLI_BINARY_NAME], undefined, env);
		if (whichResult.exitCode !== 0 || !whichResult.stdout.trim()) {
			logger.debug('maestro-cli not found on PATH', LOG_CONTEXT, {
				useExpandedEnv,
				whichCommand,
				exitCode: whichResult.exitCode,
				stderr: whichResult.stderr,
			});
			return null;
		}
		const lines = splitOutputLines(whichResult.stdout);
		const resolved = lines[0] || null;
		logger.debug('maestro-cli detected on PATH', LOG_CONTEXT, {
			useExpandedEnv,
			whichCommand,
			resolved,
		});
		return resolved;
	}

	private async readCliVersion(commandPath: string): Promise<string | null> {
		const env = getExpandedEnv();
		const versionResult = await execFileNoThrow(commandPath, ['--version'], undefined, env);
		if (versionResult.exitCode !== 0 || !versionResult.stdout.trim()) {
			logger.warn('Failed to read maestro-cli version', LOG_CONTEXT, {
				commandPath,
				exitCode: versionResult.exitCode,
				stdout: versionResult.stdout,
				stderr: versionResult.stderr,
			});
			return null;
		}
		const version = normalizeVersion(versionResult.stdout);
		logger.debug('Read maestro-cli version', LOG_CONTEXT, { commandPath, version });
		return version;
	}

	/**
	 * Shims are written via temp file + rename so the rename replaces whatever
	 * sits at `installPath` itself. A plain `writeFile` follows a symlink, and a
	 * hand-made `~/.local/bin/maestro-cli -> Maestro.app/.../maestro-cli.js` link
	 * made it overwrite the app's own bundled CLI with this shim, which then
	 * exec'd itself as JavaScript and broke every `maestro-cli` call.
	 */
	private async writeUnixShim(installPath: string, bundledCliPath: string): Promise<void> {
		const appImagePath = this.resolveAppImagePath();
		if (appImagePath) {
			await this.writeAppImageShim(installPath, appImagePath);
			return;
		}

		const safeCliPath = bundledCliPath.replace(/'/g, "'\\''");
		const safeRuntimePath = process.execPath.replace(/'/g, "'\\''");
		const script =
			`#!/usr/bin/env bash\n` +
			`ELECTRON_RUN_AS_NODE=1 '${safeRuntimePath}' '${safeCliPath}' "$@"\n`;
		logger.info('Writing Unix maestro-cli shim', LOG_CONTEXT, {
			installPath,
			bundledCliPath,
			runtimePath: process.execPath,
		});
		await atomicWriteFile(installPath, script);
		await fs.promises.chmod(installPath, 0o755);
	}

	/**
	 * AppImage builds run from a temporary mount (`/tmp/.mount_*`) whose name
	 * changes on every launch, so a shim recording `process.execPath` breaks at
	 * the next start. `$APPIMAGE` holds the stable AppImage file path. Write a
	 * shim that re-enters that file in node mode, plus a bootstrap beside it
	 * that resolves the bundled CLI from the mount that run creates. The shim
	 * then survives a restart, an AppImage update that renames the file, and a
	 * closed desktop app.
	 */
	private async writeAppImageShim(installPath: string, appImagePath: string): Promise<void> {
		const bootstrapPath = this.getBootstrapPath(installPath);
		const safeAppImage = shellEscape(appImagePath);
		const safeBootstrap = shellEscape(bootstrapPath);
		const script =
			`#!/usr/bin/env bash\n` +
			`${APPIMAGE_SHIM_MARKER}\n` +
			`# The app mounts at a new /tmp/.mount_* path on every launch. This shim\n` +
			`# re-enters the AppImage in node mode; the bootstrap resolves the bundled\n` +
			`# CLI from the mount that run creates. Install / Update CLI rewrites it.\n` +
			`set -euo pipefail\n` +
			`\n` +
			`appimage=${safeAppImage}\n` +
			`bootstrap=${safeBootstrap}\n` +
			`\n` +
			`if [ ! -x "$appimage" ]; then\n` +
			`  echo "maestro-cli: the Maestro AppImage is not at $appimage." >&2\n` +
			`  echo "Run Install / Update CLI in Maestro settings." >&2\n` +
			`  exit 127\n` +
			`fi\n` +
			`\n` +
			`if [ ! -f "$bootstrap" ]; then\n` +
			`  echo "maestro-cli: $bootstrap is missing." >&2\n` +
			`  echo "Run Install / Update CLI in Maestro settings." >&2\n` +
			`  exit 127\n` +
			`fi\n` +
			`\n` +
			`ELECTRON_RUN_AS_NODE=1 exec "$appimage" "$bootstrap" "$@"\n`;
		logger.info('Writing AppImage maestro-cli shim', LOG_CONTEXT, {
			installPath,
			appImagePath,
			bootstrapPath,
		});
		await atomicWriteFile(bootstrapPath, APPIMAGE_BOOTSTRAP_SOURCE);
		await fs.promises.chmod(bootstrapPath, 0o644);
		await atomicWriteFile(installPath, script);
		await fs.promises.chmod(installPath, 0o755);
	}

	private async writeWindowsShim(installPath: string, bundledCliPath: string): Promise<void> {
		const escapedCliPath = this.escapeForWindowsCmd(bundledCliPath);
		const escapedRuntimePath = this.escapeForWindowsCmd(process.execPath);
		const script =
			`@echo off\r\n` +
			`set "ELECTRON_RUN_AS_NODE=1"\r\n` +
			`"${escapedRuntimePath}" "${escapedCliPath}" %*\r\n`;
		logger.info('Writing Windows maestro-cli shim', LOG_CONTEXT, {
			installPath,
			bundledCliPath,
			runtimePath: process.execPath,
		});
		await atomicWriteFile(installPath, script);
	}

	/**
	 * True when the file at `installPath` is a shim this installer wrote: either
	 * the current AppImage shim (marker present) or the older shim that recorded
	 * a `.mount_*` path. Any other file belongs to the user and stays as is.
	 */
	private isInstallerShim(contents: string): boolean {
		if (contents.includes(APPIMAGE_SHIM_MARKER)) return true;
		// The pre-fix installer wrote exactly two lines, with both paths inside
		// the same AppImage mount. The `.mount_` segment rejects the same shape
		// written for a deb, rpm, or macOS install, and tolerates a non-/tmp
		// TMPDIR. A hand-written wrapper that only mentions these strings is
		// left alone too.
		return /^#!\/usr\/bin\/env bash\r?\nELECTRON_RUN_AS_NODE=1 '([^']*\/\.mount_[^'\/]*)\/maestro' '\1\/resources\/maestro-cli\.js' "\$@"\r?\n?$/.test(
			contents
		);
	}

	private shimTargetsAppImage(contents: string, appImagePath: string): boolean {
		return contents.includes(`appimage=${shellEscape(appImagePath)}`);
	}

	/**
	 * Repair the shim when the recorded AppImage path no longer matches the app
	 * that is running: an update renamed the file, or an older build recorded a
	 * `.mount_*` path that is now gone. Startup runs this, so a failure is
	 * logged and never thrown. Returns true when the shim was rewritten.
	 */
	async healAppImageShim(): Promise<boolean> {
		const appImagePath = this.resolveAppImagePath();
		if (!appImagePath || isWindows()) return false;

		const installPath = this.getInstallPath();
		let contents: string;
		try {
			contents = await fs.promises.readFile(installPath, 'utf-8');
		} catch {
			return false;
		}

		if (!this.isInstallerShim(contents)) return false;
		if (
			contents.includes(APPIMAGE_SHIM_MARKER) &&
			this.shimTargetsAppImage(contents, appImagePath)
		) {
			return false;
		}

		try {
			await fs.promises.mkdir(this.getInstallDir(), { recursive: true });
			await this.writeAppImageShim(installPath, appImagePath);
			logger.info('Repaired AppImage maestro-cli shim', LOG_CONTEXT, {
				installPath,
				appImagePath,
			});
			return true;
		} catch (err) {
			logger.warn('Could not repair AppImage maestro-cli shim', LOG_CONTEXT, {
				installPath,
				appImagePath,
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	}

	private async ensurePosixPathExport(
		installDir: string
	): Promise<{ updated: boolean; files: string[]; error?: string }> {
		const home = os.homedir();
		const shellName = path.basename(process.env.SHELL || '').toLowerCase();
		const rcFiles = new Set<string>();
		if (shellName === 'zsh') rcFiles.add('.zshrc');
		if (shellName === 'bash') rcFiles.add('.bashrc');
		if (rcFiles.size === 0) {
			rcFiles.add('.profile');
		}

		const normalizedInstallDir = path.resolve(installDir);
		const normalizedHome = path.resolve(home);
		const expectedEntry = normalizedInstallDir.startsWith(`${normalizedHome}${path.sep}`)
			? `$HOME/${path.relative(normalizedHome, normalizedInstallDir).replace(/\\/g, '/')}`
			: normalizedInstallDir.replace(/\\/g, '/');
		const exportLine = `export PATH="${expectedEntry}:$PATH"`;

		let updated = false;
		const filesUpdated: string[] = [];
		let error: string | undefined;

		logger.info('Ensuring POSIX PATH export for maestro-cli', LOG_CONTEXT, {
			installDir,
			shellName,
			rcFiles: Array.from(rcFiles),
			exportLine,
		});

		for (const rcFile of rcFiles) {
			const rcPath = path.join(home, rcFile);
			let contents = '';
			try {
				contents = await fs.promises.readFile(rcPath, 'utf-8');
			} catch (err) {
				logger.debug('Shell rc file not readable; will create if write succeeds', LOG_CONTEXT, {
					rcPath,
					error: err instanceof Error ? err.message : String(err),
				});
				contents = '';
			}

			if (contents.includes(this.posixPathMarker) || contents.includes(exportLine)) {
				logger.debug('Shell rc already contains PATH export; skipping', LOG_CONTEXT, { rcPath });
				continue;
			}

			const prefix = contents.length > 0 && !contents.endsWith('\n') ? '\n' : '';
			const snippet = `${prefix}${this.posixPathMarker}\n${exportLine}\n`;
			try {
				await fs.promises.appendFile(rcPath, snippet, 'utf-8');
				logger.info('Appended maestro-cli PATH export to rc file', LOG_CONTEXT, { rcPath });
				updated = true;
				filesUpdated.push(rcPath);
			} catch (err) {
				logger.error('Failed to append PATH export to rc file', LOG_CONTEXT, {
					rcPath,
					error: err instanceof Error ? err.message : String(err),
				});
				// The shim is already installed by now; only the PATH line failed.
				// A shell rc file the app may not write (owned by root, locked by a
				// dotfile manager, or blocked by macOS privacy controls) is the
				// user's to fix, so hand them the line instead of failing the whole
				// install with an exception (MAESTRO-177, MAESTRO-15Z).
				if (!isPermissionError(err)) throw err;
				error = `Could not add maestro-cli to PATH: ${rcPath} is not writable. Add this line to it yourself: ${exportLine}`;
			}
		}

		return { updated, files: filesUpdated, error };
	}

	private async ensureWindowsUserPath(installDir: string): Promise<boolean> {
		const escapedInstallDir = this.escapeForPowerShellSingleQuoted(installDir);
		const script = [
			`$installDir = '${escapedInstallDir}'`,
			"$current = [Environment]::GetEnvironmentVariable('Path', 'User')",
			"if (-not $current) { $current = '' }",
			"$parts = @($current -split ';' | Where-Object { $_ -and $_.Trim() -ne '' })",
			'if ($parts -notcontains $installDir) {',
			"  $newPath = (($parts + $installDir) | Select-Object -Unique) -join ';'",
			"  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')",
			'}',
		].join('\n');

		// Use the executable name so execFileNoThrow does not route the command
		// through cmd.exe, which would reinterpret PowerShell's pipe characters.
		const result = await execFileNoThrow('powershell.exe', [
			'-NoProfile',
			'-NonInteractive',
			'-Command',
			script,
		]);
		if (result.exitCode !== 0) {
			logger.error('Failed to update Windows user PATH for maestro-cli', LOG_CONTEXT, {
				exitCode: result.exitCode,
				stdout: result.stdout,
				stderr: result.stderr,
			});
		}
		return result.exitCode === 0;
	}

	private async pathExists(filePath: string): Promise<boolean> {
		try {
			await fs.promises.access(filePath, fs.constants.F_OK);
			return true;
		} catch {
			return false;
		}
	}

	async checkStatus(): Promise<MaestroCliStatus> {
		const expectedVersion = normalizeVersion(app.getVersion());
		const installDir = this.getInstallDir();
		const bundledCliPath = await this.resolveBundledCliPath();

		const inPathCommand = await this.detectCliPath(false);
		const expandedCommand = await this.detectCliPath(true);
		const installPath = this.getInstallPath();
		const installShimExists = await this.pathExists(installPath);
		const commandPath = expandedCommand || (installShimExists ? installPath : null);
		const inPath = Boolean(inPathCommand);
		const inShellPath = Boolean(expandedCommand);
		const installed = Boolean(commandPath);
		const installedVersion = commandPath ? await this.readCliVersion(commandPath) : null;
		const versionMatch =
			Boolean(installedVersion) && compareVersions(installedVersion || '', expectedVersion) === 0;

		const status: MaestroCliStatus = {
			expectedVersion,
			installed,
			inPath,
			inShellPath,
			commandPath,
			installedVersion,
			versionMatch,
			needsInstallOrUpdate: !installed || !versionMatch,
			installDir,
			bundledCliPath,
		};

		logger.info('Checked maestro-cli status', LOG_CONTEXT, {
			expectedVersion,
			installedVersion,
			installed,
			inPath,
			inShellPath,
			versionMatch,
			commandPath,
			installShimExists,
			installDir,
			bundledCliPath,
		});

		return status;
	}

	async installOrUpdate(): Promise<MaestroCliInstallResult> {
		const installDir = this.getInstallDir();
		const installPath = this.getInstallPath();

		logger.info('Starting maestro-cli install/update', LOG_CONTEXT, {
			installDir,
			installPath,
			platform: process.platform,
			electronVersion: process.versions.electron,
			nodeVersion: process.versions.node,
			runtimePath: process.execPath,
			resourcesPath: process.resourcesPath,
			appPath: app.getAppPath(),
		});

		const bundledCliPath = await this.resolveBundledCliPath();
		if (!bundledCliPath) {
			const candidates = getBundledCliCandidates();
			logger.error('Unable to locate bundled maestro-cli.js in app resources', LOG_CONTEXT, {
				candidates,
			});
			throw new Error(
				`Unable to locate bundled maestro-cli.js in app resources. Tried: ${candidates.join(', ')}`
			);
		}

		try {
			await fs.promises.mkdir(installDir, { recursive: true });
			logger.debug('Ensured install directory exists', LOG_CONTEXT, { installDir });
		} catch (err) {
			logger.error('Failed to create install directory', LOG_CONTEXT, {
				installDir,
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}

		try {
			if (isWindows()) {
				await this.writeWindowsShim(installPath, bundledCliPath);
			} else {
				await this.writeUnixShim(installPath, bundledCliPath);
			}
			logger.info('maestro-cli shim written', LOG_CONTEXT, { installPath });
		} catch (err) {
			logger.error('Failed to write maestro-cli shim', LOG_CONTEXT, {
				installPath,
				bundledCliPath,
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}

		let pathUpdated = false;
		let shellFilesUpdated: string[] = [];
		let pathUpdateError: string | undefined;

		const alreadyInPath = this.isPathEntryPresent(process.env.PATH, installDir);
		logger.debug('PATH membership check for install dir', LOG_CONTEXT, {
			installDir,
			alreadyInPath,
		});

		if (!alreadyInPath) {
			if (isWindows()) {
				pathUpdated = await this.ensureWindowsUserPath(installDir);
				if (!pathUpdated) {
					pathUpdateError = 'Failed to update Windows user PATH for maestro-cli';
				}
			} else {
				const result = await this.ensurePosixPathExport(installDir);
				pathUpdated = result.updated;
				shellFilesUpdated = result.files;
				pathUpdateError = result.error;
			}
		}

		const status = await this.checkStatus();
		const shimVersion = await this.readCliVersion(installPath);
		const executionSucceeded = shimVersion !== null;

		const success =
			status.installed &&
			status.versionMatch &&
			executionSucceeded &&
			pathUpdateError === undefined;

		logger.info('maestro-cli install/update finished', LOG_CONTEXT, {
			success,
			executionSucceeded,
			shimVersion,
			pathUpdated,
			shellFilesUpdated,
			pathUpdateError,
			installed: status.installed,
			versionMatch: status.versionMatch,
			commandPath: status.commandPath,
		});

		if (!success) {
			logger.warn('maestro-cli install/update completed with issues', LOG_CONTEXT, {
				reasonInstalled: status.installed,
				reasonVersionMatch: status.versionMatch,
				reasonExecutionSucceeded: executionSucceeded,
				pathUpdateError,
			});
		}

		return {
			success,
			status,
			pathUpdated,
			pathUpdateError,
			restartRequired: pathUpdated,
			shellFilesUpdated,
		};
	}
}
