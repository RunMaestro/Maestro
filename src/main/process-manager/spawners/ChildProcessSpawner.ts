// src/main/process-manager/spawners/ChildProcessSpawner.ts

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';
import { logger } from '../../utils/logger';
import { getOutputParser } from '../../parsers';
import { getAgentCapabilities } from '../../agent-capabilities';
import type { ProcessConfig, ManagedProcess, SpawnResult } from '../types';
import type { DataBufferManager } from '../handlers/DataBufferManager';
import { StdoutHandler } from '../handlers/StdoutHandler';
import { StderrHandler } from '../handlers/StderrHandler';
import { ExitHandler } from '../handlers/ExitHandler';
import { buildChildProcessEnv } from '../utils/envBuilder';
import { saveImageToTempFile } from '../utils/imageUtils';
import { buildStreamJsonMessage } from '../utils/streamJsonBuilder';

/**
 * Handles spawning of child processes (non-PTY).
 * Used for AI agents in batch mode and interactive mode.
 */
export class ChildProcessSpawner {
	private stdoutHandler: StdoutHandler;
	private stderrHandler: StderrHandler;
	private exitHandler: ExitHandler;

	constructor(
		private processes: Map<string, ManagedProcess>,
		private emitter: EventEmitter,
		private bufferManager: DataBufferManager
	) {
		this.stdoutHandler = new StdoutHandler({
			processes: this.processes,
			emitter: this.emitter,
			bufferManager: this.bufferManager,
		});
		this.stderrHandler = new StderrHandler({
			processes: this.processes,
			emitter: this.emitter,
		});
		this.exitHandler = new ExitHandler({
			processes: this.processes,
			emitter: this.emitter,
			bufferManager: this.bufferManager,
		});
	}

	/**
	 * Spawn a child process for a session
	 */
	spawn(config: ProcessConfig): SpawnResult {
		const {
			sessionId,
			toolType,
			cwd,
			command,
			args,
			prompt,
			images,
			imageArgs,
			promptArgs,
			contextWindow,
			customEnvVars,
			noPromptSeparator,
		} = config;

		const isWindows = process.platform === 'win32';
		const hasImages = images && images.length > 0;
		const capabilities = getAgentCapabilities(toolType);

		// Build final args based on batch mode and images
		let finalArgs: string[];
		let tempImageFiles: string[] = [];

		if (hasImages && prompt && capabilities.supportsStreamJsonInput) {
			// For agents that support stream-json input (like Claude Code)
			finalArgs = [...args, '--input-format', 'stream-json'];
		} else if (hasImages && prompt && imageArgs) {
			// For agents that use file-based image args (like Codex, OpenCode)
			finalArgs = [...args];
			tempImageFiles = [];
			for (let i = 0; i < images.length; i++) {
				const tempPath = saveImageToTempFile(images[i], i);
				if (tempPath) {
					tempImageFiles.push(tempPath);
					finalArgs = [...finalArgs, ...imageArgs(tempPath)];
				}
			}
			// Add the prompt using promptArgs if available, otherwise as positional arg
			if (promptArgs) {
				finalArgs = [...finalArgs, ...promptArgs(prompt)];
			} else if (noPromptSeparator) {
				finalArgs = [...finalArgs, prompt];
			} else {
				finalArgs = [...finalArgs, '--', prompt];
			}
			logger.debug('[ProcessManager] Using file-based image args', 'ProcessManager', {
				sessionId,
				imageCount: images.length,
				tempFiles: tempImageFiles,
			});
		} else if (prompt) {
			// Regular batch mode - prompt as CLI arg
			if (promptArgs) {
				finalArgs = [...args, ...promptArgs(prompt)];
			} else if (noPromptSeparator) {
				finalArgs = [...args, prompt];
			} else {
				finalArgs = [...args, '--', prompt];
			}
		} else {
			finalArgs = args;
		}

		// Log spawn config
		const spawnConfigLogFn = isWindows ? logger.info.bind(logger) : logger.debug.bind(logger);
		spawnConfigLogFn('[ProcessManager] spawn() config', 'ProcessManager', {
			sessionId,
			toolType,
			platform: process.platform,
			hasPrompt: !!prompt,
			promptLength: prompt?.length,
			promptPreview:
				prompt && isWindows
					? {
							first100: prompt.substring(0, 100),
							last100: prompt.substring(Math.max(0, prompt.length - 100)),
						}
					: undefined,
			hasImages,
			hasImageArgs: !!imageArgs,
			tempImageFilesCount: tempImageFiles.length,
			command,
			commandHasExtension: path.extname(command).length > 0,
			baseArgsCount: args.length,
			finalArgsCount: finalArgs.length,
		});

		try {
			// Build environment
			const isResuming = finalArgs.includes('--resume') || finalArgs.includes('--session');
			const env = buildChildProcessEnv(customEnvVars, isResuming);

			logger.debug('[ProcessManager] About to spawn child process', 'ProcessManager', {
				command,
				finalArgs,
				cwd,
				PATH: env.PATH?.substring(0, 150),
				hasStdio: 'default (pipe)',
			});

			// Handle Windows shell requirements
			const spawnCommand = command;
			let spawnArgs = finalArgs;
			let useShell = false;

			if (isWindows) {
				const lowerCommand = command.toLowerCase();
				// Use shell for batch files
				if (lowerCommand.endsWith('.cmd') || lowerCommand.endsWith('.bat')) {
					useShell = true;
					logger.debug(
						'[ProcessManager] Using shell=true for Windows batch file',
						'ProcessManager',
						{ command }
					);
				} else if (!lowerCommand.endsWith('.exe') && !lowerCommand.endsWith('.com')) {
					// Check if the command has any extension at all
					const hasExtension = path.extname(command).length > 0;
					if (!hasExtension) {
						useShell = true;
						logger.debug(
							'[ProcessManager] Using shell=true for Windows command without extension',
							'ProcessManager',
							{ command }
						);
					}
				}

				// Escape arguments for cmd.exe when using shell
				if (useShell) {
					spawnArgs = finalArgs.map((arg) => {
						const needsQuoting = /[ &|<>^%!()"\n\r#?*]/.test(arg) || arg.length > 100;
						if (needsQuoting) {
							const escaped = arg.replace(/"/g, '""').replace(/\^/g, '^^');
							return `"${escaped}"`;
						}
						return arg;
					});
					logger.info('[ProcessManager] Escaped args for Windows shell', 'ProcessManager', {
						originalArgsCount: finalArgs.length,
						escapedArgsCount: spawnArgs.length,
						escapedPromptArgLength: spawnArgs[spawnArgs.length - 1]?.length,
						escapedPromptArgPreview: spawnArgs[spawnArgs.length - 1]?.substring(0, 200),
						argsModified: finalArgs.some((arg, i) => arg !== spawnArgs[i]),
					});
				}
			}

			// Log spawn details
			const spawnLogFn = isWindows ? logger.info.bind(logger) : logger.debug.bind(logger);
			spawnLogFn('[ProcessManager] About to spawn with shell option', 'ProcessManager', {
				sessionId,
				spawnCommand,
				useShell,
				isWindows,
				argsCount: spawnArgs.length,
				promptArgLength: prompt ? spawnArgs[spawnArgs.length - 1]?.length : undefined,
				fullCommandPreview: `${spawnCommand} ${spawnArgs.slice(0, 5).join(' ')}${spawnArgs.length > 5 ? ' ...' : ''}`,
			});

			const childProcess = spawn(spawnCommand, spawnArgs, {
				cwd,
				env,
				shell: useShell,
				stdio: ['pipe', 'pipe', 'pipe'],
			});

			logger.debug('[ProcessManager] Child process spawned', 'ProcessManager', {
				sessionId,
				pid: childProcess.pid,
				hasStdout: !!childProcess.stdout,
				hasStderr: !!childProcess.stderr,
				hasStdin: !!childProcess.stdin,
				killed: childProcess.killed,
				exitCode: childProcess.exitCode,
			});

			const isBatchMode = !!prompt;
			// Detect JSON streaming mode from args
			const argsContain = (pattern: string) => finalArgs.some((arg) => arg.includes(pattern));
			const isStreamJsonMode =
				argsContain('stream-json') ||
				argsContain('--json') ||
				(argsContain('--format') && argsContain('json')) ||
				(hasImages && !!prompt);

			// Get the output parser for this agent type
			const outputParser = getOutputParser(toolType) || undefined;

			logger.debug('[ProcessManager] Output parser lookup', 'ProcessManager', {
				sessionId,
				toolType,
				hasParser: !!outputParser,
				parserId: outputParser?.agentId,
				isStreamJsonMode,
				isBatchMode,
				argsPreview:
					finalArgs.length > 0 ? finalArgs[finalArgs.length - 1]?.substring(0, 200) : undefined,
			});

			const managedProcess: ManagedProcess = {
				sessionId,
				toolType,
				childProcess,
				cwd,
				pid: childProcess.pid || -1,
				isTerminal: false,
				isBatchMode,
				isStreamJsonMode,
				jsonBuffer: isBatchMode ? '' : undefined,
				startTime: Date.now(),
				outputParser,
				stderrBuffer: '',
				stdoutBuffer: '',
				contextWindow,
				tempImageFiles: tempImageFiles.length > 0 ? tempImageFiles : undefined,
				command,
				args: finalArgs,
				querySource: config.querySource,
				tabId: config.tabId,
				projectPath: config.projectPath,
				sshRemoteId: config.sshRemoteId,
				sshRemoteHost: config.sshRemoteHost,
			};

			this.processes.set(sessionId, managedProcess);

			logger.debug('[ProcessManager] Setting up stdout/stderr/exit handlers', 'ProcessManager', {
				sessionId,
				hasStdout: childProcess.stdout ? 'exists' : 'null',
				hasStderr: childProcess.stderr ? 'exists' : 'null',
			});

			// Handle stdin errors
			if (childProcess.stdin) {
				childProcess.stdin.on('error', (err) => {
					const errorCode = (err as NodeJS.ErrnoException).code;
					if (errorCode === 'EPIPE') {
						logger.debug(
							'[ProcessManager] stdin EPIPE - process closed before write completed',
							'ProcessManager',
							{ sessionId }
						);
					} else {
						logger.error('[ProcessManager] stdin error', 'ProcessManager', {
							sessionId,
							error: String(err),
							code: errorCode,
						});
					}
				});
			}

			// Handle stdout
			if (childProcess.stdout) {
				logger.debug('[ProcessManager] Attaching stdout data listener', 'ProcessManager', {
					sessionId,
				});
				childProcess.stdout.setEncoding('utf8');
				childProcess.stdout.on('error', (err) => {
					logger.error('[ProcessManager] stdout error', 'ProcessManager', {
						sessionId,
						error: String(err),
					});
				});
				childProcess.stdout.on('data', (data: Buffer | string) => {
					const output = data.toString();

					// Debug: Log all stdout data for group chat sessions
					if (sessionId.includes('group-chat-')) {
						console.log(
							`[GroupChat:Debug:ProcessManager] STDOUT received for session ${sessionId}`
						);
						console.log(`[GroupChat:Debug:ProcessManager] Raw output length: ${output.length}`);
						console.log(
							`[GroupChat:Debug:ProcessManager] Raw output preview: "${output.substring(0, 500)}${output.length > 500 ? '...' : ''}"`
						);
					}

					this.stdoutHandler.handleData(sessionId, output);
				});
			} else {
				logger.warn('[ProcessManager] childProcess.stdout is null', 'ProcessManager', {
					sessionId,
				});
			}

			// Handle stderr
			if (childProcess.stderr) {
				logger.debug('[ProcessManager] Attaching stderr data listener', 'ProcessManager', {
					sessionId,
				});
				childProcess.stderr.setEncoding('utf8');
				childProcess.stderr.on('error', (err) => {
					logger.error('[ProcessManager] stderr error', 'ProcessManager', {
						sessionId,
						error: String(err),
					});
				});
				childProcess.stderr.on('data', (data: Buffer | string) => {
					const stderrData = data.toString();

					// Debug: Log all stderr data for group chat sessions
					if (sessionId.includes('group-chat-')) {
						console.log(
							`[GroupChat:Debug:ProcessManager] STDERR received for session ${sessionId}`
						);
						console.log(`[GroupChat:Debug:ProcessManager] Stderr length: ${stderrData.length}`);
						console.log(
							`[GroupChat:Debug:ProcessManager] Stderr preview: "${stderrData.substring(0, 500)}${stderrData.length > 500 ? '...' : ''}"`
						);
					}

					this.stderrHandler.handleData(sessionId, stderrData);
				});
			}

			// Handle exit
			childProcess.on('exit', (code) => {
				this.exitHandler.handleExit(sessionId, code || 0);
			});

			// Handle errors
			childProcess.on('error', (error) => {
				this.exitHandler.handleError(sessionId, error);
			});

			// Handle stdin for batch mode
			if (isStreamJsonMode && prompt && images) {
				// Stream-json mode with images: send the message via stdin
				const streamJsonMessage = buildStreamJsonMessage(prompt, images);
				logger.debug('[ProcessManager] Sending stream-json message with images', 'ProcessManager', {
					sessionId,
					messageLength: streamJsonMessage.length,
					imageCount: images.length,
				});
				childProcess.stdin?.write(streamJsonMessage + '\n');
				childProcess.stdin?.end();
			} else if (isBatchMode) {
				// Regular batch mode: close stdin immediately
				logger.debug('[ProcessManager] Closing stdin for batch mode', 'ProcessManager', {
					sessionId,
				});
				childProcess.stdin?.end();
			}

			return { pid: childProcess.pid || -1, success: true };
		} catch (error) {
			logger.error('[ProcessManager] Failed to spawn process', 'ProcessManager', {
				error: String(error),
			});
			return { pid: -1, success: false };
		}
	}
}
