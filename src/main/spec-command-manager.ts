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
 * Source locations supplied to domain hooks. Hooks keep source precedence and
 * malformed-file policy visible in the manager that owns those semantics.
 */
export interface SpecCommandStoragePaths {
	bundledPromptsDir: string;
	userPromptsDir: string;
	customizationsPath: string;
}

export interface RefreshedSpecPrompt {
	id: string;
	content: string;
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
	/** Domain-owned command spelling when the standard `/${filePrefix}.${id}` is not applicable. */
	commandForDefinition?: (command: SpecCommandDefinition) => string;
	/** Domain-owned source precedence and prompt read-error policy. */
	loadPrompt?: (
		command: SpecCommandDefinition,
		paths: SpecCommandStoragePaths
	) => Promise<string | null>;
	/** Domain-owned metadata source precedence and malformed-file policy. */
	loadMetadata?: (paths: SpecCommandStoragePaths, fallback: SpecMetadata) => Promise<SpecMetadata>;
	/** Domain-owned customization read policy, including diagnostics. */
	loadCustomizations?: (customizationsPath: string) => Promise<StoredData | null>;
	/** Domain-owned serialization policy for customization mutations. */
	withCustomizationLock?: <T>(mutation: () => Promise<T>) => Promise<T>;
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
	/**
	 * Commits refreshed source files, metadata, and customization metadata as one
	 * rollback unit. Existing customization prompt bodies are preserved.
	 */
	commitRefresh(prompts: readonly RefreshedSpecPrompt[], metadata: SpecMetadata): Promise<void>;
	/** Runs a complete domain refresh under its established mutation policy. */
	runCustomizationMutation<T>(mutation: () => Promise<T>): Promise<T>;
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
		commandForDefinition = (command) => `/${filePrefix}.${command.id}`,
		loadPrompt,
		loadMetadata,
		loadCustomizations,
		withCustomizationLock = async <T>(mutation: () => Promise<T>): Promise<T> => mutation(),
	} = config;

	function getUserDataPath(): string {
		return path.join(app.getPath('userData'), customizationsFileName);
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

	function getStoragePaths(): SpecCommandStoragePaths {
		return {
			bundledPromptsDir: getBundledPromptsPath(),
			userPromptsDir: getUserPromptsPath(),
			customizationsPath: getUserDataPath(),
		};
	}

	async function loadUserCustomizations(): Promise<StoredData | null> {
		if (loadCustomizations) {
			return loadCustomizations(getUserDataPath());
		}

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

	async function loadDefaultPrompt(
		command: SpecCommandDefinition,
		paths: SpecCommandStoragePaths
	): Promise<string | null> {
		if (!command.isCustom) {
			try {
				return await fs.readFile(
					path.join(paths.userPromptsDir, `${filePrefix}.${command.id}.md`),
					'utf-8'
				);
			} catch (error: unknown) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			}
		}

		try {
			return await fs.readFile(
				path.join(paths.bundledPromptsDir, `${filePrefix}.${command.id}.md`),
				'utf-8'
			);
		} catch (error) {
			logger.warn(`Failed to load bundled prompt for ${command.id}: ${error}`, logContext);
			return null;
		}
	}

	async function getBundledPrompts(): Promise<
		Record<string, { prompt: string; description: string; isCustom: boolean }>
	> {
		const paths = getStoragePaths();
		const result: Record<string, { prompt: string; description: string; isCustom: boolean }> = {};

		for (const command of commands) {
			const prompt = await (loadPrompt ?? loadDefaultPrompt)(command, paths);
			result[command.id] = {
				prompt: prompt ?? `# ${command.id}\n\nPrompt not available.`,
				description: command.description,
				isCustom: command.isCustom,
			};
		}

		return result;
	}

	async function loadDefaultMetadata(
		paths: SpecCommandStoragePaths,
		fallback: SpecMetadata
	): Promise<SpecMetadata> {
		try {
			const content = await fs.readFile(path.join(paths.userPromptsDir, 'metadata.json'), 'utf-8');
			return JSON.parse(content);
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}

		try {
			const content = await fs.readFile(
				path.join(paths.bundledPromptsDir, 'metadata.json'),
				'utf-8'
			);
			return JSON.parse(content);
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			return { ...fallback };
		}
	}

	async function getBundledMetadata(): Promise<SpecMetadata> {
		const paths = getStoragePaths();
		return (loadMetadata ?? loadDefaultMetadata)(paths, defaultMetadata);
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

		return Object.entries(bundled).map(([id, data]) => {
			const customPrompt = customizations?.prompts?.[id];
			const isModified = customPrompt?.isModified ?? false;
			return {
				id,
				command: commandForDefinition(commands.find((command) => command.id === id)!),
				description: data.description,
				prompt: isModified && customPrompt ? customPrompt.content : data.prompt,
				isCustom: data.isCustom,
				isModified,
			};
		});
	}

	async function savePrompt(id: string, content: string): Promise<void> {
		return withCustomizationLock(async () => {
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
		});
	}

	async function resetPrompt(id: string): Promise<string> {
		return withCustomizationLock(async () => {
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
		});
	}

	async function getCommand(id: string): Promise<SpecCommand | null> {
		const all = await getPrompts();
		return all.find((command) => command.id === id) ?? null;
	}

	async function getCommandBySlash(slashCommand: string): Promise<SpecCommand | null> {
		const all = await getPrompts();
		return all.find((command) => command.command === slashCommand) ?? null;
	}

	async function snapshot(pathname: string): Promise<Buffer | null> {
		try {
			return await fs.readFile(pathname);
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw error;
		}
	}

	async function commitRefresh(
		prompts: readonly RefreshedSpecPrompt[],
		metadata: SpecMetadata
	): Promise<void> {
		const paths = getStoragePaths();
		const knownIds = new Set(commands.map((command) => command.id));
		if (
			prompts.some((prompt) => !knownIds.has(prompt.id)) ||
			new Set(prompts.map((prompt) => prompt.id)).size !== prompts.length
		) {
			throw new Error(`Invalid ${filePrefix} refresh prompt set`);
		}

		const refreshPaths = [
			...prompts.map((prompt) => path.join(paths.userPromptsDir, `${filePrefix}.${prompt.id}.md`)),
			path.join(paths.userPromptsDir, 'metadata.json'),
			paths.customizationsPath,
		];
		const previous = await Promise.all(
			refreshPaths.map(async (pathname) => [pathname, await snapshot(pathname)] as const)
		);

		try {
			await fs.mkdir(paths.userPromptsDir, { recursive: true });
			for (const prompt of prompts) {
				await fs.writeFile(
					path.join(paths.userPromptsDir, `${filePrefix}.${prompt.id}.md`),
					prompt.content,
					'utf-8'
				);
			}
			await fs.writeFile(
				path.join(paths.userPromptsDir, 'metadata.json'),
				JSON.stringify(metadata, null, 2),
				'utf-8'
			);

			const customizations = (await loadUserCustomizations()) ?? { metadata, prompts: {} };
			customizations.metadata = metadata;
			await saveUserCustomizations(customizations);
		} catch (error) {
			await Promise.all(
				previous.map(async ([pathname, content]) => {
					if (content === null) {
						await fs.rm(pathname, { force: true });
						return;
					}
					await fs.writeFile(pathname, content);
				})
			);
			throw error;
		}
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
		commitRefresh,
		runCustomizationMutation: withCustomizationLock,
	};
}
