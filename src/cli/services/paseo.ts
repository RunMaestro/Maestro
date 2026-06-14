// Paseo CLI adapter for Maestro CLI
// Wraps the local Paseo CLI so Maestro can create and inspect Paseo-managed work.

import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';

const MACOS_BUNDLED_PASEO_CLI = '/Applications/Paseo.app/Contents/Resources/bin/paseo';

export interface PaseoExecOptions {
	cliPath?: string;
}

export interface PaseoCommandResult {
	stdout: string;
	stderr: string;
}

export interface PaseoScheduleCreateOptions extends PaseoExecOptions {
	every?: string;
	cron?: string;
	name?: string;
	target?: string;
	provider?: string;
	mode?: string;
	cwd?: string;
	maxRuns?: string;
	expiresIn?: string;
	runNow?: boolean;
	host?: string;
	json?: boolean;
}

export interface PaseoRunOptions extends PaseoExecOptions {
	title?: string;
	provider?: string;
	model?: string;
	thinking?: string;
	mode?: string;
	cwd?: string;
	detach?: boolean;
	waitTimeout?: string;
	host?: string;
	json?: boolean;
}

export interface PaseoScheduleListOptions extends PaseoExecOptions {
	host?: string;
	json?: boolean;
}

export interface PaseoScheduleLogsOptions extends PaseoExecOptions {
	host?: string;
	json?: boolean;
}

function isExecutable(filePath: string): boolean {
	try {
		const stats = fs.statSync(filePath);
		if (!stats.isFile()) return false;
		if (os.platform() !== 'win32') {
			fs.accessSync(filePath, fs.constants.X_OK);
		}
		return true;
	} catch {
		return false;
	}
}

export function resolvePaseoCliPath(explicitPath?: string): string {
	if (explicitPath) return explicitPath;
	if (process.env.PASEO_CLI_PATH) return process.env.PASEO_CLI_PATH;
	if (os.platform() === 'darwin' && isExecutable(MACOS_BUNDLED_PASEO_CLI)) {
		return MACOS_BUNDLED_PASEO_CLI;
	}
	return 'paseo';
}

export function runPaseoCommand(
	args: string[],
	options: PaseoExecOptions = {}
): Promise<PaseoCommandResult> {
	return new Promise((resolve, reject) => {
		const cliPath = resolvePaseoCliPath(options.cliPath);
		const child = childProcess.spawn(cliPath, args, {
			env: process.env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		let stdout = '';
		let stderr = '';

		child.stdout?.on('data', (data: Buffer) => {
			stdout += data.toString();
		});

		child.stderr?.on('data', (data: Buffer) => {
			stderr += data.toString();
		});

		child.on('error', (error) => {
			reject(new Error(`Failed to run Paseo CLI (${cliPath}): ${error.message}`));
		});

		child.on('close', (code) => {
			if (code === 0) {
				resolve({ stdout, stderr });
				return;
			}

			const exitDetail =
				code === null ? 'Paseo exited without an exit code' : `Paseo exited with code ${code}`;
			const details = [stderr.trim(), stdout.trim(), exitDetail].filter(Boolean).join('\n');
			reject(new Error(details));
		});
	});
}

function addOption(args: string[], flag: string, value?: string): void {
	if (value !== undefined && value !== '') {
		args.push(flag, value);
	}
}

function addCommonOptions(args: string[], options: { host?: string; json?: boolean }): void {
	addOption(args, '--host', options.host);
	if (options.json) {
		args.push('--json');
	}
}

export function createPaseoSchedule(
	prompt: string,
	options: PaseoScheduleCreateOptions
): Promise<PaseoCommandResult> {
	const args = ['schedule', 'create'];

	addOption(args, '--every', options.every);
	addOption(args, '--cron', options.cron);
	addOption(args, '--name', options.name);
	addOption(args, '--target', options.target);
	addOption(args, '--provider', options.provider);
	addOption(args, '--mode', options.mode);
	addOption(args, '--cwd', options.cwd);
	addOption(args, '--max-runs', options.maxRuns);
	addOption(args, '--expires-in', options.expiresIn);

	if (options.runNow === true) {
		args.push('--run-now');
	} else if (options.runNow === false) {
		args.push('--no-run-now');
	}

	addCommonOptions(args, options);
	args.push(prompt);

	return runPaseoCommand(args, options);
}

export function runPaseoAgent(
	prompt: string,
	options: PaseoRunOptions
): Promise<PaseoCommandResult> {
	const args = ['run'];

	addOption(args, '--title', options.title);
	addOption(args, '--provider', options.provider);
	addOption(args, '--model', options.model);
	addOption(args, '--thinking', options.thinking);
	addOption(args, '--mode', options.mode);
	addOption(args, '--cwd', options.cwd);
	if (options.detach !== false) {
		args.push('--detach');
	}
	addOption(args, '--wait-timeout', options.waitTimeout);
	addCommonOptions(args, options);
	args.push(prompt);

	return runPaseoCommand(args, options);
}

export function listPaseoSchedules(options: PaseoScheduleListOptions): Promise<PaseoCommandResult> {
	const args = ['schedule', 'ls'];
	addCommonOptions(args, options);
	return runPaseoCommand(args, options);
}

export function getPaseoScheduleLogs(
	scheduleId: string,
	options: PaseoScheduleLogsOptions
): Promise<PaseoCommandResult> {
	const args = ['schedule', 'logs'];
	addCommonOptions(args, options);
	args.push(scheduleId);
	return runPaseoCommand(args, options);
}
