/**
 * @file groupchat/windows-spawn.ts
 * @description The Windows shell and stdin choices for a group chat or consult turn.
 *
 * The desktop's `group-chat-config.ts` binds it to the custom shell path from Settings; the
 * headless runtime binds it to the same setting read from the settings file.
 */

import { isWindows } from '../../platformDetection';
import { getWindowsShellForAgentExecution } from '../launch/windows-shell-escape';
import { getAgentCapabilities } from '../providers/capabilities';

/**
 * SSH remote configuration type for spawn config.
 * Matches the pattern used in GroupChatSessionInfo.sshRemoteConfig.
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
 * @param options.customShellPath - The shell the user chose in Settings, preferred over cmd.exe
 * @returns Shell and stdin configuration for Windows, or no-op config for non-Windows/SSH
 */
export function getWindowsSpawnConfig(
	agentId: string,
	sshConfig?: SpawnSshConfig,
	options: { customShellPath?: string } = {}
): WindowsSpawnConfig {
	// Don't apply Windows shell config when using SSH (remote may be Linux)
	if (!isWindows() || sshConfig?.enabled) {
		return {
			shell: undefined,
			runInShell: false,
			sendPromptViaStdin: false,
			sendPromptViaStdinRaw: false,
		};
	}

	// Get shell configuration for Windows
	const shellConfig = getWindowsShellForAgentExecution({
		customShellPath: options.customShellPath,
	});

	// Determine stdin mode based on agent capabilities. A CLI that only accepts
	// the prompt as a positional argument (omp) keeps it in argv - handing it
	// stdin instead makes it run with no prompt at all.
	const capabilities = getAgentCapabilities(agentId);
	const supportsStreamJson = capabilities.supportsStreamJsonInput;
	const supportsPromptViaStdin = capabilities.supportsPromptViaStdin;

	return {
		shell: shellConfig.shell,
		runInShell: shellConfig.useShell,
		sendPromptViaStdin: supportsPromptViaStdin && supportsStreamJson,
		sendPromptViaStdinRaw: supportsPromptViaStdin && !supportsStreamJson,
	};
}
