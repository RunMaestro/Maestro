/**
 * i18n Translation Validation Script
 *
 * Validates all translation files against English (source of truth).
 * Checks for: missing keys, orphaned keys, interpolation variable mismatches,
 * pluralization completeness, and JSON syntax errors.
 *
 * Handles both i18next plural styles:
 *   - v4 CLDR: key_one, key_other (+ _zero, _two, _few, _many for Arabic)
 *   - v3 legacy: key, key_plural
 *
 * Usage:
 *   npx tsx scripts/i18n-validate.ts
 *   npx tsx scripts/i18n-validate.ts --json   # Machine-readable output
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Configuration ──────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const LOCALES_DIR = path.join(ROOT, 'src/shared/i18n/locales');

const LANGUAGES = ['en', 'es', 'fr', 'de', 'zh', 'hi', 'ar', 'bn', 'pt'] as const;
type Language = (typeof LANGUAGES)[number];

const NAMESPACES = [
	'common',
	'settings',
	'modals',
	'menus',
	'notifications',
	'accessibility',
	'shortcuts',
] as const;

/** CLDR plural suffixes used by i18next v4 */
const CLDR_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other'] as const;

/** All recognized plural suffixes (CLDR + legacy _plural) */
const ALL_PLURAL_SUFFIXES = [...CLDR_SUFFIXES, '_plural'] as const;

/**
 * Required CLDR plural forms per language (cardinal rules).
 * i18next v21+ uses Intl.PluralRules under the hood.
 */
const REQUIRED_PLURAL_FORMS: Record<Language, string[]> = {
	en: ['one', 'other'],
	es: ['one', 'other'],
	fr: ['one', 'other'],
	de: ['one', 'other'],
	zh: ['other'],
	hi: ['one', 'other'],
	ar: ['zero', 'one', 'two', 'few', 'many', 'other'],
	bn: ['one', 'other'],
	pt: ['one', 'other'],
};

/**
 * Plural forms where interpolation variables may be omitted intentionally.
 *
 * _zero: "no items" — count/total are meaningless when quantity is zero.
 * _one: "one item" — count is expressed as a word, not a number.
 * _two: "two items" — count is expressed as a word (Arabic dual form).
 *
 * Only {{count}} and count-like variables (e.g. {{total}}) are exempt.
 * Other variables (e.g. {{name}}) must still be present.
 */
const IMPLICIT_COUNT_FORMS = new Set(['zero', 'one', 'two']);
const COUNT_LIKE_VARS = new Set(['count', 'total']);

// ── Types ──────────────────────────────────────────────────────────────────

interface Issue {
	type: 'missing' | 'orphaned' | 'interpolation' | 'plural' | 'syntax';
	namespace: string;
	key: string;
	detail: string;
}

interface LanguageReport {
	language: string;
	totalEnglishKeys: number;
	presentKeys: number;
	completionPercent: number;
	issues: Issue[];
	syntaxErrors: string[];
}

type PluralStyle = 'v4' | 'v3';

interface PluralStem {
	stem: string;
	style: PluralStyle;
	/** The English forms present (e.g. ['one', 'other'] or ['base', 'plural']) */
	enForms: string[];
}

// ── Utility functions ──────────────────────────────────────────────────────

/** Flatten a nested JSON object into a Map of dot-notated keys → string values */
function flattenKeys(obj: Record<string, unknown>, prefix = ''): Map<string, string> {
	const result = new Map<string, string>();
	for (const [key, value] of Object.entries(obj)) {
		const fullKey = prefix ? `${prefix}.${key}` : key;
		if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
			for (const [k, v] of flattenKeys(value as Record<string, unknown>, fullKey)) {
				result.set(k, v);
			}
		} else {
			result.set(fullKey, String(value));
		}
	}
	return result;
}

/** Extract {{var}} interpolation variable names from a translation value */
function extractInterpolationVars(value: string): Set<string> {
	const vars = new Set<string>();
	const regex = /\{\{(\w+)\}\}/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(value)) !== null) {
		vars.add(match[1]);
	}
	return vars;
}

/** Get the last segment of a dot-notated key */
function lastSegment(key: string): string {
	return key.includes('.') ? key.split('.').pop()! : key;
}

/**
 * Detect confirmed plural stems from English keys.
 *
 * A stem is confirmed plural only if English has 2+ forms for it:
 *   - v4: stem_one + stem_other (and possibly _zero, _two, _few, _many)
 *   - v3: stem (base) + stem_plural
 *
 * This prevents false positives like "meta_enter_to_send_other" where
 * "_other" means "other platforms", not the plural "other" category.
 */
function detectPluralStems(enKeys: Map<string, string>): Map<string, PluralStem> {
	// Collect CLDR-suffix candidates: stem → set of forms
	const cldrCandidates = new Map<string, Set<string>>();
	for (const key of enKeys.keys()) {
		const seg = lastSegment(key);
		for (const suffix of CLDR_SUFFIXES) {
			if (seg.endsWith(suffix)) {
				const stem = key.slice(0, key.length - suffix.length);
				if (!cldrCandidates.has(stem)) cldrCandidates.set(stem, new Set());
				cldrCandidates.get(stem)!.add(suffix.slice(1));
				break;
			}
		}
	}

	const result = new Map<string, PluralStem>();

	// v4 stems: must have 2+ CLDR forms in English
	for (const [stem, forms] of cldrCandidates) {
		if (forms.size >= 2) {
			result.set(stem, { stem, style: 'v4', enForms: [...forms] });
		}
	}

	// v3 stems: base key + key_plural both exist, and stem not already detected as v4
	for (const key of enKeys.keys()) {
		const seg = lastSegment(key);
		if (seg.endsWith('_plural')) {
			const stem = key.slice(0, key.length - '_plural'.length);
			if (enKeys.has(stem) && !result.has(stem)) {
				result.set(stem, { stem, style: 'v3', enForms: ['base', 'plural'] });
			}
		}
	}

	return result;
}

/**
 * Get all keys that belong to a plural stem (in any language).
 * For v4: stem_zero, stem_one, ... stem_other
 * For v3: stem, stem_plural
 */
function getPluralKeys(stem: string, style: PluralStyle): string[] {
	if (style === 'v4') {
		return CLDR_SUFFIXES.map((s) => `${stem}${s}`);
	} else {
		return [stem, `${stem}_plural`];
	}
}

// ── Core validation ────────────────────────────────────────────────────────

function loadNamespace(
	lang: string,
	ns: string
): { data: Map<string, string>; syntaxError: string | null } {
	const filePath = path.join(LOCALES_DIR, lang, `${ns}.json`);
	if (!fs.existsSync(filePath)) {
		return { data: new Map(), syntaxError: `File not found: ${filePath}` };
	}

	const raw = fs.readFileSync(filePath, 'utf-8');
	try {
		const parsed = JSON.parse(raw);
		return { data: flattenKeys(parsed), syntaxError: null };
	} catch (e) {
		return {
			data: new Map(),
			syntaxError: `JSON syntax error in ${lang}/${ns}.json: ${(e as Error).message}`,
		};
	}
}

function validateLanguage(
	lang: Language,
	englishData: Map<string, Map<string, string>>
): LanguageReport {
	const issues: Issue[] = [];
	const syntaxErrors: string[] = [];
	let totalEnglishKeys = 0;
	let presentKeys = 0;

	for (const ns of NAMESPACES) {
		const enKeys = englishData.get(ns)!;
		const { data: langKeys, syntaxError } = loadNamespace(lang, ns);

		if (syntaxError) {
			syntaxErrors.push(syntaxError);
			continue;
		}

		// Detect plural stems from English
		const enPluralStems = detectPluralStems(enKeys);

		// Build set of all English keys that belong to a plural stem
		const enPluralKeySet = new Set<string>();
		for (const [stem, info] of enPluralStems) {
			for (const key of getPluralKeys(stem, info.style)) {
				enPluralKeySet.add(key);
			}
		}

		// Build set of all language keys that belong to a known plural stem
		// (including CLDR expansions of v3 stems)
		const langPluralKeySet = new Set<string>();
		for (const [stem] of enPluralStems) {
			// Both v3 and v4 keys for this stem
			for (const s of CLDR_SUFFIXES) {
				langPluralKeySet.add(`${stem}${s}`);
			}
			langPluralKeySet.add(stem);
			langPluralKeySet.add(`${stem}_plural`);
		}

		// Also detect plural stems unique to this language (Arabic may add new ones)
		const langOnlyPluralStems = new Map<string, Set<string>>();
		for (const key of langKeys.keys()) {
			const seg = lastSegment(key);
			for (const suffix of ALL_PLURAL_SUFFIXES) {
				if (seg.endsWith(suffix)) {
					const stem = key.slice(0, key.length - suffix.length);
					if (!enPluralStems.has(stem)) {
						if (!langOnlyPluralStems.has(stem)) langOnlyPluralStems.set(stem, new Set());
						langOnlyPluralStems.get(stem)!.add(suffix.slice(1));
					}
					langPluralKeySet.add(key);
					break;
				}
			}
		}

		// Detect "language-expanded plurals": English has a non-plural key with
		// {{count}} and the language expanded it into proper CLDR plural forms.
		// This is valid i18next behavior — the CLDR forms take priority when
		// count is passed. Don't flag these as missing/orphaned.
		const langExpandedStems = new Set<string>();
		for (const [stem, forms] of langOnlyPluralStems) {
			if (forms.size >= 2) {
				const enBaseValue = enKeys.get(stem);
				if (enBaseValue && extractInterpolationVars(enBaseValue).has('count')) {
					langExpandedStems.add(stem);
					// Add all CLDR keys for this stem to the plural key set
					for (const s of CLDR_SUFFIXES) {
						langPluralKeySet.add(`${stem}${s}`);
					}
					langPluralKeySet.add(stem);
				}
			}
		}

		// ── 1. Check non-plural keys: missing and orphaned ──────────
		for (const key of enKeys.keys()) {
			if (enPluralKeySet.has(key)) continue; // handled in plural section

			totalEnglishKeys++;

			// If the language expanded this key into CLDR plural forms, count it as present
			if (langExpandedStems.has(key)) {
				presentKeys++;
				continue;
			}

			if (langKeys.has(key)) {
				presentKeys++;
			} else {
				issues.push({
					type: 'missing',
					namespace: ns,
					key,
					detail: `Missing translation for "${key}"`,
				});
			}
		}

		// Orphaned non-plural keys
		for (const key of langKeys.keys()) {
			if (langPluralKeySet.has(key)) continue;
			if (!enKeys.has(key)) {
				issues.push({
					type: 'orphaned',
					namespace: ns,
					key,
					detail: `Orphaned key "${key}" — exists in ${lang} but not in English`,
				});
			}
		}

		// ── 2. Pluralization completeness ────────────────────────────
		for (const [stem, info] of enPluralStems) {
			totalEnglishKeys++; // count each plural stem as one logical key

			const requiredForms = REQUIRED_PLURAL_FORMS[lang];
			const presentForms: string[] = [];
			const missingForms: string[] = [];

			// For v3-style stems, language can use EITHER v3 or v4 (CLDR) style
			const hasV3 = langKeys.has(stem) && langKeys.has(`${stem}_plural`);
			const hasCLDR = requiredForms.some((form) => langKeys.has(`${stem}_${form}`));

			if (info.style === 'v3' && hasV3 && !hasCLDR) {
				// Language uses v3 style — that's fine
				presentKeys++;
			} else {
				// Check CLDR forms
				for (const form of requiredForms) {
					const pluralKey = `${stem}_${form}`;
					if (langKeys.has(pluralKey)) {
						presentForms.push(form);
					} else {
						missingForms.push(form);
					}
				}

				if (presentForms.length > 0) {
					presentKeys++;
				}

				if (missingForms.length > 0) {
					issues.push({
						type: 'plural',
						namespace: ns,
						key: `${stem}_*`,
						detail: `Missing plural form(s): ${missingForms.map((f) => `_${f}`).join(', ')} (has: ${presentForms.map((f) => `_${f}`).join(', ') || 'none'})`,
					});
				}
			}
		}

		// Orphaned plural stems (exist in language but not English)
		for (const [stem, forms] of langOnlyPluralStems) {
			if (forms.size >= 2) {
				// Skip language-expanded plurals (valid CLDR expansion of English base key)
				if (langExpandedStems.has(stem)) continue;

				const orphanedKeys = [...langKeys.keys()]
					.filter((k) => {
						const seg = lastSegment(k);
						return ALL_PLURAL_SUFFIXES.some(
							(s) => seg.endsWith(s) && k.slice(0, k.length - s.length) === stem
						);
					})
					.join(', ');
				issues.push({
					type: 'orphaned',
					namespace: ns,
					key: `${stem}_*`,
					detail: `Orphaned plural stem "${stem}" — exists in ${lang} but not in English (keys: ${orphanedKeys})`,
				});
			}
		}

		// ── 3. Interpolation variable checks ────────────────────────
		for (const [key, enValue] of enKeys) {
			if (enPluralKeySet.has(key)) continue; // handled below

			const langValue = langKeys.get(key);
			if (!langValue) continue;

			const enVars = extractInterpolationVars(enValue);
			const langVars = extractInterpolationVars(langValue);

			if (enVars.size === 0 && langVars.size === 0) continue;

			for (const v of enVars) {
				if (!langVars.has(v)) {
					issues.push({
						type: 'interpolation',
						namespace: ns,
						key,
						detail: `Missing interpolation variable "{{${v}}}" in ${lang} translation`,
					});
				}
			}

			for (const v of langVars) {
				if (!enVars.has(v)) {
					issues.push({
						type: 'interpolation',
						namespace: ns,
						key,
						detail: `Extra interpolation variable "{{${v}}}" in ${lang} — not in English source`,
					});
				}
			}
		}

		// Interpolation checks for plural keys
		for (const [stem, info] of enPluralStems) {
			// Get reference interpolation vars from any English form
			let enVars = new Set<string>();
			if (info.style === 'v3') {
				const baseVal = enKeys.get(stem);
				if (baseVal) enVars = extractInterpolationVars(baseVal);
			} else {
				for (const suffix of CLDR_SUFFIXES) {
					const val = enKeys.get(`${stem}${suffix}`);
					if (val) {
						enVars = extractInterpolationVars(val);
						break;
					}
				}
			}

			if (enVars.size === 0) continue;

			// Check all language plural forms
			const keysToCheck = [
				...CLDR_SUFFIXES.map((s) => ({ key: `${stem}${s}`, form: s.slice(1) })),
				{ key: stem, form: 'base' },
				{ key: `${stem}_plural`, form: 'plural' },
			];

			for (const { key, form } of keysToCheck) {
				const langValue = langKeys.get(key);
				if (!langValue) continue;

				const langVars = extractInterpolationVars(langValue);

				for (const v of enVars) {
					if (!langVars.has(v)) {
						// Skip count-like variables for _zero, _one, _two forms
						// where the quantity is expressed as a word (e.g. Arabic)
						if (COUNT_LIKE_VARS.has(v) && IMPLICIT_COUNT_FORMS.has(form)) continue;

						issues.push({
							type: 'interpolation',
							namespace: ns,
							key,
							detail: `Missing interpolation variable "{{${v}}}" in ${lang} plural form (_${form})`,
						});
					}
				}
			}
		}
	}

	const completionPercent =
		totalEnglishKeys > 0 ? Math.round((presentKeys / totalEnglishKeys) * 1000) / 10 : 100;

	return {
		language: lang,
		totalEnglishKeys,
		presentKeys,
		completionPercent,
		issues,
		syntaxErrors,
	};
}

// ── Output formatting ──────────────────────────────────────────────────────

function printReport(reports: LanguageReport[]): void {
	let totalIssues = 0;

	console.log('\n\x1b[1m══════════════════════════════════════════════\x1b[0m');
	console.log('\x1b[1m  i18n Translation Validation Report\x1b[0m');
	console.log('\x1b[1m══════════════════════════════════════════════\x1b[0m\n');

	// Summary table
	console.log('\x1b[1m── Completion Summary ──\x1b[0m\n');
	for (const report of reports) {
		const bar = makeProgressBar(report.completionPercent);
		const color =
			report.completionPercent === 100
				? '\x1b[32m'
				: report.completionPercent >= 90
					? '\x1b[33m'
					: '\x1b[31m';
		const issueCount = report.issues.length + report.syntaxErrors.length;
		totalIssues += issueCount;
		const issueStr =
			issueCount > 0 ? `  \x1b[31m${issueCount} issue(s)\x1b[0m` : '  \x1b[32m\u2713\x1b[0m';
		console.log(
			`  ${report.language.padEnd(4)} ${bar} ${color}${report.completionPercent.toFixed(1)}%\x1b[0m  (${report.presentKeys}/${report.totalEnglishKeys})${issueStr}`
		);
	}

	// Per-language details
	for (const report of reports) {
		if (report.issues.length === 0 && report.syntaxErrors.length === 0) continue;

		console.log(`\n\x1b[1m\u2500\u2500 ${report.language} \u2500\u2500\x1b[0m`);

		for (const err of report.syntaxErrors) {
			console.log(`  \x1b[31m[SYNTAX]\x1b[0m ${err}`);
		}

		// Group issues by type
		const byType = new Map<string, Issue[]>();
		for (const issue of report.issues) {
			const list = byType.get(issue.type) || [];
			list.push(issue);
			byType.set(issue.type, list);
		}

		for (const [type, typeIssues] of byType) {
			const label = type.toUpperCase();
			const color =
				type === 'missing'
					? '\x1b[31m'
					: type === 'orphaned'
						? '\x1b[33m'
						: type === 'interpolation'
							? '\x1b[35m'
							: type === 'plural'
								? '\x1b[36m'
								: '\x1b[31m';
			for (const issue of typeIssues) {
				console.log(
					`  ${color}[${label}]\x1b[0m \x1b[2m${issue.namespace}:\x1b[0m ${issue.detail}`
				);
			}
		}
	}

	// Final summary
	console.log(
		`\n\x1b[1m\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\x1b[0m`
	);
	if (totalIssues === 0) {
		console.log('\x1b[32m\u2713 All translations valid!\x1b[0m\n');
	} else {
		console.log(
			`\x1b[31m\u2717 ${totalIssues} total issue(s) found across all languages.\x1b[0m\n`
		);
	}
}

function makeProgressBar(percent: number): string {
	const width = 20;
	const filled = Math.round((percent / 100) * width);
	const empty = width - filled;
	return '[' + '\u2588'.repeat(filled) + '\u2591'.repeat(empty) + ']';
}

// ── Main ───────────────────────────────────────────────────────────────────

function main(): void {
	const args = process.argv.slice(2);
	const jsonMode = args.includes('--json');

	// Load English as source of truth
	const englishData = new Map<string, Map<string, string>>();
	for (const ns of NAMESPACES) {
		const { data, syntaxError } = loadNamespace('en', ns);
		if (syntaxError) {
			console.error(`\x1b[31mFATAL: ${syntaxError}\x1b[0m`);
			process.exit(1);
		}
		englishData.set(ns, data);
	}

	// Validate each non-English language
	const reports: LanguageReport[] = [];
	for (const lang of LANGUAGES) {
		if (lang === 'en') continue;
		reports.push(validateLanguage(lang, englishData));
	}

	if (jsonMode) {
		console.log(JSON.stringify({ reports }, null, 2));
	} else {
		printReport(reports);
	}

	// Exit with error code if issues found
	const totalIssues = reports.reduce((sum, r) => sum + r.issues.length + r.syntaxErrors.length, 0);
	if (totalIssues > 0) {
		process.exit(1);
	}
}

// Run main() only when executed directly
const isDirectRun =
	process.argv[1]?.endsWith('i18n-validate.ts') || process.argv[1]?.includes('i18n-validate');
if (isDirectRun) {
	main();
}

export {
	flattenKeys,
	extractInterpolationVars,
	detectPluralStems,
	validateLanguage,
	loadNamespace,
};
