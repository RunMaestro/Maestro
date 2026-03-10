/**
 * @file group-chat-config.ts
 * @description Shared configuration callbacks for Group Chat feature.
 *
 * These callbacks are set once during initialization and used by both
 * group-chat-router.ts and group-chat-agent.ts to avoid duplication.
 */

import path from 'path';
import { getAgentCapabilities } from '../agents';
import { getWindowsShellForAgentExecution } from '../process-manager/utils/shellEscape';
import { isWindows } from '../../shared/platformDetection';

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

/**
 * Build additional --include-directories args for Gemini CLI in group chat.
 * Gemini CLI has stricter sandbox enforcement than other agents and needs
 * explicit directory approval for each path it accesses. In group chat,
 * this means the project directories, the group chat shared folder, and
 * the home directory all need to be included.
 *
 * Paths are normalized via path.resolve() before dedup so that equivalent
 * paths (e.g., `/foo/bar` and `/foo/../foo/bar`) are not duplicated.
 *
 * For non-Gemini agents, returns an empty array (no-op).
 */
export function buildGeminiWorkspaceDirArgs(
	agent: { workingDirArgs?: (dir: string) => string[]; id?: string } | null | undefined,
	agentId: string,
	directories: string[]
): string[] {
	if (agentId !== 'gemini-cli' || !agent?.workingDirArgs) {
		return [];
	}
	const args: string[] = [];
	const seen = new Set<string>();
	for (const dir of directories) {
		if (!dir || !dir.trim()) continue;
		const resolved = path.resolve(dir);
		if (!seen.has(resolved)) {
			seen.add(resolved);
			args.push(...agent.workingDirArgs(resolved));
		}
	}
	return args;
}
