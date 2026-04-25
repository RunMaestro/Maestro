// Shared prompt loader for the CLI
// Resolves prompts in this order: in-memory cache → user customizations → bundled disk locations.
// Used by both batch-processor (Auto Run) and the `prompts get` CLI command so they
// honor identical precedence (matches the Electron prompt-manager).

import fs from 'fs/promises';
import path from 'path';
import { getPromptFilename } from '../../shared/promptDefinitions';
import { getConfigDirectory } from './storage';

const cliPromptCache = new Map<string, string>();

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
		// No customizations file or parse error — fall through to bundled
	}
	return null;
}

export async function getCliPrompt(id: string): Promise<string> {
	if (cliPromptCache.has(id)) {
		return cliPromptCache.get(id)!;
	}

	const customized = await getCustomizedPrompt(id);
	if (customized !== null) {
		cliPromptCache.set(id, customized);
		return customized;
	}

	const filename = getPromptFilename(id);

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

	for (const candidate of candidates) {
		try {
			const content = await fs.readFile(candidate, 'utf-8');
			cliPromptCache.set(id, content);
			return content;
		} catch {
			// Try next candidate
		}
	}

	throw new Error(
		`Failed to load prompt "${id}" (${filename}). Searched: ${candidates.join(', ')}`
	);
}
