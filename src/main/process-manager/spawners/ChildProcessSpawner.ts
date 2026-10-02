// src/main/process-manager/spawners/ChildProcessSpawner.ts

import { EventEmitter } from 'events';
import * as path from 'path';
import { logger } from '../../utils/logger';
import { createOutputParser } from '../../parsers';
import { getAgentCapabilities } from '../../agents';
import { getAgentDefinition } from '../../agents/definitions';
import type { ProcessConfig, ManagedProcess, SpawnResult } from '../types';
import type { DataBufferManager } from '../handlers/DataBufferManager';
import { StdoutHandler } from '../handlers/StdoutHandler';
import { StderrHandler } from '../handlers/StderrHandler';
import { ExitHandler } from '../handlers/ExitHandler';
import { buildChildProcessEnv, collectMaestroEnvVars } from '../utils/envBuilder';
import { buildPromptArgv } from '../../../shared/maestro-lib/launch/prompt-delivery';
import { DEFAULT_QUERY_SOURCE } from '../../../shared/querySource';
import {
	saveImageToTempFile,
	savePromptToTempFile,
	buildImagePromptPrefix,
} from '../utils/imageUtils';
import { buildStreamJsonMessage } from '../utils/streamJsonBuilder';
import { escapeArgsForShell, isPowerShellShell } from '../utils/shellEscape';
import { isWindows } from '../../../shared/platformDetection';
import {
	quoteCommandForCmdShell,
	windowsShellReason,
	type WindowsShellReason,
} from '../../../shared/maestro-lib/launch/windows-command';
import { captureException } from '../../utils/sentry';
import { nextSpawnGeneration, isSupersededGeneration } from '../generation';
import { startTurn } from '../../../shared/maestro-lib/run/start-turn';
import { INTERACTIVE_STOP_GRACE_MS } from '../../../shared/maestro-lib/control/termination';

// The log line each Windows shell promotion writes (see windowsShellReason).
const WINDOWS_SHELL_LOG_MESSAGES: Record<WindowsShellReason, string> = {
	'bare-exe':
		'[ProcessManager] Auto-enabling shell for Windows to allow PATH resolution of basename exe',
	'batch-file': '[ProcessManager] Auto-enabling shell for Windows to spawn batch-file command',
	'shebang-script': '[ProcessManager] Auto-enabling shell for Windows to execute shell script',
};

/** Prompts longer than this go through a file on Windows; well under PowerShell's ~32K argv cap. */
const PROMPT_FILE_THRESHOLD_CHARS = 24_000;

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
			imagePromptBuilder,
			promptArgs,
			promptFileArgs,
			contextWindow,
			ompModelCatalogKey,
			customEnvVars,
			shellEnvVars,
			noPromptSeparator,
			sendPromptViaStdin,
			sendPromptViaStdinRaw,
		} = config;

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
		// If the caller pre-embedded the prompt in args (e.g., SSH tab naming wraps it
		// inside bash -c), skip the appending paths below and treat it as already-added.
		let promptAddedToArgs = !!config.promptAlreadyInArgs;

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
		} else if (hasImages && prompt && (imageArgs || imagePromptBuilder)) {
			// For agents that use file-based image args (like Codex, OpenCode) or
			// prompt-embedded image mentions (like Copilot's @path syntax)
			finalArgs = [...args];
			tempImageFiles = [];
			for (let i = 0; i < images.length; i++) {
				const tempPath = saveImageToTempFile(images[i], i);
				if (tempPath) {
					tempImageFiles.push(tempPath);
				}
			}

			const isResumeWithPromptEmbed =
				capabilities.imageResumeMode === 'prompt-embed' && args.some((a) => a === 'resume');
			const shouldEmbedImagesInPrompt = !!imagePromptBuilder || isResumeWithPromptEmbed;

			if (shouldEmbedImagesInPrompt) {
				// Some agents consume images by mentioning temp file paths inside the prompt
				// instead of accepting a dedicated CLI image flag.
				const imagePrefix = imagePromptBuilder
					? imagePromptBuilder(tempImageFiles)
					: buildImagePromptPrefix(tempImageFiles);
				effectivePrompt = imagePrefix + prompt;
				if (!promptViaStdin) {
					finalArgs = [
						...finalArgs,
						...buildPromptArgv({ promptArgs, noPromptSeparator }, effectivePrompt),
					];
					promptAddedToArgs = true;
				}
				logger.debug('[ProcessManager] Embedded image paths in prompt', 'ProcessManager', {
					sessionId,
					imageCount: images.length,
					tempFiles: tempImageFiles,
					embedMode: imagePromptBuilder ? 'prompt-builder' : 'resume-prompt-embed',
					promptViaStdin,
				});
			} else {
				// Initial spawn: use -i flag as before
				for (const tempPath of tempImageFiles) {
					if (!imageArgs) {
						continue;
					}
					finalArgs = [...finalArgs, ...imageArgs(tempPath)];
				}
				if (!promptViaStdin) {
					finalArgs = [...finalArgs, ...buildPromptArgv({ promptArgs, noPromptSeparator }, prompt)];
					promptAddedToArgs = true;
				}
				logger.debug('[ProcessManager] Using file-based image args', 'ProcessManager', {
					sessionId,
					imageCount: images.length,
					tempFiles: tempImageFiles,
					promptViaStdin,
				});
			}
		} else if (prompt && !promptViaStdin && !promptAddedToArgs) {
			// Regular batch mode - prompt as CLI arg
			// SKIP this when prompt is sent via stdin to avoid shell escaping issues,
			// or when the caller already embedded the prompt in args (promptAlreadyInArgs).
			// On Windows the agent is spawned through PowerShell, whose command line caps at
			// ~32K; a prompt carrying the embedded system prompt exceeds it and spawn fails
			// with ENAMETOOLONG. CLIs that read a prompt from a file get it that way instead.
			const promptFilePath =
				isWindows() && promptFileArgs && prompt.length > PROMPT_FILE_THRESHOLD_CHARS
					? savePromptToTempFile(prompt)
					: null;
			if (promptFilePath && promptFileArgs) {
				tempImageFiles.push(promptFilePath);
				finalArgs = [...args, ...promptFileArgs(promptFilePath)];
				logger.info(
					'[ProcessManager] Delivering long prompt through a temp file',
					'ProcessManager',
					{
						sessionId,
						toolType,
						promptLength: prompt.length,
					}
				);
			} else {
				finalArgs = [...args, ...buildPromptArgv({ promptArgs, noPromptSeparator }, prompt)];
			}
			promptAddedToArgs = true;
		} else {
			finalArgs = args;
		}

		// Some CLIs need an explicit query source to avoid opening their interactive UI.
		// SSH scripts own their remote arguments and must not receive local stdin flags.
		if (
			sendPromptViaStdinRaw &&
			effectivePrompt &&
			!config.sshStdinScript &&
			!config.promptAlreadyInArgs
		) {
			const stdinPromptArgs = getAgentDefinition(toolType)?.stdinPromptArgs;
			if (stdinPromptArgs) finalArgs = [...finalArgs, ...stdinPromptArgs];
		}

		// Log metadata only: prompts and argv can contain private user or playbook text.
		const spawnConfigLogFn = isWindows() ? logger.info.bind(logger) : logger.debug.bind(logger);
		spawnConfigLogFn('[ProcessManager] spawn() config', 'ProcessManager', {
			sessionId,
			toolType,
			platform: process.platform,
			hasPrompt: !!prompt,
			promptLength: prompt?.length,
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
			const isResuming =
				args.some((arg) => arg === '--resume' || arg.startsWith('--resume=')) ||
				args.includes('--session');
			const env = buildChildProcessEnv(
				customEnvVars,
				isResuming,
				shellEnvVars,
				config.extraPathDirs,
				config.querySource
			);

			// Log environment variable application for troubleshooting
			if (shellEnvVars && Object.keys(shellEnvVars).length > 0) {
				const globalVarKeys = Object.keys(shellEnvVars);
				logger.debug('[ProcessManager] Applying global environment variables', 'ProcessManager', {
					sessionId: config.sessionId,
					globalVarCount: globalVarKeys.length,
					globalVarKeys: globalVarKeys.slice(0, 10), // First 10 keys for visibility
					hasCustomVars: !!(customEnvVars && Object.keys(customEnvVars).length > 0),
					customVarCount: customEnvVars ? Object.keys(customEnvVars).length : 0,
				});
			}

			logger.debug('[ProcessManager] About to spawn child process', 'ProcessManager', {
				command,
				argsCount: finalArgs.length,
				cwd,
				PATH: env.PATH?.substring(0, 150),
				hasStdio: 'default (pipe)',
			});

			// Handle Windows shell requirements
			let spawnCommand = command;
			let spawnArgs = finalArgs;
			// Respect explicit request from caller, but also be defensive: if caller
			// did not set runInShell and we're on Windows with a bare .exe basename,
			// enable shell so PATH resolution occurs. This avoids ENOENT when callers
			// rewrite the command to basename (or pass a basename) but forget to set
			// the runInShell flag.
			let useShell = !!config.runInShell;

			// Auto-enable shell for Windows when the command cannot be spawned directly:
			// a bare .exe (PATH resolution), a .cmd/.bat shim (spawn EINVAL since the
			// CVE-2024-27980 fix, MAESTRO-Q8), or an extensionless shebang script. The
			// rules live in maestro-lib's windowsShellReason(); the logging stays here.
			if (isWindows() && !useShell) {
				const { reason, shebang } = windowsShellReason(spawnCommand);
				if (reason) {
					useShell = true;
					logger.info(
						WINDOWS_SHELL_LOG_MESSAGES[reason],
						'ProcessManager',
						shebang !== undefined ? { command: spawnCommand, shebang } : { command: spawnCommand }
					);
				}
			}

			if (isWindows() && useShell) {
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

			// cmd.exe splits an unquoted command path that contains spaces; see
			// quoteCommandForCmdShell() in maestro-lib. Only for the boolean (cmd.exe)
			// shell - an explicit shell string carries its own quoting rules.
			if (isWindows() && spawnShell === true) {
				spawnCommand = quoteCommandForCmdShell(spawnCommand);
			}

			// Log spawn details
			const spawnLogFn = isWindows() ? logger.info.bind(logger) : logger.debug.bind(logger);
			spawnLogFn('[ProcessManager] About to spawn with shell option', 'ProcessManager', {
				sessionId,
				spawnCommand,
				// show the actual shell value passed to spawn (boolean or shell path)
				spawnShell: typeof spawnShell === 'string' ? spawnShell : !!spawnShell,
				isWindows: isWindows(),
				argsCount: spawnArgs.length,
				promptArgLength: prompt ? spawnArgs[spawnArgs.length - 1]?.length : undefined,
			});

			const isBatchMode = !!prompt;
			// Detect JSON streaming mode from args or config flag
			// IMPORTANT: SSH stdin script mode (sshStdinScript) MUST enable stream-json parsing
			// because the SSH command wraps the actual agent command. Without this, the output
			// parser won't process JSON output from remote agents, causing raw JSON to display.
			// NOTE: sendPromptViaStdinRaw sends RAW text (not JSON), so it should NOT set isStreamJsonMode
			// Use the pre-prompt args for detection to avoid false positives from prompt content
			// (e.g., a prompt like "Explain --json" should not flip isStreamJsonMode)
			const cliArgs = promptAddedToArgs ? args : finalArgs;
			const argsContain = (pattern: string) => cliArgs.some((arg) => arg.includes(pattern));
			const argsHaveFlagValue = (flag: string, value: string) =>
				cliArgs.some(
					(arg, index) =>
						arg === `${flag}=${value}` || (arg === flag && cliArgs[index + 1] === value)
				);

			// Create a fresh output parser instance for this process (not the shared singleton)
			// to isolate mutable state like tool name tracking across concurrent sessions
			const outputParser = createOutputParser(toolType) || undefined;

			const isStreamJsonMode =
				argsContain('stream-json') ||
				argsContain('--json') ||
				argsHaveFlagValue('--format', 'json') ||
				argsHaveFlagValue('--output-format', 'json') ||
				(hasImages && !!prompt) ||
				!!config.sendPromptViaStdin ||
				!!config.sshStdinScript ||
				!!outputParser; // Agents with output parsers use streaming JSONL, not batch JSON

			// What travels on stdin, decided before the process exists:
			// - SSH stdin script mode sends the entire script to /bin/bash on the
			//   remote, which bypasses all shell escaping issues.
			// - Raw stdin mode sends the prompt as literal text (non-stream-json
			//   agents on Windows). PowerShell treats the input as literal text, NOT
			//   as code to parse, so no escaping is needed.
			// - Stream-json mode sends the message as JSON, but only when the prompt
			//   was NOT already added to the CLI args. Without that guard, agents like
			//   Codex (whose --json flag sets isStreamJsonMode for output parsing)
			//   would receive the prompt both as a CLI arg and as stream-json stdin.
			// - Anything written here is the whole of what the process gets on
			//   stdin, so stdin is closed behind it. That includes the SSH script
			//   of a turn that carries no local prompt: the remote shell and the
			//   agent it starts both wait for the end of input.
			// - Batch mode with nothing to write closes stdin at once; interactive
			//   mode with nothing to write leaves it open for `ProcessManager.write()`.
			let stdinText: string | undefined;
			if (config.sshStdinScript) {
				stdinText = config.sshStdinScript;
				logger.debug('[ProcessManager] Sending SSH stdin script', 'ProcessManager', {
					sessionId,
					scriptLength: config.sshStdinScript.length,
				});
			} else if (config.sendPromptViaStdinRaw && effectivePrompt) {
				stdinText = effectivePrompt;
				logger.debug('[ProcessManager] Sending raw prompt via stdin', 'ProcessManager', {
					sessionId,
					promptLength: effectivePrompt.length,
				});
			} else if (isStreamJsonMode && effectivePrompt && !promptAddedToArgs) {
				const streamJsonMessage = buildStreamJsonMessage(effectivePrompt, images || []);
				stdinText = streamJsonMessage + '\n';
				logger.debug('[ProcessManager] Sending stream-json message via stdin', 'ProcessManager', {
					sessionId,
					messageLength: streamJsonMessage.length,
					imageCount: (images || []).length,
					hasImages: !!(images && images.length > 0),
				});
			} else if (isBatchMode) {
				logger.debug('[ProcessManager] Closing stdin for batch mode', 'ProcessManager', {
					sessionId,
				});
			}

			// The process is started, streamed and settled by the library's run
			// layer, the same one the CLI and Cue use. Everything the renderer
			// hears is still produced here, from the run layer's callbacks, in the
			// same order as before: raw stdout, then the stdout handler; stderr;
			// then exit. A killed predecessor's late events are dropped by the
			// generation check below. `managedProcess` is built once the process
			// exists; every callback that reads it runs later, from the event loop.
			const isSuperseded = (): boolean =>
				isSupersededGeneration(sessionId, managedProcess.spawnGeneration);

			const turn = startTurn(
				{
					command: spawnCommand,
					args: spawnArgs,
					cwd,
					env,
					stdin: stdinText,
					shell: spawnShell,
				},
				{
					onStdout: (output) => {
						if (isSuperseded()) return;
						// Emit raw stdout before processing for live-streaming consumers (e.g., group chat peek).
						// Wrapped in try/catch so a failing listener cannot prevent stdoutHandler from running.
						try {
							this.emitter.emit('raw-stdout', sessionId, output);
						} catch (err) {
							void captureException(err);
							logger.error('[ProcessManager] raw-stdout listener error', 'ProcessManager', {
								sessionId,
								error: String(err),
							});
						}
						this.stdoutHandler.handleData(sessionId, output);
					},
					onStderr: (stderrData) => {
						if (isSuperseded()) return;
						this.stderrHandler.handleData(sessionId, stderrData);
					},
				},
				{
					// The desktop stops through ProcessManager.interrupt() / kill(),
					// which run the same ladder on this child; the turn's own stop
					// methods are not used here.
					stopGraceMs: INTERACTIVE_STOP_GRACE_MS,
					keepStdinOpen: stdinText === undefined && !isBatchMode,
					// The stdout and stderr handlers keep what the desktop needs; a
					// second copy here would only grow for as long as the process lives.
					stdoutTailLimit: 0,
					stderrTailLimit: 0,
					sessionId,
					label: toolType,
				}
			);
			const childProcess = turn.child;

			// A stream error with no listener is an uncaught exception. stdin's is
			// the common one: EPIPE, from a prompt written to a process that has
			// already gone; the exit that follows reports what happened.
			childProcess.stdin?.on('error', (err) => {
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
			childProcess.stdout?.on('error', (err) => {
				logger.error('[ProcessManager] stdout error', 'ProcessManager', {
					sessionId,
					error: String(err),
				});
			});
			childProcess.stderr?.on('error', (err) => {
				logger.error('[ProcessManager] stderr error', 'ProcessManager', {
					sessionId,
					error: String(err),
				});
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
				ompModelCatalogKey,
				tempImageFiles: tempImageFiles.length > 0 ? tempImageFiles : undefined,
				command,
				args: finalArgs,
				querySource: config.querySource,
				tabId: config.tabId,
				projectPath: config.projectPath,
				sshRemoteId: config.sshRemoteId,
				sshRemoteHost: config.sshRemoteHost,
				sshRemoteCommand: config.sshRemoteCommand,
				// Seed from config on resume. Copilot emits `session.resume`
				// (no sessionId) instead of `session.start` when --resume=<id>
				// is set, so StdoutHandler can't populate this from the stream
				// for resumed sessions - without the seed, the post-exit disk
				// reconciliation (`ExitHandler.awaitCopilotShutdown` →
				// `readCopilotFinalAnswer` + `readCopilotShutdownUsage`)
				// short-circuits at its `if (!agentSessionId) return` guard and
				// the renderer falls back to the streamed commentary deltas
				// instead of the authoritative task_complete.summary, and the
				// context-window gauge never receives the on-disk currentTokens
				// snapshot. The stream-derived assignment in
				// `StdoutHandler.emitSessionIdIfNeeded` remains the source of
				// truth for fresh sessions.
				agentSessionId: config.agentSessionId,
				maestroEnvVars: collectMaestroEnvVars(
					shellEnvVars,
					customEnvVars,
					isResuming,
					config.querySource ?? DEFAULT_QUERY_SOURCE
				),
			};

			// A killed process keeps emitting stdio and fires `close` well after
			// ProcessManager has registered a replacement under the same sessionId
			// key (`spawn()` kills the predecessor first, then the spawner re-uses
			// the key). Everything downstream is keyed by sessionId alone, so those
			// late events get attributed to the live successor: its `close` reports
			// the dead turn's exit code (143 after SIGTERM) as the live agent
			// crashing AND deletes the successor's tracking entry, orphaning a
			// process the user can no longer stop.
			//
			// Generation, not map identity: the map answers "am I still the entry?",
			// which stops working the moment the successor finishes and deletes its
			// own entry - at which point a predecessor still draining would look
			// current again. See process-manager/generation.ts.
			managedProcess.spawnGeneration = nextSpawnGeneration(sessionId);
			this.processes.set(sessionId, managedProcess);

			// The run layer settles once the streams have ended, so every line the
			// process wrote has been read by then. A process that never started is
			// reported once, as an error, rather than as an error and then a close.
			void turn.done.then((exit) => {
				if (isSuperseded()) {
					logger.warn('[ProcessManager] Ignoring exit from superseded process', 'ProcessManager', {
						sessionId,
						pid: childProcess.pid,
						exitCode: exit.exitCode,
						error: exit.spawnError ? String(exit.spawnError) : undefined,
					});
					return;
				}
				if (exit.spawnError) {
					this.exitHandler.handleError(sessionId, exit.spawnError);
					return;
				}
				// Hand the exiting process in explicitly: it may already have been
				// unregistered, and handleExit must settle THIS process rather than
				// whatever currently owns the session id.
				// `signal` is what tells a kill from a clean exit once `code || 0` has
				// turned the killed process's null code into 0. `stdinError` says the
				// prompt never fully reached the agent.
				return this.exitHandler
					.handleExit(sessionId, exit.exitCode || 0, managedProcess, exit.signal, exit.stdinError)
					.catch((err) => {
						logger.error('[ProcessManager] handleExit threw', 'ProcessManager', {
							sessionId,
							error: String(err),
						});
					});
			});

			return { pid: childProcess.pid || -1, success: true };
		} catch (error) {
			void captureException(error);
			logger.error('[ProcessManager] Failed to spawn process', 'ProcessManager', {
				error: String(error),
			});
			return { pid: -1, success: false };
		}
	}
}
