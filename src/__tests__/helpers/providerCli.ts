/**
 * Running a real provider CLI (`claude`, `codex`) from an opt-in end-to-end
 * test: the environment it gets, the process call, and whether it is installed.
 *
 * NOT re-exported from `./index`: it imports `child_process`, and only the
 * opt-in e2e suites that drive a real harness need it.
 */

import { execFile, execFileSync } from 'child_process';

/**
 * The environment for a provider CLI: this process's, minus what an agent
 * shell leaks. A `CLAUDE_CODE_*` variable from a parent Claude Code session
 * makes the child behave as a nested session, a Maestro variable would point it
 * at live app data, and an inherited base URL would send it somewhere else.
 * `PWD` names THIS process's directory, not the one the child is started in,
 * and OpenCode 2 works in the directory `PWD` names when it is set.
 */
export function providerCliEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key === 'CLAUDECODE' || key === 'CLAUDE_PID' || key === 'CLAUDE_EFFORT') continue;
		if (key.startsWith('CLAUDE_CODE_') || key.startsWith('MAESTRO_')) continue;
		if (key === 'ANTHROPIC_BASE_URL' || key === 'OPENAI_BASE_URL') continue;
		if (key === 'PWD') continue;
		env[key] = value;
	}
	return { ...env, ...extra };
}

export interface ProviderCliResult {
	code: number;
	stdout: string;
	stderr: string;
	/** True when the CLI was killed for running past `timeoutMs`. */
	timedOut: boolean;
	/** Wall time from spawn to exit. */
	wallMs: number;
}

/** Run a provider CLI to completion. Never rejects: a failure is a non-zero `code`. */
export function runProviderCli(
	command: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; stdin?: string }
): Promise<ProviderCliResult> {
	const started = Date.now();
	return new Promise((resolve) => {
		const child = execFile(
			command,
			args,
			{
				cwd: options.cwd,
				env: options.env,
				timeout: options.timeoutMs,
				maxBuffer: 64 * 1024 * 1024,
			},
			(error, stdout, stderr) => {
				const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
				resolve({
					code,
					stdout: String(stdout),
					stderr: String(stderr),
					timedOut: Boolean(error?.killed && error.signal),
					wallMs: Date.now() - started,
				});
			}
		);
		// Always closed: an open pipe makes Codex wait for a prompt it was given as
		// an argument.
		child.stdin?.end(options.stdin ?? '');
	});
}

/** Whether `command` resolves on PATH. */
export function isOnPath(command: string): boolean {
	try {
		execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}
