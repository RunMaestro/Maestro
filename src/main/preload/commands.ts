/**
 * Preload API for slash commands
 *
 * Provides the window.maestro.speckit and window.maestro.openspec namespaces for:
 * - Spec-Kit slash commands
 * - OpenSpec slash commands
 */

import { ipcRenderer } from 'electron';

/**
 * Command metadata
 */
export interface CommandMetadata {
	lastRefreshed: string;
	commitSha: string;
	sourceVersion: string;
	sourceUrl: string;
}

/**
 * Command definition
 */
export interface CommandDefinition {
	id: string;
	command: string;
	description: string;
	prompt: string;
	isCustom: boolean;
	isModified: boolean;
}

/**
 * Creates the Spec-Kit API object for preload exposure
 */
export function createSpeckitApi() {
	return {
		getMetadata: (): Promise<{
			success: boolean;
			metadata?: CommandMetadata;
			error?: string;
		}> => ipcRenderer.invoke('speckit:getMetadata'),

		getPrompts: (): Promise<{
			success: boolean;
			commands?: CommandDefinition[];
			error?: string;
		}> => ipcRenderer.invoke('speckit:getPrompts'),

		getCommand: (
			slashCommand: string
		): Promise<{
			success: boolean;
			command?: CommandDefinition | null;
			error?: string;
		}> => ipcRenderer.invoke('speckit:getCommand', slashCommand),

		savePrompt: (
			id: string,
			content: string
		): Promise<{
			success: boolean;
			error?: string;
		}> => ipcRenderer.invoke('speckit:savePrompt', id, content),

		resetPrompt: (
			id: string
		): Promise<{
			success: boolean;
			prompt?: string;
			error?: string;
		}> => ipcRenderer.invoke('speckit:resetPrompt', id),

		refresh: (): Promise<{
			success: boolean;
			metadata?: CommandMetadata;
			error?: string;
		}> => ipcRenderer.invoke('speckit:refresh'),
	};
}

/**
 * Creates the OpenSpec API object for preload exposure
 */
export function createOpenspecApi() {
	return {
		getMetadata: (): Promise<{
			success: boolean;
			metadata?: CommandMetadata;
			error?: string;
		}> => ipcRenderer.invoke('openspec:getMetadata'),

		getPrompts: (): Promise<{
			success: boolean;
			commands?: CommandDefinition[];
			error?: string;
		}> => ipcRenderer.invoke('openspec:getPrompts'),

		getCommand: (
			slashCommand: string
		): Promise<{
			success: boolean;
			command?: CommandDefinition | null;
			error?: string;
		}> => ipcRenderer.invoke('openspec:getCommand', slashCommand),

		savePrompt: (
			id: string,
			content: string
		): Promise<{
			success: boolean;
			error?: string;
		}> => ipcRenderer.invoke('openspec:savePrompt', id, content),

		resetPrompt: (
			id: string
		): Promise<{
			success: boolean;
			prompt?: string;
			error?: string;
		}> => ipcRenderer.invoke('openspec:resetPrompt', id),

		refresh: (): Promise<{
			success: boolean;
			metadata?: CommandMetadata;
			error?: string;
		}> => ipcRenderer.invoke('openspec:refresh'),
	};
}

export type SpeckitApi = ReturnType<typeof createSpeckitApi>;
export type OpenspecApi = ReturnType<typeof createOpenspecApi>;
