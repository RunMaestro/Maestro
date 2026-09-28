/**
 * Preload API for AI command mode
 *
 * Provides the window.maestro.aiCommand namespace for turning a plain-English
 * request into one shell command line. This is only the suggestion round trip -
 * running the accepted command still goes through window.maestro.process, so a
 * suggested command and a typed `!` command execute through the same path.
 */

import { ipcRenderer } from 'electron';
import type { AiCommandHistoryEntry } from '../../shared/aiCommand';

export interface AiCommandSuggestRequest {
	/** The user's plain-English description of what they want to do. */
	request: string;
	/** Provider that owns the tab. */
	agentType: string;
	/** Directory the accepted command will run in. */
	cwd: string;
	isGitRepo?: boolean;
	sessionSshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
	sshRemoteName?: string;
	customPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	/** The tab's current model and effort. */
	customModel?: string;
	customEffort?: string;
	/** Commands already run in this tab, oldest first, so follow-ups can refine. */
	recentCommands?: AiCommandHistoryEntry[];
}

export interface AiCommandSuggestResult {
	success: boolean;
	command?: string;
	error?: string;
}

export function createAiCommandApi() {
	return {
		suggest: (config: AiCommandSuggestRequest): Promise<AiCommandSuggestResult> =>
			ipcRenderer.invoke('aiCommand:suggest', config),
	};
}

export type AiCommandApi = ReturnType<typeof createAiCommandApi>;
