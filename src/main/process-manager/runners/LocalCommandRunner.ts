// src/main/process-manager/runners/LocalCommandRunner.ts

import { spawn } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import { logger } from '../../utils/logger';
import type { CommandResult } from '../types';
import { buildUnixBasePath } from '../utils/envBuilder';
import { resolveShellPath, buildWrappedCommand } from '../utils/pathResolver';

/**
 * Runs single commands locally and captures stdout/stderr cleanly.
 * Does NOT use PTY - spawns commands directly via shell -c.
 */
export class LocalCommandRunner {
	constructor(private emitter: EventEmitter) {}

	/**
	 * Run a single command and capture stdout/stderr cleanly
	 */
	run(
		sessionId: string,
		command: string,
		cwd: string,
		shell?: string,
		shellEnvVars?: Record<string, string>
	): Promise<CommandResult> {
		return new Promise((resolve) => {
			const isWindows = process.platform === 'win32';
			const defaultShell = isWindows ? 'powershell.exe' : 'bash';
			const shellToUse = shell || defaultShell;

			logger.debug('[ProcessManager] runCommand()', 'ProcessManager', {
				sessionId,
				command,
				cwd,
				shell: shellToUse,
				hasEnvVars: !!shellEnvVars,
				isWindows,
			});

			// Build the command with shell config sourcing
			const shellName =
				shellToUse
					.split(/[/\\]/)
					.pop()
					?.replace(/\.exe$/i, '') || shellToUse;

			const wrappedCommand = buildWrappedCommand(command, shellName);

			// Build environment for command execution
			let env: NodeJS.ProcessEnv;

			if (isWindows) {
				// Windows: Inherit full parent environment
				env = {
					...process.env,
					TERM: 'xterm-256color',
				};
			} else {
				// Unix: Use minimal env - shell startup files handle PATH setup
				const basePath = buildUnixBasePath();
				env = {
					HOME: process.env.HOME,
					USER: process.env.USER,
					SHELL: process.env.SHELL,
					TERM: 'xterm-256color',
					LANG: process.env.LANG || 'en_US.UTF-8',
					PATH: basePath,
				};
			}

			// Apply custom shell environment variables from user configuration
			if (shellEnvVars && Object.keys(shellEnvVars).length > 0) {
				const homeDir = os.homedir();
				for (const [key, value] of Object.entries(shellEnvVars)) {
					env[key] = value.startsWith('~/') ? path.join(homeDir, value.slice(2)) : value;
				}
				logger.debug('[ProcessManager] Applied custom shell env vars to runCommand', 'ProcessManager', {
					keys: Object.keys(shellEnvVars),
				});
			}

			// Resolve shell to full path
			const shellPath = resolveShellPath(shellToUse);

			logger.debug('[ProcessManager] runCommand spawning', 'ProcessManager', {
				shell: shellToUse,
				shellPath,
				wrappedCommand,
				cwd,
				PATH: env.PATH?.substring(0, 100),
			});

			const childProcess = spawn(wrappedCommand, [], {
				cwd,
				env,
				shell: shellPath,
			});

			// Handle stdout - emit data events for real-time streaming
			childProcess.stdout?.on('data', (data: Buffer) => {
				let output = data.toString();
				logger.debug('[ProcessManager] runCommand stdout RAW', 'ProcessManager', {
					sessionId,
					rawLength: output.length,
					rawPreview: output.substring(0, 200),
				});

				// Filter out shell integration sequences
				output = output.replace(/\x1b?\]1337;[^\x07\x1b\n]*(\x07|\x1b\\)?/g, '');
				output = output.replace(/\x1b?\]133;[^\x07\x1b\n]*(\x07|\x1b\\)?/g, '');
				output = output.replace(/\x1b?\]7;[^\x07\x1b\n]*(\x07|\x1b\\)?/g, '');
				output = output.replace(/\x1b?\][0-9];[^\x07\x1b\n]*(\x07|\x1b\\)?/g, '');

				logger.debug('[ProcessManager] runCommand stdout FILTERED', 'ProcessManager', {
					sessionId,
					filteredLength: output.length,
					filteredPreview: output.substring(0, 200),
					trimmedEmpty: !output.trim(),
				});

				// Only emit if there's actual content after filtering
				if (output.trim()) {
					logger.debug('[ProcessManager] runCommand EMITTING data event', 'ProcessManager', {
						sessionId,
						outputLength: output.length,
					});
					this.emitter.emit('data', sessionId, output);
				} else {
					logger.debug('[ProcessManager] runCommand SKIPPED emit (empty after trim)', 'ProcessManager', {
						sessionId,
					});
				}
			});

			// Handle stderr
			childProcess.stderr?.on('data', (data: Buffer) => {
				const output = data.toString();
				this.emitter.emit('stderr', sessionId, output);
			});

			// Handle process exit
			childProcess.on('exit', (code) => {
				logger.debug('[ProcessManager] runCommand exit', 'ProcessManager', {
					sessionId,
					exitCode: code,
				});
				this.emitter.emit('command-exit', sessionId, code || 0);
				resolve({ exitCode: code || 0 });
			});

			// Handle errors
			childProcess.on('error', (error) => {
				logger.error('[ProcessManager] runCommand error', 'ProcessManager', {
					sessionId,
					error: error.message,
				});
				this.emitter.emit('stderr', sessionId, `Error: ${error.message}`);
				this.emitter.emit('command-exit', sessionId, 1);
				resolve({ exitCode: 1 });
			});
		});
	}
}
