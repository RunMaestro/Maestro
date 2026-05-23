/**
 * Lazy `highlight.js`-based language auto-detection. Only used when a code
 * fence arrives without an explicit language tag — Shiki has no built-in
 * guesser, and `highlight.js`'s `highlightAuto` is the industry standard.
 *
 * Cost: `highlight.js` is ~40 KB gzipped. We pay it once, on first detection,
 * via a dynamic import so the cost stays out of the main bundle.
 */

import { captureException } from '../sentry';
import { resolveLanguage } from './highlighterManager';

interface HighlightJsApi {
	highlightAuto: (
		code: string,
		languageSubset?: string[]
	) => {
		language?: string;
		relevance: number;
	};
}

type HighlightJsImport = typeof import('highlight.js') & {
	default?: unknown;
};

let hljsPromise: Promise<HighlightJsApi> | null = null;

function hasHighlightAuto(value: unknown): value is HighlightJsApi {
	return (
		typeof value === 'object' &&
		value !== null &&
		'highlightAuto' in value &&
		typeof (value as { highlightAuto?: unknown }).highlightAuto === 'function'
	);
}

function normalizeHljs(module: HighlightJsImport): HighlightJsApi {
	const defaultExport = (module as { default?: unknown }).default;
	if (hasHighlightAuto(module)) return module;
	if (hasHighlightAuto(defaultExport)) return defaultExport;
	throw new Error('highlight.js did not expose highlightAuto');
}

function loadHljs(): Promise<HighlightJsApi> {
	if (hljsPromise) return hljsPromise;
	hljsPromise = import('highlight.js').then(normalizeHljs);
	return hljsPromise;
}

/**
 * Guess a Shiki-compatible language id for `code`. Returns null if the
 * heuristic isn't confident enough, or if hljs's pick doesn't map to a
 * grammar Shiki ships.
 *
 * The `relevance` field from hljs is a rough confidence signal — anything
 * under 5 tends to be noise on small snippets. We pass that threshold up so
 * callers can decide whether to render plain or highlight on a weak guess.
 */
export interface DetectionResult {
	/** Canonical Shiki language id, e.g. `'typescript'`. */
	language: string;
	/** hljs relevance score; higher = more confident. */
	relevance: number;
}

const MIN_RELEVANCE = 5;

export async function detectLanguage(code: string): Promise<DetectionResult | null> {
	const trimmed = code.trim();
	if (trimmed.length < 8) return null;
	try {
		const hljs = await loadHljs();
		const result = hljs.highlightAuto(trimmed);
		if (!result.language || result.relevance < MIN_RELEVANCE) return null;
		const shikiLang = await resolveLanguage(result.language);
		if (!shikiLang) return null;
		return { language: shikiLang, relevance: result.relevance };
	} catch (err) {
		captureException(err, { extra: { component: 'shikiLanguageDetect' } });
		return null;
	}
}

/** Test-only reset for the hljs module promise cache. */
export function __resetForTests(): void {
	hljsPromise = null;
}
