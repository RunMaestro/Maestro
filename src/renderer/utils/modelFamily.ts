/**
 * Model family labelling.
 *
 * An agent's model list is a flat array of ids with no provider metadata, and
 * for a multi-provider CLI (Copilot-CLI resolves its catalog from models.dev,
 * so one list holds Claude, GPT, Gemini and Grok entries) a flat list of
 * thirty ids is hard to scan. Grouping them under the vendor that made them
 * turns that into four short lists.
 *
 * This is a display aid only: nothing here decides what gets spawned, so an
 * unrecognized id simply lands under "Other" rather than being rejected.
 */

/** Families in the order they should be listed, with the id prefixes that select them. */
const MODEL_FAMILIES: Array<{ label: string; matches: (id: string) => boolean }> = [
	{ label: 'Claude', matches: (id) => id.startsWith('claude') || id.startsWith('anthropic') },
	{
		label: 'OpenAI',
		matches: (id) =>
			id.startsWith('gpt') ||
			id.startsWith('openai') ||
			id.startsWith('codex') ||
			/^o\d/.test(id) ||
			id.startsWith('chatgpt'),
	},
	{ label: 'Gemini', matches: (id) => id.startsWith('gemini') || id.startsWith('google') },
	{ label: 'Grok', matches: (id) => id.startsWith('grok') || id.startsWith('xai') },
	{ label: 'Llama', matches: (id) => id.startsWith('llama') || id.startsWith('meta') },
	{ label: 'Mistral', matches: (id) => id.startsWith('mistral') || id.startsWith('codestral') },
	{ label: 'DeepSeek', matches: (id) => id.startsWith('deepseek') },
	{ label: 'Qwen', matches: (id) => id.startsWith('qwen') },
];

/** The vendor family a model id belongs to, or 'Other' when nothing matches. */
export function getModelFamily(modelId: string): string {
	const id = modelId.trim().toLowerCase();
	// A provider-qualified id ("github-copilot/claude-sonnet-4.5") names its
	// vendor after the slash, so match on the last segment when one is present.
	const tail = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
	return MODEL_FAMILIES.find((family) => family.matches(tail))?.label ?? 'Other';
}

/**
 * Group model ids by family, preserving the incoming order inside each group
 * and ordering the groups by MODEL_FAMILIES (with 'Other' last).
 *
 * Returns a single unlabelled group when every model lands in the same family:
 * a lone "Claude" header over a list of Claude models is noise.
 */
export function groupModelsByFamily(
	models: string[]
): Array<{ family: string | null; models: string[] }> {
	const byFamily = new Map<string, string[]>();
	for (const model of models) {
		const family = getModelFamily(model);
		const bucket = byFamily.get(family);
		if (bucket) {
			bucket.push(model);
		} else {
			byFamily.set(family, [model]);
		}
	}

	if (byFamily.size <= 1) {
		return [{ family: null, models }];
	}

	const order = [...MODEL_FAMILIES.map((f) => f.label), 'Other'];
	return [...byFamily.entries()]
		.sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
		.map(([family, grouped]) => ({ family, models: grouped }));
}
