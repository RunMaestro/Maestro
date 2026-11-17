/**
 * Preload API for Prompt Links (`window.maestro.promptLinks`).
 *
 * Mirrors the `promptLinks:*` channels registered in
 * `src/main/ipc/handlers/promptLinks.ts`. Desktop-only by construction: the
 * web-desktop bridge refuses every one of these channels, so this namespace
 * exists in a browser but answers nothing.
 */

import { ipcRenderer } from 'electron';
import type {
	PromptLinkCreateInput,
	PromptLinkCreated,
	PromptLinkPublic,
} from '../../shared/promptLinks';

/** Creates the Prompt Links API object for contextBridge exposure. */
export function createPromptLinksApi() {
	return {
		list: (): Promise<PromptLinkPublic[]> => ipcRenderer.invoke('promptLinks:list'),
		create: (input: PromptLinkCreateInput): Promise<PromptLinkCreated> =>
			ipcRenderer.invoke('promptLinks:create', input),
		revoke: (id: string): Promise<PromptLinkPublic> => ipcRenderer.invoke('promptLinks:revoke', id),
		rendererReady: (): Promise<void> => ipcRenderer.invoke('promptLinks:rendererReady'),
	};
}

export type PromptLinksApi = ReturnType<typeof createPromptLinksApi>;
