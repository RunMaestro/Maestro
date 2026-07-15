/**
 * Shared Shiki highlighter singleton used by every code-rendering surface in
 * the app (AI chat code fences, FilePreview markdown/text Fast tiers).
 *
 * Why one module:
 *   Shiki's WASM/regex engine is ~60 KB and creating a highlighter is
 *   expensive. Having multiple `createHighlighter` call sites would load the
 *   engine twice and waste startup time. This module ensures exactly one
 *   highlighter instance lives at runtime, with languages loaded on demand.
 *
 * Public API:
 *   - `getHighlighter()` - returns a Promise that resolves to the singleton.
 *     Triggers the dynamic `import('shiki')` on first call.
 *   - `ensureLanguage(highlighter, lang)` - lazily loads a language grammar
 *     after the initial bundle. Returns the resolved language id (after alias
 *     normalisation) or `null` if Shiki doesn't ship that language.
 *   - `resolveLanguage(input)` - normalise a raw fence tag (`'ts'`,
 *     `'TypeScript'`, `'sh'`) to a bundled Shiki language id, or null.
 *   - `themeNameForMode(mode)` - pick `github-light` / `github-dark` from a
 *     Theme.mode.
 */

import type { ThemeMode } from '../../../shared/theme-types';
import { captureException } from '../sentry';

type ShikiModule = typeof import('shiki');
type Highlighter = Awaited<ReturnType<ShikiModule['createHighlighter']>>;

type ShikiApi = Pick<
	ShikiModule,
	'createHighlighter' | 'bundledLanguagesInfo' | 'bundledLanguagesAlias'
>;

/**
 * Dynamic imports through Vite 8 / Rolldown sometimes hand back a module
 * where the runtime API lives under `.default` (CJS interop) instead of the
 * top-level namespace. This matches the same defensive normaliser the
 * `languageDetect` module applies to `highlight.js` - silently picking the
 * wrong shape is exactly what would produce "Shiki loaded but
 * `createHighlighter` is undefined → catch → fallback → no colors".
 */
function isShikiApi(value: unknown): value is ShikiApi {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as { createHighlighter?: unknown }).createHighlighter === 'function'
	);
}

function normalizeShikiModule(mod: unknown): ShikiApi {
	if (isShikiApi(mod)) return mod;
	const defaultExport = (mod as { default?: unknown }).default;
	if (isShikiApi(defaultExport)) return defaultExport;
	throw new Error('shiki module did not expose createHighlighter');
}

/** Languages preloaded with the highlighter to cover the common cases hot. */
export const PRELOADED_LANGUAGES = [
	'javascript',
	'typescript',
	'tsx',
	'jsx',
	'json',
	'python',
	'bash',
	'shell',
	'sh',
	'html',
	'css',
	'scss',
	'markdown',
	'md',
	'yaml',
	'yml',
	'rust',
	'go',
	'java',
	'c',
	'cpp',
	'sql',
	'xml',
	'diff',
	'toml',
	'docker',
] as const;

/**
 * Common fence aliases resolved without touching Shiki's bundle. Used by the
 * observer fast-path so popular short tags don't pay an async round trip.
 */
export const LANGUAGE_ALIASES: Record<string, string> = {
	ts: 'typescript',
	js: 'javascript',
	py: 'python',
	zsh: 'bash',
	dockerfile: 'docker',
	plaintext: 'text',
	'': 'text',
};

export const LIGHT_THEME = 'github-light';
export const DARK_THEME = 'github-dark';

export type ShikiThemeName = typeof LIGHT_THEME | typeof DARK_THEME;

export function themeNameForMode(mode: ThemeMode): ShikiThemeName {
	// Match react-syntax-highlighter's existing pairing: 'vibe' themes use the
	// dark syntax palette (see src/renderer/utils/syntaxTheme.ts).
	return mode === 'light' ? LIGHT_THEME : DARK_THEME;
}

let highlighterPromise: Promise<Highlighter> | null = null;
let bundledLanguagesPromise: Promise<Set<string>> | null = null;
let bundledAliasMapPromise: Promise<Map<string, string>> | null = null;

/**
 * Get (or lazily create) the singleton Shiki highlighter. Both light/dark
 * themes are preloaded so callers can switch without an extra round trip.
 */
export function getHighlighter(): Promise<Highlighter> {
	if (highlighterPromise) return highlighterPromise;
	highlighterPromise = (async () => {
		const shiki = normalizeShikiModule(await import('shiki'));
		return shiki.createHighlighter({
			themes: [LIGHT_THEME, DARK_THEME],
			langs: [...PRELOADED_LANGUAGES],
		});
	})();
	return highlighterPromise;
}

/**
 * Return the set of language ids Shiki ships in its full bundle. Used by the
 * language picker to populate its dropdown. Lazy-loaded so the metadata
 * doesn't pull in the highlighter when we only need the list of names.
 */
export async function getBundledLanguageIds(): Promise<Set<string>> {
	if (bundledLanguagesPromise) return bundledLanguagesPromise;
	bundledLanguagesPromise = (async () => {
		const shiki = normalizeShikiModule(await import('shiki'));
		return new Set(shiki.bundledLanguagesInfo.map((l) => l.id));
	})();
	return bundledLanguagesPromise;
}

export interface BundledLanguageEntry {
	id: string;
	name: string;
	aliases: string[];
}

/**
 * Returns the full bundled-language list with names + aliases, sorted by
 * display name. Used by the LanguagePicker to populate its dropdown. Goes
 * through the same shape-normaliser as the highlighter to dodge Vite/Rolldown
 * default-export interop quirks.
 */
export async function getBundledLanguageEntries(): Promise<BundledLanguageEntry[]> {
	const shiki = normalizeShikiModule(await import('shiki'));
	return shiki.bundledLanguagesInfo
		.map((info) => ({
			id: info.id,
			name: info.name ?? info.id,
			aliases: info.aliases ?? [],
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Return a map from any known alias to its canonical Shiki language id (e.g.
 * `'ts' -> 'typescript'`). Combines Shiki's own alias table with our local
 * overrides.
 */
async function getAliasMap(): Promise<Map<string, string>> {
	if (bundledAliasMapPromise) return bundledAliasMapPromise;
	bundledAliasMapPromise = (async () => {
		const shiki = normalizeShikiModule(await import('shiki'));
		const map = new Map<string, string>();
		// `bundledLanguagesInfo` carries each canonical id plus its aliases,
		// which is everything we need. We deliberately ignore Shiki's
		// `bundledLanguagesAlias` (it maps to language *registrations*, not
		// canonical ids, so it would require value-equality comparisons to
		// reverse-resolve).
		for (const info of shiki.bundledLanguagesInfo) {
			map.set(info.id.toLowerCase(), info.id);
			for (const alias of info.aliases ?? []) {
				map.set(alias.toLowerCase(), info.id);
			}
		}
		for (const [alias, target] of Object.entries(LANGUAGE_ALIASES)) {
			map.set(alias.toLowerCase(), target);
		}
		return map;
	})();
	return bundledAliasMapPromise;
}

/**
 * Synchronously resolve a fence tag against our local alias overrides only.
 * Use this for the fast-path before falling through to `resolveLanguageAsync`
 * (which can hit Shiki's bundle for full alias coverage).
 */
export function resolveLanguageSync(input: string | null | undefined): string | null {
	if (input == null) return null;
	const lower = input.toLowerCase().trim();
	if ((PRELOADED_LANGUAGES as readonly string[]).includes(lower)) return lower;
	// Hit the alias table even for empty strings - `LANGUAGE_ALIASES['']` maps
	// the no-fence-tag case to `'text'`.
	if (lower in LANGUAGE_ALIASES) return LANGUAGE_ALIASES[lower];
	return null;
}

/**
 * Resolve any fence tag to a canonical bundled Shiki language id, or null if
 * Shiki doesn't ship a grammar for it. Asynchronous because it may need to
 * consult Shiki's full alias map.
 */
export async function resolveLanguage(input: string | null | undefined): Promise<string | null> {
	const sync = resolveLanguageSync(input);
	if (sync) return sync;
	if (!input) return null;
	const aliasMap = await getAliasMap();
	const lower = input.toLowerCase().trim();
	const direct = aliasMap.get(lower);
	if (direct) return direct;
	// `input` may itself already be a canonical id we haven't preloaded.
	const bundled = await getBundledLanguageIds();
	if (bundled.has(lower)) return lower;
	return null;
}

/**
 * Ensure a language grammar is loaded on the highlighter. Returns the
 * canonical language id on success, or null when Shiki doesn't ship the
 * requested language (callers should fall back to plain rendering).
 */
export async function ensureLanguage(
	highlighter: Highlighter,
	lang: string
): Promise<string | null> {
	const resolved = await resolveLanguage(lang);
	if (!resolved) return null;
	if (highlighter.getLoadedLanguages().includes(resolved)) {
		return resolved;
	}
	try {
		// Shiki's `loadLanguage` accepts a `BundledLangKeys` string union or a
		// registration object. The runtime check above already proved `resolved`
		// is a bundled id, but TS can't narrow string → union, so cast.
		await highlighter.loadLanguage(resolved as Parameters<Highlighter['loadLanguage']>[0]);
		return resolved;
	} catch (err) {
		captureException(err, {
			extra: { component: 'shikiHighlighterManager', stage: 'loadLanguage', lang: resolved },
		});
		return null;
	}
}

/**
 * Reset the singleton. Test-only - production code should never need this.
 */
export function __resetForTests(): void {
	highlighterPromise = null;
	bundledLanguagesPromise = null;
	bundledAliasMapPromise = null;
}
