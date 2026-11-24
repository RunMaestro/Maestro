/**
 * Preload API for side questions (`/btw`)
 *
 * Provides the window.maestro.sideQuestion namespace: ask the tab's model a
 * question about its conversation through a throwaway fork of the session, so
 * the answer never lands in the tab's history.
 */

import { ipcRenderer } from 'electron';

export interface SideQuestionRequest {
	question: string;
	/** Provider that owns the tab. */
	agentType: string;
	/** The agent's working directory. */
	cwd: string;
	/** The tab's provider session, when it has had a turn. */
	agentSessionId?: string;
	sessionSshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
	customPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	/** The tab's current model and effort. */
	customModel?: string;
	customEffort?: string;
}

export interface SideQuestionResult {
	success: boolean;
	answer?: string;
	error?: string;
}

export function createSideQuestionApi() {
	return {
		ask: (config: SideQuestionRequest): Promise<SideQuestionResult> =>
			ipcRenderer.invoke('sideQuestion:ask', config),
	};
}

export type SideQuestionApi = ReturnType<typeof createSideQuestionApi>;
