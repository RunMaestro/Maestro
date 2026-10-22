/**
 * Tests for M3, the Obsidian link resolver (src/shared/dataview/resolve.ts), reached through the one
 * import site, src/shared/dataview/index.ts. The rule table is in docs/agent-guides/DATAVIEW.md.
 */

import { describe, expect, it } from 'vitest';
import { createLinkResolver, linkPathKey, linkTargetKeys } from '../../../shared/dataview';

const VAULT = [
	'Note.md',
	'Folder/Note.md',
	'Folder/Deep/Note.md',
	'Other/Unique.md',
	'People/Pedram Amini.md',
	'Projects/Alpha/Design/Spec.md',
	'views/sample/view.js',
	'data/people.csv',
	'Docs/Report.pdf',
];

const resolver = createLinkResolver(VAULT);
const resolve = (link: string, source = 'Inbox/Source.md') => resolver.resolve(link, source);

describe('createLinkResolver', () => {
	it('resolves a unique name anywhere in the vault, with or without .md', () => {
		expect(resolve('Unique')).toBe('Other/Unique.md');
		expect(resolve('Unique.md')).toBe('Other/Unique.md');
		expect(resolve('Pedram Amini')).toBe('People/Pedram Amini.md');
	});

	it('picks the shortest path for a duplicate name, but the source folder first', () => {
		expect(resolve('Note')).toBe('Note.md');
		expect(resolve('Note', 'Folder/Deep/Source.md')).toBe('Folder/Deep/Note.md');
		expect(resolve('Note', 'Folder/Source.md')).toBe('Folder/Note.md');
	});

	it('resolves folder-qualified links by exact path, then source-relative, then a folder-bounded suffix', () => {
		expect(resolve('Folder/Note')).toBe('Folder/Note.md');
		expect(resolve('Deep/Note', 'Folder/Source.md')).toBe('Folder/Deep/Note.md');
		expect(resolve('Design/Spec')).toBe('Projects/Alpha/Design/Spec.md');
		expect(resolve('sign/Spec')).toBeNull();
	});

	it('resolves ./ and ../ against the source folder', () => {
		expect(resolve('./Note', 'Folder/Source.md')).toBe('Folder/Note.md');
		expect(resolve('../Note', 'Folder/Deep/Source.md')).toBe('Folder/Note.md');
		expect(resolve('../../../Note', 'Folder/Source.md')).toBeNull();
		expect(resolve('./Unique', 'Folder/Source.md')).toBeNull();
	});

	it('treats a leading slash as the vault root', () => {
		expect(resolve('/Folder/Deep/Note')).toBe('Folder/Deep/Note.md');
	});

	it('matches case-insensitively and prefers an exact-case match', () => {
		expect(resolve('pedram amini')).toBe('People/Pedram Amini.md');
		const mixed = createLinkResolver(['a/topic.md', 'b/Topic.md']);
		expect(mixed.resolve('Topic', 'x.md')).toBe('b/Topic.md');
		expect(mixed.resolve('topic', 'x.md')).toBe('a/topic.md');
	});

	it('resolves non-markdown files only with their extension', () => {
		expect(resolve('views/sample/view.js')).toBe('views/sample/view.js');
		expect(resolve('people.csv')).toBe('data/people.csv');
		expect(resolve('Report.pdf')).toBe('Docs/Report.pdf');
		expect(resolve('Report')).toBeNull();
		expect(resolve('view')).toBeNull();
	});

	it('returns the source itself for a self link with an empty path', () => {
		expect(resolve('', 'Folder/Source.md')).toBe('Folder/Source.md');
	});

	it('returns null for a link that matches nothing', () => {
		expect(resolve('Missing Note')).toBeNull();
		expect(createLinkResolver([]).resolve('Note', 'x.md')).toBeNull();
	});
});

describe('linkTargetKeys and linkPathKey', () => {
	it('key a file by its last segment, with and without .md for a markdown file', () => {
		expect(linkTargetKeys('Folder/Deep/Note.md')).toEqual(['note.md', 'note']);
		expect(linkTargetKeys('views/sample/view.js')).toEqual(['view.js']);
	});

	it('give every link that can resolve to a file a key that file holds', () => {
		for (const file of VAULT) {
			const keys = linkTargetKeys(file);
			for (const written of [file, file.replace(/\.md$/, ''), file.split('/').pop()!]) {
				if (resolve(written) !== file) continue;
				expect(keys).toContain(linkPathKey(written));
			}
		}
		expect(linkPathKey('Folder\\Note')).toBe('note');
	});
});
