/**
 * Prompt Manager - Core System Prompts
 *
 * Loads all core prompts from disk exactly once at application startup.
 * User customizations are stored separately and take precedence over bundled defaults.
 *
 * Architecture (same as SpecKit/OpenSpec):
 * - Bundled prompts: Resources/prompts/core/*.md (read-only)
 * - User customizations: userData/core-prompts-customizations.json
 * - On load: User customization wins if isModified=true, else bundled
 * - On save: Writes to customizations JSON AND updates in-memory cache immediately
 * - On reset: Removes from customizations JSON AND updates in-memory cache immediately
 */

import { app } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { logger } from './utils/logger';
import { CORE_PROMPTS } from '../shared/promptDefinitions';

const LOG_CONTEXT = '[PromptManager]';

// ============================================================================
// Types
// ============================================================================

export interface CorePrompt {
	id: string;
	filename: string;
	description: string;
	category: string;
	content: string;
	isModified: boolean;
}

interface StoredPrompt {
	content: string;
	isModified: boolean;
	modifiedAt?: string;
}

interface StoredData {
	prompts: Record<string, StoredPrompt>;
}

// ============================================================================
// State
// ============================================================================

const promptCache = new Map<string, { content: string; isModified: boolean }>();
let initialized = false;

// ============================================================================
// Path Helpers
// ============================================================================

function getBundledPromptsPath(): string {
	if (app.isPackaged) {
		return path.join(process.resourcesPath, 'prompts', 'core');
	}
	return path.join(__dirname, '..', '..', 'src', 'prompts');
}

function getCustomizationsPath(): string {
	return path.join(app.getPath('userData'), 'core-prompts-customizations.json');
}

// ============================================================================
// Customizations Storage
// ============================================================================

async function loadUserCustomizations(): Promise<StoredData | null> {
	const filePath = getCustomizationsPath();
	try {
		const content = await fs.readFile(filePath, 'utf-8');
		return JSON.parse(content) as StoredData;
	} catch (error: any) {
		// File not existing is expected (no customizations yet)
		if (error?.code === 'ENOENT') {
			return null;
		}
		// Any other error (malformed JSON, permission denied, disk corruption)
		// is a real problem — log it so users know their customizations failed to load
		logger.error(`Failed to load prompt customizations from ${filePath}: ${error}`, LOG_CONTEXT);
		throw error;
	}
}

async function saveUserCustomizations(data: StoredData): Promise<void> {
	await fs.writeFile(getCustomizationsPath(), JSON.stringify(data, null, 2), 'utf-8');
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize all prompts from disk. Called once at app startup.
 * Loads bundled prompts, then overlays user customizations.
 */
export async function initializePrompts(): Promise<void> {
	if (initialized) {
		logger.warn('Prompts already initialized, skipping', LOG_CONTEXT);
		return;
	}

	const promptsPath = getBundledPromptsPath();
	const customizations = await loadUserCustomizations();

	logger.info(`Loading ${CORE_PROMPTS.length} prompts from: ${promptsPath}`, LOG_CONTEXT);

	let customizedCount = 0;
	for (const prompt of CORE_PROMPTS) {
		const filePath = path.join(promptsPath, prompt.filename);

		// Load bundled content
		let bundledContent: string;
		try {
			bundledContent = await fs.readFile(filePath, 'utf-8');
		} catch (error) {
			logger.error(`Failed to load prompt ${prompt.id} from ${filePath}: ${error}`, LOG_CONTEXT);
			throw new Error(`Failed to load required prompt: ${prompt.id}`);
		}

		// Check for user customization
		const customPrompt = customizations?.prompts?.[prompt.id];
		const isModified = customPrompt?.isModified ?? false;
		const content = isModified && customPrompt ? customPrompt.content : bundledContent;

		if (isModified) customizedCount++;
		promptCache.set(prompt.id, { content, isModified });
	}

	initialized = true;
	logger.info(
		`Successfully loaded ${promptCache.size} prompts (${customizedCount} customized)`,
		LOG_CONTEXT
	);
}

/**
 * Get a prompt by ID. Returns cached value (prompts are loaded once at startup).
 */
export function getPrompt(id: string): string {
	if (!initialized) {
		throw new Error('Prompts not initialized. Call initializePrompts() first.');
	}

	const cached = promptCache.get(id);
	if (!cached) {
		throw new Error(`Unknown prompt ID: ${id}`);
	}

	return cached.content;
}

/**
 * Get all prompts with metadata (for UI display).
 */
export function getAllPrompts(): CorePrompt[] {
	if (!initialized) {
		throw new Error('Prompts not initialized. Call initializePrompts() first.');
	}

	return CORE_PROMPTS.map((def) => {
		const cached = promptCache.get(def.id)!;
		return {
			id: def.id,
			filename: def.filename,
			description: def.description,
			category: def.category,
			content: cached.content,
			isModified: cached.isModified,
		};
	});
}

/**
 * Save user's edit to a prompt. Updates both disk and in-memory cache immediately.
 */
export async function savePrompt(id: string, content: string): Promise<void> {
	const def = CORE_PROMPTS.find((p) => p.id === id);
	if (!def) {
		throw new Error(`Unknown prompt ID: ${id}`);
	}

	// Update disk
	const customizations = (await loadUserCustomizations()) || { prompts: {} };
	customizations.prompts[id] = {
		content,
		isModified: true,
		modifiedAt: new Date().toISOString(),
	};
	await saveUserCustomizations(customizations);

	// Update in-memory cache immediately
	promptCache.set(id, { content, isModified: true });

	logger.info(`Saved and applied customization for ${id}`, LOG_CONTEXT);
}

/**
 * Reset a prompt to bundled default. Updates both disk and in-memory cache immediately.
 * Returns the bundled content for UI confirmation.
 */
export async function resetPrompt(id: string): Promise<string> {
	const def = CORE_PROMPTS.find((p) => p.id === id);
	if (!def) {
		throw new Error(`Unknown prompt ID: ${id}`);
	}

	// Read bundled content FIRST — verify it's readable before deleting customization
	const promptsPath = getBundledPromptsPath();
	const filePath = path.join(promptsPath, def.filename);
	const bundledContent = await fs.readFile(filePath, 'utf-8');

	// Only remove customization after confirming bundled file is readable
	const customizations = await loadUserCustomizations();
	if (customizations?.prompts?.[id]) {
		delete customizations.prompts[id];
		await saveUserCustomizations(customizations);
	}

	// Update in-memory cache immediately
	promptCache.set(id, { content: bundledContent, isModified: false });

	logger.info(`Reset and applied bundled default for ${id}`, LOG_CONTEXT);
	return bundledContent;
}

/**
 * Check if prompts have been initialized.
 */
export function arePromptsInitialized(): boolean {
	return initialized;
}

/**
 * Get all prompt IDs.
 */
export function getAllPromptIds(): string[] {
	return CORE_PROMPTS.map((p) => p.id);
}
