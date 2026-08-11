/**
 * ast-grep backing for TTSR's `astCondition` rules.
 *
 * Structural matching runs over the *content an edit/write tool is writing*
 * (see `ttsr-tool-extract.ts`), never over a reconstructed source snapshot:
 * Maestro observes an external CLI's tool call after the fact, so AST matching
 * is post-write corrective, not preventive (a stated fidelity gap of the plan).
 *
 * `@ast-grep/napi` is a napi-rs native module, loaded lazily the same way
 * `@napi-rs/keyring` is in `plugins/authorization-ledger.ts`, so a missing or
 * unloadable binary degrades TTSR to regex-only instead of breaking main.
 */

import * as path from 'path';
import { logger } from '../utils/logger';

const LOG_CONTEXT = 'TTSR';

/**
 * Languages the core `@ast-grep/napi` package ships grammars for. Everything
 * else (Python, Go, Rust, ...) needs `registerDynamicLanguage` with a separately
 * compiled grammar, which Maestro does not bundle - so `astCondition` rules are
 * honestly limited to these file types and are skipped elsewhere.
 */
export const TTSR_AST_LANGUAGES = ['Html', 'JavaScript', 'Tsx', 'Css', 'TypeScript'] as const;
export type TtsrAstLanguage = (typeof TTSR_AST_LANGUAGES)[number];

/** Largest snapshot handed to the parser. Beyond this, structural matching is skipped. */
const MAX_AST_CONTENT_CHARS = 512_000;

const EXTENSION_LANGUAGES: Record<string, TtsrAstLanguage> = {
	'.ts': 'TypeScript',
	'.mts': 'TypeScript',
	'.cts': 'TypeScript',
	'.tsx': 'Tsx',
	'.js': 'JavaScript',
	'.mjs': 'JavaScript',
	'.cjs': 'JavaScript',
	'.jsx': 'JavaScript',
	'.css': 'Css',
	'.html': 'Html',
	'.htm': 'Html',
};

/** The ast-grep language for a file, or `null` when no bundled grammar fits. */
export function astLanguageForPath(filePath: string | undefined): TtsrAstLanguage | null {
	if (!filePath) return null;
	const ext = path.extname(filePath.replace(/\\/g, '/')).toLowerCase();
	return EXTENSION_LANGUAGES[ext] ?? null;
}

// ── Engine ───────────────────────────────────────────────────────────────────

/** The slice of `SgNode` TTSR uses. */
interface AstNodeLike {
	text(): string;
}

interface AstRootLike {
	root(): { find(pattern: string): AstNodeLike | null };
}

/** The slice of `@ast-grep/napi` TTSR uses, so tests can substitute a fake. */
export interface AstGrepModuleLike {
	Lang: Record<string, unknown>;
	parseAsync(lang: unknown, source: string): Promise<AstRootLike>;
}

export interface TtsrAstMatcher {
	/**
	 * First structural hit of any pattern, or `null`. Returns the matched source
	 * text so the activity log can show what tripped the rule.
	 */
	find(patterns: string[], content: string, filePath?: string): Promise<string | null>;
	/** False when no grammar covers the path or the native module is unavailable. */
	supports(filePath: string | undefined): boolean;
}

function defaultLoadModule(): AstGrepModuleLike | null {
	try {
		const mod = require('@ast-grep/napi') as Partial<AstGrepModuleLike>;
		return typeof mod.parseAsync === 'function' && mod.Lang ? (mod as AstGrepModuleLike) : null;
	} catch (err) {
		logger.warn('TTSR ast-grep unavailable; astCondition rules are inert', LOG_CONTEXT, {
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/**
 * Build the matcher. The native module is resolved on first use and the result
 * (including failure) is cached, so an unloadable binary costs one warning.
 */
export function createTtsrAstMatcher(
	loadModule: () => AstGrepModuleLike | null = defaultLoadModule
): TtsrAstMatcher {
	let module: AstGrepModuleLike | null | undefined;

	const engine = (): AstGrepModuleLike | null => {
		if (module === undefined) module = loadModule();
		return module;
	};

	return {
		supports(filePath) {
			return astLanguageForPath(filePath) !== null && engine() !== null;
		},

		async find(patterns, content, filePath) {
			if (patterns.length === 0 || !content) return null;
			if (content.length > MAX_AST_CONTENT_CHARS) return null;

			const language = astLanguageForPath(filePath);
			if (!language) return null;

			const mod = engine();
			if (!mod) return null;

			const lang = mod.Lang[language];
			if (lang === undefined) return null;

			try {
				const root = (await mod.parseAsync(lang, content)).root();
				for (const pattern of patterns) {
					// A malformed pattern yields `null` rather than throwing, so a bad
					// rule is simply inert instead of poisoning the whole snapshot.
					const node = root.find(pattern);
					if (node) return node.text();
				}
			} catch (err) {
				logger.warn('TTSR ast-grep match failed', LOG_CONTEXT, {
					filePath,
					language,
					error: err instanceof Error ? err.message : String(err),
				});
			}
			return null;
		},
	};
}
