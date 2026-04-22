import { app } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileNoThrow } from './utils/execFile';
import { getWhichCommand, isWindows } from '../shared/platformDetection';
import { compareVersions } from '../shared/pathUtils';
import { getExpandedEnv } from './utils/cliDetection';
import { logger } from './utils/logger';
import type { MaestroCliStatus, MaestroCliInstallResult } from '../shared/maestro-cli';

const CLI_BINARY_NAME = 'maestro-cli';
const LOG_CONTEXT = 'MaestroCliManager';

function normalizeVersion(raw: string): string {
	const firstLine = raw.trim().split(/\r?\n/)[0] || '';
	const semverMatch = firstLine.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
	return semverMatch?.[1] || firstLine.replace(/^v/i, '').trim();
}

function splitOutputLines(output: string): string[] {
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
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

	private getBundledCliCandidates(): string[] {
		return [
			path.join(process.resourcesPath, 'maestro-cli.js'),
			path.resolve(app.getAppPath(), 'dist', 'cli', 'maestro-cli.js'),
			path.resolve(__dirname, '..', 'cli', 'maestro-cli.js'),
		];
	}

	private async resolveBundledCliPath(): Promise<string | null> {
		const candidates = this.getBundledCliCandidates();
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

	private async writeUnixShim(installPath: string, bundledCliPath: string): Promise<void> {
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
		await fs.promises.writeFile(installPath, script, 'utf-8');
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
		await fs.promises.writeFile(installPath, script, 'utf-8');
	}

	private async ensurePosixPathExport(
		installDir: string
	): Promise<{ updated: boolean; files: string[] }> {
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
				throw err;
			}
		}

		return { updated, files: filesUpdated };
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
		].join('; ');

		const result = await execFileNoThrow('powershell', [
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
			const candidates = this.getBundledCliCandidates();
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
