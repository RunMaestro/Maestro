/**
 * Dataview fence highlighting for the three highlighters that draw markdown fences: Prism (the document
 * preview), Shiki (chat and the File Preview Fast tier), and CodeMirror (the markdown editor). All three are
 * built from `DQL_TOKEN_RULES` (`src/shared/dataview/syntax.ts`), so a `dataview` fence colors the same tokens
 * on every surface. A `dataviewjs` fence is JavaScript on all three.
 *
 * Prism: `registerDataviewPrismLanguages()` registers the grammar on the `refractor/all` instance that
 * react-syntax-highlighter's full Prism build highlights with; `PrismCodeBlock` calls it once at load.
 * Shiki: `DATAVIEW_SHIKI_GRAMMAR` is loaded on demand by `ensureLanguage()` in `utils/shiki/highlighterManager.ts`.
 * CodeMirror: `DQL_STREAM_PARSER` becomes a `StreamLanguage` in `FilePreview/giantPreview/languageLoader.ts`,
 * which hands it to the markdown language as the grammar of `dataview` fences.
 */

import type { LanguageRegistration } from 'shiki';
import type { Refractor, Syntax } from 'refractor/core';
import type { StreamParser } from '@codemirror/language';
import {
	DATAVIEW_JS_LANGUAGE_IDS,
	DATAVIEW_LANGUAGE_ID,
	DQL_TOKEN_RULES,
	type DqlTokenName,
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

/** DQL token name to the `@lezer/highlight` tag a CodeMirror `StreamLanguage` resolves it to. */
const DQL_CODEMIRROR_TAGS: Record<DqlTokenName, string> = {
	comment: 'comment',
	string: 'string',
	url: 'link',
	tag: 'tagName',
	function: 'variableName.function',
	keyword: 'keyword',
	boolean: 'bool',
	number: 'number',
	operator: 'operator',
	punctuation: 'punctuation',
};

interface DqlStreamRule {
	style: string;
	/** Sticky, so a rule matches only at the stream's position. */
	pattern: RegExp;
	/** The comment rule: only where nothing but whitespace precedes it on the line. */
	lineStartOnly: boolean;
}

const DQL_STREAM_RULES: DqlStreamRule[] = DQL_TOKEN_RULES.map((rule) => {
	const lineStartOnly = rule.token === 'comment';
	// A stream reads from its own position, so the comment rule drops its `^[ \t]*` and checks the line instead.
	const source = lineStartOnly ? rule.pattern.replace(/^\^\[ \\t\]\*/, '') : rule.pattern;
	return {
		style: DQL_CODEMIRROR_TAGS[rule.token],
		pattern: new RegExp(source, rule.caseInsensitive ? 'iy' : 'y'),
		lineStartOnly,
	};
});

/** The CodeMirror stream parser for DQL, one token per rule in match order. */
export const DQL_STREAM_PARSER: StreamParser<null> = {
	name: DATAVIEW_LANGUAGE_ID,
	token(stream) {
		if (stream.eatSpace()) return null;
		const line = stream.string;
		const start = stream.pos;
		for (const rule of DQL_STREAM_RULES) {
			if (rule.lineStartOnly && line.slice(0, start).trim() !== '') continue;
			rule.pattern.lastIndex = start;
			const match = rule.pattern.exec(line);
			if (match && match[0].length > 0) {
				stream.pos = start + match[0].length;
				return rule.style;
			}
		}
		// A plain field name (`file.cday`, `Summary`): take the whole word, so no rule can match inside it.
		if (!stream.match(/^[\w-]+/)) stream.next();
		return null;
	},
};
