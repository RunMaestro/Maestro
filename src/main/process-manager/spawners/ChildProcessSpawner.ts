// src/main/process-manager/spawners/ChildProcessSpawner.ts

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../../utils/logger';
import { getOutputParser } from '../../parsers';
import { getAgentCapabilities } from '../../agents';
import type { ProcessConfig, ManagedProcess, SpawnResult } from '../types';
import type { DataBufferManager } from '../handlers/DataBufferManager';
import { StdoutHandler } from '../handlers/StdoutHandler';
import { StderrHandler } from '../handlers/StderrHandler';
import { ExitHandler } from '../handlers/ExitHandler';
import { buildChildProcessEnv } from '../utils/envBuilder';
import { saveImageToTempFile, buildImagePromptPrefix } from '../utils/imageUtils';
import { buildStreamJsonMessage } from '../utils/streamJsonBuilder';
import { escapeArgsForShell, isPowerShellShell } from '../utils/shellEscape';

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
			sendPromptViaStdin,
			sendPromptViaStdinRaw,
		} = config;

		const isWindows = process.platform === 'win32';
		const hasImages = images && images.length > 0;
		const capabilities = getAgentCapabilities(toolType);

		// Check if prompt will be sent via stdin instead of command line
		// This is critical for SSH remote execution to avoid shell escaping issues
		// Also critical on Windows: when using stream-json output mode, the prompt is sent
		// via stdin (see stream-json stdin write below). Adding it as a CLI arg too would
		// exceed cmd.exe's ~8191 character command line limit, causing immediate exit code 1.
		//
		// IMPORTANT: Only match --input-format stream-json, NOT --output-format stream-json.
		// Matching --output-format caused promptViaStdin to be always true for Claude Code
		// (whose default args include --output-format stream-json), which prevented
		// --input-format stream-json from being added when sending images, causing Claude
		// to interpret the raw JSON+base64 blob as plain text and blow the token limit.
		const argsHaveInputStreamJson = args.some(
			(arg, i) => arg === 'stream-json' && i > 0 && args[i - 1] === '--input-format'
		);
		const promptViaStdin = sendPromptViaStdin || sendPromptViaStdinRaw || argsHaveInputStreamJson;

		// Build final args based on batch mode and images
		// Track whether the prompt was added to CLI args (used later to decide stdin behavior)
		let finalArgs: string[];
		let tempImageFiles: string[] = [];
		// effectivePrompt may be modified (e.g., image path prefix prepended for resume mode)
		let effectivePrompt = prompt;
		let promptAddedToArgs = false;

		if (hasImages && prompt && capabilities.supportsStreamJsonInput) {
			// For agents that support stream-json input (like Claude Code)
			// Always add --input-format stream-json when sending images via stdin.
			// This flag is required for Claude Code to parse the JSON+base64 message
			// correctly; without it, the raw JSON is treated as plain text prompt.
			const needsInputFormat = !args.includes('--input-format')
				? ['--input-format', 'stream-json']
				: [];
			finalArgs = [...args, ...needsInputFormat];
			// Prompt will be sent via stdin as stream-json with embedded images (not in CLI args)
		} else if (hasImages && prompt && imageArgs) {
			// For agents that use file-based image args (like Codex, OpenCode)
			finalArgs = [...args];
			tempImageFiles = [];
			for (let i = 0; i < images.length; i++) {
				const tempPath = saveImageToTempFile(images[i], i);
				if (tempPath) {
					tempImageFiles.push(tempPath);
				}
			}

			const isResumeWithPromptEmbed = capabilities.imageResumeMode === 'prompt-embed'
				&& args.some(a => a === 'resume');

			if (isResumeWithPromptEmbed) {
				// Resume mode: embed file paths in prompt text, don't use -i flag
				const imagePrefix = buildImagePromptPrefix(tempImageFiles);
				effectivePrompt = imagePrefix + prompt;
				if (!promptViaStdin) {
					if (promptArgs) {
						finalArgs = [...finalArgs, ...promptArgs(effectivePrompt)];
					} else if (noPromptSeparator) {
						finalArgs = [...finalArgs, effectivePrompt];
					} else {
						finalArgs = [...finalArgs, '--', effectivePrompt];
					}
					promptAddedToArgs = true;
				}
				logger.debug('[ProcessManager] Resume mode: embedded image paths in prompt', 'ProcessManager', {
					sessionId,
					imageCount: images.length,
					tempFiles: tempImageFiles,
					promptViaStdin,
				});
			} else {
				// Initial spawn: use -i flag as before
				for (const tempPath of tempImageFiles) {
					finalArgs = [...finalArgs, ...imageArgs(tempPath)];
				}
				if (!promptViaStdin) {
					if (promptArgs) {
						finalArgs = [...finalArgs, ...promptArgs(prompt)];
					} else if (noPromptSeparator) {
						finalArgs = [...finalArgs, prompt];
					} else {
						finalArgs = [...finalArgs, '--', prompt];
					}
					promptAddedToArgs = true;
				}
				logger.debug('[ProcessManager] Using file-based image args', 'ProcessManager', {
					sessionId,
					imageCount: images.length,
					tempFiles: tempImageFiles,
					promptViaStdin,
				});
			}
		} else if (prompt && !promptViaStdin) {
			// Regular batch mode - prompt as CLI arg
			// SKIP this when prompt is sent via stdin to avoid shell escaping issues
			if (promptArgs) {
				finalArgs = [...args, ...promptArgs(prompt)];
			} else if (noPromptSeparator) {
				finalArgs = [...args, prompt];
			} else {
				finalArgs = [...args, '--', prompt];
			}
			promptAddedToArgs = true;
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
			// Respect explicit request from caller, but also be defensive: if caller
			// did not set runInShell and we're on Windows with a bare .exe basename,
			// enable shell so PATH resolution occurs. This avoids ENOENT when callers
			// rewrite the command to basename (or pass a basename) but forget to set
			// the runInShell flag.
			let useShell = !!config.runInShell;

			// Auto-enable shell for Windows when command is a bare .exe (no path)
			const commandHasPath = /\\|\//.test(spawnCommand);
			const commandExt = path.extname(spawnCommand).toLowerCase();
			if (isWindows && !useShell && !commandHasPath && commandExt === '.exe') {
				useShell = true;
				logger.info(
					'[ProcessManager] Auto-enabling shell for Windows to allow PATH resolution of basename exe',
					'ProcessManager',
					{ command: spawnCommand }
				);
			}

			// Auto-enable shell for Windows when command is a shell script (extensionless with shebang)
			// This handles tools like OpenCode installed via npm with shell scripts
			if (isWindows && !useShell && !commandExt && commandHasPath) {
				try {
					const fileContent = fs.readFileSync(spawnCommand, 'utf8');
					if (fileContent.startsWith('#!')) {
						useShell = true;
						logger.info(
							'[ProcessManager] Auto-enabling shell for Windows to execute shell script',
							'ProcessManager',
							{ command: spawnCommand, shebang: fileContent.split('\n')[0] }
						);
					}
				} catch {
					// If we can't read the file, just continue without special handling
				}
			}

			if (isWindows && useShell) {
				logger.debug(
					'[ProcessManager] Forcing shell=true for agent spawn on Windows (runInShell or auto)',
					'ProcessManager',
					{ command: spawnCommand }
				);

				// Use the shell escape utility for proper argument escaping
				const shellPath = typeof config.shell === 'string' ? config.shell : undefined;
				spawnArgs = escapeArgsForShell(finalArgs, shellPath);

				const shellType = isPowerShellShell(shellPath) ? 'PowerShell' : 'cmd.exe';
				logger.info(`[ProcessManager] Escaped args for ${shellType}`, 'ProcessManager', {
					originalArgsCount: finalArgs.length,
					escapedArgsCount: spawnArgs.length,
					escapedPromptArgLength: spawnArgs[spawnArgs.length - 1]?.length,
					escapedPromptArgPreview: spawnArgs[spawnArgs.length - 1]?.substring(0, 200),
					argsModified: finalArgs.some((arg, i) => arg !== spawnArgs[i]),
				});
			}

			// Determine shell option to pass to child_process.spawn.
			// If the caller provided a specific shell path, prefer that (string).
			// Otherwise pass a boolean indicating whether to use the default shell.
			let spawnShell: boolean | string = !!useShell;
			if (useShell && typeof config.shell === 'string' && config.shell.trim()) {
				spawnShell = config.shell.trim();
			}

			// Log spawn details
			const spawnLogFn = isWindows ? logger.info.bind(logger) : logger.debug.bind(logger);
			spawnLogFn('[ProcessManager] About to spawn with shell option', 'ProcessManager', {
				sessionId,
				spawnCommand,
				// show the actual shell value passed to spawn (boolean or shell path)
				spawnShell: typeof spawnShell === 'string' ? spawnShell : !!spawnShell,
				isWindows,
				argsCount: spawnArgs.length,
				promptArgLength: prompt ? spawnArgs[spawnArgs.length - 1]?.length : undefined,
				fullCommandPreview: `${spawnCommand} ${spawnArgs.join(' ')}`,
			});

			const childProcess = spawn(spawnCommand, spawnArgs, {
				cwd,
				env,
				shell: spawnShell,
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
			// Detect JSON streaming mode from args or config flag
			// IMPORTANT: SSH stdin script mode (sshStdinScript) MUST enable stream-json parsing
			// because the SSH command wraps the actual agent command. Without this, the output
			// parser won't process JSON output from remote agents, causing raw JSON to display.
			// NOTE: sendPromptViaStdinRaw sends RAW text (not JSON), so it should NOT set isStreamJsonMode
			const argsContain = (pattern: string) => finalArgs.some((arg) => arg.includes(pattern));
			const isStreamJsonMode =
				argsContain('stream-json') ||
				argsContain('--json') ||
				(argsContain('--format') && argsContain('json')) ||
				(hasImages && !!prompt) ||
				!!config.sendPromptViaStdin ||
				!!config.sshStdinScript;

			// Get the output parser for this agent type
			const outputParser = getOutputParser(toolType) || undefined;

			logger.debug('[ProcessManager] Output parser lookup', 'ProcessManager', {
				sessionId,
				toolType,
				hasParser: !!outputParser,
				parserId: outputParser?.agentId,
				isStreamJsonMode,
				isBatchMode,
				hasSshStdinScript: !!config.sshStdinScript,
				command: config.command,
				argsCount: finalArgs.length,
				argsPreview:
					finalArgs.length > 0 ? finalArgs[finalArgs.length - 1]?.substring(0, 500) : undefined,
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

			// Handle close (NOT exit) to ensure all stdout/stderr data is fully consumed.
			// The 'exit' event can fire before the stdio streams have been drained,
			// which causes data loss for short-lived processes where the result is
			// emitted near the end of stdout (e.g., tab-naming, batch operations).
			// The 'close' event guarantees all stdio streams are closed first.
			childProcess.on('close', (code) => {
				this.exitHandler.handleExit(sessionId, code || 0);
			});

			// Handle errors
			childProcess.on('error', (error) => {
				this.exitHandler.handleError(sessionId, error);
			});

			if (config.sshStdinScript) {
				// SSH stdin script mode: send the entire script to /bin/bash on remote
				// This bypasses all shell escaping issues by piping the script via stdin
				logger.debug('[ProcessManager] Sending SSH stdin script', 'ProcessManager', {
					sessionId,
					scriptLength: config.sshStdinScript.length,
				});
				childProcess.stdin?.write(config.sshStdinScript);
				childProcess.stdin?.end();
			} else if (config.sendPromptViaStdinRaw && effectivePrompt) {
				// Raw stdin mode: send prompt as literal text (non-stream-json agents on Windows)
				// Note: When sending via stdin, PowerShell treats the input as literal text,
				// NOT as code to parse. No escaping is needed for special characters.
				logger.debug('[ProcessManager] Sending raw prompt via stdin', 'ProcessManager', {
					sessionId,
					promptLength: effectivePrompt.length,
				});
				childProcess.stdin?.write(effectivePrompt);
				childProcess.stdin?.end();
			} else if (isStreamJsonMode && effectivePrompt && !promptAddedToArgs) {
				// Stream-json mode: send the message via stdin as JSON.
				// Only write when prompt was NOT already added to CLI args.
				// Without this guard, agents like Codex (whose --json flag sets isStreamJsonMode
				// for output parsing) would receive the prompt both as a CLI arg and as stream-json
				// stdin, causing unexpected behavior.
				const streamJsonMessage = buildStreamJsonMessage(effectivePrompt, images || []);
				logger.debug('[ProcessManager] Sending stream-json message via stdin', 'ProcessManager', {
					sessionId,
					messageLength: streamJsonMessage.length,
					imageCount: (images || []).length,
					hasImages: !!(images && images.length > 0),
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
