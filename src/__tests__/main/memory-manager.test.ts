/**
 * Tests for memory-manager.ts - project memory CRUD operations.
 *
 * Uses a per-test temporary directory passed explicitly as homeDir so we
 * never touch the user's real ~/.claude/projects/<encoded>/memory/.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
	getMemoryDirectoryPath,
	listMemoryEntries,
	readMemoryEntry,
	writeMemoryEntry,
	createMemoryEntry,
	deleteMemoryEntry,
	searchMemoryEntries,
	findOrphanMemories,
} from '../../main/memory-manager';

let tempHome: string;

describe('memory-manager', () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-memory-test-'));
	});

	afterEach(() => {
		try {
			fs.rmSync(tempHome, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it('resolves the memory directory using the Claude project-path encoding', () => {
		const projectPath = '/Users/me/Projects/My App';
		const dir = getMemoryDirectoryPath(projectPath, 'claude-code', tempHome);
		expect(dir).toBe(
			path.join(tempHome, '.claude', 'projects', '-Users-me-Projects-My-App', 'memory')
		);
	});

	it('refuses non-claude-code agents', () => {
		expect(() => getMemoryDirectoryPath('/p', 'codex', tempHome)).toThrow(/not supported/);
	});

	it('returns exists:false with empty entries when the directory is missing', async () => {
		const result = await listMemoryEntries('/Users/me/Projects/Empty', 'claude-code', tempHome);
		expect(result.exists).toBe(false);
		expect(result.entries).toEqual([]);
		expect(result.stats.fileCount).toBe(0);
		expect(result.stats.totalBytes).toBe(0);
	});

	it('pins MEMORY.md to the top and sorts the rest alphabetically', async () => {
		const projectPath = '/Users/me/Projects/Pinning';
		await writeMemoryEntry(projectPath, 'zebra.md', 'z', 'claude-code', tempHome);
		await writeMemoryEntry(projectPath, 'alpha.md', 'a', 'claude-code', tempHome);
		await writeMemoryEntry(projectPath, 'MEMORY.md', '- index', 'claude-code', tempHome);
		const result = await listMemoryEntries(projectPath, 'claude-code', tempHome);
		expect(result.entries.map((e) => e.name)).toEqual(['MEMORY.md', 'alpha.md', 'zebra.md']);
	});

	it('round-trips write/read/delete for a single entry', async () => {
		const projectPath = '/Users/me/Projects/Rw';
		await writeMemoryEntry(projectPath, 'note.md', 'hello', 'claude-code', tempHome);
		expect(await readMemoryEntry(projectPath, 'note.md', 'claude-code', tempHome)).toBe('hello');
		await deleteMemoryEntry(projectPath, 'note.md', 'claude-code', tempHome);
		const after = await listMemoryEntries(projectPath, 'claude-code', tempHome);
		expect(after.entries.find((e) => e.name === 'note.md')).toBeUndefined();
	});

	it('createMemoryEntry fails if the file already exists', async () => {
		const projectPath = '/Users/me/Projects/Create';
		await createMemoryEntry(projectPath, 'dup.md', 'first', 'claude-code', tempHome);
		await expect(
			createMemoryEntry(projectPath, 'dup.md', 'second', 'claude-code', tempHome)
		).rejects.toThrow(/already exists/);
	});

	it('refuses filenames that would escape the memory directory', async () => {
		const projectPath = '/Users/me/Projects/Safety';
		await expect(
			writeMemoryEntry(projectPath, '../evil.md', 'x', 'claude-code', tempHome)
		).rejects.toThrow(/Unsafe/);
		await expect(
			writeMemoryEntry(projectPath, 'sub/evil.md', 'x', 'claude-code', tempHome)
		).rejects.toThrow(/Unsafe/);
		await expect(
			writeMemoryEntry(projectPath, 'no-extension', 'x', 'claude-code', tempHome)
		).rejects.toThrow(/must end with \.md/);
	});

	it('refuses to delete MEMORY.md via the viewer', async () => {
		const projectPath = '/Users/me/Projects/Protect';
		await writeMemoryEntry(projectPath, 'MEMORY.md', 'index', 'claude-code', tempHome);
		await expect(
			deleteMemoryEntry(projectPath, 'MEMORY.md', 'claude-code', tempHome)
		).rejects.toThrow(/cannot be deleted/);
	});

	it('reports aggregate stats across all entries', async () => {
		const projectPath = '/Users/me/Projects/Stats';
		await writeMemoryEntry(projectPath, 'a.md', 'a'.repeat(100), 'claude-code', tempHome);
		await writeMemoryEntry(projectPath, 'b.md', 'b'.repeat(250), 'claude-code', tempHome);
		const result = await listMemoryEntries(projectPath, 'claude-code', tempHome);
		expect(result.stats.fileCount).toBe(2);
		expect(result.stats.totalBytes).toBe(350);
		expect(result.stats.firstCreatedAt).toBeTruthy();
		expect(result.stats.lastModifiedAt).toBeTruthy();
	});
	describe('searchMemoryEntries', () => {
		const projectPath = '/Users/me/Projects/Search';

		beforeEach(async () => {
			await writeMemoryEntry(projectPath, 'MEMORY.md', '- index line', 'claude-code', tempHome);
			await writeMemoryEntry(
				projectPath,
				'project_widgets.md',
				'The widget pipeline runs nightly.',
				'claude-code',
				tempHome
			);
			await writeMemoryEntry(
				projectPath,
				'user_prefs.md',
				'Prefers tabs over spaces.',
				'claude-code',
				tempHome
			);
		});

		it('returns every entry for an empty query', async () => {
			const matches = await searchMemoryEntries(projectPath, '   ', 'claude-code', tempHome);
			expect(matches.map((m) => m.name)).toEqual([
				'MEMORY.md',
				'project_widgets.md',
				'user_prefs.md',
			]);
		});

		it('matches on the filename', async () => {
			const matches = await searchMemoryEntries(projectPath, 'PREFS', 'claude-code', tempHome);
			expect(matches.map((m) => m.name)).toEqual(['user_prefs.md']);
			expect(matches[0].matchedName).toBe(true);
		});

		it('matches on the body and reports the matching line', async () => {
			const matches = await searchMemoryEntries(projectPath, 'nightly', 'claude-code', tempHome);
			expect(matches.map((m) => m.name)).toEqual(['project_widgets.md']);
			expect(matches[0].matchedName).toBe(false);
			expect(matches[0].snippet).toBe('The widget pipeline runs nightly.');
		});

		it('returns nothing when neither name nor body matches', async () => {
			const matches = await searchMemoryEntries(projectPath, 'zzzznope', 'claude-code', tempHome);
			expect(matches).toEqual([]);
		});

		it('caps the snippet and keeps the pinned/alphabetical order', async () => {
			await writeMemoryEntry(
				projectPath,
				'aaa_long.md',
				`prefix ${'x'.repeat(400)}`,
				'claude-code',
				tempHome
			);
			await writeMemoryEntry(
				projectPath,
				'MEMORY.md',
				'prefix in the index',
				'claude-code',
				tempHome
			);
			const matches = await searchMemoryEntries(projectPath, 'prefix', 'claude-code', tempHome);
			expect(matches.map((m) => m.name)).toEqual(['MEMORY.md', 'aaa_long.md']);
			const long = matches.find((m) => m.name === 'aaa_long.md');
			expect(long?.snippet?.length).toBeLessThanOrEqual(121);
			expect(long?.snippet?.endsWith('\u2026')).toBe(true);
		});
	});
	describe('findOrphanMemories', () => {
		const projectPath = '/Users/me/Projects/Orphans';

		it('reports entries that nothing references', async () => {
			await writeMemoryEntry(
				projectPath,
				'MEMORY.md',
				'- [Indexed](project_indexed.md) - hook',
				'claude-code',
				tempHome
			);
			await writeMemoryEntry(projectPath, 'project_indexed.md', 'body', 'claude-code', tempHome);
			await writeMemoryEntry(projectPath, 'project_lonely.md', 'body', 'claude-code', tempHome);

			const { orphans } = await findOrphanMemories(projectPath, 'claude-code', tempHome);
			expect(orphans).toEqual(['project_lonely.md']);
		});

		it('never reports MEMORY.md, which nothing is expected to point at', async () => {
			await writeMemoryEntry(projectPath, 'MEMORY.md', '# index', 'claude-code', tempHome);
			const { orphans } = await findOrphanMemories(projectPath, 'claude-code', tempHome);
			expect(orphans).toEqual([]);
		});

		it('counts a wiki link by filename stem as a reference', async () => {
			await writeMemoryEntry(projectPath, 'MEMORY.md', 'see [[a_note]]', 'claude-code', tempHome);
			await writeMemoryEntry(projectPath, 'a_note.md', 'body', 'claude-code', tempHome);
			const { orphans } = await findOrphanMemories(projectPath, 'claude-code', tempHome);
			expect(orphans).toEqual([]);
		});

		it('counts a wiki link by frontmatter name as a reference', async () => {
			// The memory instructions tell the agent to link by the `name:` slug,
			// which is often NOT the filename. A checker that only knew filenames
			// would report almost every entry as an orphan.
			await writeMemoryEntry(projectPath, 'MEMORY.md', 'see [[the-slug]]', 'claude-code', tempHome);
			await writeMemoryEntry(
				projectPath,
				'a_note.md',
				'---\nname: the-slug\n---\n\nbody',
				'claude-code',
				tempHome
			);
			const { orphans } = await findOrphanMemories(projectPath, 'claude-code', tempHome);
			expect(orphans).toEqual([]);
		});

		it('treats hyphen and underscore spellings as the same target', async () => {
			// One character apart, invisible in rendered markdown, and the single
			// biggest source of silently-dead pointers in a real memory dir.
			await writeMemoryEntry(
				projectPath,
				'MEMORY.md',
				'see [[project-my-note]]',
				'claude-code',
				tempHome
			);
			await writeMemoryEntry(projectPath, 'project_my_note.md', 'body', 'claude-code', tempHome);
			const { orphans, brokenLinks } = await findOrphanMemories(
				projectPath,
				'claude-code',
				tempHome
			);
			expect(orphans).toEqual([]);
			expect(brokenLinks).toEqual([]);
		});

		it('reports a link whose target does not exist', async () => {
			await writeMemoryEntry(projectPath, 'MEMORY.md', 'see [[nope]]', 'claude-code', tempHome);
			const { brokenLinks } = await findOrphanMemories(projectPath, 'claude-code', tempHome);
			expect(brokenLinks).toEqual([{ source: 'MEMORY.md', target: 'nope' }]);
		});

		it('does not let a self-link rescue an entry from being an orphan', async () => {
			await writeMemoryEntry(projectPath, 'MEMORY.md', '# index', 'claude-code', tempHome);
			await writeMemoryEntry(
				projectPath,
				'a_note.md',
				'I link to [[a_note]] only',
				'claude-code',
				tempHome
			);
			const { orphans } = await findOrphanMemories(projectPath, 'claude-code', tempHome);
			expect(orphans).toEqual(['a_note.md']);
		});
	});
});
