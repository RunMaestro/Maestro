// src/shared/maestro-lib/run/pipe-spawn.ts

/**
 * The process a piped agent turn starts, decided before it exists.
 *
 * Given what a caller says about a turn (the command, the arguments, the prompt, the stdin and
 * shell flags the launch resolved), this answers the exact `{ command, args, cwd, env, stdin,
 * shell }` that `startTurn` runs: where the prompt travels (the command line, stdin as stream-json,
 * raw stdin, an SSH script), which arguments the images add, how the Windows shell escapes them,
 * and whether the process is a one-shot batch or an interactive one that keeps stdin open.
 *
 * The headless runtime's background turns (group chat and consults) call it. The desktop's
 * `ChildProcessSpawner` does not: it keeps its own spawner, whose steps this mirrors, so a rule the
 * desktop gains there has to be ported here. The two share what can be shared (`argsResumeSession`
 * below, and the prompt, image, environment and SSH helpers). The Windows shell step stays a copy
 * of the desktop's `planSpawnShell`: the desktop's suite stubs the shell escaper at its main-process
 * path, which a shared copy would bypass. It carries no desktop framework: the one host-owned step,
 * writing an image to a temp file, is passed in.
 *
 * Design: `Plans/maestro-tui-group-chat.md` GD7.
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isWindows } from '../../platformDetection';
import type { QuerySource } from '../../querySource';
import { logger } from '../host';
import { buildChildProcessEnv } from '../launch/env';
import { buildImagePromptPrefix } from '../launch/image-refs';
import { buildPromptArgv } from '../launch/prompt-delivery';
import { buildStreamJsonMessage } from '../launch/stream-json-message';
import {
	quoteCommandForCmdShell,
	windowsShellReason,
	type WindowsShellReason,
} from '../launch/windows-command';
import { escapeArgsForShell, isPowerShellShell } from '../launch/windows-shell-escape';
import { recordRemoteAgent, type RemoteAgentTarget } from '../control/turn-guard';
import { getAgentCapabilities } from '../providers/capabilities';
import { getAgentDefinition } from '../providers/definitions';
import type { TurnProcessSpec } from './start-turn';

const LOG_CONTEXT = 'ProcessManager';

// The log line each Windows shell promotion writes (see windowsShellReason).
const WINDOWS_SHELL_LOG_MESSAGES: Record<WindowsShellReason, string> = {
	'bare-exe':
		'[ProcessManager] Auto-enabling shell for Windows to allow PATH resolution of basename exe',
	'batch-file': '[ProcessManager] Auto-enabling shell for Windows to spawn batch-file command',
	'shebang-script': '[ProcessManager] Auto-enabling shell for Windows to execute shell script',
};

/** What a caller says about one turn. The field names are the desktop's `ProcessConfig`. */
export interface PipeSpawnConfig {
	sessionId: string;
	/** The provider id; capabilities and the stdin query-source flags are read from it. */
	toolType: string;
	cwd: string;
	command: string;
	/** Arguments before the prompt: the prompt is added here, where the provider wants it. */
	args: string[];
	prompt?: string;
	/** Image data URLs. Needs `saveImageToTempFile` unless the provider takes them over stdin. */
	images?: string[];
	imageArgs?: (imagePath: string) => string[];
	imagePromptBuilder?: (imagePaths: string[]) => string;
	promptArgs?: (prompt: string) => string[];
	noPromptSeparator?: boolean;
	customEnvVars?: Record<string, string>;
	/** Global Settings -> Environment variables, merged beneath `customEnvVars`. */
	shellEnvVars?: Record<string, string>;
	extraPathDirs?: string[];
	querySource?: QuerySource;
	/** Run through a shell. Windows also promotes a bare `.exe`, a `.cmd`, or a shebang script itself. */
	runInShell?: boolean;
	/** The shell's path, when the caller names one. */
	shell?: string;
	sendPromptViaStdin?: boolean;
	sendPromptViaStdinRaw?: boolean;
	/** The script an SSH remote runs: it is the whole of stdin. */
	sshStdinScript?: string;
	/** The caller already embedded the prompt in `args` (an SSH wrapper). */
	promptAlreadyInArgs?: boolean;
	/** Whether the provider has an output parser (a parsed provider streams JSONL). */
	hasOutputParser: boolean;
}

/** The host-owned step: write an image to a temp file and answer its path, or null on failure. */
export interface PipeSpawnImages {
	saveImageToTempFile(dataUrl: string, index: number): string | null;
}

export interface PipeSpawnPlan {
	/** What `startTurn` runs. */
	spec: TurnProcessSpec;
	/** The arguments before shell escaping and with the prompt in place: what a process record keeps. */
	args: string[];
	/**
	 * Temp files the turn reads: its images, and its prompt when a Windows host moved it into a
	 * file. The caller removes them when the turn ends (`removeTempFiles`).
	 */
	tempFiles: string[];
	/** A prompt was given: one answer, then the process ends. */
	isBatchMode: boolean;
	/** The provider's stdout is JSONL (or a JSON document) rather than text. */
	isStreamJsonMode: boolean;
	/** The arguments resume an earlier provider session. */
	isResuming: boolean;
	/** Leave stdin open after the first write: an interactive process the caller keeps talking to. */
	keepStdinOpen: boolean;
	/** The agent an SSH script starts on its remote host, recorded so Stop can reach it there. */
	remoteAgent?: RemoteAgentTarget;
}

/** Remove a turn's temp files, ignoring one that is already gone. Never throws. */
export function removeTempFiles(files: readonly string[]): void {
	for (const file of files) {
		fs.promises.unlink(file).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== 'ENOENT') {
				logger.warn('[ProcessManager] Could not remove a temp file', LOG_CONTEXT, {
					file,
					error: error.message,
				});
			}
		});
	}
}

/** Decide what a piped turn starts. Throws only when an input cannot be honored (see `PipeSpawnImages`). */
export function planPipeSpawn(
	config: PipeSpawnConfig,
	host: Partial<PipeSpawnImages> = {}
): PipeSpawnPlan {
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
		noPromptSeparator,
		customEnvVars,
		shellEnvVars,
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
	let tempFiles: string[] = [];
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
		const saveImageToTempFile = host.saveImageToTempFile;
		if (!saveImageToTempFile) {
			throw new Error('This provider takes images as files, and no image writer was supplied.');
		}
		finalArgs = [...args];
		tempFiles = [];
		for (let i = 0; i < images.length; i++) {
			const tempPath = saveImageToTempFile(images[i], i);
			if (tempPath) {
				tempFiles.push(tempPath);
			}
		}

		const isResumeWithPromptEmbed =
			capabilities.imageResumeMode === 'prompt-embed' && args.some((a) => a === 'resume');
		const shouldEmbedImagesInPrompt = !!imagePromptBuilder || isResumeWithPromptEmbed;

		if (shouldEmbedImagesInPrompt) {
			// Some agents consume images by mentioning temp file paths inside the prompt
			// instead of accepting a dedicated CLI image flag.
			const imagePrefix = imagePromptBuilder
				? imagePromptBuilder(tempFiles)
				: buildImagePromptPrefix(tempFiles);
			effectivePrompt = imagePrefix + prompt;
			if (!promptViaStdin) {
				finalArgs = [
					...finalArgs,
					...buildPromptArgv({ promptArgs, noPromptSeparator }, effectivePrompt),
				];
				promptAddedToArgs = true;
			}
			logger.debug('[ProcessManager] Embedded image paths in prompt', LOG_CONTEXT, {
				sessionId,
				imageCount: images.length,
				tempFiles: tempFiles,
				embedMode: imagePromptBuilder ? 'prompt-builder' : 'resume-prompt-embed',
				promptViaStdin,
			});
		} else {
			// Initial spawn: use -i flag as before
			for (const tempPath of tempFiles) {
				if (!imageArgs) {
					continue;
				}
				finalArgs = [...finalArgs, ...imageArgs(tempPath)];
			}
			if (!promptViaStdin) {
				finalArgs = [...finalArgs, ...buildPromptArgv({ promptArgs, noPromptSeparator }, prompt)];
				promptAddedToArgs = true;
			}
			logger.debug('[ProcessManager] Using file-based image args', LOG_CONTEXT, {
				sessionId,
				imageCount: images.length,
				tempFiles: tempFiles,
				promptViaStdin,
			});
		}
	} else if (prompt && !promptViaStdin && !promptAddedToArgs) {
		// Regular batch mode - prompt as CLI arg
		// SKIP this when prompt is sent via stdin to avoid shell escaping issues,
		// or when the caller already embedded the prompt in args (promptAlreadyInArgs).
		finalArgs = [...args, ...buildPromptArgv({ promptArgs, noPromptSeparator }, prompt)];
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
	spawnConfigLogFn('[ProcessManager] spawn() config', LOG_CONTEXT, {
		sessionId,
		toolType,
		platform: process.platform,
		hasPrompt: !!prompt,
		promptLength: prompt?.length,
		hasImages,
		hasImageArgs: !!imageArgs,
		tempFilesCount: tempFiles.length,
		command,
		commandHasExtension: path.extname(command).length > 0,
		baseArgsCount: args.length,
		finalArgsCount: finalArgs.length,
	});

	// OMP expands @file attachments, including on resume. Keep its full prompt
	// out of the Windows command line without assuming stdin support.
	const promptFileArgs = getAgentDefinition(toolType)?.promptFileArgs;
	if (
		isWindows() &&
		effectivePrompt &&
		promptAddedToArgs &&
		promptFileArgs &&
		!config.sshStdinScript &&
		!config.promptAlreadyInArgs
	) {
		const promptFile = path.join(os.tmpdir(), 'maestro-prompt-' + randomUUID() + '.txt');
		tempFiles.push(promptFile);
		try {
			fs.writeFileSync(promptFile, effectivePrompt, {
				encoding: 'utf8',
				mode: 0o600,
				flag: 'wx',
			});
		} catch (error) {
			// Nothing will start to read them, so nothing else would remove them.
			removeTempFiles(tempFiles);
			throw error;
		}
		// `--` makes OMP treat @file as a literal message, not an attachment.
		const promptOffset = finalArgs.at(-2) === '--' ? 2 : 1;
		finalArgs = [...finalArgs.slice(0, -promptOffset), ...promptFileArgs(promptFile)];
	}

	// Build environment
	const isResuming = argsResumeSession(args);
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
		logger.debug('[ProcessManager] Applying global environment variables', LOG_CONTEXT, {
			sessionId,
			globalVarCount: globalVarKeys.length,
			globalVarKeys: globalVarKeys.slice(0, 10), // First 10 keys for visibility
			hasCustomVars: !!(customEnvVars && Object.keys(customEnvVars).length > 0),
			customVarCount: customEnvVars ? Object.keys(customEnvVars).length : 0,
		});
	}

	logger.debug('[ProcessManager] About to spawn child process', LOG_CONTEXT, {
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
				LOG_CONTEXT,
				shebang !== undefined ? { command: spawnCommand, shebang } : { command: spawnCommand }
			);
		}
	}

	if (isWindows() && useShell) {
		logger.debug(
			'[ProcessManager] Forcing shell=true for agent spawn on Windows (runInShell or auto)',
			LOG_CONTEXT,
			{ command: spawnCommand }
		);

		// Use the shell escape utility for proper argument escaping
		const shellPath = typeof config.shell === 'string' ? config.shell : undefined;
		spawnArgs = escapeArgsForShell(finalArgs, shellPath);

		const shellType = isPowerShellShell(shellPath) ? 'PowerShell' : 'cmd.exe';
		logger.info(`[ProcessManager] Escaped args for ${shellType}`, LOG_CONTEXT, {
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
	spawnLogFn('[ProcessManager] About to spawn with shell option', LOG_CONTEXT, {
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
			(arg, index) => arg === `${flag}=${value}` || (arg === flag && cliArgs[index + 1] === value)
		);

	const isStreamJsonMode =
		argsContain('stream-json') ||
		argsContain('--json') ||
		argsHaveFlagValue('--format', 'json') ||
		argsHaveFlagValue('--output-format', 'json') ||
		(!!hasImages && !!prompt) ||
		!!config.sendPromptViaStdin ||
		!!config.sshStdinScript ||
		config.hasOutputParser; // Agents with output parsers use streaming JSONL, not batch JSON

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
	// A stdin-script SSH spawn records the remote agent's pid so Stop can
	// reach it: signalling only the local ssh client leaves it running.
	const sshLaunch = recordRemoteAgent({
		command,
		args: finalArgs,
		sshStdinScript: config.sshStdinScript,
		sessionId,
	});

	let stdinText: string | undefined;
	if (config.sshStdinScript) {
		stdinText = sshLaunch.sshStdinScript;
		logger.debug('[ProcessManager] Sending SSH stdin script', LOG_CONTEXT, {
			sessionId,
			scriptLength: config.sshStdinScript.length,
		});
	} else if (sendPromptViaStdinRaw && effectivePrompt) {
		stdinText = effectivePrompt;
		logger.debug('[ProcessManager] Sending raw prompt via stdin', LOG_CONTEXT, {
			sessionId,
			promptLength: effectivePrompt.length,
		});
	} else if (isStreamJsonMode && effectivePrompt && !promptAddedToArgs) {
		const streamJsonMessage = buildStreamJsonMessage(effectivePrompt, images || []);
		stdinText = streamJsonMessage + '\n';
		logger.debug('[ProcessManager] Sending stream-json message via stdin', LOG_CONTEXT, {
			sessionId,
			messageLength: streamJsonMessage.length,
			imageCount: (images || []).length,
			hasImages: !!(images && images.length > 0),
		});
	} else if (isBatchMode) {
		logger.debug('[ProcessManager] Closing stdin for batch mode', LOG_CONTEXT, { sessionId });
	}

	return {
		spec: {
			command: spawnCommand,
			args: spawnArgs,
			cwd,
			env,
			stdin: stdinText,
			shell: spawnShell,
		},
		args: finalArgs,
		tempFiles,
		isBatchMode,
		isStreamJsonMode,
		isResuming,
		keepStdinOpen: stdinText === undefined && !isBatchMode,
		...(sshLaunch.remote ? { remoteAgent: sshLaunch.remote } : {}),
	};
}

/**
 * Whether an agent's CLI args resume an earlier provider session, which sets
 * `MAESTRO_SESSION_RESUMED` in the child's environment. Shared by every
 * pipe-backed spawner so the same args produce the same environment whichever
 * transport carries the turn.
 */
export function argsResumeSession(args: string[]): boolean {
	return (
		args.some((arg) => arg === '--resume' || arg.startsWith('--resume=')) ||
		args.includes('--session')
	);
}

/** The session id a `--resume <id>` (or `--resume=<id>`) argument names, if any. */
export function resumeIdFromArgs(args: readonly string[]): string | undefined {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === '--resume') return args[i + 1] || undefined;
		if (arg.startsWith('--resume=')) return arg.slice('--resume='.length) || undefined;
	}
	return undefined;
}
