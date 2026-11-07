import { describe, it, expect, vi } from 'vitest';
import { refractor } from 'refractor/all';
import type { Element, RootContent } from 'hast';
import {
	DATAVIEW_SHIKI_GRAMMAR,
	buildDqlPrismGrammar,
	registerDataviewPrismLanguages,
} from '../../../renderer/utils/dataviewSyntax';
import {
	CUSTOM_LANGUAGES,
	ensureLanguage,
	resolveLanguage,
	resolveLanguageSync,
} from '../../../renderer/utils/shiki/highlighterManager';
import { DQL_TOKEN_RULES } from '../../../shared/dataview/syntax';

const MEETINGS = `// meetings that mention me
TABLE file.cday as Created, Summary
FROM #meeting or "meetings"
WHERE contains(file.outlinks, this.file.link) AND x != null
SORT file.cday DESC
LIMIT 25`;

/** Every Prism token in a highlight tree as `type:text`, in document order. */
function tokens(nodes: RootContent[]): string[] {
	return nodes.flatMap((node) => {
		if (node.type !== 'element') return [];
		const element = node as Element;
		const classes = (element.properties.className as string[]).filter((c) => c !== 'token');
		const text = element.children.map((child) => ('value' in child ? child.value : '')).join('');
		return [`${classes.join('.')}:${text}`, ...tokens(element.children)];
	});
}

describe('DQL token rules', () => {
	it('compile as JavaScript regular expressions', () => {
		for (const rule of DQL_TOKEN_RULES) {
			expect(() => new RegExp(rule.pattern, 'm'), rule.token).not.toThrow();
		}
	});
});

describe('Prism', () => {
	registerDataviewPrismLanguages(refractor);

	it('registers dataview once, however often it is asked', () => {
		expect(() => registerDataviewPrismLanguages(refractor)).not.toThrow();
		expect(refractor.registered('dataview')).toBe(true);
	});

	it('colors the tokens of a DQL query', () => {
		const found = tokens(refractor.highlight(MEETINGS, 'dataview').children);
		expect(found).toEqual([
			'comment:// meetings that mention me',
			'keyword:TABLE',
			'keyword:as',
			'punctuation:,',
			'keyword:FROM',
			'tag:#meeting',
			'keyword:or',
			'string:"meetings"',
			'keyword:WHERE',
			'function:contains',
			'punctuation:(',
			'punctuation:,',
			'punctuation:)',
			'keyword:AND',
			'operator:!=',
			'boolean:null',
			'keyword:SORT',
			'keyword:DESC',
			'keyword:LIMIT',
			'number:25',
		]);
	});

	it('reads a link, an embed, and a function named like a query type', () => {
		const found = tokens(
			refractor.highlight('LIST FROM [[People]] WHERE list(1) AND !embed = ![[Note]]', 'dataview')
				.children
		);
		expect(found).toContain('url:[[People]]');
		expect(found).toContain('url:![[Note]]');
		expect(found).toContain('function:list');
		expect(found).toContain('keyword:LIST');
	});

	it('keeps a tag or comment marker inside a string part of the string', () => {
		const found = tokens(
			refractor.highlight('WHERE name = "#not // a comment"', 'dataview').children
		);
		expect(found).toContain('string:"#not // a comment"');
		expect(found.some((token) => token.startsWith('tag:') || token.startsWith('comment:'))).toBe(
			false
		);
	});

	it('highlights a dataviewjs fence as JavaScript', () => {
		expect(refractor.registered('dataviewjs')).toBe(true);
		const found = tokens(
			refractor.highlight('const pages = dv.pages("#meeting");', 'dataviewjs').children
		);
		expect(found).toContain('keyword:const');
		expect(found).toContain('string:"#meeting"');
	});

	it('builds one case-insensitive keyword rule', () => {
		const grammar = buildDqlPrismGrammar();
		expect(grammar.keyword.pattern.flags).toContain('i');
		expect(grammar.keyword.pattern.test('table')).toBe(true);
		expect(grammar.number.pattern.flags).not.toContain('i');
	});
});

describe('Shiki', () => {
	it('builds a TextMate grammar with one pattern per rule, in order', () => {
		expect(DATAVIEW_SHIKI_GRAMMAR.name).toBe('dataview');
		expect(DATAVIEW_SHIKI_GRAMMAR.scopeName).toBe('source.dataview');
		const patterns = DATAVIEW_SHIKI_GRAMMAR.patterns as Array<{ name: string; match: string }>;
		expect(patterns).toHaveLength(DQL_TOKEN_RULES.length);
		expect(patterns[0].name).toBe('comment.line.double-slash.dataview');
		const keyword = patterns.find((pattern) => pattern.name === 'keyword.control.dataview');
		expect(keyword?.match.startsWith('(?i)')).toBe(true);
	});

	it('resolves dataview to its own grammar and dataviewjs to javascript without loading Shiki', async () => {
		expect(resolveLanguageSync('dataview')).toBe('dataview');
		expect(resolveLanguageSync('DataView')).toBe('dataview');
		expect(resolveLanguageSync('dataviewjs')).toBe('javascript');
		await expect(resolveLanguage('dataview')).resolves.toBe('dataview');
		expect(CUSTOM_LANGUAGES.dataview).toBe(DATAVIEW_SHIKI_GRAMMAR);
	});

	it('loads the dataview grammar object on first use and reuses it after', async () => {
		const loaded: string[] = [];
		const highlighter = {
			getLoadedLanguages: () => loaded,
			loadLanguage: vi.fn(async (grammar: { name: string }) => {
				loaded.push(grammar.name);
			}),
		};
		type Highlighter = Parameters<typeof ensureLanguage>[0];
		await expect(ensureLanguage(highlighter as unknown as Highlighter, 'dataview')).resolves.toBe(
			'dataview'
		);
		expect(highlighter.loadLanguage).toHaveBeenCalledWith(DATAVIEW_SHIKI_GRAMMAR);
		await ensureLanguage(highlighter as unknown as Highlighter, 'dataview');
		expect(highlighter.loadLanguage).toHaveBeenCalledTimes(1);
	});
});
