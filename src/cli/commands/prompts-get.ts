// `prompts get <id>` — print a Maestro prompt's content to stdout.
// Honors the same customization precedence as the Electron app, so an agent
// fetching `_maestro-cue` (etc.) sees what the user actually edits in Settings.

import { getCliPrompt } from '../services/prompt-loader';
import { CORE_PROMPTS } from '../../shared/promptDefinitions';

interface PromptsGetOptions {
	json?: boolean;
}

export async function promptsGet(id: string, options: PromptsGetOptions): Promise<void> {
	const def = CORE_PROMPTS.find((p) => p.id === id);
	if (!def) {
		const known = CORE_PROMPTS.map((p) => p.id).join(', ');
		const message = `Unknown prompt id: ${id}. Available: ${known}`;
		if (options.json) {
			console.error(JSON.stringify({ error: message }));
		} else {
			console.error(message);
		}
		process.exit(1);
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
		if (options.json) {
			console.error(JSON.stringify({ error: message }));
		} else {
			console.error(message);
		}
		process.exit(1);
	}
}

export function promptsList(options: PromptsGetOptions): void {
	const items = CORE_PROMPTS.map((p) => ({
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
