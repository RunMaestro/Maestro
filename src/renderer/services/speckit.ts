/**
 * Spec Kit Service
 *
 * Provides access to bundled spec-kit commands for the renderer.
 * These commands integrate with the slash command system.
 */

import type { SpecKitCommand, SpecKitMetadata } from '../types';

/**
 * Get all spec-kit commands from the main process
 */
export async function getSpeckitCommands(): Promise<SpecKitCommand[]> {
	try {
		const result = await window.maestro.speckit.getPrompts();
		if (result.success && result.commands) {
			return result.commands;
		}
		return [];
	} catch (error) {
		console.error('[SpecKit] Failed to get commands:', error);
		return [];
	}
}

/**
 * Get spec-kit metadata (version, refresh date)
 */
export async function getSpeckitMetadata(): Promise<SpecKitMetadata | null> {
	try {
		const result = await window.maestro.speckit.getMetadata();
		if (result.success && result.metadata) {
			return result.metadata;
		}
		return null;
	} catch (error) {
		console.error('[SpecKit] Failed to get metadata:', error);
		return null;
	}
}

/**
 * Get a single spec-kit command by its slash command string
 */
export async function getSpeckitCommand(slashCommand: string): Promise<SpecKitCommand | null> {
	try {
		const result = await window.maestro.speckit.getCommand(slashCommand);
		if (result.success && result.command) {
			return result.command;
		}
		return null;
	} catch (error) {
		console.error('[SpecKit] Failed to get command:', error);
		return null;
	}
}
