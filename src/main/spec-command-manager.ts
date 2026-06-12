/**
 * Spec Command Manager (Shared Base)
 *
 * Shared implementation for managing bundled command prompts with support for:
 * - Loading bundled prompts from src/prompts/{specDir}/
 * - Checking user prompts directory first (downloaded updates), then bundled fallback
 * - User customization with ability to reset to defaults
 * - Refresh hook for fetching latest prompts from an upstream source
 *
 * Used by both the SpecKit and OpenSpec managers. Each wrapper provides its own
 * config (command list, file paths, source URL, refresh strategy) and this module
 * implements the common logic.
 */

import fs from 'fs/promises';
import path from 'path';
import { app } from 'electron';
import { logger } from './utils/logger';

export interface SpecCommandDefinition {
	id: string;
	description: string;
	isCustom: boolean;
}

export interface SpecCommand {
	id: string;
	command: string;
	description: string;
	prompt: string;
	isCustom: boolean;
	isModified: boolean;
}

export interface SpecMetadata {
	lastRefreshed: string;
	commitSha: string;
	sourceVersion: string;
	sourceUrl: string;
}

export interface StoredPrompt {
	content: string;
	isModified: boolean;
	modifiedAt?: string;
}

export interface StoredData {
	metadata: SpecMetadata;
	prompts: Record<string, StoredPrompt>;
}

/**
 * Configuration for a spec command manager instance.
 * Provides the per-source values that differentiate SpecKit from OpenSpec.
 */
export interface SpecCommandManagerConfig {
	/** Log context prefix, e.g. '[SpecKit]' or '[OpenSpec]'. */
	logContext: string;
	/**
	 * Prefix used in filenames and slash commands (e.g. 'speckit' or 'openspec').
	 * Prompt files are named `${filePrefix}.${id}.md`. Slash commands are `/${filePrefix}.${id}`.
	 */
	filePrefix: string;
	/** Subdirectory name under src/prompts/ and process.resourcesPath/prompts/. */
	bundledDirName: string;
	/** Filename for the user customizations JSON file in userData. */
	customizationsFileName: string;
	/** Directory name for the user prompts directory (downloaded updates) in userData. */
	userPromptsDirName: string;
	/** The set of commands supported by this manager. */
	commands: readonly SpecCommandDefinition[];
	/** Default metadata returned if neither user nor bundled metadata files exist. */
	defaultMetadata: SpecMetadata;
}

/**
 * Public API surface returned by createSpecCommandManager().
 */
export interface SpecCommandManager {
	getMetadata(): Promise<SpecMetadata>;
	getPrompts(): Promise<SpecCommand[]>;
	savePrompt(id: string, content: string): Promise<void>;
	resetPrompt(id: string): Promise<string>;
	getCommand(id: string): Promise<SpecCommand | null>;
	getCommandBySlash(slashCommand: string): Promise<SpecCommand | null>;
	/** Helpers used by refresh implementations. */
	getUserPromptsPath(): string;
	loadUserCustomizations(): Promise<StoredData | null>;
	saveUserCustomizations(data: StoredData): Promise<void>;
	getBundledMetadata(): Promise<SpecMetadata>;
}

/**
 * Factory that creates a spec command manager bound to the given config.
 */
export function createSpecCommandManager(config: SpecCommandManagerConfig): SpecCommandManager {
	const {
		logContext,
		filePrefix,
		bundledDirName,
		customizationsFileName,
		userPromptsDirName,
		commands,
		defaultMetadata,
	} = config;

	function getUserDataPath(): string {
		return path.join(app.getPath('userData'), customizationsFileName);
	}

	async function loadUserCustomizations(): Promise<StoredData | null> {
		try {
			const content = await fs.readFile(getUserDataPath(), 'utf-8');
			return JSON.parse(content);
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			return null;
		}
	}

	async function saveUserCustomizations(data: StoredData): Promise<void> {
		await fs.writeFile(getUserDataPath(), JSON.stringify(data, null, 2), 'utf-8');
	}

	function getBundledPromptsPath(): string {
		if (app.isPackaged) {
			return path.join(process.resourcesPath, 'prompts', bundledDirName);
		}
		return path.join(__dirname, '..', '..', 'src', 'prompts', bundledDirName);
	}

	function getUserPromptsPath(): string {
		return path.join(app.getPath('userData'), userPromptsDirName);
	}

	async function getBundledPrompts(): Promise<
		Record<string, { prompt: string; description: string; isCustom: boolean }>
	> {
		const bundledPromptsDir = getBundledPromptsPath();
		const userPromptsDir = getUserPromptsPath();
		const result: Record<string, { prompt: string; description: string; isCustom: boolean }> = {};

		for (const cmd of commands) {
			// For custom commands, always use bundled
			if (cmd.isCustom) {
				try {
					const promptPath = path.join(bundledPromptsDir, `${filePrefix}.${cmd.id}.md`);
					const prompt = await fs.readFile(promptPath, 'utf-8');
					result[cmd.id] = {
						prompt,
						description: cmd.description,
						isCustom: cmd.isCustom,
					};
				} catch (error) {
					logger.warn(`Failed to load bundled prompt for ${cmd.id}: ${error}`, logContext);
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
				const userPromptPath = path.join(userPromptsDir, `${filePrefix}.${cmd.id}.md`);
				const prompt = await fs.readFile(userPromptPath, 'utf-8');
				result[cmd.id] = {
					prompt,
					description: cmd.description,
					isCustom: cmd.isCustom,
				};
				continue;
			} catch (error: unknown) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
				// User prompt not found, try bundled
			}

			// Fall back to bundled prompts
			try {
				const promptPath = path.join(bundledPromptsDir, `${filePrefix}.${cmd.id}.md`);
				const prompt = await fs.readFile(promptPath, 'utf-8');
				result[cmd.id] = {
					prompt,
					description: cmd.description,
					isCustom: cmd.isCustom,
				};
			} catch (error) {
				logger.warn(`Failed to load bundled prompt for ${cmd.id}: ${error}`, logContext);
				result[cmd.id] = {
					prompt: `# ${cmd.id}\n\nPrompt not available.`,
					description: cmd.description,
					isCustom: cmd.isCustom,
				};
			}
		}

		return result;
	}

	async function getBundledMetadata(): Promise<SpecMetadata> {
		const bundledPromptsDir = getBundledPromptsPath();
		const userPromptsDir = getUserPromptsPath();

		// Check user prompts directory first (downloaded updates)
		try {
			const userMetadataPath = path.join(userPromptsDir, 'metadata.json');
			const content = await fs.readFile(userMetadataPath, 'utf-8');
			return JSON.parse(content);
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			// User metadata not found, try bundled
		}

		// Fall back to bundled metadata
		try {
			const metadataPath = path.join(bundledPromptsDir, 'metadata.json');
			const content = await fs.readFile(metadataPath, 'utf-8');
			return JSON.parse(content);
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			return { ...defaultMetadata };
		}
	}

	async function getMetadata(): Promise<SpecMetadata> {
		const customizations = await loadUserCustomizations();
		if (customizations?.metadata) {
			return customizations.metadata;
		}
		return getBundledMetadata();
	}

	async function getPrompts(): Promise<SpecCommand[]> {
		const bundled = await getBundledPrompts();
		const customizations = await loadUserCustomizations();

		const result: SpecCommand[] = [];

		for (const [id, data] of Object.entries(bundled)) {
			const customPrompt = customizations?.prompts?.[id];
			const isModified = customPrompt?.isModified ?? false;
			const prompt = isModified && customPrompt ? customPrompt.content : data.prompt;

			result.push({
				id,
				command: `/${filePrefix}.${id}`,
				description: data.description,
				prompt,
				isCustom: data.isCustom,
				isModified,
			});
		}

		return result;
	}

	async function savePrompt(id: string, content: string): Promise<void> {
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
		logger.info(`Saved customization for ${filePrefix}.${id}`, logContext);
	}

	async function resetPrompt(id: string): Promise<string> {
		const bundled = await getBundledPrompts();
		const defaultPrompt = bundled[id];

		if (!defaultPrompt) {
			throw new Error(`Unknown ${filePrefix} command: ${id}`);
		}

		const customizations = await loadUserCustomizations();
		if (customizations?.prompts?.[id]) {
			delete customizations.prompts[id];
			await saveUserCustomizations(customizations);
			logger.info(`Reset ${filePrefix}.${id} to bundled default`, logContext);
		}

		return defaultPrompt.prompt;
	}

	async function getCommand(id: string): Promise<SpecCommand | null> {
		const all = await getPrompts();
		return all.find((cmd) => cmd.id === id) ?? null;
	}

	async function getCommandBySlash(slashCommand: string): Promise<SpecCommand | null> {
		const all = await getPrompts();
		return all.find((cmd) => cmd.command === slashCommand) ?? null;
	}

	return {
		getMetadata,
		getPrompts,
		savePrompt,
		resetPrompt,
		getCommand,
		getCommandBySlash,
		getUserPromptsPath,
		loadUserCustomizations,
		saveUserCustomizations,
		getBundledMetadata,
	};
}
