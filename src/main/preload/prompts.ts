// ABOUTME: Preload API for core system prompts.
// ABOUTME: Provides window.maestro.prompts namespace for get, getAll, save, and reset operations.

/**
 * Preload API for core system prompts
 *
 * Provides the window.maestro.prompts namespace for:
 * - Getting individual prompts by ID
 * - Getting all prompts with metadata (for the Prompts UI tab)
 * - Saving user edits (immediate in-memory + disk)
 * - Resetting prompts to bundled defaults
 */

import { ipcRenderer } from 'electron';

/**
 * Core prompt definition returned by the prompts API
 */
export interface CorePromptEntry {
	id: string;
	filename: string;
	description: string;
	category: string;
	content: string;
	isModified: boolean;
}

/**
 * Creates the Prompts API object for preload exposure
 */
export function createPromptsApi() {
	return {
		// Get a single prompt by ID
		get: (id: string): Promise<{
			success: boolean;
			content?: string;
			error?: string;
		}> => ipcRenderer.invoke('prompts:get', id),

		// Get all prompts with metadata (for UI)
		getAll: (): Promise<{
			success: boolean;
			prompts?: CorePromptEntry[];
			error?: string;
		}> => ipcRenderer.invoke('prompts:getAll'),

		// Get all prompt IDs
		getAllIds: (): Promise<{
			success: boolean;
			ids?: string[];
			error?: string;
		}> => ipcRenderer.invoke('prompts:getAllIds'),

		// Save user's edit (immediate effect)
		save: (id: string, content: string): Promise<{
			success: boolean;
			error?: string;
		}> => ipcRenderer.invoke('prompts:save', id, content),

		// Reset to bundled default (immediate effect)
		reset: (id: string): Promise<{
			success: boolean;
			content?: string;
			error?: string;
		}> => ipcRenderer.invoke('prompts:reset', id),
	};
}

export type PromptsApi = ReturnType<typeof createPromptsApi>;
