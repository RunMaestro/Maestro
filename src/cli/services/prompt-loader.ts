// Shared prompt loader for the CLI
// Resolves prompts in this order: in-memory cache → user customizations → bundled disk locations.
// Used by both batch-processor (Auto Run) and the `prompts get` CLI command so they
// honor identical precedence (matches the Electron prompt-manager).

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { CORE_PROMPTS, getPromptFilename } from '../../shared/promptDefinitions';
import { getConfigDirectory } from './storage';

const cliPromptCache = new Map<string, string>();
let bundledPromptsDir: string | null = null;

function getBundledPromptCandidates(filename: string): string[] {
	// The CLI runs in three contexts: dev (ts-node from src), packaged Electron
	// (process.resourcesPath), and standalone bundled CLI (Resources/maestro-cli.js).
	const projectRoot = path.resolve(__dirname, '..', '..', '..');
	const candidates = [path.join(projectRoot, 'src', 'prompts', filename)];

	if (typeof process !== 'undefined' && (process as { resourcesPath?: string }).resourcesPath) {
		candidates.push(
			path.join((process as { resourcesPath?: string }).resourcesPath!, 'prompts', 'core', filename)
		);
	}

	candidates.push(
		path.join(path.dirname(process.argv[1] || __dirname), 'prompts', 'core', filename)
	);
	candidates.push(path.join(__dirname, '..', 'prompts', 'core', filename));

	return candidates;
}

/**
 * Resolve the on-disk directory that holds bundled prompt files. Probes the
 * same candidate chain as getCliPrompt() using a known file (the first entry
 * in CORE_PROMPTS) and remembers whichever location exists. Used by
 * resolveRefs() so `{{REF:name}}` expands to an absolute path the agent can
 * read with its file tools, mirroring the Electron prompt-manager.
 */
function getBundledPromptsDir(): string | null {
	if (bundledPromptsDir) return bundledPromptsDir;

	const probeFilename = CORE_PROMPTS[0]?.filename;
	if (!probeFilename) return null;

	for (const candidate of getBundledPromptCandidates(probeFilename)) {
		try {
			fsSync.accessSync(candidate, fsSync.constants.R_OK);
			bundledPromptsDir = path.dirname(candidate);
			return bundledPromptsDir;
		} catch {
			// Try next candidate
		}
	}
	return null;
}

/**
 * Expand `{{REF:name}}` directives to the absolute on-disk path of the bundled
 * `.md` for that prompt id. Matches the renderer-facing behavior in
 * `src/main/prompt-manager.ts:resolveRefs` so agents launched via the CLI see
 * the same paths Settings → Maestro Prompts hands to desktop-spawned agents.
 * Unresolvable refs (unknown id or no bundled dir found) are left as-is so the
 * agent at least has a chance to surface the problem rather than seeing an
 * empty path.
 */
function resolveRefs(content: string): string {
	// Local /g regex - using a module-level singleton would force manual
	// `lastIndex = 0` resets between the `.test()` probe and `.replace()` and
	// silently skip later matches if any helper in between also called
	// `.test()`. A fresh regex per call has zero shared state.
	const refPattern = /\{\{REF:([a-zA-Z0-9_-]+)\}\}/g;
	if (!content.includes('{{REF:')) return content;

	const promptsDir = getBundledPromptsDir();
	if (!promptsDir) return content;

	return content.replace(refPattern, (match, name: string) => {
		const def = CORE_PROMPTS.find((p) => p.id === name);
		if (!def) return match;
		return path.resolve(promptsDir, def.filename);
	});
}

async function getCustomizedPrompt(id: string): Promise<string | null> {
	try {
		const customizationsPath = path.join(getConfigDirectory(), 'core-prompts-customizations.json');
		const raw = await fs.readFile(customizationsPath, 'utf-8');
		const data = JSON.parse(raw);
		const entry = data?.prompts?.[id];
		if (entry?.isModified && typeof entry?.content === 'string') {
			return entry.content;
		}
	} catch {
		// No customizations file or parse error - fall through to bundled
	}
	return null;
}

export async function getCliPrompt(id: string): Promise<string> {
	if (cliPromptCache.has(id)) {
		return cliPromptCache.get(id)!;
	}

	const customized = await getCustomizedPrompt(id);
	if (customized !== null) {
		const resolved = resolveRefs(customized);
		cliPromptCache.set(id, resolved);
		return resolved;
	}

	const filename = getPromptFilename(id);
	const candidates = getBundledPromptCandidates(filename);

	for (const candidate of candidates) {
		try {
			const content = await fs.readFile(candidate, 'utf-8');
			const resolved = resolveRefs(content);
			cliPromptCache.set(id, resolved);
			return resolved;
		} catch {
			// Try next candidate
		}
	}

	throw new Error(
		`Failed to load prompt "${id}" (${filename}). Searched: ${candidates.join(', ')}`
	);
}

/**
 * Test-only: reset cached state between tests.
 */
export function _resetCliPromptCacheForTests(): void {
	cliPromptCache.clear();
	bundledPromptsDir = null;
}
