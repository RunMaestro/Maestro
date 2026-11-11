import { describe, it, expect } from 'vitest';
import { EditorState, type Extension } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { classHighlighter, highlightTree } from '@lezer/highlight';
import {
	fenceLanguage,
	loadLanguageExtension,
	hasLanguageSupport,
} from '../../../../../renderer/components/FilePreview/giantPreview/languageLoader';

describe('hasLanguageSupport', () => {
	it('returns true for markdown variants', () => {
		expect(hasLanguageSupport('markdown')).toBe(true);
		expect(hasLanguageSupport('md')).toBe(true);
		expect(hasLanguageSupport('mdx')).toBe(true);
	});

	it('returns true for javascript / typescript family', () => {
		expect(hasLanguageSupport('javascript')).toBe(true);
		expect(hasLanguageSupport('js')).toBe(true);
		expect(hasLanguageSupport('jsx')).toBe(true);
		expect(hasLanguageSupport('typescript')).toBe(true);
		expect(hasLanguageSupport('ts')).toBe(true);
		expect(hasLanguageSupport('tsx')).toBe(true);
	});

	it('returns true for python / json / yaml', () => {
		expect(hasLanguageSupport('python')).toBe(true);
		expect(hasLanguageSupport('py')).toBe(true);
		expect(hasLanguageSupport('json')).toBe(true);
		expect(hasLanguageSupport('jsonl')).toBe(true);
		expect(hasLanguageSupport('yaml')).toBe(true);
		expect(hasLanguageSupport('yml')).toBe(true);
	});

	it('returns true for compiled-language packs', () => {
		expect(hasLanguageSupport('go')).toBe(true);
		expect(hasLanguageSupport('rust')).toBe(true);
		expect(hasLanguageSupport('java')).toBe(true);
		expect(hasLanguageSupport('cpp')).toBe(true);
		expect(hasLanguageSupport('c')).toBe(true);
		expect(hasLanguageSupport('php')).toBe(true);
	});

	it('returns true for web / data / query grammars', () => {
		expect(hasLanguageSupport('html')).toBe(true);
		expect(hasLanguageSupport('css')).toBe(true);
		expect(hasLanguageSupport('scss')).toBe(true);
		expect(hasLanguageSupport('sql')).toBe(true);
		expect(hasLanguageSupport('xml')).toBe(true);
	});

	it('returns true for legacy-mode grammars', () => {
		expect(hasLanguageSupport('ruby')).toBe(true);
		expect(hasLanguageSupport('bash')).toBe(true);
		expect(hasLanguageSupport('sh')).toBe(true);
		expect(hasLanguageSupport('toml')).toBe(true);
		expect(hasLanguageSupport('csharp')).toBe(true);
	});

	it('is case-insensitive', () => {
		expect(hasLanguageSupport('MARKDOWN')).toBe(true);
		expect(hasLanguageSupport('Python')).toBe(true);
		expect(hasLanguageSupport('Rust')).toBe(true);
	});

	it('returns false for plain text', () => {
		expect(hasLanguageSupport('text')).toBe(false);
	});

	it('returns false for languages we have not packaged', () => {
		expect(hasLanguageSupport('cobol')).toBe(false);
		expect(hasLanguageSupport('fortran')).toBe(false);
	});

	it('returns false for unknown identifiers', () => {
		expect(hasLanguageSupport('')).toBe(false);
		expect(hasLanguageSupport('whatever')).toBe(false);
	});
});

describe('loadLanguageExtension', () => {
	// These tests dynamically import the real `@codemirror/lang-*` packages so
	// they validate the wiring end-to-end. Each loader returns a CM6 Extension
	// object (truthy); we don't assert on its internal shape.

	it('loads markdown extension for markdown / md / mdx', async () => {
		expect(await loadLanguageExtension('markdown')).toBeTruthy();
		expect(await loadLanguageExtension('md')).toBeTruthy();
		expect(await loadLanguageExtension('mdx')).toBeTruthy();
	});

	it('loads javascript extension for js variants', async () => {
		expect(await loadLanguageExtension('javascript')).toBeTruthy();
		expect(await loadLanguageExtension('jsx')).toBeTruthy();
	});

	it('loads typescript variant of the javascript extension', async () => {
		expect(await loadLanguageExtension('typescript')).toBeTruthy();
		expect(await loadLanguageExtension('tsx')).toBeTruthy();
	});

	it('loads python extension', async () => {
		expect(await loadLanguageExtension('python')).toBeTruthy();
		expect(await loadLanguageExtension('py')).toBeTruthy();
	});

	it('loads json extension for json / jsonl / ndjson', async () => {
		expect(await loadLanguageExtension('json')).toBeTruthy();
		expect(await loadLanguageExtension('jsonl')).toBeTruthy();
		expect(await loadLanguageExtension('ndjson')).toBeTruthy();
	});

	it('loads yaml extension', async () => {
		expect(await loadLanguageExtension('yaml')).toBeTruthy();
		expect(await loadLanguageExtension('yml')).toBeTruthy();
	});

	it('loads dedicated Lezer packs for compiled languages', async () => {
		expect(await loadLanguageExtension('go')).toBeTruthy();
		expect(await loadLanguageExtension('rust')).toBeTruthy();
		expect(await loadLanguageExtension('java')).toBeTruthy();
		expect(await loadLanguageExtension('cpp')).toBeTruthy();
		expect(await loadLanguageExtension('c')).toBeTruthy();
		expect(await loadLanguageExtension('php')).toBeTruthy();
	});

	it('loads web / data / query grammars', async () => {
		expect(await loadLanguageExtension('html')).toBeTruthy();
		expect(await loadLanguageExtension('css')).toBeTruthy();
		expect(await loadLanguageExtension('sql')).toBeTruthy();
		expect(await loadLanguageExtension('xml')).toBeTruthy();
	});

	it('loads legacy-mode grammars via StreamLanguage', async () => {
		expect(await loadLanguageExtension('ruby')).toBeTruthy();
		expect(await loadLanguageExtension('bash')).toBeTruthy();
		expect(await loadLanguageExtension('sh')).toBeTruthy();
		expect(await loadLanguageExtension('toml')).toBeTruthy();
		expect(await loadLanguageExtension('scss')).toBeTruthy();
		expect(await loadLanguageExtension('csharp')).toBeTruthy();
	});

	it('returns null for plain text', async () => {
		expect(await loadLanguageExtension('text')).toBeNull();
	});

	it('returns null for unsupported languages', async () => {
		expect(await loadLanguageExtension('cobol')).toBeNull();
		expect(await loadLanguageExtension('')).toBeNull();
	});

	it('is case-insensitive', async () => {
		expect(await loadLanguageExtension('PYTHON')).toBeTruthy();
		expect(await loadLanguageExtension('Markdown')).toBeTruthy();
	});
});

describe('fenceLanguage', () => {
	it('resolves a fence tag through the same aliases a file name uses', () => {
		expect(fenceLanguage('ts')?.name).toBe('typescript');
		expect(fenceLanguage('zsh')?.name).toBe('shell');
		expect(fenceLanguage('dataview')?.name).toBe('dataview');
		expect(fenceLanguage('dataviewjs')?.name).toBe('javascript');
		expect(fenceLanguage(' Python ')?.name).toBe('python');
	});

	it('returns null for a tag with no grammar, so the fence stays plain text', () => {
		expect(fenceLanguage('cobol')).toBeNull();
		expect(fenceLanguage('')).toBeNull();
	});

	it('hands out one description per language, so a grammar loads once', () => {
		expect(fenceLanguage('js')).toBe(fenceLanguage('javascript'));
		expect(fenceLanguage('dataviewjs')).toBe(fenceLanguage('js'));
	});

	it('colors the code inside markdown fences, including dataview and dataviewjs', async () => {
		const doc = [
			'# Note',
			'',
			'```dataview',
			'TABLE file.cday AS Created',
			'FROM #meeting or "meetings"',
			'LIMIT 25',
			'```',
			'',
			'```dataviewjs',
			'const p = dv.pages("#x");',
			'```',
			'',
			'```ts',
			'const n: number = 1;',
			'```',
			'',
		].join('\n');
		// The editor loads a fence's grammar on demand and reparses; load them up front to parse once.
		for (const tag of ['dataview', 'dataviewjs', 'ts']) await fenceLanguage(tag)!.load();
		const markdown = (await loadLanguageExtension('markdown')) as Extension;
		const state = EditorState.create({ doc, extensions: [markdown] });
		const tree = ensureSyntaxTree(state, doc.length, 5000)!;
		const tokens: string[] = [];
		highlightTree(tree, classHighlighter, (from, to, classes) => {
			tokens.push(`${classes.replace(/tok-/g, '')}:${doc.slice(from, to)}`);
		});

		// DQL, from the shared Dataview token rules.
		expect(tokens).toContain('keyword:TABLE');
		expect(tokens).toContain('keyword:LIMIT');
		expect(tokens).toContain('string:"meetings"');
		expect(tokens).toContain('number:25');
		// dataviewjs and ts, from their JavaScript grammars.
		expect(tokens).toContain('propertyName:pages');
		expect(tokens).toContain('typeName:number');
	});
});
