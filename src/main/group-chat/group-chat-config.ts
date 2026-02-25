/**
 * @file group-chat-config.ts
 * @description Shared configuration callbacks for Group Chat feature.
 *
 * These callbacks are set once during initialization and used by both
 * group-chat-router.ts and group-chat-agent.ts to avoid duplication.
 */

import { getAgentCapabilities } from '../agents';
import { getWindowsShellForAgentExecution } from '../process-manager/utils/shellEscape';

// Module-level callback for getting custom shell path from settings
let getCustomShellPathCallback: (() => string | undefined) | null = null;

/**
 * Sets the callback for getting the custom shell path from settings.
 * This is used on Windows to prefer PowerShell over cmd.exe to avoid command line length limits.
 * Called from index.ts during initialization.
 */
export function setGetCustomShellPathCallback(callback: () => string | undefined): void {
	getCustomShellPathCallback = callback;
}

/**
 * Gets the custom shell path using the registered callback.
 * Returns undefined if no callback is registered or if the callback returns undefined.
 */
export function getCustomShellPath(): string | undefined {
	return getCustomShellPathCallback?.();
}

/**
 * SSH remote configuration type for spawn config.
 * Matches the pattern used in SessionInfo.sshRemoteConfig.
 */
export interface SpawnSshConfig {
	enabled: boolean;
	remoteId: string | null;
	workingDirOverride?: string;
}

/**
 * Result of getWindowsSpawnConfig - shell and stdin flags for Windows spawning.
 */
export interface WindowsSpawnConfig {
	/** Shell path for Windows (PowerShell or cmd.exe) */
	shell: string | undefined;
	/** Whether to run in shell */
	runInShell: boolean;
	/** Whether to send prompt via stdin as JSON (for stream-json agents) */
	sendPromptViaStdin: boolean;
	/** Whether to send prompt via stdin as raw text (for non-stream-json agents) */
	sendPromptViaStdinRaw: boolean;
}

/**
 * Gets Windows-specific spawn configuration for group chat agent execution.
 *
 * This centralizes the logic for:
 * 1. Shell selection (PowerShell vs cmd.exe)
 * 2. Stdin mode selection (JSON vs raw text based on agent capabilities)
 *
 * IMPORTANT: This should NOT be applied when SSH remote execution is enabled,
 * as the remote host may be Linux where these Windows-specific configs don't apply.
 *
 * @param agentId - The agent ID to check capabilities for
 * @param sshConfig - Optional SSH configuration; if enabled, returns no-op config
 * @returns Shell and stdin configuration for Windows, or no-op config for non-Windows/SSH
 */
export function getWindowsSpawnConfig(
	agentId: string,
	sshConfig?: SpawnSshConfig
): WindowsSpawnConfig {
	// Don't apply Windows shell config when using SSH (remote may be Linux)
	if (process.platform !== 'win32' || sshConfig?.enabled) {
		return {
			shell: undefined,
			runInShell: false,
			sendPromptViaStdin: false,
			sendPromptViaStdinRaw: false,
		};
	}

	// Get shell configuration for Windows
	const shellConfig = getWindowsShellForAgentExecution({
		customShellPath: getCustomShellPath(),
	});

	// Determine stdin mode based on agent capabilities
	const capabilities = getAgentCapabilities(agentId);
	const supportsStreamJson = capabilities.supportsStreamJsonInput;

	return {
		shell: shellConfig.shell,
		runInShell: shellConfig.useShell,
		sendPromptViaStdin: supportsStreamJson,
		sendPromptViaStdinRaw: !supportsStreamJson,
	};
}
