/**
 * OpenSpec prompts module
 *
 * Bundled prompts for the OpenSpec workflow from Fission-AI with our custom Maestro integration.
 * These prompts are imported at build time using Vite's ?raw suffix.
 *
 * OpenSpec provides a structured change management workflow:
 * - Proposal → Draft change specifications before coding
 * - Apply → Implement tasks referencing agreed specs
 * - Archive → Move completed work to archive after deployment
 *
 * Source: https://github.com/Fission-AI/OpenSpec
 * Version: 0.1.0
 */

// Bundled OpenSpec prompts (extracted from upstream AGENTS.md)
import proposalPrompt from './openspec.proposal.md?raw';
import applyPrompt from './openspec.apply.md?raw';
import archivePrompt from './openspec.archive.md?raw';

// Custom Maestro prompts
import helpPrompt from './openspec.help.md?raw';
import implementPrompt from './openspec.implement.md?raw';

// Metadata
import metadataJson from './metadata.json';

export interface OpenSpecCommandDefinition {
	id: string;
	command: string;
	description: string;
	prompt: string;
	isCustom: boolean;
}

export interface OpenSpecMetadata {
	lastRefreshed: string;
	commitSha: string;
	sourceVersion: string;
	sourceUrl: string;
}

/**
 * All bundled OpenSpec commands
 */
export const openspecCommands: OpenSpecCommandDefinition[] = [
	{
		id: 'help',
		command: '/openspec.help',
		description: 'Learn how to use OpenSpec with Maestro',
		prompt: helpPrompt,
		isCustom: true,
	},
	{
		id: 'proposal',
		command: '/openspec.proposal',
		description: 'Create a change proposal with specs, tasks, and optional design docs',
		prompt: proposalPrompt,
		isCustom: false,
	},
	{
		id: 'apply',
		command: '/openspec.apply',
		description: 'Implement an approved change proposal by executing tasks',
		prompt: applyPrompt,
		isCustom: false,
	},
	{
		id: 'archive',
		command: '/openspec.archive',
		description: 'Archive a completed change after deployment',
		prompt: archivePrompt,
		isCustom: false,
	},
	{
		id: 'implement',
		command: '/openspec.implement',
		description: 'Convert OpenSpec tasks to Maestro Auto Run documents',
		prompt: implementPrompt,
		isCustom: true,
	},
];

/**
 * Get an OpenSpec command by ID
 */
export function getOpenSpecCommand(id: string): OpenSpecCommandDefinition | undefined {
	return openspecCommands.find((cmd) => cmd.id === id);
}

/**
 * Get an OpenSpec command by slash command string
 */
export function getOpenSpecCommandBySlash(command: string): OpenSpecCommandDefinition | undefined {
	return openspecCommands.find((cmd) => cmd.command === command);
}

/**
 * Get the metadata for bundled OpenSpec prompts
 */
export function getOpenSpecMetadata(): OpenSpecMetadata {
	return {
		lastRefreshed: metadataJson.lastRefreshed,
		commitSha: metadataJson.commitSha,
		sourceVersion: metadataJson.sourceVersion,
		sourceUrl: metadataJson.sourceUrl,
	};
}

// Export individual prompts for direct access
export { helpPrompt, proposalPrompt, applyPrompt, archivePrompt, implementPrompt };
