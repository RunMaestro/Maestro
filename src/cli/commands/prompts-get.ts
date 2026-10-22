// `prompts get <id>` - print a Maestro prompt's content to stdout.
// Honors the same customization precedence as the Electron app, so an agent
// fetching `_autorun-playbooks` (etc.) sees what the user actually edits in
// Settings. A prompt that belongs to a switched-off Encore Feature is neither
// listed nor served, the same as in Settings > Maestro Prompts.

import { getCliPrompt } from '../services/prompt-loader';
import { CORE_PROMPTS, isPromptAvailable } from '../../shared/promptDefinitions';
import { readSettingValue } from '../services/storage';
import { failCommand } from '../services/session-command';

/** The core prompts that exist right now (none from a switched-off feature). */
function availablePrompts() {
	const encoreFeatures = readSettingValue('encoreFeatures');
	return CORE_PROMPTS.filter((def) => isPromptAvailable(def.id, encoreFeatures));
}

interface PromptsGetOptions {
	json?: boolean;
}

export async function promptsGet(id: string, options: PromptsGetOptions): Promise<void> {
	const available = availablePrompts();
	const def = available.find((p) => p.id === id);
	if (!def) {
		const known = available.map((p) => p.id).join(', ');
		const message = `Unknown prompt id: ${id}. Available: ${known}`;
		failCommand(message, options.json);
	}

	try {
		const content = await getCliPrompt(id);
		if (options.json) {
			console.log(
				JSON.stringify({
					id: def.id,
					filename: def.filename,
					description: def.description,
					category: def.category,
					content,
				})
			);
		} else {
			process.stdout.write(content);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		failCommand(message, options.json);
	}
}

export function promptsList(options: PromptsGetOptions): void {
	const items = availablePrompts().map((p) => ({
		id: p.id,
		category: p.category,
		description: p.description,
	}));

	if (options.json) {
		console.log(JSON.stringify(items, null, 2));
		return;
	}

	const grouped = new Map<string, typeof items>();
	for (const item of items) {
		const bucket = grouped.get(item.category) ?? [];
		bucket.push(item);
		grouped.set(item.category, bucket);
	}

	for (const [category, entries] of [...grouped.entries()].sort()) {
		console.log(`\n[${category}]`);
		for (const entry of entries.sort((a, b) => a.id.localeCompare(b.id))) {
			console.log(`  ${entry.id.padEnd(28)} ${entry.description}`);
		}
	}
}
