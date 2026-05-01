/**
 * Preload API for the PM slash-command suite
 *
 * Provides the window.maestro.pm namespace for:
 * - /PM <idea>        → pm:orchestrate
 * - /PM prd-new       → pm:prd-new
 * - /PM prd-list      → pm:prd-list
 * - /PM next          → pm:next
 * - /PM status        → pm:status
 * - /PM standup       → pm:standup
 *
 * Also exposes onOpenPlanningPrompt() — a push listener for the main process to
 * request the renderer seed the active chat with a PM planning prompt.
 */

import { ipcRenderer } from 'electron';

export interface PmCommandRequest {
	args?: string;
	projectPath?: string;
	gitPath?: string;
	actor?: { sessionId?: string; name?: string };
}

export interface PmCommandResponse {
	success: boolean;
	message?: string;
	data?: unknown;
	error?: string;
	code?: string;
}

export interface PmOpenPlanningPromptEvent {
	mode: 'orchestrate' | 'prd-new';
	idea?: string;
	name?: string;
	projectPath?: string;
	gitPath?: string;
}

export function createPmApi() {
	return {
		/** /PM <idea> — open PM planning prompt in the active chat */
		orchestrate: (req: PmCommandRequest): Promise<PmCommandResponse> =>
			ipcRenderer.invoke('pm:orchestrate', req),

		/** /PM prd-new <name> — seed a new PRD planning conversation */
		prdNew: (req: PmCommandRequest): Promise<PmCommandResponse> =>
			ipcRenderer.invoke('pm:prd-new', req),

		/** /PM prd-list — list PRDs for the current project */
		prdList: (req?: PmCommandRequest): Promise<PmCommandResponse> =>
			ipcRenderer.invoke('pm:prd-list', req ?? {}),

		/** /PM next — next eligible work item */
		next: (req?: PmCommandRequest): Promise<PmCommandResponse> =>
			ipcRenderer.invoke('pm:next', req ?? {}),

		/** /PM status — board snapshot */
		status: (req?: PmCommandRequest): Promise<PmCommandResponse> =>
			ipcRenderer.invoke('pm:status', req ?? {}),

		/** /PM standup — standup summary */
		standup: (req?: PmCommandRequest): Promise<PmCommandResponse> =>
			ipcRenderer.invoke('pm:standup', req ?? {}),

		/**
		 * Listen for main-process push events requesting the renderer to seed
		 * the active chat with a PM planning prompt.
		 * Returns an unsubscribe function.
		 */
		onOpenPlanningPrompt: (handler: (event: PmOpenPlanningPromptEvent) => void): (() => void) => {
			const listener = (_e: unknown, event: PmOpenPlanningPromptEvent) => handler(event);
			ipcRenderer.on('pm:openPlanningPrompt', listener);
			return () => {
				ipcRenderer.removeListener('pm:openPlanningPrompt', listener);
			};
		},
	};
}

export type PmApi = ReturnType<typeof createPmApi>;
