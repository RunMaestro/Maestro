/**
 * Loading Maestro's own prompts without a desktop.
 *
 * Two hosts used to resolve a prompt each: the desktop's prompt manager
 * (customization, `{{REF:}}`, `{{INCLUDE:}}`) and the CLI's loader (customization
 * and `{{REF:}}` only). A third copy in the TUI would have drifted the same way, so
 * the directive rules live here and both of those call them.
 *
 * - `{{REF:name}}` becomes the absolute path of the BUNDLED `.md`. It is resolved on
 *   the top-level text only, so a block that arrives through an include keeps its
 *   refs. The path serves the bundled file, never a customization.
 * - `{{INCLUDE:name}}` inlines another prompt, customization-aware, to a depth of 3
 *   with a cycle check.
 *
 * A prompt the user edited wins over the bundled file when `isModified` is true. The
 * customizations file is re-read on every `get`, so an edit made in the desktop applies
 * to the next turn; bundled files are cached.
 */

import * as fs from 'fs';
import * as path from 'path';
import { CORE_PROMPTS } from '../../promptDefinitions';
import { logger } from '../host';
import { parseStoreJson } from '../store/corrupt-store';
import { PROMPT_CUSTOMIZATIONS_FILE } from '../settings/snapshot';

const LOG_CONTEXT = '[PromptLoader]';

const INCLUDE_PATTERN = /\{\{INCLUDE:([a-zA-Z0-9_-]+)\}\}/g;
const REF_PATTERN = /\{\{REF:([a-zA-Z0-9_-]+)\}\}/g;
const MAX_INCLUDE_DEPTH = 3;

/** What directive resolution needs from its host. */
export interface PromptDirectiveHost {
	/** The directory holding the bundled `.md` files. */
	bundledPromptsDir: string;
	/**
	 * The raw, still-unresolved text of another prompt, customization-aware. `null`
	 * when it does not exist.
	 */
	readPrompt(name: string): string | null;
	/** Told about a directive that could not be resolved. It is left in the text. */
	warn?(message: string): void;
}

/**
 * Expand `{{REF:name}}` into the absolute on-disk path of the bundled `.md`.
 * `path.resolve` guarantees an absolute path on every OS, with native separators.
 * Nothing else is emitted: authors supply their own surrounding prose.
 */
function resolveRefs(content: string, host: PromptDirectiveHost): string {
	if (!content.includes('{{REF:')) return content;
	return content.replace(REF_PATTERN, (match, name: string) => {
		const def = CORE_PROMPTS.find((p) => p.id === name);
		if (!def) {
			host.warn?.(`REF target not found in registry: ${name}`);
			return match;
		}
		return path.resolve(host.bundledPromptsDir, def.filename);
	});
}

function resolveIncludes(
	content: string,
	host: PromptDirectiveHost,
	visited: Set<string>,
	depth: number
): string {
	if (depth >= MAX_INCLUDE_DEPTH) return content;
	if (!content.includes('{{INCLUDE:')) return content;

	return content.replace(INCLUDE_PATTERN, (match, name: string) => {
		if (visited.has(name)) {
			host.warn?.(`Circular include detected: ${name} (visited: ${[...visited].join(' -> ')})`);
			return match;
		}

		const resolved = host.readPrompt(name);
		if (resolved === null) {
			host.warn?.(`Include not found: ${name}`);
			return match;
		}

		const nextVisited = new Set(visited);
		nextVisited.add(name);
		return resolveIncludes(resolved, host, nextVisited, depth + 1);
	});
}

/**
 * Resolve a prompt's directives: refs first, then includes. `id` seeds the cycle
 * check so a prompt cannot include itself.
 */
export function resolvePromptDirectives(
	id: string,
	content: string,
	host: PromptDirectiveHost
): string {
	return resolveIncludes(resolveRefs(content, host), host, new Set([id]), 0);
}

/**
 * Where a bundled prompt file may live, best first.
 *
 * Maestro runs in three contexts: a checkout (ts-node or a dev bundle in
 * `dist/cli`), a packaged Electron app (`process.resourcesPath`), and a standalone
 * bundled program (`Resources/maestro-cli.js`). A module sits at `src/<x>/<y>` in the
 * first and `dist/<x>` in the second, so both root depths are probed. `moduleDirectory`
 * is the CALLER's own directory (`__dirname`), which is why it is a parameter: this
 * file is bundled into several programs.
 */
export function bundledPromptCandidates(filename: string, moduleDirectory: string): string[] {
	const projectRoots = [
		path.resolve(moduleDirectory, '..', '..', '..'),
		path.resolve(moduleDirectory, '..', '..'),
	];
	const candidates = projectRoots.map((root) => path.join(root, 'src', 'prompts', filename));

	if (typeof process !== 'undefined' && (process as { resourcesPath?: string }).resourcesPath) {
		candidates.push(
			path.join((process as { resourcesPath?: string }).resourcesPath!, 'prompts', 'core', filename)
		);
	}

	candidates.push(
		path.join(path.dirname(process.argv[1] || moduleDirectory), 'prompts', 'core', filename)
	);
	candidates.push(path.join(moduleDirectory, '..', 'prompts', 'core', filename));

	return [...new Set(candidates)];
}

/**
 * The directory holding the bundled prompt files, found with a known file (the
 * first entry in `CORE_PROMPTS`). Undefined when no candidate is readable.
 */
export function findBundledPromptsDir(moduleDirectory: string): string | undefined {
	const probeFilename = CORE_PROMPTS[0]?.filename;
	if (!probeFilename) return undefined;
	for (const candidate of bundledPromptCandidates(probeFilename, moduleDirectory)) {
		try {
			fs.accessSync(candidate, fs.constants.R_OK);
			return path.dirname(candidate);
		} catch {
			// Try the next candidate.
		}
	}
	return undefined;
}

export interface PromptLoaderOptions {
	/** The directory holding the bundled `.md` files (`findBundledPromptsDir`). */
	bundledPromptsDir: string;
	/** `<userData>/core-prompts-customizations.json`. */
	customizationsFile: string;
}

export interface PromptLoader {
	/**
	 * The resolved text of prompt `id`: the user's edit when there is one, else the
	 * bundled file, with refs and includes resolved. `undefined` when it could not be
	 * loaded, so a caller can send the turn without it, as the desktop does.
	 */
	get(id: string): string | undefined;
}

/** The text of every prompt the user edited, by id. A missing or broken file is "none". */
function readCustomizations(file: string): Map<string, string> {
	const edited = new Map<string, string>();
	let content: string;
	try {
		content = fs.readFileSync(file, 'utf-8');
	} catch {
		return edited;
	}
	const parsed = parseStoreJson<{
		prompts?: Record<string, { content?: unknown; isModified?: unknown } | null>;
	}>(content);
	if (!parsed.ok) {
		logger.warn(`Prompt customizations are not valid JSON: ${parsed.error.message}`, LOG_CONTEXT);
		return edited;
	}
	for (const [id, entry] of Object.entries(parsed.value?.prompts ?? {})) {
		if (entry?.isModified === true && typeof entry.content === 'string') {
			edited.set(id, entry.content);
		}
	}
	return edited;
}

export function createPromptLoader(options: PromptLoaderOptions): PromptLoader {
	const bundled = new Map<string, string | null>();

	function readBundled(name: string): string | null {
		const cached = bundled.get(name);
		if (cached !== undefined) return cached;
		const filename = CORE_PROMPTS.find((p) => p.id === name)?.filename ?? `${name}.md`;
		let content: string | null;
		try {
			content = fs.readFileSync(path.join(options.bundledPromptsDir, filename), 'utf-8');
		} catch {
			content = null;
		}
		bundled.set(name, content);
		return content;
	}

	return {
		get(id) {
			const edited = readCustomizations(options.customizationsFile);
			const readPrompt = (name: string) => edited.get(name) ?? readBundled(name);
			const raw = readPrompt(id);
			if (raw === null) {
				logger.warn(`Prompt "${id}" could not be loaded`, LOG_CONTEXT);
				return undefined;
			}
			return resolvePromptDirectives(id, raw, {
				bundledPromptsDir: options.bundledPromptsDir,
				readPrompt,
				warn: (message) => logger.warn(message, LOG_CONTEXT),
			});
		},
	};
}

export interface PromptLoaderSources {
	/** The data directory holding `core-prompts-customizations.json`. */
	userDataDir: string;
	/** The directory holding the bundled `.md` prompts. Found by probing from `moduleDirectory` when omitted. */
	bundledPromptsDir?: string;
	/** The directory of the running bundle, which the bundled-prompt probe is relative to. Default: the entry script's. */
	moduleDirectory?: string;
}

/**
 * The prompt loader a host that has no desktop uses: the user's customizations from the data
 * directory over the bundled prompts it can find. `undefined` when no bundled directory exists,
 * so a turn goes without a prompt, as a desktop turn does when its template did not load.
 */
export function createPromptLoaderFor(sources: PromptLoaderSources): PromptLoader | undefined {
	const moduleDirectory = sources.moduleDirectory ?? path.dirname(process.argv[1] ?? process.cwd());
	const bundledPromptsDir = sources.bundledPromptsDir ?? findBundledPromptsDir(moduleDirectory);
	if (!bundledPromptsDir) {
		logger.warn('The bundled prompts directory was not found; no prompt can load', LOG_CONTEXT);
		return undefined;
	}
	return createPromptLoader({
		bundledPromptsDir,
		customizationsFile: path.join(sources.userDataDir, PROMPT_CUSTOMIZATIONS_FILE),
	});
}
