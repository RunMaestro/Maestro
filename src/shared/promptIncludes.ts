/**
 * `{{INCLUDE:name}}` expansion for Maestro prompts.
 *
 * Both prompt loaders resolve includes: the desktop's prompt manager
 * (`src/main/prompt-manager.ts`) and the CLI's (`src/cli/services/prompt-loader.ts`).
 * They differ only in where a prompt's text comes from - an in-memory cache
 * versus files read on demand - so this module owns the expansion rules and
 * takes the loader as an argument. A loader that skipped an include would hand
 * a CLI-spawned agent the literal directive while the desktop agent got the
 * content, which is exactly how the two would drift.
 *
 * Pure: no fs, no logger. Callers report problems through the callbacks.
 */

/** Deepest include chain expanded; anything nested further is left verbatim. */
export const MAX_PROMPT_INCLUDE_DEPTH = 3;

// A fresh /g regex per call: a shared one carries `lastIndex` between calls.
const includePattern = () => /\{\{INCLUDE:([a-zA-Z0-9_-]+)\}\}/g;

/** Every include name `content` references directly, in order, without duplicates. */
export function findPromptIncludeNames(content: string): string[] {
	if (!content.includes('{{INCLUDE:')) return [];
	return [...new Set(Array.from(content.matchAll(includePattern()), (m) => m[1]))];
}

export interface ResolvePromptIncludesOptions {
	/** The raw text of an include by name, or null when no such prompt exists. */
	load: (name: string) => string | null;
	/** Id of the prompt being resolved, so a self-include counts as a cycle. */
	rootId?: string;
	/** Called for an include that `load` could not find. The directive is left as-is. */
	onMissing?: (name: string) => void;
	/** Called for an include already on the current chain. The directive is left as-is. */
	onCycle?: (name: string, chain: string[]) => void;
}

/**
 * Inline every `{{INCLUDE:name}}` in `content`, recursively up to
 * {@link MAX_PROMPT_INCLUDE_DEPTH}. A missing or circular include leaves its
 * directive in place rather than an empty gap, so the problem stays visible.
 */
export function resolvePromptIncludes(
	content: string,
	options: ResolvePromptIncludesOptions
): string {
	const expand = (text: string, chain: string[], depth: number): string => {
		if (depth >= MAX_PROMPT_INCLUDE_DEPTH || !text.includes('{{INCLUDE:')) return text;
		return text.replace(includePattern(), (match, name: string) => {
			if (chain.includes(name)) {
				options.onCycle?.(name, chain);
				return match;
			}
			const included = options.load(name);
			if (included === null) {
				options.onMissing?.(name);
				return match;
			}
			return expand(included, [...chain, name], depth + 1);
		});
	};
	return expand(content, options.rootId ? [options.rootId] : [], 0);
}
