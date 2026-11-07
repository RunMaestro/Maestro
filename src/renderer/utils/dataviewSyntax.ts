/**
 * Dataview fence highlighting for the two markdown highlighters: Prism (the document preview) and Shiki (chat
 * and the File Preview Fast tier). Both are built from `DQL_TOKEN_RULES` (`src/shared/dataview/syntax.ts`),
 * so a `dataview` fence colors the same tokens on every surface. A `dataviewjs` fence is JavaScript on both.
 *
 * Prism: `registerDataviewPrismLanguages()` registers the grammar on the `refractor/all` instance that
 * react-syntax-highlighter's full Prism build highlights with; `PrismCodeBlock` calls it once at load.
 * Shiki: `DATAVIEW_SHIKI_GRAMMAR` is loaded on demand by `ensureLanguage()` in `utils/shiki/highlighterManager.ts`.
 */

import type { LanguageRegistration } from 'shiki';
import type { Refractor, Syntax } from 'refractor/core';
import {
	DATAVIEW_JS_LANGUAGE_IDS,
	DATAVIEW_LANGUAGE_ID,
	DQL_TOKEN_RULES,
} from '../../shared/dataview/syntax';

/** The Prism grammar object for DQL: one token per rule, in match order. */
export function buildDqlPrismGrammar(): Record<string, { pattern: RegExp; greedy?: boolean }> {
	const grammar: Record<string, { pattern: RegExp; greedy?: boolean }> = {};
	for (const rule of DQL_TOKEN_RULES) {
		// `m` so the comment rule's `^` anchors at each line; `greedy` keeps a `//` or `#` inside a string
		// from being re-tokenized as a comment or a tag.
		const greedy = rule.token === 'string' || rule.token === 'comment' || rule.token === 'url';
		grammar[rule.token] = {
			pattern: new RegExp(rule.pattern, rule.caseInsensitive ? 'im' : 'm'),
			...(greedy ? { greedy: true } : {}),
		};
	}
	return grammar;
}

const dataviewSyntax: Syntax = Object.assign(
	(prism: Refractor) => {
		(prism.languages as Record<string, unknown>)[DATAVIEW_LANGUAGE_ID] = buildDqlPrismGrammar();
	},
	{ displayName: DATAVIEW_LANGUAGE_ID, aliases: [] as string[] }
);

/** Register `dataview` and the `dataviewjs` alias on a refractor instance. Safe to call more than once. */
export function registerDataviewPrismLanguages(refractor: Refractor): void {
	if (!refractor.registered(DATAVIEW_LANGUAGE_ID)) refractor.register(dataviewSyntax);
	refractor.alias({ javascript: [...DATAVIEW_JS_LANGUAGE_IDS] });
}

/** The TextMate grammar Shiki loads for a `dataview` fence. */
export const DATAVIEW_SHIKI_GRAMMAR: LanguageRegistration = {
	name: DATAVIEW_LANGUAGE_ID,
	scopeName: `source.${DATAVIEW_LANGUAGE_ID}`,
	patterns: DQL_TOKEN_RULES.map((rule) => ({
		name: `${rule.scope}.${DATAVIEW_LANGUAGE_ID}`,
		match: `${rule.caseInsensitive ? '(?i)' : ''}${rule.pattern}`,
	})),
	repository: {},
};
