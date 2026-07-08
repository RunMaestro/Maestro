import Store from 'electron-store';
import type { AgentConfig } from '../../../agents/definitions';
import { buildRemoteInteractiveSpawn } from '../../../agents/resolveClaudeSpawnMode';
import { isWindows } from '../../../../shared/platformDetection';
import { logger } from '../../../utils/logger';
import {
	getSshRemoteConfig,
	createSshRemoteStoreAdapter,
} from '../../../utils/ssh-remote-resolver';
import { buildSshCommandWithStdin } from '../../../utils/ssh-command-builder';
import { buildStreamJsonMessage } from '../../../process-manager/utils/streamJsonBuilder';
import type { SshRemoteConfig } from '../../../../shared/types';
import { MaestroSettings } from '../persistence';
import type { ClaudeSpawnContext } from './resolve-claude-spawn-context';
import type { SpawnProcessConfig } from './spawn-types';

const LOG_CONTEXT = '[ProcessManager]';

export interface SshSpawnWrapInput {
	config: SpawnProcessConfig;
	agent: AgentConfig | null;
	claudeContext: ClaudeSpawnContext;
	commandToSpawn: string;
	argsToSpawn: string[];
	/** Headless arg list before any local maestro-p transform (used for SSH). */
	headlessArgs: string[];
	customEnvVarsToPass: Record<string, string> | undefined;
	effectiveCustomEnvVars: Record<string, string> | undefined;
	effectivePrompt: string | undefined;
	globalShellEnvVars: Record<string, string>;
	useShell: boolean;
	shellToUse: string | undefined;
	settingsStore: Store<MaestroSettings>;
}

export interface SshSpawnWrapResult {
	commandToSpawn: string;
	argsToSpawn: string[];
	sshRemoteUsed: SshRemoteConfig | null;
	customEnvVarsToPass: Record<string, string> | undefined;
	sshStdinScript: string | undefined;
	sshRemoteCommand: string | undefined;
	useShell: boolean;
	shellToUse: string | undefined;
}

/**
 * Detect SSH remote config and wrap the spawn command for stdin-script execution.
 */
export async function wrapSpawnForSsh(input: SshSpawnWrapInput): Promise<SshSpawnWrapResult> {
	const {
		config,
		agent,
		claudeContext,
		commandToSpawn: initialCommand,
		argsToSpawn: initialArgs,
		headlessArgs,
		customEnvVarsToPass: initialCustomEnvVars,
		effectiveCustomEnvVars,
		effectivePrompt,
		globalShellEnvVars,
		useShell: initialUseShell,
		shellToUse: initialShellToUse,
		settingsStore,
	} = input;

	let commandToSpawn = initialCommand;
	let argsToSpawn = initialArgs;
	let useShell = initialUseShell;
	let shellToUse = initialShellToUse;
	let sshRemoteUsed: SshRemoteConfig | null = null;
	let customEnvVarsToPass = initialCustomEnvVars;
	let sshStdinScript: string | undefined;
	let sshRemoteCommand: string | undefined;

	const {
		isClaudeCode,
		claudeResolvedMode,
		claudeResolvedReason,
		claudeDecisionRealBinPath,
		claudeResolvedRemote,
	} = claudeContext;

	// ========================================================================
	// SSH Remote Execution: Detect and wrap command for remote execution
	// Terminal sessions are always local (they need PTY for shell interaction)
	// ========================================================================
	// Only consider SSH remote for non-terminal AI agent sessions
	// SSH is session-level ONLY - no agent-level or global defaults
	// Log SSH evaluation on Windows for debugging
	if (isWindows()) {
		logger.info(`Evaluating SSH remote config`, LOG_CONTEXT, {
			toolType: config.toolType,
			isTerminal: config.toolType === 'terminal',
			hasSessionSshRemoteConfig: !!config.sessionSshRemoteConfig,
			sshEnabled: config.sessionSshRemoteConfig?.enabled,
			willUseSsh: config.toolType !== 'terminal' && config.sessionSshRemoteConfig?.enabled,
		});
	}
	if (config.toolType !== 'terminal' && config.sessionSshRemoteConfig?.enabled) {
		// Session-level SSH config provided - resolve and use it
		logger.info(`Using session-level SSH config`, LOG_CONTEXT, {
			sessionId: config.sessionId,
			enabled: config.sessionSshRemoteConfig.enabled,
			remoteId: config.sessionSshRemoteConfig.remoteId,
		});

		// Resolve effective SSH remote configuration
		const sshStoreAdapter = createSshRemoteStoreAdapter(settingsStore);
		const sshResult = getSshRemoteConfig(sshStoreAdapter, {
			sessionSshConfig: config.sessionSshRemoteConfig,
		});

		if (sshResult.config) {
			// SSH remote is configured - use stdin-based execution
			// This completely bypasses shell escaping issues by sending the script via stdin
			sshRemoteUsed = sshResult.config;

			// Claude interactive/dynamic over SSH: run maestro-p on the remote
			// host (it strips the headless flags, drives the remote claude TUI
			// on the Max subscription, and reads the prompt from the stdin
			// passthrough below) instead of `claude --print`. maestro-p must be
			// installed on the remote PATH. For the API path this is null and
			// the spawn stays on the plain claude binary.
			const remoteInteractive =
				isClaudeCode && claudeResolvedMode === 'interactive' && claudeResolvedRemote
					? buildRemoteInteractiveSpawn({
							decision: {
								mode: 'interactive',
								reason: claudeResolvedReason,
								maestroPBinPath: null,
								remote: true,
								claudeRealBinPath: claudeDecisionRealBinPath,
							},
							interactiveModeArgs: agent?.interactiveModeArgs,
							remoteClaudeBin: claudeDecisionRealBinPath,
						})
					: null;

			// Determine the command to run on the remote host
			const remoteCommand =
				remoteInteractive?.command ||
				config.sessionCustomPath ||
				agent?.binaryName ||
				config.command;

			// Build the SSH command with stdin script
			// The script contains PATH setup, cd, env vars, and the actual command
			// This eliminates all shell escaping issues
			//
			// IMPORTANT: ALL agent prompts are passed via stdin passthrough for SSH.
			// Benefits:
			// - Avoids CLI argument length limits (128KB-2MB depending on OS)
			// - No shell escaping needed - prompt is never parsed by any shell
			// - Works with any prompt content (quotes, newlines, special chars)
			// - Simpler code - no heredoc or delimiter collision detection
			//
			// How it works: bash reads the script, `exec` replaces bash with the agent,
			// and the agent reads the remaining stdin (the prompt) directly.
			//
			// IMAGE SUPPORT: When images are present, the approach depends on the agent:
			// - Stream-json agents (Claude Code): Images are embedded as base64 in the
			//   stream-json message sent via stdin passthrough. --input-format stream-json
			//   is added to args so the agent parses the JSON+base64 message correctly.
			// - File-based agents (Codex, OpenCode): Images are decoded from base64 into
			//   temp files on the remote host via the SSH script, then passed as CLI args
			//   (e.g., -i /tmp/image.png for Codex, -f /tmp/image.png for OpenCode).
			const hasImages = config.images && config.images.length > 0;
			// Prepend the interactive flags ahead of the headless arg list when
			// running maestro-p on the remote (it forwards the interactive flags
			// to the TUI and strips the headless ones). No-op for the API path.
			let sshArgs = remoteInteractive
				? [...remoteInteractive.prependArgs, ...headlessArgs]
				: headlessArgs;
			let stdinInput: string | undefined = effectivePrompt;

			if (hasImages && effectivePrompt && agent?.capabilities?.supportsStreamJsonInput) {
				// Stream-json agent (Claude Code): embed images in the stdin message
				stdinInput = buildStreamJsonMessage(effectivePrompt, config.images!) + '\n';
				if (!sshArgs.includes('--input-format')) {
					sshArgs = [...sshArgs, '--input-format', 'stream-json'];
				}
				logger.info(`SSH: using stream-json stdin for images`, LOG_CONTEXT, {
					sessionId: config.sessionId,
					imageCount: config.images!.length,
				});
			}

			// Determine if this is a resume with prompt-embed images
			// agentSessionId presence indicates resume; imageResumeMode tells us to embed paths in prompt
			const isResumeWithImages =
				hasImages &&
				agent?.capabilities?.imageResumeMode === 'prompt-embed' &&
				config.agentSessionId;

			// Merge global environment variables with session custom env vars
			// Session vars take precedence over global vars. Remote interactive
			// adds MAESTRO_CLAUDE_BIN only when a custom remote claude path is
			// set (otherwise maestro-p defaults to `claude` on the remote PATH).
			const mergedSshEnvVars = {
				...globalShellEnvVars,
				...(effectiveCustomEnvVars || {}),
				...(remoteInteractive?.env || {}),
			};

			const sshCommand = await buildSshCommandWithStdin(sshResult.config, {
				command: remoteCommand,
				args: sshArgs,
				cwd: config.cwd,
				env: mergedSshEnvVars,
				// prompt is not passed as CLI arg - it goes via stdinInput
				stdinInput,
				// File-based image agents (Codex, OpenCode): pass images for remote temp file creation
				// Also needed for resume-with-prompt-embed (still creates temp files, just no -i args)
				images:
					hasImages &&
					(agent?.imageArgs || agent?.imagePromptBuilder) &&
					!agent?.capabilities?.supportsStreamJsonInput
						? config.images
						: undefined,
				imageArgs:
					hasImages && agent?.imageArgs && !agent?.capabilities?.supportsStreamJsonInput
						? agent.imageArgs
						: undefined,
				imagePromptBuilder:
					hasImages && agent?.imagePromptBuilder && !agent?.capabilities?.supportsStreamJsonInput
						? agent.imagePromptBuilder
						: undefined,
				// Signal resume mode for prompt embedding instead of -i CLI args
				imageResumeMode: isResumeWithImages ? 'prompt-embed' : undefined,
			});

			commandToSpawn = sshCommand.command;
			argsToSpawn = sshCommand.args;
			sshStdinScript = sshCommand.stdinScript;
			sshRemoteCommand = sshCommand.remoteCommandLine;

			// For SSH, env vars are passed in the stdin script, not locally
			customEnvVarsToPass = undefined;

			// CRITICAL: When using SSH, do NOT use shell execution
			// SSH needs direct stdin/stdout/stderr access for the script passthrough to work
			// Running SSH through a shell breaks stdin passthrough and the agent never gets the script
			useShell = false;
			shellToUse = undefined;

			logger.info(`SSH command built with stdin passthrough`, LOG_CONTEXT, {
				sessionId: config.sessionId,
				toolType: config.toolType,
				sshBinary: sshCommand.command,
				sshArgsCount: sshCommand.args.length,
				remoteCommand,
				remoteCwd: config.cwd,
				promptLength: config.prompt?.length,
				stdinScriptLength: sshCommand.stdinScript?.length,
				hasImages,
				imageCount: config.images?.length,
			});
		}
	}

	return {
		commandToSpawn,
		argsToSpawn,
		sshRemoteUsed,
		customEnvVarsToPass,
		sshStdinScript,
		sshRemoteCommand,
		useShell,
		shellToUse,
	};
}
