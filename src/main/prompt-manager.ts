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
 *
 * Directives:
 * - {{INCLUDE:name}} — full inlining. Resolves recursively (max depth 3) with cycle detection.
 *   Use for foundational content the recipient must always have (e.g., file-access rules).
 * - {{REF:name}} — expands to just the absolute on-disk path of the bundled `.md`, in the host
 *   OS's native separator format. Nothing else — no bullet, no description, no quoting. Authors
 *   wrap the directive with whatever surrounding prose, list markers, or context they want.
 *   Use for heavy reference material the agent only needs in some sessions; the agent reads the
 *   file on demand. NOTE: the path serves the bundled file, not user customizations from
 *   Settings → Maestro Prompts. Agents that need customization-aware content should fetch via
 *   `maestro-cli prompts get <name>` instead.
 */

import { app } from 'electron';
import fs from 'fs/promises';
import fsSync from 'fs';
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

// Serialize disk writes to prevent concurrent read-modify-write races
let writeLock: Promise<void> = Promise.resolve();
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
	const next = writeLock.then(fn, fn);
	writeLock = next.then(
		() => {},
		() => {}
	);
	return next;
}

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
	} catch (error: unknown) {
		// File not existing is expected (no customizations yet)
		const err = error as NodeJS.ErrnoException | undefined;
		if (err?.code === 'ENOENT') {
			return null;
		}
		// Any other error (malformed JSON, permission denied, disk corruption)
		// is a real problem — log it so users know their customizations failed to load
		logger.error(
			`Failed to load prompt customizations from ${filePath}: ${String(error)}`,
			LOG_CONTEXT
		);
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
 * Get a prompt by ID. Resolves {{INCLUDE:name}} (full inline) and {{REF:name}}
 * (pointer-style stub) directives in the content.
 */
export function getPrompt(id: string): string {
	if (!initialized) {
		throw new Error('Prompts not initialized. Call initializePrompts() first.');
	}

	const cached = promptCache.get(id);
	if (!cached) {
		throw new Error(`Unknown prompt ID: ${id}`);
	}

	const withRefs = resolveRefs(cached.content);
	return resolveIncludes(withRefs, new Set([id]), 0);
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

	await withWriteLock(async () => {
		const customizations = (await loadUserCustomizations()) || { prompts: {} };
		customizations.prompts[id] = {
			content,
			isModified: true,
			modifiedAt: new Date().toISOString(),
		};
		await saveUserCustomizations(customizations);
	});

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
	await withWriteLock(async () => {
		const customizations = await loadUserCustomizations();
		if (customizations?.prompts?.[id]) {
			delete customizations.prompts[id];
			await saveUserCustomizations(customizations);
		}
	});

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

/**
 * Get the platform-resolved path to the prompts directory.
 */
export function getPromptsPath(): string {
	return getBundledPromptsPath();
}

/**
 * List all .md files in the prompts directory, including user-added files
 * that aren't in the catalog. Returns objects with name (without .md) and
 * whether the file is a registered catalog prompt.
 */
export async function listPromptFiles(): Promise<
	Array<{ name: string; filename: string; isCatalog: boolean }>
> {
	const promptsPath = getBundledPromptsPath();
	const catalogFilenames = new Set(CORE_PROMPTS.map((p) => p.filename));

	try {
		const entries = await fs.readdir(promptsPath);
		return entries
			.filter((f) => f.endsWith('.md'))
			.sort()
			.map((filename) => ({
				name: filename.replace(/\.md$/, ''),
				filename,
				isCatalog: catalogFilenames.has(filename),
			}));
	} catch (error) {
		logger.error(`Failed to list prompt files from ${promptsPath}: ${error}`, LOG_CONTEXT);
		return CORE_PROMPTS.map((p) => ({
			name: p.id,
			filename: p.filename,
			isCatalog: true,
		}));
	}
}

// ============================================================================
// Directive Resolution
// ============================================================================

const INCLUDE_PATTERN = /\{\{INCLUDE:([a-zA-Z0-9_-]+)\}\}/g;
const REF_PATTERN = /\{\{REF:([a-zA-Z0-9_-]+)\}\}/g;
const MAX_INCLUDE_DEPTH = 3;

/**
 * Expand {{REF:name}} into the absolute on-disk path of the bundled `.md`.
 * `path.resolve` guarantees an absolute path on every OS and emits native
 * separators (`/` on macOS/Linux, `\` on Windows). Nothing else is emitted —
 * authors supply their own surrounding prose. Refs are resolved before
 * includes and are not recursive: a ref produces literal text, not a fetch
 * the resolver follows.
 */
function resolveRefs(content: string): string {
	if (!REF_PATTERN.test(content)) return content;
	REF_PATTERN.lastIndex = 0;

	const promptsPath = getBundledPromptsPath();

	return content.replace(REF_PATTERN, (match, name: string) => {
		const def = CORE_PROMPTS.find((p) => p.id === name);
		if (!def) {
			logger.warn(`REF target not found in registry: ${name}`, LOG_CONTEXT);
			return match;
		}
		return path.resolve(promptsPath, def.filename);
	});
}

function resolveIncludes(content: string, visited: Set<string>, depth: number): string {
	if (depth >= MAX_INCLUDE_DEPTH) return content;
	if (!INCLUDE_PATTERN.test(content)) return content;

	INCLUDE_PATTERN.lastIndex = 0;

	return content.replace(INCLUDE_PATTERN, (match, name: string) => {
		if (visited.has(name)) {
			logger.warn(
				`Circular include detected: ${name} (visited: ${[...visited].join(' → ')})`,
				LOG_CONTEXT
			);
			return match;
		}

		const resolved = resolveIncludeContent(name);
		if (resolved === null) {
			logger.warn(`Include not found: ${name}`, LOG_CONTEXT);
			return match;
		}

		const nextVisited = new Set(visited);
		nextVisited.add(name);
		return resolveIncludes(resolved, nextVisited, depth + 1);
	});
}

function resolveIncludeContent(name: string): string | null {
	const cached = promptCache.get(name);
	if (cached) return cached.content;

	const promptsPath = getBundledPromptsPath();
	const filePath = path.join(promptsPath, `${name}.md`);
	try {
		return fsSync.readFileSync(filePath, 'utf-8');
	} catch {
		return null;
	}
}
