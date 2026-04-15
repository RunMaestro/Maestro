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
		for (const candidate of this.getBundledCliCandidates()) {
			try {
				await fs.promises.access(candidate, fs.constants.R_OK);
				return candidate;
			} catch {
				continue;
			}
		}
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
		const whichResult = await execFileNoThrow(getWhichCommand(), [CLI_BINARY_NAME], undefined, env);
		if (whichResult.exitCode !== 0 || !whichResult.stdout.trim()) {
			return null;
		}
		const lines = splitOutputLines(whichResult.stdout);
		return lines[0] || null;
	}

	private async readCliVersion(commandPath: string): Promise<string | null> {
		const env = getExpandedEnv();
		const versionResult = await execFileNoThrow(commandPath, ['--version'], undefined, env);
		if (versionResult.exitCode !== 0 || !versionResult.stdout.trim()) {
			return null;
		}
		return normalizeVersion(versionResult.stdout);
	}

	private async writeUnixShim(installPath: string, bundledCliPath: string): Promise<void> {
		const script = `#!/usr/bin/env bash\nnode ${JSON.stringify(bundledCliPath)} \"$@\"\n`;
		await fs.promises.writeFile(installPath, script, 'utf-8');
		await fs.promises.chmod(installPath, 0o755);
	}

	private async writeWindowsShim(installPath: string, bundledCliPath: string): Promise<void> {
		const escapedCliPath = this.escapeForWindowsCmd(bundledCliPath);
		const script = `@echo off\r\nnode "${escapedCliPath}" %*\r\n`;
		await fs.promises.writeFile(installPath, script, 'utf-8');
	}

	private async ensurePosixPathExport(
		installDir: string
	): Promise<{ updated: boolean; files: string[] }> {
		const home = os.homedir();
		const shellName = path.basename(process.env.SHELL || '').toLowerCase();
		const rcFiles = new Set<string>(['.profile']);
		if (shellName === 'zsh') rcFiles.add('.zshrc');
		if (shellName === 'bash') rcFiles.add('.bashrc');
		if (!shellName) {
			rcFiles.add('.zshrc');
			rcFiles.add('.bashrc');
		}

		const expectedEntry = '$HOME/.local/bin';
		const exportLine = `export PATH=\"${expectedEntry}:$PATH\"`;
		const marker = '# Added by Maestro CLI installer';

		let updated = false;
		const filesUpdated: string[] = [];

		for (const rcFile of rcFiles) {
			const rcPath = path.join(home, rcFile);
			let contents = '';
			try {
				contents = await fs.promises.readFile(rcPath, 'utf-8');
			} catch {
				contents = '';
			}

			if (contents.includes(expectedEntry) || contents.includes(installDir)) {
				continue;
			}

			const prefix = contents.length > 0 && !contents.endsWith('\n') ? '\n' : '';
			const snippet = `${prefix}${marker}\n${exportLine}\n`;
			await fs.promises.appendFile(rcPath, snippet, 'utf-8');
			updated = true;
			filesUpdated.push(rcPath);
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

	async checkStatus(): Promise<MaestroCliStatus> {
		const expectedVersion = normalizeVersion(app.getVersion());
		const installDir = this.getInstallDir();
		const bundledCliPath = await this.resolveBundledCliPath();

		const inPathCommand = await this.detectCliPath(false);
		const expandedCommand = inPathCommand || (await this.detectCliPath(true));
		const installPath = this.getInstallPath();
		const installShimExists = fs.existsSync(installPath);
		const commandPath = expandedCommand || (installShimExists ? installPath : null);
		const inPath = Boolean(inPathCommand);
		const installed = Boolean(commandPath);
		const installedVersion = commandPath ? await this.readCliVersion(commandPath) : null;
		const versionMatch =
			Boolean(installedVersion) && compareVersions(installedVersion || '', expectedVersion) === 0;

		return {
			expectedVersion,
			installed,
			inPath,
			commandPath,
			installedVersion,
			versionMatch,
			needsInstallOrUpdate: !installed || !inPath || !versionMatch,
			installDir,
			bundledCliPath,
		};
	}

	async installOrUpdate(): Promise<MaestroCliInstallResult> {
		const installDir = this.getInstallDir();
		const installPath = this.getInstallPath();
		const bundledCliPath = await this.resolveBundledCliPath();
		if (!bundledCliPath) {
			throw new Error('Unable to locate bundled maestro-cli.js in app resources');
		}

		await fs.promises.mkdir(installDir, { recursive: true });
		if (isWindows()) {
			await this.writeWindowsShim(installPath, bundledCliPath);
		} else {
			await this.writeUnixShim(installPath, bundledCliPath);
		}

		let pathUpdated = false;
		let shellFilesUpdated: string[] = [];

		const alreadyInPath = this.isPathEntryPresent(process.env.PATH, installDir);
		if (!alreadyInPath) {
			if (isWindows()) {
				pathUpdated = await this.ensureWindowsUserPath(installDir);
			} else {
				const result = await this.ensurePosixPathExport(installDir);
				pathUpdated = result.updated;
				shellFilesUpdated = result.files;
			}
		}

		const status = await this.checkStatus();
		const executionSucceeded = (await this.readCliVersion(installPath)) !== null;
		return {
			success: status.installed && status.versionMatch && executionSucceeded,
			status,
			pathUpdated,
			restartRequired: pathUpdated,
			shellFilesUpdated,
		};
	}
}
