/**
 * SSH Command Builder utilities for remote agent execution.
 *
 * Provides functions to construct SSH command invocations that wrap
 * agent commands for remote execution. These utilities work with
 * SshRemoteManager and ProcessManager to enable executing AI agents
 * on remote hosts via SSH.
 */

import { SshRemoteConfig } from '../../shared/types';
import { shellEscape, buildShellCommand } from './shell-escape';
import { expandTilde } from '../../shared/pathUtils';
import { logger } from './logger';
import { resolveSshPath } from './cliDetection';
import { parseDataUrl, buildImagePromptPrefix } from '../process-manager/utils/imageUtils';

/**
 * Result of building an SSH command.
 * Contains the command and arguments to pass to spawn().
 */
export interface SshCommandResult {
	/** The command to execute ('ssh') */
	command: string;
	/** Arguments for the SSH command */
	args: string[];
	/** Script to send via stdin (for stdin-based execution) */
	stdinScript?: string;
	/** Remote temp file paths created during image decoding (for informational/logging purposes) */
	remoteTempImagePaths?: string[];
}

/**
 * Options for building the remote command.
 */
export interface RemoteCommandOptions {
	/** The command to execute on the remote host */
	command: string;
	/** Arguments for the command */
	args: string[];
	/** Working directory on the remote host (optional) */
	cwd?: string;
	/** Environment variables to set on the remote (optional) */
	env?: Record<string, string>;
	/** Indicates the caller will send input via stdin to the remote command (optional) */
	useStdin?: boolean;
}

/**
 * Default SSH options for all connections.
 * These options ensure non-interactive, key-based authentication.
 */
const DEFAULT_SSH_OPTIONS: Record<string, string> = {
	BatchMode: 'yes', // Disable password prompts (key-only)
	StrictHostKeyChecking: 'accept-new', // Auto-accept new host keys
	ConnectTimeout: '10', // Connection timeout in seconds
	ClearAllForwardings: 'yes', // Disable port forwarding from SSH config (avoids "Address already in use" errors)
	RequestTTY: 'no', // Default: do NOT request a TTY. We only force a TTY for specific remote modes (e.g., --print)
	LogLevel: 'ERROR', // Suppress SSH warnings like "Pseudo-terminal will not be allocated..."
};

/**
 * Build the remote shell command string from command, args, cwd, and env.
 *
 * This function constructs a properly escaped shell command that:
 * 1. Changes to the specified working directory (if provided)
 * 2. Sets environment variables (if provided)
 * 3. Executes the command with its arguments
 *
 * The result is a single shell command string that can be passed to SSH.
 * All user-provided values are properly escaped to prevent shell injection.
 *
 * @param options Command options including command, args, cwd, and env
 * @returns Properly escaped shell command string for remote execution
 *
 * @example
 * buildRemoteCommand({
 *   command: 'claude',
 *   args: ['--print', '--verbose'],
 *   cwd: '/home/user/project',
 *   env: { ANTHROPIC_API_KEY: 'sk-...' }
 * })
 * // => "cd '/home/user/project' && ANTHROPIC_API_KEY='sk-...' 'claude' '--print' '--verbose'"
 */
export function buildRemoteCommand(options: RemoteCommandOptions): string {
	const { command, args, cwd, env } = options;

	const parts: string[] = [];

	// Add cd command if working directory is specified
	if (cwd) {
		parts.push(`cd ${shellEscape(cwd)}`);
	}

	// Build environment variable exports
	const envExports: string[] = [];
	if (env && Object.keys(env).length > 0) {
		for (const [key, value] of Object.entries(env)) {
			// Environment variable names are validated (alphanumeric + underscore)
			// but we still escape the value to be safe
			if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
				envExports.push(`${key}=${shellEscape(value)}`);
			}
		}
	}

	// Build the command with arguments
	const commandWithArgs = buildShellCommand(command, args);

	// Handle stdin input modes
	let finalCommandWithArgs: string;
	if (options.useStdin) {
		const hasStreamJsonInput =
			Array.isArray(args) && args.includes('--input-format') && args.includes('stream-json');
		if (hasStreamJsonInput) {
			// Stream-JSON mode: use exec to avoid shell control sequences
			finalCommandWithArgs = `exec ${commandWithArgs}`;
		} else {
			// Raw prompt mode: pipe stdin directly to the command
			finalCommandWithArgs = commandWithArgs;
		}
	} else {
		finalCommandWithArgs = commandWithArgs;
	}

	// Combine env exports with command
	let fullCommand: string;
	if (envExports.length > 0) {
		// Prepend env vars inline: VAR1='val1' VAR2='val2' command args
		fullCommand = `${envExports.join(' ')} ${finalCommandWithArgs}`;
	} else {
		fullCommand = finalCommandWithArgs;
	}

	parts.push(fullCommand);

	// Join with && to ensure cd succeeds before running command
	return parts.join(' && ');
}

/**
 * Build an SSH command that executes a script via stdin.
 *
 * This approach completely bypasses shell escaping issues by:
 * 1. SSH connects and runs `/bin/bash` on the remote
 * 2. The script (with PATH setup, cd, env vars, command) is sent via stdin
 * 3. The prompt (if any) is appended after the script, passed through to the exec'd command
 *
 * This is the preferred method for SSH remote execution as it:
 * - Handles any prompt content (special chars, newlines, quotes, etc.)
 * - Avoids command-line length limits
 * - Works regardless of the remote user's login shell (bash, zsh, fish, etc.)
 * - Eliminates the escaping nightmare of nested shell contexts
 * - No heredoc or delimiter collision detection needed
 *
 * How stdin passthrough works:
 * - Bash reads and executes the script lines
 * - The `exec` command replaces bash with the target process
 * - Any remaining stdin (the prompt) is inherited by the exec'd command
 * - The prompt is NEVER parsed by any shell - it flows through as raw bytes
 *
 * @param config SSH remote configuration
 * @param remoteOptions Options for the remote command
 * @returns SSH command/args plus the script+prompt to send via stdin
 *
 * @example
 * const result = await buildSshCommandWithStdin(config, {
 *   command: 'opencode',
 *   args: ['run', '--format', 'json'],
 *   cwd: '/home/user/project',
 *   env: { OPENCODE_CONFIG_CONTENT: '{"permission":{"*":"allow"}}' },
 *   stdinInput: 'Write hello world to a file'
 * });
 * // result.command = 'ssh'
 * // result.args = ['-o', 'BatchMode=yes', ..., 'user@host', '/bin/bash']
 * // result.stdinScript = 'export PATH=...\ncd /home/user/project\nexport OPENCODE_CONFIG_CONTENT=...\nexec opencode run --format json\nWrite hello world to a file'
 */
export async function buildSshCommandWithStdin(
	config: SshRemoteConfig,
	remoteOptions: RemoteCommandOptions & {
		prompt?: string;
		stdinInput?: string;
		/** Base64 data URL images to decode into remote temp files (for file-based agents like Codex/OpenCode) */
		images?: string[];
		/** Function to build CLI args for each image path (e.g., (path) => ['-i', path]) */
		imageArgs?: (imagePath: string) => string[];
		/** When set to 'prompt-embed', embed image paths in the prompt/stdinInput instead of adding -i CLI args.
		 * Used for resumed Codex sessions where the resume command doesn't support -i flag. */
		imageResumeMode?: 'prompt-embed';
	}
): Promise<SshCommandResult> {
	const args: string[] = [];

	// Resolve the SSH binary path
	const sshPath = await resolveSshPath();

	// For stdin-based execution, we never need TTY (stdin is the script, not user input)
	// TTY would interfere with piping the script

	// Private key - only add if explicitly provided
	if (config.privateKeyPath && config.privateKeyPath.trim()) {
		args.push('-i', expandTilde(config.privateKeyPath));
	}

	// Default SSH options - but RequestTTY is always 'no' for stdin mode
	for (const [key, value] of Object.entries(DEFAULT_SSH_OPTIONS)) {
		args.push('-o', `${key}=${value}`);
	}

	// Port specification
	if (!config.useSshConfig || config.port !== 22) {
		args.push('-p', config.port.toString());
	}

	// Build destination
	if (config.username && config.username.trim()) {
		args.push(`${config.username}@${config.host}`);
	} else {
		args.push(config.host);
	}

	// The remote command is just /bin/bash - it will read the script from stdin
	args.push('/bin/bash');

	// Build the script to send via stdin
	const scriptLines: string[] = [];

	// PATH setup - same directories as before
	scriptLines.push(
		'export PATH="$HOME/.local/bin:$HOME/.opencode/bin:$HOME/bin:/usr/local/bin:/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"'
	);

	// Change directory if specified
	if (remoteOptions.cwd) {
		// In the script context, we can use simple quoting
		scriptLines.push(`cd ${shellEscape(remoteOptions.cwd)} || exit 1`);
	}

	// Merge environment variables
	const mergedEnv: Record<string, string> = {
		...(config.remoteEnv || {}),
		...(remoteOptions.env || {}),
	};

	// Export environment variables
	for (const [key, value] of Object.entries(mergedEnv)) {
		if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
			scriptLines.push(`export ${key}=${shellEscape(value)}`);
		}
	}

	// Decode images into remote temp files for file-based agents (Codex, OpenCode)
	// This creates temp files on the remote host from base64 data, then either:
	// - Adds CLI args (e.g., -i /tmp/image.png) for initial spawns
	// - Embeds paths in the prompt/stdinInput for resumed sessions (imageResumeMode === 'prompt-embed')
	const imageArgParts: string[] = [];
	const remoteImagePaths: string[] = [];
	/** All remote temp file paths created during image decoding (for cleanup) */
	const allRemoteTempPaths: string[] = [];
	if (remoteOptions.images && remoteOptions.images.length > 0 && remoteOptions.imageArgs) {
		const timestamp = Date.now();
		for (let i = 0; i < remoteOptions.images.length; i++) {
			const parsed = parseDataUrl(remoteOptions.images[i]);
			if (!parsed) continue;
			const ext = parsed.mediaType.split('/')[1] || 'png';
			const remoteTempPath = `/tmp/maestro-image-${timestamp}-${i}.${ext}`;
			allRemoteTempPaths.push(remoteTempPath);
			// Use heredoc + base64 decode to create the file on the remote host
			// Heredoc avoids shell argument length limits for large images
			// Base64 alphabet (A-Za-z0-9+/=) is safe in heredocs
			scriptLines.push(`base64 -d > ${shellEscape(remoteTempPath)} <<'MAESTRO_IMG_${i}_EOF'`);
			scriptLines.push(parsed.base64);
			scriptLines.push(`MAESTRO_IMG_${i}_EOF`);
			if (remoteOptions.imageResumeMode === 'prompt-embed') {
				// Resume mode: collect paths for prompt embedding instead of CLI args
				remoteImagePaths.push(remoteTempPath);
			} else {
				// Normal mode: add -i (or equivalent) CLI args
				imageArgParts.push(...remoteOptions.imageArgs(remoteTempPath).map((arg) => shellEscape(arg)));
			}
		}
		logger.info('SSH: embedded remote image decode commands', '[ssh-command-builder]', {
			imageCount: remoteOptions.images.length,
			decodedCount: remoteOptions.imageResumeMode === 'prompt-embed' ? remoteImagePaths.length : imageArgParts.length / 2,
			imageResumeMode: remoteOptions.imageResumeMode || 'default',
		});
	}

	// For prompt-embed mode (resumed sessions), prepend image paths to stdinInput/prompt
	if (remoteImagePaths.length > 0) {
		const imagePrefix = buildImagePromptPrefix(remoteImagePaths);
		if (remoteOptions.stdinInput !== undefined) {
			remoteOptions.stdinInput = imagePrefix + remoteOptions.stdinInput;
		} else if (remoteOptions.prompt) {
			remoteOptions.prompt = imagePrefix + remoteOptions.prompt;
		}
	}

	// Build the command line
	// For the script, we use simple quoting since we're not going through shell parsing layers
	const cmdParts = [remoteOptions.command, ...remoteOptions.args.map((arg) => shellEscape(arg))];

	// Add image args for file-based agents (decoded temp files on remote)
	if (imageArgParts.length > 0) {
		cmdParts.push(...imageArgParts);
	}

	// Add prompt as final argument if provided and not sending via stdin passthrough
	const hasStdinInput = remoteOptions.stdinInput !== undefined;
	if (remoteOptions.prompt && !hasStdinInput) {
		cmdParts.push(shellEscape(remoteOptions.prompt));
	}

	// When remote temp files exist, don't use exec (which replaces the shell) so that
	// cleanup commands can run after the agent exits. When no temp files, use exec for
	// a cleaner process tree. When stdinInput is provided, the prompt will be appended
	// after the script and passed through to the command via stdin inheritance.
	if (allRemoteTempPaths.length > 0) {
		const rmPaths = allRemoteTempPaths.map(p => shellEscape(p)).join(' ');
		scriptLines.push(`${cmdParts.join(' ')}; rm -f ${rmPaths}`);
	} else {
		scriptLines.push(`exec ${cmdParts.join(' ')}`);
	}

	// Build the final stdin content: script + optional prompt passthrough
	// The script ends with exec, which replaces bash with the target command
	// Any content after the script (the prompt) is read by the exec'd command from stdin
	let stdinScript = scriptLines.join('\n') + '\n';

	if (hasStdinInput && remoteOptions.stdinInput) {
		// Append the prompt after the script - it will be passed through to the exec'd command
		// No escaping needed - the prompt is never parsed by any shell
		stdinScript += remoteOptions.stdinInput;
	}

	logger.info('SSH command built with stdin script', '[ssh-command-builder]', {
		host: config.host,
		username: config.username || '(using SSH config/system default)',
		port: config.port,
		sshPath,
		sshArgsCount: args.length,
		scriptLineCount: scriptLines.length,
		stdinLength: stdinScript.length,
		hasStdinInput,
		stdinInputLength: remoteOptions.stdinInput?.length,
		// Show first part of script for debugging (truncate if long)
		scriptPreview: stdinScript.length > 500 ? stdinScript.substring(0, 500) + '...' : stdinScript,
	});

	return {
		command: sshPath,
		args,
		stdinScript,
		remoteTempImagePaths: allRemoteTempPaths.length > 0 ? allRemoteTempPaths : undefined,
	};
}

/**
 * Build SSH command and arguments for remote execution.
 *
 * This function constructs the complete SSH invocation to execute
 * a command on a remote host. It uses the SSH config for authentication
 * details and builds a properly escaped remote command string.
 *
 * When config.useSshConfig is true, the function relies on ~/.ssh/config
 * for connection settings (User, IdentityFile, Port, HostName) and only
 * passes the Host pattern to SSH. This allows leveraging existing SSH
 * configurations including ProxyJump for bastion hosts.
 *
 * @param config SSH remote configuration
 * @param remoteOptions Options for the remote command (command, args, cwd, env)
 * @returns Object with 'ssh' command and arguments array
 *
 * @example
 * // Direct connection (no SSH config)
 * buildSshCommand(
 *   { host: 'dev.example.com', port: 22, username: 'user', privateKeyPath: '~/.ssh/id_ed25519', ... },
 *   { command: 'claude', args: ['--print', 'hello'], cwd: '/home/user/project' }
 * )
 * // => {
 * //   command: 'ssh',
 * //   args: [
 * //     '-i', '/Users/me/.ssh/id_ed25519',
 * //     '-o', 'BatchMode=yes',
 * //     '-o', 'StrictHostKeyChecking=accept-new',
 * //     '-o', 'ConnectTimeout=10',
 * //     '-p', '22',
 * //     'user@dev.example.com',
 * //     "cd '/home/user/project' && 'claude' '--print' 'hello'"
 * //   ]
 * // }
 *
 * @example
 * // Using SSH config (useSshConfig: true)
 * buildSshCommand(
 *   { host: 'dev-server', useSshConfig: true, ... },
 *   { command: 'claude', args: ['--print', 'hello'] }
 * )
 * // => {
 * //   command: 'ssh',
 * //   args: [
 * //     '-o', 'BatchMode=yes',
 * //     '-o', 'StrictHostKeyChecking=accept-new',
 * //     '-o', 'ConnectTimeout=10',
 * //     'dev-server',  // SSH will look up settings from ~/.ssh/config
 * //     "'claude' '--print' 'hello'"
 * //   ]
 * // }
 */
export async function buildSshCommand(
	config: SshRemoteConfig,
	remoteOptions: RemoteCommandOptions
): Promise<SshCommandResult> {
	const args: string[] = [];

	// Resolve the SSH binary path (handles packaged Electron apps where PATH is limited)
	const sshPath = await resolveSshPath();

	// Decide whether we need to force a TTY for the remote command.
	// Historically we forced a TTY for Claude Code when running with `--print`.
	// However, for stream-json input (sending JSON via stdin) a TTY injects terminal
	// control sequences that corrupt the stream. Only enable forced TTY for cases
	// that explicitly require it (e.g., `--print` without `--input-format stream-json`).
	const remoteArgs = remoteOptions.args || [];
	const hasPrintFlag = remoteArgs.includes('--print');
	const hasStreamJsonInput = remoteOptions.useStdin
		? true
		: remoteArgs.includes('--input-format') && remoteArgs.includes('stream-json');
	const forceTty = Boolean(hasPrintFlag && !hasStreamJsonInput);

	// Log the decision so callers can debug why a TTY was or was not forced
	logger.debug('SSH TTY decision', '[ssh-command-builder]', {
		host: config.host,
		useStdinFlag: !!remoteOptions.useStdin,
		hasPrintFlag,
		hasStreamJsonInput,
		forceTty,
	});

	if (forceTty) {
		// -tt must come first for reliable forced allocation in some SSH implementations
		args.push('-tt');
	}

	// Private key - only add if explicitly provided
	// SSH will use ~/.ssh/config or ssh-agent if no key is specified
	if (config.privateKeyPath && config.privateKeyPath.trim()) {
		args.push('-i', expandTilde(config.privateKeyPath));
	}

	// Default SSH options for non-interactive operation
	// These are always needed to ensure BatchMode behavior. If `forceTty` is true,
	// override RequestTTY to `force` so SSH will allocate a TTY even in non-interactive contexts.
	for (const [key, value] of Object.entries(DEFAULT_SSH_OPTIONS)) {
		// If we will force a TTY for this command, override the RequestTTY option
		if (key === 'RequestTTY' && forceTty) {
			args.push('-o', `${key}=force`);
		} else {
			args.push('-o', `${key}=${value}`);
		}
	}

	// Port specification - only add if not default and not using SSH config
	// (when using SSH config, let SSH config handle the port)
	if (!config.useSshConfig || config.port !== 22) {
		args.push('-p', config.port.toString());
	}

	// Build destination - use user@host if username provided, otherwise just host
	// SSH will use current user or ~/.ssh/config User directive if no username specified
	if (config.username && config.username.trim()) {
		args.push(`${config.username}@${config.host}`);
	} else {
		args.push(config.host);
	}

	// Merge remote config's environment with the command-specific environment
	// Command-specific env takes precedence over remote config env
	const mergedEnv: Record<string, string> = {
		...(config.remoteEnv || {}),
		...(remoteOptions.env || {}),
	};

	// Use working directory from remoteOptions if provided
	// No cd if not specified - agent will start in remote home directory
	const effectiveCwd = remoteOptions.cwd;

	// Build the remote command string
	const remoteCommand = buildRemoteCommand({
		command: remoteOptions.command,
		args: remoteOptions.args,
		cwd: effectiveCwd,
		env: Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined,
	});

	// Wrap the command with explicit PATH setup instead of sourcing profile files.
	// Profile files often chain to zsh or contain syntax incompatible with -c embedding.
	//
	// CRITICAL: Use /bin/bash (full path) instead of just 'bash' because:
	// SSH passes the command to the remote's login shell (often zsh) which parses it.
	// If we use 'bash', zsh still sources its profile files while resolving the command.
	// Using /bin/bash directly bypasses this - zsh just executes the path without sourcing.
	//
	// We prepend common binary locations to PATH:
	// - ~/.local/bin: Claude Code, pip --user installs
	// - ~/.opencode/bin: OpenCode installer default location
	// - ~/bin: User scripts
	// - /usr/local/bin: Homebrew on Intel Mac, manual installs
	// - /opt/homebrew/bin: Homebrew on Apple Silicon
	// - ~/.cargo/bin: Rust tools
	//
	// This approach avoids all profile sourcing issues while ensuring agent binaries are found.
	//
	// CRITICAL: Use single quotes for the -c argument to prevent the remote shell (often zsh)
	// from parsing the command content. SSH passes the command to the remote's login shell,
	// which parses it before executing. Double quotes allow zsh to interpret $, `, \, etc.
	// Single quotes are parsed literally by zsh - it just passes the content to bash as-is.
	//
	// The inner command uses shellEscape() which handles embedded single quotes via '\'' pattern.
	const pathSetup =
		'export PATH="$HOME/.local/bin:$HOME/.opencode/bin:$HOME/bin:/usr/local/bin:/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"';
	const fullBashCommand = `${pathSetup} && ${remoteCommand}`;
	const wrappedCommand = `/bin/bash --norc --noprofile -c ${shellEscape(fullBashCommand)}`;
	args.push(wrappedCommand);

	// Log the exact command being built - use info level so it appears in system logs
	logger.info('SSH command built for remote execution', '[ssh-command-builder]', {
		host: config.host,
		username: config.username || '(using SSH config/system default)',
		port: config.port,
		useSshConfig: config.useSshConfig,
		privateKeyPath: config.privateKeyPath ? '***configured***' : '(using SSH config/agent)',
		remoteCommand,
		wrappedCommand,
		sshPath,
		sshArgsCount: args.length,
		// Full command for debugging - escape quotes for readability
		fullCommand: `${sshPath} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`,
	});

	return {
		command: sshPath,
		args,
	};
}
