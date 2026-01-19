/**
 * OpenSpec Service
 *
 * Provides access to bundled OpenSpec commands for the renderer.
 * These commands integrate with the slash command system.
 */

import type { OpenSpecCommand, OpenSpecMetadata } from '../types';

/**
 * Get all OpenSpec commands from the main process
 */
export async function getOpenSpecCommands(): Promise<OpenSpecCommand[]> {
	try {
		const result = await window.maestro.openspec.getPrompts();
		if (result.success && result.commands) {
			return result.commands;
		}
		return [];
	} catch (error) {
		console.error('[OpenSpec] Failed to get commands:', error);
		return [];
	}
}

/**
 * Get OpenSpec metadata (version, refresh date)
 */
export async function getOpenSpecMetadata(): Promise<OpenSpecMetadata | null> {
	try {
		const result = await window.maestro.openspec.getMetadata();
		if (result.success && result.metadata) {
			return result.metadata;
		}
		return null;
	} catch (error) {
		console.error('[OpenSpec] Failed to get metadata:', error);
		return null;
	}
}

/**
 * Get a single OpenSpec command by its slash command string
 */
export async function getOpenSpecCommand(slashCommand: string): Promise<OpenSpecCommand | null> {
	try {
		const result = await window.maestro.openspec.getCommand(slashCommand);
		if (result.success && result.command) {
			return result.command;
		}
		return null;
	} catch (error) {
		console.error('[OpenSpec] Failed to get command:', error);
		return null;
	}
}
