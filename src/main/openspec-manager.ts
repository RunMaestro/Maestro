/**
 * OpenSpec Manager
 *
 * Manages bundled OpenSpec prompts with support for:
 * - Loading bundled prompts from src/prompts/openspec/
 * - Fetching updates from GitHub's OpenSpec repository
 * - User customization with ability to reset to defaults
 *
 * OpenSpec provides a structured change management workflow:
 * - Proposal → Draft change specifications before coding
 * - Apply → Implement tasks referencing agreed specs
 * - Archive → Move completed work to archive after deployment
 *
 * Source: https://github.com/Fission-AI/OpenSpec
 *
 * The common load/save/reset/getBySlash logic lives in spec-command-manager.ts.
 * This module provides the OpenSpec specific configuration and the AGENTS.md
 * section-parsing refresh strategy.
 */

import fs from 'fs/promises';
import path from 'path';
import { logger } from './utils/logger';
import {
	createSpecCommandManager,
	SpecCommand,
	SpecCommandDefinition,
	SpecMetadata,
} from './spec-command-manager';

const LOG_CONTEXT = '[OpenSpec]';

// All bundled OpenSpec commands with their metadata
const OPENSPEC_COMMANDS: readonly SpecCommandDefinition[] = [
	{
		id: 'help',
		description: 'Learn how to use OpenSpec with Maestro',
		isCustom: true,
	},
	{
		id: 'proposal',
		description: 'Create a change proposal with specs, tasks, and optional design docs',
		isCustom: false,
	},
	{
		id: 'apply',
		description: 'Implement an approved change proposal by executing tasks',
		isCustom: false,
	},
	{
		id: 'archive',
		description: 'Archive a completed change after deployment',
		isCustom: false,
	},
	{
		id: 'implement',
		description: 'Convert OpenSpec tasks to Maestro Auto Run documents',
		isCustom: true,
	},
] as const;

// OpenSpec specific public types are aliases over the shared shape.
export type OpenSpecCommand = SpecCommand;
export type OpenSpecMetadata = SpecMetadata;

const manager = createSpecCommandManager({
	logContext: LOG_CONTEXT,
	filePrefix: 'openspec',
	bundledDirName: 'openspec',
	customizationsFileName: 'openspec-customizations.json',
	userPromptsDirName: 'openspec-prompts',
	commands: OPENSPEC_COMMANDS,
	defaultMetadata: {
		lastRefreshed: '2026-01-12T00:00:00Z',
		commitSha: 'v0.19.0',
		sourceVersion: '0.19.0',
		sourceUrl: 'https://github.com/Fission-AI/OpenSpec',
	},
});

/**
 * Get current OpenSpec metadata
 */
export const getOpenSpecMetadata = (): Promise<OpenSpecMetadata> => manager.getMetadata();

/**
 * Get all OpenSpec prompts (bundled defaults merged with user customizations)
 */
export const getOpenSpecPrompts = (): Promise<OpenSpecCommand[]> => manager.getPrompts();

/**
 * Save user's edit to an OpenSpec prompt
 */
export const saveOpenSpecPrompt = (id: string, content: string): Promise<void> =>
	manager.savePrompt(id, content);

/**
 * Reset an OpenSpec prompt to its bundled default
 */
export const resetOpenSpecPrompt = (id: string): Promise<string> => manager.resetPrompt(id);

/**
 * Get a single OpenSpec command by ID
 */
export const getOpenSpecCommand = (id: string): Promise<OpenSpecCommand | null> =>
	manager.getCommand(id);

/**
 * Get an OpenSpec command by its slash command string (e.g., "/openspec.proposal")
 */
export const getOpenSpecCommandBySlash = (slashCommand: string): Promise<OpenSpecCommand | null> =>
	manager.getCommandBySlash(slashCommand);

/**
 * Upstream commands to fetch (we skip custom commands like 'help' and 'implement')
 */
const UPSTREAM_COMMANDS = ['proposal', 'apply', 'archive'];

/**
 * Section markers in AGENTS.md for extracting workflow prompts
 */
const SECTION_MARKERS: Record<string, { start: RegExp; end: RegExp }> = {
	proposal: {
		start: /^#+\s*Stage\s*1[:\s]+Creating\s+Changes/i,
		end: /^#+\s*Stage\s*2[:\s]+/i,
	},
	apply: {
		start: /^#+\s*Stage\s*2[:\s]+Implementing\s+Changes/i,
		end: /^#+\s*Stage\s*3[:\s]+/i,
	},
	archive: {
		start: /^#+\s*Stage\s*3[:\s]+Archiving\s+Changes/i,
		end: /^$/, // End of file or next major section
	},
};

/**
 * Parse AGENTS.md and extract workflow sections as prompts
 */
function parseAgentsMd(content: string): Record<string, string> {
	const result: Record<string, string> = {};
	const lines = content.split('\n');

	for (const [sectionId, markers] of Object.entries(SECTION_MARKERS)) {
		let inSection = false;
		const sectionLines: string[] = [];

		for (const line of lines) {
			if (!inSection && markers.start.test(line)) {
				inSection = true;
				sectionLines.push(line);
				continue;
			}

			if (inSection) {
				// Check if we've hit the end marker (next stage or end of content)
				if (markers.end.test(line) && line.trim() !== '') {
					// Don't include the end marker line, it belongs to the next section
					break;
				}
				sectionLines.push(line);
			}
		}

		if (sectionLines.length > 0) {
			result[sectionId] = sectionLines.join('\n').trim();
		}
	}

	return result;
}

/**
 * Fetch latest prompts from GitHub OpenSpec repository
 * Updates all upstream commands by parsing AGENTS.md
 */
export async function refreshOpenSpecPrompts(): Promise<OpenSpecMetadata> {
	logger.info('Refreshing OpenSpec prompts from GitHub...', LOG_CONTEXT);

	// First, get the latest release info to get the version
	let version = 'main';
	try {
		const releaseResponse = await fetch(
			'https://api.github.com/repos/Fission-AI/OpenSpec/releases/latest',
			{
				headers: { 'User-Agent': 'Maestro-OpenSpec-Refresher' },
			}
		);
		if (releaseResponse.ok) {
			const releaseInfo = (await releaseResponse.json()) as { tag_name: string };
			version = releaseInfo.tag_name;
			logger.info(`Latest OpenSpec release: ${version}`, LOG_CONTEXT);
		}
	} catch {
		logger.warn('Could not fetch release info, using main branch', LOG_CONTEXT);
	}

	// Fetch AGENTS.md from the release tag (or main if no release found)
	const agentsMdUrl = `https://raw.githubusercontent.com/Fission-AI/OpenSpec/${version}/openspec/AGENTS.md`;
	const agentsResponse = await fetch(agentsMdUrl);
	if (!agentsResponse.ok) {
		throw new Error(`Failed to fetch AGENTS.md: ${agentsResponse.statusText}`);
	}
	const agentsMdContent = await agentsResponse.text();
	logger.info(`Downloaded AGENTS.md from ${version}`, LOG_CONTEXT);

	// Parse the AGENTS.md content to extract sections
	const extractedPrompts = parseAgentsMd(agentsMdContent);
	logger.info(
		`Extracted ${Object.keys(extractedPrompts).length} sections from AGENTS.md`,
		LOG_CONTEXT
	);

	// Create user prompts directory
	const userPromptsDir = manager.getUserPromptsPath();
	await fs.mkdir(userPromptsDir, { recursive: true });

	// Save extracted prompts
	for (const cmdId of UPSTREAM_COMMANDS) {
		const promptContent = extractedPrompts[cmdId];
		if (promptContent) {
			const destPath = path.join(userPromptsDir, `openspec.${cmdId}.md`);
			await fs.writeFile(destPath, promptContent, 'utf8');
			logger.info(`Updated: openspec.${cmdId}.md`, LOG_CONTEXT);
		} else {
			logger.warn(`Could not extract ${cmdId} section from AGENTS.md`, LOG_CONTEXT);
		}
	}

	// Update metadata with new version info
	const newMetadata: OpenSpecMetadata = {
		lastRefreshed: new Date().toISOString(),
		commitSha: version,
		sourceVersion: version.replace(/^v/, ''),
		sourceUrl: 'https://github.com/Fission-AI/OpenSpec',
	};

	// Save metadata to user prompts directory
	await fs.writeFile(
		path.join(userPromptsDir, 'metadata.json'),
		JSON.stringify(newMetadata, null, 2),
		'utf8'
	);

	// Also save to customizations file for compatibility
	const customizations = (await manager.loadUserCustomizations()) ?? {
		metadata: newMetadata,
		prompts: {},
	};
	customizations.metadata = newMetadata;
	await manager.saveUserCustomizations(customizations);

	logger.info(`Refreshed OpenSpec prompts to ${version}`, LOG_CONTEXT);

	return newMetadata;
}
