import { describe, expect, it } from 'vitest';
import {
	RUN_EVIDENCE_MAX_HASHED_PATHS,
	buildGitChanges,
	diffGitChanges,
	diffMtimeSnapshots,
	isRunEvidenceSnapshot,
	mtimePathsToConfirm,
	pairHashes,
	parseGitNameStatusZ,
	pathsToHash,
	splitNulFields,
	type MtimeRunEvidenceSnapshot,
} from '../../shared/runEvidence';

const mtime = (
	files: Record<string, number>,
	overrides: Partial<MtimeRunEvidenceSnapshot> = {}
): MtimeRunEvidenceSnapshot => ({
	source: 'mtime',
	takenAt: 1_000,
	files,
	truncated: false,
	...overrides,
});

describe('runEvidence parsers', () => {
	it('splits NUL-terminated output and drops the empty tail', () => {
		expect(splitNulFields('a\0b c\0\0')).toEqual(['a', 'b c']);
		expect(splitNulFields('')).toEqual([]);
	});

	it('reads name-status pairs, folding type changes and unmerged paths into modified', () => {
		expect(
			parseGitNameStatusZ('A\0new.ts\0M\0old.ts\0D\0gone.ts\0T\0link\0U\0conflict.ts\0')
		).toEqual({
			'new.ts': 'A',
			'old.ts': 'M',
			'gone.ts': 'D',
			link: 'M',
			'conflict.ts': 'M',
		});
	});

	it('keeps a path with spaces and non-ASCII characters intact', () => {
		expect(parseGitNameStatusZ('M\0docs/my notes é.md\0')).toEqual({ 'docs/my notes é.md': 'M' });
	});

	it('hashes only paths that exist, sorted and capped', () => {
		expect(pathsToHash({ 'b.ts': 'M', 'a.ts': 'A', 'gone.ts': 'D' })).toEqual(['a.ts', 'b.ts']);
		const many = Object.fromEntries(
			Array.from({ length: RUN_EVIDENCE_MAX_HASHED_PATHS + 5 }, (_, i) => [
				`f${String(i).padStart(4, '0')}`,
				'M' as const,
			])
		);
		expect(pathsToHash(many)).toHaveLength(RUN_EVIDENCE_MAX_HASHED_PATHS);
	});

	it('pairs hashes with paths, and discards output that does not line up', () => {
		expect(pairHashes(['a', 'b'], 'h1\nh2\n')).toEqual({ a: 'h1', b: 'h2' });
		expect(pairHashes(['a', 'b'], 'h1\n')).toEqual({});
	});

	it('keeps a hash only where one was read', () => {
		expect(buildGitChanges({ a: 'M', b: 'D' }, { a: 'h1' })).toEqual({
			a: { status: 'M', hash: 'h1' },
			b: { status: 'D' },
		});
	});
});

describe('diffGitChanges', () => {
	it("reports a difference that only exists at the end as the run's work", () => {
		expect(
			diffGitChanges(
				{},
				{ 'new.ts': { status: 'A' }, 'edit.ts': { status: 'M' }, 'rm.ts': { status: 'D' } }
			)
		).toEqual({ createdFiles: ['new.ts'], changedFiles: ['edit.ts'], deletedFiles: ['rm.ts'] });
	});

	it('reports an undone difference against the start commit', () => {
		expect(
			diffGitChanges(
				{
					'scratch.ts': { status: 'A', hash: 'h' },
					'restored.ts': { status: 'D' },
					'reverted.ts': { status: 'M', hash: 'h' },
				},
				{}
			)
		).toEqual({
			createdFiles: ['restored.ts'],
			changedFiles: ['reverted.ts'],
			deletedFiles: ['scratch.ts'],
		});
	});

	it('ignores a path that was dirty at start and was not touched', () => {
		expect(
			diffGitChanges(
				{ 'dirty.ts': { status: 'M', hash: 'h1' }, 'gone.ts': { status: 'D' } },
				{ 'dirty.ts': { status: 'M', hash: 'h1' }, 'gone.ts': { status: 'D' } }
			)
		).toEqual({ createdFiles: [], changedFiles: [], deletedFiles: [] });
	});

	it('counts a dirty file the run edited again by its content hash', () => {
		expect(
			diffGitChanges(
				{ 'dirty.ts': { status: 'M', hash: 'h1' }, 'untracked.txt': { status: 'A', hash: 'u1' } },
				{ 'dirty.ts': { status: 'M', hash: 'h2' }, 'untracked.txt': { status: 'A', hash: 'u2' } }
			).changedFiles
		).toEqual(['dirty.ts', 'untracked.txt']);
	});

	it('treats an unknown hash as unchanged rather than guessing', () => {
		expect(
			diffGitChanges({ 'big.bin': { status: 'M' } }, { 'big.bin': { status: 'M', hash: 'h' } })
				.changedFiles
		).toEqual([]);
	});

	it('classifies a status change between start and end', () => {
		expect(
			diffGitChanges(
				{ 'deleted-later.ts': { status: 'M', hash: 'h' }, 'back.ts': { status: 'D' } },
				{ 'deleted-later.ts': { status: 'D' }, 'back.ts': { status: 'M', hash: 'h' } }
			)
		).toEqual({ createdFiles: ['back.ts'], changedFiles: [], deletedFiles: ['deleted-later.ts'] });
	});
});

describe('diffMtimeSnapshots', () => {
	it('reports created, changed, and deleted files, sorted', () => {
		expect(
			diffMtimeSnapshots(
				mtime({ 'same.md': 1, 'edit.md': 1, 'gone.md': 1 }),
				mtime({ 'same.md': 1, 'edit.md': 2, 'z-new.md': 5, 'a-new.md': 5 })
			)
		).toEqual({
			createdFiles: ['a-new.md', 'z-new.md'],
			changedFiles: ['edit.md'],
			deletedFiles: ['gone.md'],
		});
	});

	it('does not call an old file past a truncated start scan created', () => {
		const start = mtime({ 'a.md': 1 }, { truncated: true, takenAt: 1_000 });
		expect(
			diffMtimeSnapshots(start, mtime({ 'a.md': 1, 'old.md': 500, 'new.md': 2_000 })).createdFiles
		).toEqual(['new.md']);
	});

	it('asks the caller to confirm deletions only after a truncated end scan', () => {
		const start = mtime({ 'a.md': 1, 'b.md': 1 });
		expect(mtimePathsToConfirm(start, mtime({ 'a.md': 1 }))).toEqual([]);
		const truncatedEnd = mtime({ 'a.md': 1 }, { truncated: true });
		expect(mtimePathsToConfirm(start, truncatedEnd)).toEqual(['b.md']);
		expect(diffMtimeSnapshots(start, truncatedEnd, new Set(['b.md'])).deletedFiles).toEqual([]);
	});
});

describe('isRunEvidenceSnapshot', () => {
	it('accepts both snapshot shapes and rejects anything else', () => {
		expect(isRunEvidenceSnapshot({ source: 'git', takenAt: 1, base: 'abc', changes: {} })).toBe(
			true
		);
		expect(isRunEvidenceSnapshot(mtime({}))).toBe(true);
		expect(isRunEvidenceSnapshot({ source: 'git', takenAt: 1, changes: {} })).toBe(false);
		expect(isRunEvidenceSnapshot({ source: 'mtime', takenAt: 1, files: {} })).toBe(false);
		expect(isRunEvidenceSnapshot({ source: 'svn', takenAt: 1 })).toBe(false);
		expect(isRunEvidenceSnapshot(null)).toBe(false);
		expect(isRunEvidenceSnapshot('snapshot')).toBe(false);
	});
});
