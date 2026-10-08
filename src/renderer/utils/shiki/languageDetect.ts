/**
 * Lazy `highlight.js`-based language auto-detection. Only used when a code
 * fence arrives without an explicit language tag - Shiki has no built-in
 * guesser, and `highlight.js`'s `highlightAuto` is the industry standard.
 *
 * Cost: `highlight.js` is ~40 KB gzipped. We pay it once, on first detection,
 * via a dynamic import so the cost stays out of the main bundle.
 */

import { captureException } from '../sentry';
import { resolveLanguage } from './highlighterManager';

interface HighlightJsGuess {
	language?: string;
	relevance: number;
}

interface HighlightJsApi {
	highlightAuto: (
		code: string,
		languageSubset?: string[]
	) => HighlightJsGuess & { secondBest?: HighlightJsGuess };
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

export interface DetectionResult {
	/** Canonical Shiki language id, e.g. `'typescript'`. */
	language: string;
}

/**
 * The confidence gate. hljs `relevance` is a raw keyword-hit count, not a
 * probability, and it grows with snippet length, so no single cutoff means
 * "sure". What separates a right guess from a wrong one is the LEAD: real code
 * wins clearly, while prose, logs, and command output score a near-tie across
 * several unrelated grammars (C#, Kotlin, YAML, SQL all match English words).
 *
 * A guess is used only when it scores at least `MIN_RELEVANCE` and at least
 * `MIN_LEAD` times the best grammar from a different family. Measured on 42
 * code and non-code samples (snippets, repo files, logs, stack traces, tool
 * output), this kept 4 guesses and none was wrong: bash, SQL, PHP, and an env
 * listing as INI. A looser gate (relevance 5, lead 1.5) let a log and a
 * CLAUDE.md through as YAML. The cost is recall: most short or C-like
 * snippets fall back to plain text, which is the intended trade. A wrong color
 * is worse than none, and the picker is one click away.
 */
const MIN_RELEVANCE = 10;
const MIN_LEAD = 2;

/**
 * Whitelist of grammars `highlightAuto` is allowed to consider. By default hljs
 * scores a snippet against *every* registered language, and niche grammars
 * (MIPS / x86 assembly, exotic configs, etc.) routinely out-score plain prose
 * or numeric text - that's how plaintext ends up rendered as MIPS assembly.
 *
 * Restricting the candidate set to languages people actually paste means a
 * snippet that doesn't look like any of these scores low and falls through to
 * plaintext, which is the desired behaviour when we aren't sure. ids are
 * hljs language names; the winner is mapped to Shiki's id by `resolveLanguage`.
 *
 * Two grammars are left out on purpose, because winning with them proves
 * nothing:
 * - Swift: its keyword list is full of English words (`as`, `in`, `is`,
 *   `some`, `each`, `operator`, `indirect`), so prose and directory listings
 *   out-score every real language as Swift.
 * - YAML: it accepts almost any text as plain scalars and scores timestamps,
 *   so a log scores as YAML while every other grammar hits an illegal token
 *   and scores 0, which reads as an unbeatable lead.
 * An untagged fence in either renders as plain text; a tagged one still
 * highlights.
 */
const HLJS_DETECT_SUBSET = [
	'javascript',
	'typescript',
	'python',
	'bash',
	'shell',
	'json',
	'xml', // hljs serves HTML under the xml grammar
	'css',
	'scss',
	'markdown',
	'rust',
	'go',
	'java',
	'c',
	'cpp',
	'csharp',
	'php',
	'ruby',
	'sql',
	'diff',
	'dockerfile',
	'ini', // covers toml-style config
	'kotlin',
];

/**
 * A line drawn by `tree`-style output: optional indent, then a box-drawing
 * branch glyph. No language puts these at the start of a line, so a block
 * that has one is a listing, not code, and hljs only scores its names as noise.
 */
const TREE_LINE_REGEX = /^[\s│]*[├└│]/m;

/**
 * Grammars that are supersets or dialects of each other. A near-tie inside a
 * family (TypeScript vs JavaScript, CSS vs SCSS) is not doubt about what the
 * code is, so the lead is measured against the best grammar OUTSIDE the
 * winner's family. Grammars not listed are their own family.
 */
const HLJS_FAMILIES: Record<string, string> = {
	javascript: 'js',
	typescript: 'js',
	json: 'js',
	c: 'c',
	cpp: 'c',
	css: 'css',
	scss: 'css',
	bash: 'sh',
	shell: 'sh',
};

function hljsFamily(language: string): string {
	return HLJS_FAMILIES[language] ?? language;
}

/** True when `text` is a JSON object or array. A parse is proof; no guess needed. */
function isJsonDocument(text: string): boolean {
	if (!text.startsWith('{') && !text.startsWith('[')) return false;
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

/**
 * The hljs language for `code`, or null unless it passes the confidence gate
 * (see `MIN_RELEVANCE` / `MIN_LEAD`).
 */
function confidentHljsGuess(hljs: HighlightJsApi, code: string): string | null {
	const best = hljs.highlightAuto(code, HLJS_DETECT_SUBSET);
	if (!best.language || best.relevance < MIN_RELEVANCE) return null;
	const family = hljsFamily(best.language);
	// `secondBest` is the rival unless it shares the winner's family; only
	// then is a second pass over the other families needed.
	let rival = best.secondBest;
	if (rival?.language && hljsFamily(rival.language) === family) {
		const others = HLJS_DETECT_SUBSET.filter((lang) => hljsFamily(lang) !== family);
		rival = hljs.highlightAuto(code, others);
	}
	const rivalRelevance = rival?.language ? rival.relevance : 0;
	return best.relevance >= rivalRelevance * MIN_LEAD ? best.language : null;
}

/**
 * Guess a Shiki-compatible language id for `code`. Returns null (render as
 * plain text) unless the guess is near certain, or if the pick has no grammar
 * Shiki ships.
 */
export async function detectLanguage(code: string): Promise<DetectionResult | null> {
	const trimmed = code.trim();
	if (trimmed.length < 8) return null;
	if (TREE_LINE_REGEX.test(trimmed)) return null;
	try {
		const guess = isJsonDocument(trimmed) ? 'json' : confidentHljsGuess(await loadHljs(), trimmed);
		if (!guess) return null;
		const shikiLang = await resolveLanguage(guess);
		return shikiLang ? { language: shikiLang } : null;
	} catch (err) {
		captureException(err, { extra: { component: 'shikiLanguageDetect' } });
		return null;
	}
}

/** Test-only reset for the hljs module promise cache. */
export function __resetForTests(): void {
	hljsPromise = null;
}
