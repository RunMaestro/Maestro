/**
 * Preload API for core prompts
 *
 * Provides the window.maestro.prompts namespace for:
 * - Getting individual prompts by ID
 * - Getting all prompts with metadata (for Settings UI)
 * - Saving user customizations
 * - Resetting prompts to bundled defaults
 */

import { ipcRenderer } from 'electron';

export interface CorePromptData {
	id: string;
	filename: string;
	description: string;
	category: string;
	content: string;
	isModified: boolean;
}

export interface PromptFileEntry {
	name: string;
	filename: string;
	isCatalog: boolean;
}

/**
 * Creates the Prompts API object for preload exposure
 */
export function createPromptsApi() {
	return {
		// Get a single prompt by ID
		get: (id: string): Promise<{ success: boolean; content?: string; error?: string }> =>
			ipcRenderer.invoke('prompts:get', id),

		// Get all prompts with metadata (for UI)
		getAll: (): Promise<{
			success: boolean;
			prompts?: CorePromptData[];
			error?: string;
		}> => ipcRenderer.invoke('prompts:getAll'),

		// Get all prompt IDs
		getAllIds: (): Promise<{ success: boolean; ids?: string[]; error?: string }> =>
			ipcRenderer.invoke('prompts:getAllIds'),

		// Save user's edit (immediate effect)
		save: (id: string, content: string): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('prompts:save', id, content),

		// Reset to bundled default (immediate effect)
		reset: (id: string): Promise<{ success: boolean; content?: string; error?: string }> =>
			ipcRenderer.invoke('prompts:reset', id),

		// Get prompts directory path (for "Open Folder" button)
		getPath: (): Promise<{ success: boolean; path?: string; error?: string }> =>
			ipcRenderer.invoke('prompts:getPath'),

		// List all .md files in the prompts directory (includes user-added files)
		listFiles: (): Promise<{
			success: boolean;
			files?: PromptFileEntry[];
			error?: string;
		}> => ipcRenderer.invoke('prompts:listFiles'),
	};
}

export type PromptsApi = ReturnType<typeof createPromptsApi>;
