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
 * Upstream commands to fetch (we skip custom commands like 'help' and 'implement').
 *
 * OpenSpec was rearchitected in the 1.x line: the old single `openspec/AGENTS.md`
 * with `Stage 1/2/3` sections is gone. The workflow prompts now live as TypeScript
 * template literals in `src/core/templates/workflows/<name>.ts`, exposed under the
 * new `opsx:` command surface. We keep our existing command surface
 * (proposal/apply/archive) and map each onto the upstream workflow that matches.
 */
const UPSTREAM_COMMANDS: Array<{ id: string; sourceFile: string }> = [
	{ id: 'proposal', sourceFile: 'propose.ts' },
	{ id: 'apply', sourceFile: 'apply-change.ts' },
	{ id: 'archive', sourceFile: 'archive-change.ts' },
];

const WORKFLOWS_BASE_PATH = 'src/core/templates/workflows';

/**
 * Extract the `instructions:` template-literal string from a workflow module's
 * TypeScript source. The literals are plain markdown with no `${}` interpolation,
 * so we just walk the backtick-delimited string, honoring escapes.
 */
function extractInstructions(tsSource: string): string | null {
	const marker = tsSource.indexOf('instructions:');
	if (marker < 0) return null;
	const start = tsSource.indexOf('`', marker);
	if (start < 0) return null;

	let result = '';
	for (let i = start + 1; i < tsSource.length; i++) {
		const char = tsSource[i];
		if (char === '\\') {
			// Preserve escaped backticks/backslashes as their literal character.
			const next = tsSource[i + 1];
			if (next === '`' || next === '\\' || next === '$') {
				result += next;
				i++;
				continue;
			}
			result += char;
			continue;
		}
		if (char === '`') break;
		result += char;
	}
	return result.trim();
}

/**
 * Fetch latest prompts from the GitHub OpenSpec repository.
 * Pulls each mapped workflow template and extracts its instructions body.
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

	// Create user prompts directory
	const userPromptsDir = manager.getUserPromptsPath();
	await fs.mkdir(userPromptsDir, { recursive: true });

	// Fetch and extract each mapped workflow template.
	let extractedCount = 0;
	for (const { id, sourceFile } of UPSTREAM_COMMANDS) {
		const url = `https://raw.githubusercontent.com/Fission-AI/OpenSpec/${version}/${WORKFLOWS_BASE_PATH}/${sourceFile}`;
		const response = await fetch(url, {
			headers: { 'User-Agent': 'Maestro-OpenSpec-Refresher' },
		});
		if (!response.ok) {
			throw new Error(`Failed to fetch ${sourceFile}: ${response.statusText}`);
		}
		const tsSource = await response.text();
		const promptContent = extractInstructions(tsSource);
		if (promptContent) {
			const destPath = path.join(userPromptsDir, `openspec.${id}.md`);
			await fs.writeFile(destPath, promptContent, 'utf8');
			logger.info(`Updated: openspec.${id}.md`, LOG_CONTEXT);
			extractedCount++;
		} else {
			logger.warn(`Could not extract instructions from ${sourceFile}`, LOG_CONTEXT);
		}
	}
	logger.info(`Extracted ${extractedCount} OpenSpec workflow prompts`, LOG_CONTEXT);

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
