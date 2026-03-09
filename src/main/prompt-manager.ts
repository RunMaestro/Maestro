// ABOUTME: Prompt Manager - Loads core system prompts from disk at startup.
// ABOUTME: Supports user customizations stored separately, with immediate in-memory updates on save/reset.

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

const LOG_CONTEXT = '[PromptManager]';

// ============================================================================
// Types
// ============================================================================

interface PromptDefinition {
	id: string;
	filename: string;
	description: string;
	category: string;
}

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
// Prompt Definitions
// ============================================================================

const CORE_PROMPTS: PromptDefinition[] = [
	// Wizard
	{ id: 'wizard-system', filename: 'wizard-system.md', description: 'Main wizard conversation system prompt', category: 'wizard' },
	{ id: 'wizard-system-continuation', filename: 'wizard-system-continuation.md', description: 'Wizard continuation prompt', category: 'wizard' },
	{ id: 'wizard-document-generation', filename: 'wizard-document-generation.md', description: 'Wizard document generation prompt', category: 'wizard' },
	// Inline Wizard
	{ id: 'wizard-inline-system', filename: 'wizard-inline-system.md', description: 'Inline wizard system prompt', category: 'inline-wizard' },
	{ id: 'wizard-inline-iterate', filename: 'wizard-inline-iterate.md', description: 'Inline wizard iteration prompt', category: 'inline-wizard' },
	{ id: 'wizard-inline-new', filename: 'wizard-inline-new.md', description: 'Inline wizard new session prompt', category: 'inline-wizard' },
	{ id: 'wizard-inline-iterate-generation', filename: 'wizard-inline-iterate-generation.md', description: 'Inline wizard iteration generation', category: 'inline-wizard' },
	// AutoRun
	{ id: 'autorun-default', filename: 'autorun-default.md', description: 'Default Auto Run behavior prompt', category: 'autorun' },
	{ id: 'autorun-synopsis', filename: 'autorun-synopsis.md', description: 'Auto Run synopsis generation prompt', category: 'autorun' },
	// Commands
	{ id: 'image-only-default', filename: 'image-only-default.md', description: 'Default prompt for image-only messages', category: 'commands' },
	{ id: 'commit-command', filename: 'commit-command.md', description: 'Git commit command prompt', category: 'commands' },
	// System
	{ id: 'maestro-system-prompt', filename: 'maestro-system-prompt.md', description: 'Maestro system context prompt', category: 'system' },
	// Group Chat
	{ id: 'group-chat-moderator-system', filename: 'group-chat-moderator-system.md', description: 'Group chat moderator system prompt', category: 'group-chat' },
	{ id: 'group-chat-moderator-synthesis', filename: 'group-chat-moderator-synthesis.md', description: 'Group chat synthesis prompt', category: 'group-chat' },
	{ id: 'group-chat-participant', filename: 'group-chat-participant.md', description: 'Group chat participant prompt', category: 'group-chat' },
	{ id: 'group-chat-participant-request', filename: 'group-chat-participant-request.md', description: 'Group chat participant request prompt', category: 'group-chat' },
	// Context
	{ id: 'context-grooming', filename: 'context-grooming.md', description: 'Context grooming prompt', category: 'context' },
	{ id: 'context-transfer', filename: 'context-transfer.md', description: 'Context transfer prompt', category: 'context' },
	{ id: 'context-summarize', filename: 'context-summarize.md', description: 'Context summarization prompt', category: 'context' },
	// Tab Naming
	{ id: 'tab-naming', filename: 'tab-naming.md', description: 'Tab naming prompt', category: 'commands' },
	// Director's Notes
	{ id: 'director-notes', filename: 'director-notes.md', description: 'Director notes synopsis prompt', category: 'system' },
];

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
	try {
		const content = await fs.readFile(getCustomizationsPath(), 'utf-8');
		return JSON.parse(content) as StoredData;
	} catch {
		return null;
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
	logger.info(`Successfully loaded ${promptCache.size} prompts (${customizedCount} customized)`, LOG_CONTEXT);
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

	// Remove from customizations on disk
	const customizations = await loadUserCustomizations();
	if (customizations?.prompts?.[id]) {
		delete customizations.prompts[id];
		await saveUserCustomizations(customizations);
	}

	// Read bundled content
	const promptsPath = getBundledPromptsPath();
	const filePath = path.join(promptsPath, def.filename);
	const bundledContent = await fs.readFile(filePath, 'utf-8');

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
