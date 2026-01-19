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
 */

import fs from 'fs/promises';
import path from 'path';
import { app } from 'electron';
import { logger } from './utils/logger';

const LOG_CONTEXT = '[OpenSpec]';

// All bundled OpenSpec commands with their metadata
const OPENSPEC_COMMANDS = [
	{
		id: 'help',
		command: '/openspec.help',
		description: 'Learn how to use OpenSpec with Maestro',
		isCustom: true,
	},
	{
		id: 'proposal',
		command: '/openspec.proposal',
		description: 'Create a change proposal with specs, tasks, and optional design docs',
		isCustom: false,
	},
	{
		id: 'apply',
		command: '/openspec.apply',
		description: 'Implement an approved change proposal by executing tasks',
		isCustom: false,
	},
	{
		id: 'archive',
		command: '/openspec.archive',
		description: 'Archive a completed change after deployment',
		isCustom: false,
	},
	{
		id: 'implement',
		command: '/openspec.implement',
		description: 'Convert OpenSpec tasks to Maestro Auto Run documents',
		isCustom: true,
	},
] as const;

export interface OpenSpecCommand {
	id: string;
	command: string;
	description: string;
	prompt: string;
	isCustom: boolean;
	isModified: boolean;
}

export interface OpenSpecMetadata {
	lastRefreshed: string;
	commitSha: string;
	sourceVersion: string;
	sourceUrl: string;
}

interface StoredPrompt {
	content: string;
	isModified: boolean;
	modifiedAt?: string;
}

interface StoredData {
	metadata: OpenSpecMetadata;
	prompts: Record<string, StoredPrompt>;
}

/**
 * Get path to user's OpenSpec customizations file
 */
function getUserDataPath(): string {
	return path.join(app.getPath('userData'), 'openspec-customizations.json');
}

/**
 * Load user customizations from disk
 */
async function loadUserCustomizations(): Promise<StoredData | null> {
	try {
		const content = await fs.readFile(getUserDataPath(), 'utf-8');
		return JSON.parse(content);
	} catch {
		return null;
	}
}

/**
 * Save user customizations to disk
 */
async function saveUserCustomizations(data: StoredData): Promise<void> {
	await fs.writeFile(getUserDataPath(), JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Get the path to bundled prompts directory
 * In development, this is src/prompts/openspec
 * In production, this is in the app resources
 */
function getBundledPromptsPath(): string {
	if (app.isPackaged) {
		return path.join(process.resourcesPath, 'prompts', 'openspec');
	}
	// In development, use the source directory
	return path.join(__dirname, '..', '..', 'src', 'prompts', 'openspec');
}

/**
 * Get the user data directory for storing downloaded OpenSpec prompts
 */
function getUserPromptsPath(): string {
	return path.join(app.getPath('userData'), 'openspec-prompts');
}

/**
 * Get bundled prompts by reading from disk
 * Checks user prompts directory first (for downloaded updates), then falls back to bundled
 */
async function getBundledPrompts(): Promise<
	Record<string, { prompt: string; description: string; isCustom: boolean }>
> {
	const bundledPromptsDir = getBundledPromptsPath();
	const userPromptsDir = getUserPromptsPath();
	const result: Record<string, { prompt: string; description: string; isCustom: boolean }> = {};

	for (const cmd of OPENSPEC_COMMANDS) {
		// For custom commands, always use bundled
		if (cmd.isCustom) {
			try {
				const promptPath = path.join(bundledPromptsDir, `openspec.${cmd.id}.md`);
				const prompt = await fs.readFile(promptPath, 'utf-8');
				result[cmd.id] = {
					prompt,
					description: cmd.description,
					isCustom: cmd.isCustom,
				};
			} catch (error) {
				logger.warn(`Failed to load bundled prompt for ${cmd.id}: ${error}`, LOG_CONTEXT);
				result[cmd.id] = {
					prompt: `# ${cmd.id}\n\nPrompt not available.`,
					description: cmd.description,
					isCustom: cmd.isCustom,
				};
			}
			continue;
		}

		// For upstream commands, check user prompts directory first (downloaded updates)
		try {
			const userPromptPath = path.join(userPromptsDir, `openspec.${cmd.id}.md`);
			const prompt = await fs.readFile(userPromptPath, 'utf-8');
			result[cmd.id] = {
				prompt,
				description: cmd.description,
				isCustom: cmd.isCustom,
			};
			continue;
		} catch {
			// User prompt not found, try bundled
		}

		// Fall back to bundled prompts
		try {
			const promptPath = path.join(bundledPromptsDir, `openspec.${cmd.id}.md`);
			const prompt = await fs.readFile(promptPath, 'utf-8');
			result[cmd.id] = {
				prompt,
				description: cmd.description,
				isCustom: cmd.isCustom,
			};
		} catch (error) {
			logger.warn(`Failed to load bundled prompt for ${cmd.id}: ${error}`, LOG_CONTEXT);
			result[cmd.id] = {
				prompt: `# ${cmd.id}\n\nPrompt not available.`,
				description: cmd.description,
				isCustom: cmd.isCustom,
			};
		}
	}

	return result;
}

/**
 * Get bundled metadata by reading from disk
 * Checks user prompts directory first (for downloaded updates), then falls back to bundled
 */
async function getBundledMetadata(): Promise<OpenSpecMetadata> {
	const bundledPromptsDir = getBundledPromptsPath();
	const userPromptsDir = getUserPromptsPath();

	// Check user prompts directory first (downloaded updates)
	try {
		const userMetadataPath = path.join(userPromptsDir, 'metadata.json');
		const content = await fs.readFile(userMetadataPath, 'utf-8');
		return JSON.parse(content);
	} catch {
		// User metadata not found, try bundled
	}

	// Fall back to bundled metadata
	try {
		const metadataPath = path.join(bundledPromptsDir, 'metadata.json');
		const content = await fs.readFile(metadataPath, 'utf-8');
		return JSON.parse(content);
	} catch {
		// Return default metadata if file doesn't exist
		return {
			lastRefreshed: '2026-01-12T00:00:00Z',
			commitSha: 'v0.19.0',
			sourceVersion: '0.19.0',
			sourceUrl: 'https://github.com/Fission-AI/OpenSpec',
		};
	}
}

/**
 * Get current OpenSpec metadata
 */
export async function getOpenSpecMetadata(): Promise<OpenSpecMetadata> {
	const customizations = await loadUserCustomizations();
	if (customizations?.metadata) {
		return customizations.metadata;
	}
	return getBundledMetadata();
}

/**
 * Get all OpenSpec prompts (bundled defaults merged with user customizations)
 */
export async function getOpenSpecPrompts(): Promise<OpenSpecCommand[]> {
	const bundled = await getBundledPrompts();
	const customizations = await loadUserCustomizations();

	const commands: OpenSpecCommand[] = [];

	for (const [id, data] of Object.entries(bundled)) {
		const customPrompt = customizations?.prompts?.[id];
		const isModified = customPrompt?.isModified ?? false;
		const prompt = isModified && customPrompt ? customPrompt.content : data.prompt;

		commands.push({
			id,
			command: `/openspec.${id}`,
			description: data.description,
			prompt,
			isCustom: data.isCustom,
			isModified,
		});
	}

	return commands;
}

/**
 * Save user's edit to an OpenSpec prompt
 */
export async function saveOpenSpecPrompt(id: string, content: string): Promise<void> {
	const customizations = (await loadUserCustomizations()) ?? {
		metadata: await getBundledMetadata(),
		prompts: {},
	};

	customizations.prompts[id] = {
		content,
		isModified: true,
		modifiedAt: new Date().toISOString(),
	};

	await saveUserCustomizations(customizations);
	logger.info(`Saved customization for openspec.${id}`, LOG_CONTEXT);
}

/**
 * Reset an OpenSpec prompt to its bundled default
 */
export async function resetOpenSpecPrompt(id: string): Promise<string> {
	const bundled = await getBundledPrompts();
	const defaultPrompt = bundled[id];

	if (!defaultPrompt) {
		throw new Error(`Unknown openspec command: ${id}`);
	}

	const customizations = await loadUserCustomizations();
	if (customizations?.prompts?.[id]) {
		delete customizations.prompts[id];
		await saveUserCustomizations(customizations);
		logger.info(`Reset openspec.${id} to bundled default`, LOG_CONTEXT);
	}

	return defaultPrompt.prompt;
}

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
	const userPromptsDir = getUserPromptsPath();
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
	const customizations = (await loadUserCustomizations()) ?? {
		metadata: newMetadata,
		prompts: {},
	};
	customizations.metadata = newMetadata;
	await saveUserCustomizations(customizations);

	logger.info(`Refreshed OpenSpec prompts to ${version}`, LOG_CONTEXT);

	return newMetadata;
}

/**
 * Get a single OpenSpec command by ID
 */
export async function getOpenSpecCommand(id: string): Promise<OpenSpecCommand | null> {
	const commands = await getOpenSpecPrompts();
	return commands.find((cmd) => cmd.id === id) ?? null;
}

/**
 * Get an OpenSpec command by its slash command string (e.g., "/openspec.proposal")
 */
export async function getOpenSpecCommandBySlash(
	slashCommand: string
): Promise<OpenSpecCommand | null> {
	const commands = await getOpenSpecPrompts();
	return commands.find((cmd) => cmd.command === slashCommand) ?? null;
}
