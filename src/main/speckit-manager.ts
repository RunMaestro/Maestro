/**
 * Spec Kit Manager
 *
 * Manages bundled spec-kit prompts with support for:
 * - Loading bundled prompts from src/prompts/speckit/
 * - Fetching updates from GitHub's spec-kit repository
 * - User customization with ability to reset to defaults
 *
 * The common load/save/reset/getBySlash logic lives in spec-command-manager.ts.
 * This module provides the SpecKit specific configuration and the GitHub release
 * ZIP refresh strategy.
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { app } from 'electron';
import https from 'https';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from './utils/logger';
import {
	createSpecCommandManager,
	SpecCommand,
	SpecCommandDefinition,
	SpecMetadata,
} from './spec-command-manager';

const execAsync = promisify(exec);

const LOG_CONTEXT = '[SpecKit]';

// All bundled spec-kit commands with their metadata
const SPECKIT_COMMANDS: readonly SpecCommandDefinition[] = [
	{
		id: 'help',
		description: 'Learn how to use spec-kit with Maestro',
		isCustom: true,
	},
	{
		id: 'constitution',
		description: 'Create or update the project constitution',
		isCustom: false,
	},
	{
		id: 'specify',
		description: 'Create or update feature specification',
		isCustom: false,
	},
	{
		id: 'clarify',
		description: 'Identify underspecified areas and ask clarification questions',
		isCustom: false,
	},
	{
		id: 'plan',
		description: 'Execute implementation planning workflow',
		isCustom: false,
	},
	{
		id: 'tasks',
		description: 'Generate actionable, dependency-ordered tasks',
		isCustom: false,
	},
	{
		id: 'analyze',
		description: 'Cross-artifact consistency and quality analysis',
		isCustom: false,
	},
	{
		id: 'checklist',
		description: 'Generate custom checklist for feature',
		isCustom: false,
	},
	{
		id: 'taskstoissues',
		description: 'Convert tasks to GitHub issues',
		isCustom: false,
	},
	{
		id: 'implement',
		description: 'Execute tasks using Maestro Auto Run with worktree support',
		isCustom: true,
	},
] as const;

// SpecKit specific public types are aliases over the shared shape.
export type SpecKitCommand = SpecCommand;
export type SpecKitMetadata = SpecMetadata;

const manager = createSpecCommandManager({
	logContext: LOG_CONTEXT,
	filePrefix: 'speckit',
	bundledDirName: 'speckit',
	customizationsFileName: 'speckit-customizations.json',
	userPromptsDirName: 'speckit-prompts',
	commands: SPECKIT_COMMANDS,
	defaultMetadata: {
		lastRefreshed: '2024-01-01T00:00:00Z',
		commitSha: 'bundled',
		sourceVersion: '0.0.90',
		sourceUrl: 'https://github.com/github/spec-kit',
	},
});

/**
 * Get current spec-kit metadata
 */
export const getSpeckitMetadata = (): Promise<SpecKitMetadata> => manager.getMetadata();

/**
 * Get all spec-kit prompts (bundled defaults merged with user customizations)
 */
export const getSpeckitPrompts = (): Promise<SpecKitCommand[]> => manager.getPrompts();

/**
 * Save user's edit to a spec-kit prompt
 */
export const saveSpeckitPrompt = (id: string, content: string): Promise<void> =>
	manager.savePrompt(id, content);

/**
 * Reset a spec-kit prompt to its bundled default
 */
export const resetSpeckitPrompt = (id: string): Promise<string> => manager.resetPrompt(id);

/**
 * Get a single spec-kit command by ID
 */
export const getSpeckitCommand = (id: string): Promise<SpecKitCommand | null> =>
	manager.getCommand(id);

/**
 * Get a spec-kit command by its slash command string (e.g., "/speckit.constitution")
 */
export const getSpeckitCommandBySlash = (slashCommand: string): Promise<SpecKitCommand | null> =>
	manager.getCommandBySlash(slashCommand);

/**
 * Download a file from a URL using https
 */
async function downloadFile(url: string, destPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const follow = (currentUrl: string) => {
			https
				.get(currentUrl, { headers: { 'User-Agent': 'Maestro-SpecKit-Refresher' } }, (res) => {
					if (res.statusCode === 301 || res.statusCode === 302) {
						follow(res.headers.location!);
						return;
					}

					if (res.statusCode !== 200) {
						reject(new Error(`HTTP ${res.statusCode}`));
						return;
					}

					const file = fsSync.createWriteStream(destPath);
					res.pipe(file);
					file.on('finish', () => {
						file.close();
						resolve();
					});
					file.on('error', reject);
				})
				.on('error', reject);
		};
		follow(url);
	});
}

/**
 * Upstream commands to fetch (we skip 'implement' as it's custom)
 */
const UPSTREAM_COMMANDS = [
	'constitution',
	'specify',
	'clarify',
	'plan',
	'tasks',
	'analyze',
	'checklist',
	'taskstoissues',
];

/**
 * Fetch latest prompts from GitHub spec-kit repository
 * Updates all upstream commands except our custom 'implement'
 */
export async function refreshSpeckitPrompts(): Promise<SpecKitMetadata> {
	logger.info('Refreshing spec-kit prompts from GitHub...', LOG_CONTEXT);

	// First, get the latest release info
	const releaseResponse = await fetch(
		'https://api.github.com/repos/github/spec-kit/releases/latest'
	);
	if (!releaseResponse.ok) {
		throw new Error(`Failed to fetch release info: ${releaseResponse.statusText}`);
	}

	const releaseInfo = (await releaseResponse.json()) as {
		tag_name: string;
		assets?: Array<{ name: string; browser_download_url: string }>;
	};
	const version = releaseInfo.tag_name;

	// Find the Claude template asset
	const claudeAsset = releaseInfo.assets?.find(
		(a) => a.name.includes('claude') && a.name.endsWith('.zip')
	);

	if (!claudeAsset) {
		throw new Error('Could not find Claude template in release assets');
	}

	// Create temp directory for download
	const tempDir = path.join(app.getPath('temp'), 'maestro-speckit-refresh');
	await fs.mkdir(tempDir, { recursive: true });

	const tempZipPath = path.join(tempDir, 'speckit.zip');

	try {
		// Download the ZIP file
		logger.info(`Downloading ${version} from ${claudeAsset.browser_download_url}`, LOG_CONTEXT);
		await downloadFile(claudeAsset.browser_download_url, tempZipPath);
		logger.info('Download complete', LOG_CONTEXT);

		// Extract prompts from ZIP
		logger.info('Extracting prompts...', LOG_CONTEXT);

		// List files in the ZIP to find prompt files
		const { stdout: listOutput } = await execAsync(`unzip -l "${tempZipPath}"`);
		const lines = listOutput.split('\n');
		const promptFiles: string[] = [];

		for (const line of lines) {
			// Match lines like: "  12345  01-01-2024 00:00   spec-kit-0.0.90/.claude/commands/constitution.md"
			const match = line.match(/^\s*\d+\s+\S+\s+\S+\s+(.+)$/);
			if (match) {
				const filePath = match[1].trim();
				if (filePath.includes('.claude/commands/') && filePath.endsWith('.md')) {
					promptFiles.push(filePath);
				}
			}
		}

		// Create user prompts directory
		const userPromptsDir = manager.getUserPromptsPath();
		await fs.mkdir(userPromptsDir, { recursive: true });

		// Extract and save each prompt
		for (const filePath of promptFiles) {
			const fileName = path.basename(filePath, '.md');
			// Skip files not in our upstream list
			if (!UPSTREAM_COMMANDS.includes(fileName)) continue;

			// Extract to temp location
			const tempExtractDir = path.join(tempDir, 'extract');
			await fs.mkdir(tempExtractDir, { recursive: true });
			await execAsync(`unzip -o -j "${tempZipPath}" "${filePath}" -d "${tempExtractDir}"`);

			// Read the extracted content
			const extractedPath = path.join(tempExtractDir, path.basename(filePath));
			try {
				const content = await fs.readFile(extractedPath, 'utf8');

				// Save to user prompts directory
				const destPath = path.join(userPromptsDir, `speckit.${fileName}.md`);
				await fs.writeFile(destPath, content, 'utf8');
				logger.info(`Updated: speckit.${fileName}.md`, LOG_CONTEXT);
			} catch {
				logger.warn(`Failed to extract ${fileName}`, LOG_CONTEXT);
			}
		}

		// Update metadata with new version info
		const newMetadata: SpecKitMetadata = {
			lastRefreshed: new Date().toISOString(),
			commitSha: version,
			sourceVersion: version.replace(/^v/, ''),
			sourceUrl: 'https://github.com/github/spec-kit',
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

		logger.info(`Refreshed spec-kit prompts to ${version}`, LOG_CONTEXT);

		return newMetadata;
	} finally {
		// Clean up temp directory
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	}
}
