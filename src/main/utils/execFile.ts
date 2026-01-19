import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execFileAsync = promisify(execFile);

export interface ExecOptions {
	input?: string; // Content to write to stdin
}

// Maximum buffer size for command output (10MB)
const EXEC_MAX_BUFFER = 10 * 1024 * 1024;

export interface ExecResult {
	stdout: string;
	stderr: string;
	/**
	 * The exit code of the process.
	 * - A number (0 for success, non-zero for failure) when the process ran and exited
	 * - A string error code ('ENOENT', 'EPERM', 'EACCES', etc.) when the process couldn't be spawned
	 */
	exitCode: number | string;
}

/**
 * Determine if a command needs shell execution on Windows
 * - Batch files (.cmd, .bat) always need shell
 * - Commands without extensions need PATHEXT resolution via shell
 * - Executables (.exe, .com) can run directly
 */
function needsWindowsShell(command: string): boolean {
	const lowerCommand = command.toLowerCase();

	// Batch files always need shell
	if (lowerCommand.endsWith('.cmd') || lowerCommand.endsWith('.bat')) {
		return true;
	}

	// Known executables don't need shell
	if (lowerCommand.endsWith('.exe') || lowerCommand.endsWith('.com')) {
		return false;
	}

	// Commands without extension need shell for PATHEXT resolution
	const hasExtension = path.extname(command).length > 0;
	return !hasExtension;
}

/**
 * Safely execute a command without shell injection vulnerabilities
 * Uses execFile instead of exec to prevent shell interpretation
 *
 * On Windows, batch files and commands without extensions are handled
 * by enabling shell mode, since execFile cannot directly execute them.
 *
 * @param command - The command to execute
 * @param args - Arguments to pass to the command
 * @param cwd - Working directory for the command
 * @param options - Additional options (input for stdin, env for environment)
 */
export async function execFileNoThrow(
	command: string,
	args: string[] = [],
	cwd?: string,
	options?: ExecOptions | NodeJS.ProcessEnv
): Promise<ExecResult> {
	// Handle backward compatibility: options can be env (old signature) or ExecOptions (new)
	let env: NodeJS.ProcessEnv | undefined;
	let input: string | undefined;

	if (options) {
		if ('input' in options) {
			// New signature with ExecOptions
			input = options.input;
		} else {
			// Old signature with just env
			env = options as NodeJS.ProcessEnv;
		}
	}

	// If input is provided, use spawn instead of execFile to write to stdin
	if (input !== undefined) {
		return execFileWithInput(command, args, cwd, input);
	}

	try {
		// On Windows, some commands need shell execution
		// This is safe because we're executing a specific file path, not user input
		const isWindows = process.platform === 'win32';
		const useShell = isWindows && needsWindowsShell(command);

		const { stdout, stderr } = await execFileAsync(command, args, {
			cwd,
			env,
			encoding: 'utf8',
			maxBuffer: EXEC_MAX_BUFFER,
			shell: useShell,
		});

		return {
			stdout,
			stderr,
			exitCode: 0,
		};
	} catch (error: any) {
		// execFile throws on non-zero exit codes
		// Use ?? instead of || to correctly handle exit code 0 (which is falsy but valid)
		return {
			stdout: error.stdout || '',
			stderr: error.stderr || error.message || '',
			exitCode: error.code ?? 1,
		};
	}
}

/**
 * Execute a command with input written to stdin
 * Uses spawn to allow writing to the process stdin
 */
async function execFileWithInput(
	command: string,
	args: string[],
	cwd: string | undefined,
	input: string
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const isWindows = process.platform === 'win32';
		const useShell = isWindows && needsWindowsShell(command);

		const child = spawn(command, args, {
			cwd,
			shell: useShell,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		let stdout = '';
		let stderr = '';

		child.stdout?.on('data', (data) => {
			stdout += data.toString();
		});

		child.stderr?.on('data', (data) => {
			stderr += data.toString();
		});

		child.on('close', (code) => {
			resolve({
				stdout,
				stderr,
				exitCode: code ?? 1,
			});
		});

		child.on('error', (err) => {
			resolve({
				stdout: '',
				stderr: err.message,
				exitCode: 1,
			});
		});

		// Write input to stdin and close it
		if (child.stdin) {
			child.stdin.write(input);
			child.stdin.end();
		}
	});
}
