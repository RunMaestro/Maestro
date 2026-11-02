import {
	analyzeMemoryLinks,
	resolveMemoryRepositoryRoot,
} from '../../shared/maestro-lib/translation/memory';
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
	memoryLayoutFor,
	listMemoryEntries,
	readMemoryEntry,
	writeMemoryEntry,
	createMemoryEntry,
	deleteMemoryEntry,
	searchMemoryEntries,
	findOrphanMemories,
} from '../../main/memory-manager';

let tempHome: string;

/** Claude's per-project store under a throwaway account dir. */
const claude = (projectPath: string) =>
	memoryLayoutFor('claude-code', { projectPath, accountDir: path.join(tempHome, '.claude') });

/** Codex's per-account store under a throwaway CODEX_HOME. */
const codex = () =>
	memoryLayoutFor('codex', { projectPath: '/ignored', accountDir: path.join(tempHome, '.codex') });

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

	it('resolves repository memory identity separately from worktree session cwd', async () => {
		const repositoryRoot = path.join(tempHome, 'repo');
		const worktree = path.join(tempHome, 'repo-worktrees', 'branch');
		expect(
			await resolveMemoryRepositoryRoot(worktree, async () => path.join(repositoryRoot, '.git'))
		).toBe(repositoryRoot);
		const plain = path.join(tempHome, 'plain');
		expect(await resolveMemoryRepositoryRoot(plain, async () => undefined)).toBe(plain);
	});
	it('reads and edits the explicitly resolved translated directory without touching a native home', async () => {
		const managed = path.join(tempHome, 'managed/memory');
		const layout = { ...claude('/project'), directoryPath: managed };
		await writeMemoryEntry(layout, 'MEMORY.md', 'Managed knowledge');
		expect(await readMemoryEntry(layout, 'MEMORY.md')).toBe('Managed knowledge');
		expect((await listMemoryEntries(layout)).directoryPath).toBe(managed);
		expect(fs.existsSync(path.join(tempHome, '.claude'))).toBe(false);
	});
	it('resolves the memory directory using the Claude project-path encoding', () => {
		const dir = claude('/Users/me/Projects/My App').directoryPath;
		expect(dir).toBe(
			path.join(tempHome, '.claude', 'projects', '-Users-me-Projects-My-App', 'memory')
		);
	});

	it('refuses providers without a memory store', () => {
		expect(() => memoryLayoutFor('opencode', { projectPath: '/p', accountDir: tempHome })).toThrow(
			/not supported/
		);
	});

	it('returns exists:false with empty entries when the directory is missing', async () => {
		const result = await listMemoryEntries(claude('/Users/me/Projects/Empty'));
		expect(result.exists).toBe(false);
		expect(result.entries).toEqual([]);
		expect(result.stats.fileCount).toBe(0);
		expect(result.stats.totalBytes).toBe(0);
	});

	it('pins MEMORY.md to the top and sorts the rest alphabetically', async () => {
		const projectPath = '/Users/me/Projects/Pinning';
		await writeMemoryEntry(claude(projectPath), 'zebra.md', 'z');
		await writeMemoryEntry(claude(projectPath), 'alpha.md', 'a');
		await writeMemoryEntry(claude(projectPath), 'MEMORY.md', '- index');
		const result = await listMemoryEntries(claude(projectPath));
		expect(result.entries.map((e) => e.name)).toEqual(['MEMORY.md', 'alpha.md', 'zebra.md']);
	});

	it('round-trips write/read/delete for a single entry', async () => {
		const projectPath = '/Users/me/Projects/Rw';
		await writeMemoryEntry(claude(projectPath), 'note.md', 'hello');
		expect(await readMemoryEntry(claude(projectPath), 'note.md')).toBe('hello');
		await deleteMemoryEntry(claude(projectPath), 'note.md');
		const after = await listMemoryEntries(claude(projectPath));
		expect(after.entries.find((e) => e.name === 'note.md')).toBeUndefined();
	});

	it('createMemoryEntry fails if the file already exists', async () => {
		const projectPath = '/Users/me/Projects/Create';
		await createMemoryEntry(claude(projectPath), 'dup.md', 'first');
		await expect(createMemoryEntry(claude(projectPath), 'dup.md', 'second')).rejects.toThrow(
			/already exists/
		);
	});

	it('refuses filenames that would escape the memory directory', async () => {
		const projectPath = '/Users/me/Projects/Safety';
		await expect(writeMemoryEntry(claude(projectPath), '../evil.md', 'x')).rejects.toThrow(
			/Unsafe/
		);
		await expect(writeMemoryEntry(claude(projectPath), 'sub/evil.md', 'x')).rejects.toThrow(
			/Unsafe/
		);
		await expect(writeMemoryEntry(claude(projectPath), 'no-extension', 'x')).rejects.toThrow(
			/must end with \.md/
		);
	});

	it('refuses to delete MEMORY.md via the viewer', async () => {
		const projectPath = '/Users/me/Projects/Protect';
		await writeMemoryEntry(claude(projectPath), 'MEMORY.md', 'index');
		await expect(deleteMemoryEntry(claude(projectPath), 'MEMORY.md')).rejects.toThrow(
			/cannot be deleted/
		);
	});

	it('reports aggregate stats across all entries', async () => {
		const projectPath = '/Users/me/Projects/Stats';
		await writeMemoryEntry(claude(projectPath), 'a.md', 'a'.repeat(100));
		await writeMemoryEntry(claude(projectPath), 'b.md', 'b'.repeat(250));
		const result = await listMemoryEntries(claude(projectPath));
		expect(result.stats.fileCount).toBe(2);
		expect(result.stats.totalBytes).toBe(350);
		expect(result.stats.firstCreatedAt).toBeTruthy();
		expect(result.stats.lastModifiedAt).toBeTruthy();
	});
	describe('searchMemoryEntries', () => {
		const projectPath = '/Users/me/Projects/Search';

		beforeEach(async () => {
			await writeMemoryEntry(claude(projectPath), 'MEMORY.md', '- index line');
			await writeMemoryEntry(
				claude(projectPath),
				'project_widgets.md',
				'The widget pipeline runs nightly.'
			);
			await writeMemoryEntry(claude(projectPath), 'user_prefs.md', 'Prefers tabs over spaces.');
		});

		it('returns every entry for an empty query', async () => {
			const matches = await searchMemoryEntries(claude(projectPath), '   ');
			expect(matches.map((m) => m.name)).toEqual([
				'MEMORY.md',
				'project_widgets.md',
				'user_prefs.md',
			]);
		});

		it('matches on the filename', async () => {
			const matches = await searchMemoryEntries(claude(projectPath), 'PREFS');
			expect(matches.map((m) => m.name)).toEqual(['user_prefs.md']);
			expect(matches[0].matchedName).toBe(true);
		});

		it('matches on the body and reports the matching line', async () => {
			const matches = await searchMemoryEntries(claude(projectPath), 'nightly');
			expect(matches.map((m) => m.name)).toEqual(['project_widgets.md']);
			expect(matches[0].matchedName).toBe(false);
			expect(matches[0].snippet).toBe('The widget pipeline runs nightly.');
		});

		it('returns nothing when neither name nor body matches', async () => {
			const matches = await searchMemoryEntries(claude(projectPath), 'zzzznope');
			expect(matches).toEqual([]);
		});

		it('caps the snippet and keeps the pinned/alphabetical order', async () => {
			await writeMemoryEntry(claude(projectPath), 'aaa_long.md', `prefix ${'x'.repeat(400)}`);
			await writeMemoryEntry(claude(projectPath), 'MEMORY.md', 'prefix in the index');
			const matches = await searchMemoryEntries(claude(projectPath), 'prefix');
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
				claude(projectPath),
				'MEMORY.md',
				'- [Indexed](project_indexed.md) - hook'
			);
			await writeMemoryEntry(claude(projectPath), 'project_indexed.md', 'body');
			await writeMemoryEntry(claude(projectPath), 'project_lonely.md', 'body');

			const { orphans } = await findOrphanMemories(claude(projectPath));
			expect(orphans).toEqual(['project_lonely.md']);
		});

		it('never reports MEMORY.md, which nothing is expected to point at', async () => {
			await writeMemoryEntry(claude(projectPath), 'MEMORY.md', '# index');
			const { orphans } = await findOrphanMemories(claude(projectPath));
			expect(orphans).toEqual([]);
		});

		it('counts a wiki link by filename stem as a reference', async () => {
			await writeMemoryEntry(claude(projectPath), 'MEMORY.md', 'see [[a_note]]');
			await writeMemoryEntry(claude(projectPath), 'a_note.md', 'body');
			const { orphans } = await findOrphanMemories(claude(projectPath));
			expect(orphans).toEqual([]);
		});

		it('counts a wiki link by frontmatter name as a reference', async () => {
			// The memory instructions tell the agent to link by the `name:` slug,
			// which is often NOT the filename. A checker that only knew filenames
			// would report almost every entry as an orphan.
			await writeMemoryEntry(claude(projectPath), 'MEMORY.md', 'see [[the-slug]]');
			await writeMemoryEntry(claude(projectPath), 'a_note.md', '---\nname: the-slug\n---\n\nbody');
			const { orphans } = await findOrphanMemories(claude(projectPath));
			expect(orphans).toEqual([]);
		});

		it('treats hyphen and underscore spellings as the same target', async () => {
			// One character apart, invisible in rendered markdown, and the single
			// biggest source of silently-dead pointers in a real memory dir.
			await writeMemoryEntry(claude(projectPath), 'MEMORY.md', 'see [[project-my-note]]');
			await writeMemoryEntry(claude(projectPath), 'project_my_note.md', 'body');
			const { orphans, brokenLinks } = await findOrphanMemories(claude(projectPath));
			expect(orphans).toEqual([]);
			expect(brokenLinks).toEqual([]);
		});

		it('reports a link whose target does not exist', async () => {
			await writeMemoryEntry(claude(projectPath), 'MEMORY.md', 'see [[nope]]');
			const { brokenLinks } = await findOrphanMemories(claude(projectPath));
			expect(brokenLinks).toEqual([{ source: 'MEMORY.md', target: 'nope' }]);
		});

		it('does not let a self-link rescue an entry from being an orphan', async () => {
			await writeMemoryEntry(claude(projectPath), 'MEMORY.md', '# index');
			await writeMemoryEntry(claude(projectPath), 'a_note.md', 'I link to [[a_note]] only');
			const { orphans } = await findOrphanMemories(claude(projectPath));
			expect(orphans).toEqual(['a_note.md']);
		});
	});

	describe('Codex layout', () => {
		const seed = (rel: string, body: string) => {
			const full = path.join(tempHome, '.codex', 'memories', ...rel.split('/'));
			fs.mkdirSync(path.dirname(full), { recursive: true });
			fs.writeFileSync(full, body);
		};

		it('lives under CODEX_HOME/memories, shared by every project', () => {
			const layout = codex();
			expect(layout.directoryPath).toBe(path.join(tempHome, '.codex', 'memories'));
			expect(layout.scope).toBe('account');
			expect(layout.newEntryDir).toBe('extensions/ad_hoc/notes');
		});

		it('lists nested markdown by relative path, index first, skipping dot dirs', async () => {
			seed('MEMORY.md', '# index');
			seed('rollout_summaries/2026-10-01-run.md', 'run');
			seed('skills/release/SKILL.md', 'steps');
			seed('extensions/skysight/notes.txt', 'not markdown');
			seed('.git/HEAD.md', 'tooling, not a memory');

			const { entries, layout } = await listMemoryEntries(codex());
			expect(entries.map((e) => e.name)).toEqual([
				'MEMORY.md',
				'rollout_summaries/2026-10-01-run.md',
				'skills/release/SKILL.md',
			]);
			expect(layout.nested).toBe(true);
		});

		it('marks generated files and extension instructions as protected', async () => {
			seed('MEMORY.md', '# index');
			seed('memory_summary.md', 'summary');
			seed('extensions/ad_hoc/instructions.md', 'how to read notes');
			seed('extensions/ad_hoc/notes/mine.md', 'a note');

			const { entries } = await listMemoryEntries(codex());
			const protectedNames = entries.filter((e) => e.protected).map((e) => e.name);
			expect(protectedNames).toEqual([
				'MEMORY.md',
				'extensions/ad_hoc/instructions.md',
				'memory_summary.md',
			]);
			await expect(deleteMemoryEntry(codex(), 'memory_summary.md')).rejects.toThrow(
				/cannot be deleted/
			);
			await deleteMemoryEntry(codex(), 'extensions/ad_hoc/notes/mine.md');
		});

		it('creates a note in a directory that does not exist yet', async () => {
			await createMemoryEntry(codex(), 'extensions/ad_hoc/notes/new-note.md', '# Note');
			expect(await readMemoryEntry(codex(), 'extensions/ad_hoc/notes/new-note.md')).toBe('# Note');
		});

		it('refuses paths that climb out of the store or into dot dirs', async () => {
			await expect(writeMemoryEntry(codex(), 'skills/../../evil.md', 'x')).rejects.toThrow(
				/Unsafe/
			);
			await expect(writeMemoryEntry(codex(), '.git/evil.md', 'x')).rejects.toThrow(/Unsafe/);
			await expect(writeMemoryEntry(codex(), 'skills//evil.md', 'x')).rejects.toThrow(/Unsafe/);
		});

		it('reports no orphans, since its index names files in prose rather than links', async () => {
			seed('MEMORY.md', '- rollout_summaries/2026-10-01-run.md (cwd=/x)');
			seed('rollout_summaries/2026-10-01-run.md', 'run');
			expect(await findOrphanMemories(codex())).toEqual({ orphans: [], brokenLinks: [] });
		});
	});
});

describe('shared memory link discovery', () => {
	it('resolves nested relative topics, skips web links, and retains missing-link evidence', () => {
		const result = analyzeMemoryLinks(
			new Map([
				[
					'memory/MEMORY.md',
					'[topic](nested/topic.md) [web](https://example.test/docs.md) [missing](absent.md)',
				],
				['memory/nested/topic.md', 'synthetic fact'],
			])
		);
		expect(result.referenced.has('memory/nested/topic.md')).toBe(true);
		expect(result.brokenLinks).toEqual([{ source: 'memory/MEMORY.md', target: 'absent.md' }]);
	});
});
