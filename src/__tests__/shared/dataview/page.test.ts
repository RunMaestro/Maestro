/**
 * Fixture-vault tests for `parsePage` (src/shared/dataview/page.ts) and M3 (src/shared/dataview/resolve.ts),
 * reached through src/shared/dataview/index.ts. Every note in src/__tests__/fixtures/dataview-vault/ is read
 * with `fs` and parsed against a resolver over the whole vault. `ctime` is stubbed from each note's
 * frontmatter `created`, as the fixture README says. Unit tests for M1 itself are in metadata.test.ts.
 */

import fs from 'fs';
import path from 'path';
import { DateTime } from 'luxon';
import { beforeAll, describe, expect, it } from 'vitest';
import { createLinkResolver, Link, parsePage } from '../../../shared/dataview';
import type { LinkResolver, PageMetadata, PageParseWarning } from '../../../shared/dataview';
import { DATAVIEW_FIXTURE_VAULT, fixtureCreatedTime } from '../../helpers/dataviewFixtureVault';

const VAULT = DATAVIEW_FIXTURE_VAULT;
const MTIME = Date.UTC(2026, 9, 1);

/** Every vault file as a POSIX path, skipping dot folders (`.obsidian`, `.trash`) as the index will. */
function listVault(dir = VAULT): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith('.')) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listVault(full));
		else out.push(path.relative(VAULT, full).split(path.sep).join('/'));
	}
	return out.sort();
}

const files = listVault();
// The vault README describes the fixtures; it is not a note (fixture README rule).
const notes = files.filter((file) => file.endsWith('.md') && file !== 'README.md');

let resolver: LinkResolver;
const pages = new Map<string, PageMetadata>();
const warnings = new Map<string, PageParseWarning[]>();

function page(file: string): PageMetadata {
	const parsed = pages.get(file);
	if (!parsed) throw new Error(`no parsed page for ${file}`);
	return parsed;
}

const linkPaths = (links: Link[]) => links.map((link) => link.path);
const listItem = (file: string, line: number) => {
	const item = page(file).lists.find((entry) => entry.line === line);
	if (!item) throw new Error(`no list item on line ${line} of ${file}`);
	return item;
};

beforeAll(() => {
	resolver = createLinkResolver(files);
	for (const file of notes) {
		const content = fs.readFileSync(path.join(VAULT, file), 'utf8');
		const found: PageParseWarning[] = [];
		pages.set(
			file,
			parsePage(
				{
					path: file,
					content,
					ctime: fixtureCreatedTime(content),
					mtime: MTIME,
					size: Buffer.byteLength(content),
				},
				resolver,
				{ onWarning: (warning) => found.push(warning) }
			)
		);
		warnings.set(file, found);
	}
});

describe('parsePage over the fixture vault', () => {
	it('parses every note, skipping dot folders and the README', () => {
		expect(notes).toContain('People/Pedram Amini.md');
		expect(notes).not.toContain('README.md');
		expect(notes.some((file) => file.startsWith('.'))).toBe(false);
		expect(pages.size).toBe(notes.length);
		for (const file of notes) {
			const parsed = page(file);
			expect(parsed.path).toBe(file);
			expect(parsed.mtime.toMillis()).toBe(MTIME);
			expect(parsed.size).toBeGreaterThan(0);
		}
	});

	it('stubs ctime from frontmatter created, and only the broken note warns', () => {
		for (const file of notes) {
			const created = page(file).ctime.toISODate();
			expect(created).toMatch(/^2026-\d{2}-\d{2}$/);
			if (file !== 'Notes/Broken Frontmatter.md') {
				// `file.frontmatter` keeps the raw YAML string; the field is the parsed date.
				expect(page(file).frontmatter.created).toBe(created);
				expect(page(file).fields.get('created')).toBeInstanceOf(DateTime);
				expect((page(file).fields.get('created') as DateTime).toISODate()).toBe(created);
			}
		}
		const warned = notes.filter((file) => (warnings.get(file) ?? []).length > 0);
		expect(warned).toEqual(['Notes/Broken Frontmatter.md']);
	});

	it('types frontmatter fields, and parses a quoted frontmatter link as a resolved Link', () => {
		const rami = page('People/Rami Example.md');
		expect(rami.fields.get('Company')).toBe('Example Corp');
		expect(rami.fields.get('Role')).toBe('Security Engineer');
		expect(rami.fields.get('created')).toBeInstanceOf(DateTime);
		const connection = rami.fields.get('Connection');
		expect(connection).toBeInstanceOf(Link);
		expect(connection as Link).toMatchObject({
			path: 'People/Pedram Amini.md',
			type: 'file',
			embed: false,
		});
		expect((connection as Link).equals(Link.file('People/Pedram Amini.md'))).toBe(true);
		// The normalized key exists beside the written one, holding an equal value.
		expect((rami.fields.get('connection') as Link).equals(connection as Link)).toBe(true);
		// `file.frontmatter` keeps the raw string, as upstream does.
		expect(rami.frontmatter.Connection).toBe('[[Pedram Amini]]');
		// A frontmatter link is an outlink too.
		expect(linkPaths(rami.links)).toEqual(['People/Pedram Amini.md']);
	});

	it('keeps a list-valued frontmatter field as a list of resolved links with display text', () => {
		const connection = page('People/Dana Sample.md').fields.get('Connection');
		expect(Array.isArray(connection)).toBe(true);
		const links = connection as Link[];
		expect(links.every((link) => link instanceof Link)).toBe(true);
		expect(linkPaths(links)).toEqual([
			'People/Pedram Amini.md',
			'People/Rami Example.md',
			'Projects/Alpha/Design/Spec.md',
		]);
		expect(links[2].display).toBe('the spec');
	});

	it('extracts Key:: value lines after the frontmatter with typed values and normalized keys', () => {
		const fields = page('Notes/Header Fields.md').fields;
		expect(fields.get('Status')).toBe('active');
		expect(fields.get('status')).toBe('active');
		expect(fields.get('Owner')).toBeInstanceOf(Link);
		expect((fields.get('Owner') as Link).path).toBe('People/Rami Example.md');
		expect((fields.get('owner') as Link).equals(fields.get('Owner') as Link)).toBe(true);
		expect(fields.get('Due')).toBeInstanceOf(DateTime);
		expect((fields.get('Due') as DateTime).toISODate()).toBe('2026-10-01');
		expect(fields.get('Score')).toBe(42);
		expect(fields.get('score')).toBe(42);
	});

	it('dash-cases a multi-word key into a second key', () => {
		const fields = page('Projects/Links.md').fields;
		expect((fields.get('Review Date') as DateTime).toISODate()).toBe('2026-10-10');
		expect(fields.get('review-date')).toBe(fields.get('Review Date'));
	});

	it('extracts [key:: value] and (key:: value) fields from body text', () => {
		const standup = page('Notes/Standup.md');
		expect(standup.fields.get('mood')).toBe('upbeat');
		expect(standup.fields.get('focus')).toBe('indexing');
		const kickoff = page('meetings/2026-09-01 Kickoff.md');
		expect(kickoff.fields.get('Summary')).toBe('Kicked off the Dataview work.');
		expect(kickoff.fields.get('summary')).toBe('Kicked off the Dataview work.');
	});

	it('collects tags from frontmatter and body, and ignores tags in code fences and code spans', () => {
		expect([...page('People/Pedram Amini.md').tags]).toEqual(['#person']);
		expect([...page('meetings/2026-09-01 Kickoff.md').tags]).toEqual(['#meeting']);
		expect([...page('Notes/Standup.md').tags]).toEqual(['#meeting']);
		// `#meeting` sits in a code span here.
		expect([...page('meetings/2026-09-15 Review.md').tags]).toEqual([]);
		// `#fenced-tag` sits in a code fence here.
		expect([...page('Projects/Links.md').tags]).toEqual([]);
		const spec = page('Projects/Alpha/Design/Spec.md');
		expect([...spec.tags]).toEqual(['#project/alpha']);
		expect(spec.fullTags()).toEqual(new Set(['#project', '#project/alpha']));
	});

	it('collects aliases from a frontmatter list', () => {
		expect([...page('People/Pedram Amini.md').aliases]).toEqual(['Pedram']);
		expect([...page('People/Rami Example.md').aliases]).toEqual(['Rami', 'R. Example']);
	});

	it('records wiki links and aliased wiki links as resolved outlinks', () => {
		const kickoff = page('meetings/2026-09-01 Kickoff.md');
		expect(linkPaths(kickoff.links)).toEqual(['People/Pedram Amini.md', 'People/Rami Example.md']);
		expect(kickoff.links[1].display).toBe('Rami');
		const review = page('meetings/2026-09-15 Review.md');
		expect(linkPaths(review.links)).toEqual(['People/Pedram Amini.md']);
		expect(review.links[0].display).toBe('Pedram');
	});

	it('records heading, block, self, and embed links with their subpaths, and skips links in code', () => {
		const links = page('Projects/Links.md').links;
		expect(
			links.map((link) => [link.path, link.type, link.subpath, link.embed, link.display])
		).toEqual([
			['Notes/Standup.md', 'header', 'Standup', false, 'Standup#Standup'],
			['Notes/Header Fields.md', 'block', 'owner', false, 'owner block'],
			['Projects/Links.md', 'header', 'Links', false, '#Links'],
			['Notes/Other.md', 'file', undefined, false, 'Other'],
			['Projects/Alpha/Other.md', 'file', undefined, false, 'Alpha/Other'],
			['Missing Note', 'file', undefined, false, 'Missing Note'],
			['People/Pedram Amini.md', 'file', undefined, true, 'Pedram Amini'],
		]);
		expect(linkPaths(links)).not.toContain('Fenced');
	});

	it('records a markdown link to a note as an outlink, but not an external link', () => {
		const links = page('Notes/Markdown Link.md').links;
		expect(linkPaths(links)).toEqual(['Notes/Other.md']);
		expect(links[0].display).toBe('x');
	});

	it('parses tasks with due fields, completion state, and status characters', () => {
		const tasks = page('Notes/Standup.md').lists.filter((item) => item.task);
		expect(tasks.map((task) => [task.line, task.task?.status, task.task?.completed])).toEqual([
			[8, ' ', false],
			[9, 'x', true],
			[10, ' ', false],
			[14, ' ', false],
		]);
		expect(tasks.map((task) => task.task?.fullyCompleted)).toEqual([false, true, false, false]);
		expect(tasks[1].task?.checked).toBe(true);
		expect(tasks[0].task?.checked).toBe(false);

		const due = tasks[0].due();
		expect(due).toBeInstanceOf(DateTime);
		expect((due as DateTime).toISODate()).toBe('2026-10-05');
		expect(tasks[2].fields.get('priority')).toEqual(['high']);
		const owner = tasks[2].fields.get('owner')?.[0];
		expect(owner).toBeInstanceOf(Link);
		expect((owner as Link).path).toBe('People/Rami Example.md');
		// Upstream quirk, kept for fidelity: `canonicalize` resolves item fields but not item `links`, so a
		// task's own outlinks keep the path as written.
		expect(linkPaths(tasks[2].links)).toEqual(['Rami Example']);
		// Task fields stay on the task; they do not become page fields.
		expect(page('Notes/Standup.md').fields.has('due')).toBe(false);
	});

	it('nests list items by indentation with parent and child line numbers', () => {
		const file = 'Notes/Standup.md';
		const parent = listItem(file, 11);
		expect(parent.parent).toBeUndefined();
		expect(parent.children).toEqual([12, 14]);
		expect(parent.text).toBe('Parent item');
		expect(listItem(file, 12).parent).toBe(11);
		expect(listItem(file, 12).children).toEqual([13]);
		expect(listItem(file, 13).parent).toBe(12);
		expect(listItem(file, 14).parent).toBe(11);
		expect(listItem(file, 14).task?.status).toBe(' ');
		// Every item of the one list points at the list's first line and sits under the Standup heading.
		for (const item of page(file).lists) {
			expect(item.list).toBe(8);
			expect(item.section.equals(Link.header(file, 'Standup'))).toBe(true);
		}
		// A field on a non-task child item propagates to the page.
		expect(listItem(file, 12).fields.get('area')).toEqual(['index']);
		expect(page(file).fields.get('area')).toBe('index');
	});

	it('sets file.day from a dated file name, and leaves it unset otherwise', () => {
		expect(page('meetings/2026-09-01 Kickoff.md').day?.toISODate()).toBe('2026-09-01');
		expect(page('meetings/2026-09-15 Review.md').day?.toISODate()).toBe('2026-09-15');
		expect(page('Notes/Standup.md').day).toBeUndefined();
	});

	it('turns broken YAML frontmatter into a warning and an empty frontmatter, not a throw', () => {
		const file = 'Notes/Broken Frontmatter.md';
		expect(warnings.get(file)).toEqual([
			{
				path: file,
				line: expect.any(Number),
				message: expect.stringMatching(/^Invalid YAML frontmatter: /),
			},
		]);
		const broken = page(file);
		expect(broken.frontmatter).toEqual({});
		expect(broken.tags.size).toBe(0);
		expect(broken.fields.get('State')).toBe('still indexed');
		expect(broken.fields.has('created')).toBe(false);
	});
});

describe('createLinkResolver over the fixture vault', () => {
	it('resolves a name shared by notes in two folders to the shortest path', () => {
		expect(resolver.resolve('Other', 'Projects/Links.md')).toBe('Notes/Other.md');
		expect(resolver.resolve('Other', 'People/Dana Sample.md')).toBe('Notes/Other.md');
		expect(resolver.resolve('Other', 'Projects/Alpha/Design/Spec.md')).toBe('Notes/Other.md');
		// A folder-qualified link, or a link from inside the deeper folder, reaches the other note.
		expect(resolver.resolve('Alpha/Other', 'Projects/Links.md')).toBe('Projects/Alpha/Other.md');
		expect(resolver.resolve('Other', 'Projects/Alpha/Source.md')).toBe('Projects/Alpha/Other.md');
	});

	it('resolves fixture links to notes, a script, and a CSV by their vault paths', () => {
		expect(resolver.resolve('Pedram Amini', 'meetings/2026-09-01 Kickoff.md')).toBe(
			'People/Pedram Amini.md'
		);
		expect(resolver.resolve('Projects/Alpha/Design/Spec', 'People/Dana Sample.md')).toBe(
			'Projects/Alpha/Design/Spec.md'
		);
		expect(resolver.resolve('views/sample/view.js', 'Scripts/JS Demo.md')).toBe(
			'views/sample/view.js'
		);
		expect(resolver.resolve('data/people.csv', 'Scripts/JS Demo.md')).toBe('data/people.csv');
	});

	it('keeps an unresolvable link as an unresolved Link rather than dropping it', () => {
		expect(resolver.resolve('Missing Note', 'Projects/Links.md')).toBeNull();
		// Notes in dot folders are not part of the vault.
		expect(resolver.resolve('Deleted', 'Projects/Links.md')).toBeNull();
		const missing = page('Projects/Links.md').links.find((link) => link.path === 'Missing Note');
		expect(missing).toBeInstanceOf(Link);
		expect(missing?.type).toBe('file');
	});
});
