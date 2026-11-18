/**
 * Syntax highlighting rules for Dataview fences: the token rules of DQL (`dataview`) and the fence tags that
 * are JavaScript (`dataviewjs`).
 *
 * The rules are engine-neutral so the two highlighters that draw markdown fences agree on what a token is:
 * Prism (the document preview, `PrismCodeBlock`) and Shiki (chat and the File Preview Fast tier). The
 * renderer adapts them in `src/renderer/utils/dataviewSyntax.ts`. Every `pattern` must stay valid in BOTH
 * a JavaScript RegExp and Oniguruma (Shiki's TextMate engine): no lookbehind, no named groups, no `u` flag
 * escapes such as `\p{...}`.
 *
 * The tokens follow the vendored parsers (`vendor/query/parse.ts`, `vendor/expression/parse.ts`): keywords
 * are case-insensitive, a comment is a line starting with `//`, a string is double-quoted with backslash
 * escapes, a link is `[[...]]` (optionally embedded with `!`), and a tag is `#` plus anything but a delimiter.
 * Highlighting is a reading aid, not a parser: a field named like a keyword (`list`, `desc`) is colored as one.
 */

/** The fence tag of a DQL block. */
export const DATAVIEW_LANGUAGE_ID = 'dataview';

/** Fence tags whose body is JavaScript, highlighted with the JavaScript grammar. */
export const DATAVIEW_JS_LANGUAGE_IDS = ['dataviewjs'] as const;

/** Prism token names DQL uses; each maps to the TextMate scope in `scope`. */
export type DqlTokenName =
	| 'comment'
	| 'string'
	| 'url'
	| 'tag'
	| 'function'
	| 'keyword'
	| 'boolean'
	| 'number'
	| 'operator'
	| 'punctuation';

export interface DqlTokenRule {
	token: DqlTokenName;
	/** TextMate scope, without the `.dataview` suffix the grammar appends. */
	scope: string;
	/** Regex source, valid in JavaScript and in Oniguruma. */
	pattern: string;
	caseInsensitive?: boolean;
}

/** DQL keywords: query types, clauses, sort directions, and the word operators. Longest first. */
export const DQL_KEYWORDS = [
	'WITHOUT\\s+ID',
	'GROUP\\s+BY',
	'CALENDAR',
	'TABLE',
	'LIST',
	'TASK',
	'FROM',
	'WHERE',
	'SORT',
	'FLATTEN',
	'LIMIT',
	'ASCENDING',
	'DESCENDING',
	'ASC',
	'DESC',
	'AND',
	'OR',
	'AS',
] as const;

/**
 * The rules in match order: earlier rules win where two could match. Functions come before keywords so
 * `list(...)` reads as Dataview's `list()` function rather than the `LIST` query type.
 */
export const DQL_TOKEN_RULES: readonly DqlTokenRule[] = [
	{ token: 'comment', scope: 'comment.line.double-slash', pattern: '^[ \\t]*//.*' },
	{ token: 'string', scope: 'string.quoted.double', pattern: '"(?:[^"\\\\]|\\\\.)*"' },
	{ token: 'url', scope: 'markup.underline.link', pattern: '!?\\[\\[[^\\[\\]]*\\]\\]' },
	{ token: 'tag', scope: 'entity.name.tag', pattern: '#[^\\s"\'#()\\[\\],;!&|=<>]+' },
	{ token: 'function', scope: 'entity.name.function', pattern: '\\b[A-Za-z_][\\w-]*(?=\\s*\\()' },
	{
		token: 'keyword',
		scope: 'keyword.control',
		pattern: `\\b(?:${DQL_KEYWORDS.join('|')})\\b`,
		caseInsensitive: true,
	},
	{
		token: 'boolean',
		scope: 'constant.language',
		pattern: '\\b(?:true|false|null)\\b',
		caseInsensitive: true,
	},
	{ token: 'number', scope: 'constant.numeric', pattern: '\\b\\d+(?:\\.\\d+)?\\b' },
	{ token: 'operator', scope: 'keyword.operator', pattern: '>=|<=|!=|[=<>+\\-*/%&|!]' },
	{ token: 'punctuation', scope: 'punctuation.separator', pattern: '[(),]' },
];
