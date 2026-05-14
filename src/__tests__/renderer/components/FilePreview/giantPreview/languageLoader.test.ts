import { describe, it, expect } from 'vitest';
import {
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

	it('is case-insensitive', () => {
		expect(hasLanguageSupport('MARKDOWN')).toBe(true);
		expect(hasLanguageSupport('Python')).toBe(true);
	});

	it('returns false for plain text', () => {
		expect(hasLanguageSupport('text')).toBe(false);
	});

	it('returns false for languages we have not packaged', () => {
		expect(hasLanguageSupport('rust')).toBe(false);
		expect(hasLanguageSupport('go')).toBe(false);
		expect(hasLanguageSupport('cobol')).toBe(false);
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
