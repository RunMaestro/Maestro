import { describe, it, expect } from 'vitest';
import {
	classifyGitStatus,
	buildFileChangeMap,
	buildChangedAncestors,
} from '../../../renderer/utils/gitChangeMap';
import type { GitFileChange } from '../../../renderer/hooks';

describe('classifyGitStatus', () => {
	// `useGitStatusPolling` stores `file.status.trim()` on GitFileChange, so the
	// trimmed forms below are what callers see in production. The function also
	// accepts the raw 2-char porcelain codes (covered separately below).
	it('maps untracked files to added', () => {
		expect(classifyGitStatus('??')).toBe('added');
	});

	it('maps modified-in-worktree (trimmed " M" → "M") to modified', () => {
		expect(classifyGitStatus('M')).toBe('modified');
	});

	it('maps modified-in-index ("M") to modified', () => {
		expect(classifyGitStatus('M')).toBe('modified');
	});

	it('maps added-in-index (trimmed "A " → "A") to added', () => {
		expect(classifyGitStatus('A')).toBe('added');
	});

	it('maps deleted-in-worktree (trimmed " D" → "D") to deleted', () => {
		expect(classifyGitStatus('D')).toBe('deleted');
	});

	it('treats added-then-deleted ("AD") as deleted (file is gone on disk)', () => {
		expect(classifyGitStatus('AD')).toBe('deleted');
	});

	it('treats renamed (trimmed "R " → "R") as modified', () => {
		expect(classifyGitStatus('R')).toBe('modified');
	});

	it('treats merge conflicts (UU) as modified', () => {
		expect(classifyGitStatus('UU')).toBe('modified');
	});

	it('falls back to modified for unknown codes', () => {
		expect(classifyGitStatus('XY')).toBe('modified');
	});

	it('accepts raw untrimmed porcelain codes the same as trimmed ones', () => {
		// Defensive: callers shouldn't need to remember whether their producer
		// trimmed the status; both forms classify identically.
		expect(classifyGitStatus(' M')).toBe('modified');
		expect(classifyGitStatus('M ')).toBe('modified');
		expect(classifyGitStatus(' D')).toBe('deleted');
		expect(classifyGitStatus('A ')).toBe('added');
		expect(classifyGitStatus(' ??')).toBe('added');
	});
});

describe('buildFileChangeMap', () => {
	const mkChange = (path: string, status: string): GitFileChange => ({
		path,
		status,
		additions: 0,
		deletions: 0,
		modified: false,
	});

	it('returns an empty map for undefined input', () => {
		expect(buildFileChangeMap(undefined).size).toBe(0);
	});

	it('returns an empty map for empty input', () => {
		expect(buildFileChangeMap([]).size).toBe(0);
	});

	it('keys by full relative path and classifies each entry (trimmed codes as produced by useGitStatusPolling)', () => {
		const map = buildFileChangeMap([
			mkChange('src/index.ts', 'M'),
			mkChange('README.md', '??'),
			mkChange('old.txt', 'D'),
		]);
		expect(map.get('src/index.ts')).toBe('modified');
		expect(map.get('README.md')).toBe('added');
		expect(map.get('old.txt')).toBe('deleted');
		expect(map.size).toBe(3);
	});

	it('skips entries with empty paths', () => {
		expect(buildFileChangeMap([mkChange('', 'M')]).size).toBe(0);
	});
});

describe('buildChangedAncestors', () => {
	it('returns an empty set for empty input', () => {
		expect(buildChangedAncestors([]).size).toBe(0);
	});

	it('collects every directory ancestor for each changed path', () => {
		const ancestors = buildChangedAncestors(['src/foo/bar.ts', 'docs/index.md']);
		expect(ancestors.has('src')).toBe(true);
		expect(ancestors.has('src/foo')).toBe(true);
		expect(ancestors.has('docs')).toBe(true);
		// Leaf files themselves are NOT ancestors.
		expect(ancestors.has('src/foo/bar.ts')).toBe(false);
		expect(ancestors.has('docs/index.md')).toBe(false);
	});

	it('handles top-level files (no ancestors)', () => {
		const ancestors = buildChangedAncestors(['package.json']);
		expect(ancestors.size).toBe(0);
	});

	it('deduplicates shared ancestors', () => {
		const ancestors = buildChangedAncestors(['src/a.ts', 'src/b.ts', 'src/nested/c.ts']);
		expect(ancestors.has('src')).toBe(true);
		expect(ancestors.has('src/nested')).toBe(true);
		expect(ancestors.size).toBe(2);
	});

	it('ignores empty paths', () => {
		expect(buildChangedAncestors(['']).size).toBe(0);
	});
});
