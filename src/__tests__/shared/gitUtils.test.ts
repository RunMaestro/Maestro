/**
 * Tests for shared git utilities
 */

import {
	parseGitStatusPorcelain,
	countUncommittedChanges,
	hasUncommittedChanges,
	parseGitNumstat,
	parseGitBehindAhead,
	parseGitBranches,
	parseGitTags,
	cleanBranchName,
	cleanGitPath,
	remoteUrlToBrowserUrl,
	isImageFile,
	getImageMimeType,
} from '../../shared/gitUtils';

describe('gitUtils', () => {
	describe('parseGitStatusPorcelain', () => {
		it('parses empty output', () => {
			expect(parseGitStatusPorcelain('')).toEqual([]);
			expect(parseGitStatusPorcelain('   ')).toEqual([]);
			expect(parseGitStatusPorcelain('\n')).toEqual([]);
		});

		it('parses modified files', () => {
			const output = ' M src/index.ts\n M src/utils.ts\n';
			const result = parseGitStatusPorcelain(output);
			expect(result).toEqual([
				{ path: 'src/index.ts', status: ' M' },
				{ path: 'src/utils.ts', status: ' M' },
			]);
		});

		it('parses untracked files', () => {
			const output = '?? new-file.ts\n?? another.ts\n';
			const result = parseGitStatusPorcelain(output);
			expect(result).toEqual([
				{ path: 'new-file.ts', status: '??' },
				{ path: 'another.ts', status: '??' },
			]);
		});

		it('parses staged files', () => {
			const output = 'A  staged.ts\nM  modified-staged.ts\n';
			const result = parseGitStatusPorcelain(output);
			expect(result).toEqual([
				{ path: 'staged.ts', status: 'A ' },
				{ path: 'modified-staged.ts', status: 'M ' },
			]);
		});

		it('parses renamed files', () => {
			const output = 'R  old-name.ts -> new-name.ts\n';
			const result = parseGitStatusPorcelain(output);
			expect(result).toEqual([{ path: 'old-name.ts', status: 'R ' }]);
		});

		it('parses deleted files', () => {
			const output = ' D deleted.ts\nD  staged-delete.ts\n';
			const result = parseGitStatusPorcelain(output);
			expect(result).toEqual([
				{ path: 'deleted.ts', status: ' D' },
				{ path: 'staged-delete.ts', status: 'D ' },
			]);
		});

		it('parses mixed status codes', () => {
			const output = 'MM both-modified.ts\nAM added-then-modified.ts\n';
			const result = parseGitStatusPorcelain(output);
			expect(result).toEqual([
				{ path: 'both-modified.ts', status: 'MM' },
				{ path: 'added-then-modified.ts', status: 'AM' },
			]);
		});

		it('handles null/undefined input gracefully', () => {
			expect(parseGitStatusPorcelain(null as unknown as string)).toEqual([]);
			expect(parseGitStatusPorcelain(undefined as unknown as string)).toEqual([]);
		});
	});

	describe('countUncommittedChanges', () => {
		it('returns 0 for empty output', () => {
			expect(countUncommittedChanges('')).toBe(0);
			expect(countUncommittedChanges('   ')).toBe(0);
			expect(countUncommittedChanges('\n')).toBe(0);
		});

		it('counts changes correctly', () => {
			expect(countUncommittedChanges(' M file1.ts\n M file2.ts\n')).toBe(2);
			expect(countUncommittedChanges(' M file1.ts\n')).toBe(1);
		});
	});

	describe('hasUncommittedChanges', () => {
		it('returns false for empty output', () => {
			expect(hasUncommittedChanges('')).toBe(false);
			expect(hasUncommittedChanges('   ')).toBe(false);
			expect(hasUncommittedChanges('\n  \n')).toBe(false);
		});

		it('returns true for non-empty output', () => {
			expect(hasUncommittedChanges(' M file.ts')).toBe(true);
		});
	});

	describe('parseGitNumstat', () => {
		it('parses empty output', () => {
			expect(parseGitNumstat('')).toEqual([]);
			expect(parseGitNumstat('   ')).toEqual([]);
		});

		it('parses numstat output', () => {
			const output = '10\t5\tsrc/index.ts\n20\t0\tsrc/new.ts\n';
			const result = parseGitNumstat(output);
			expect(result).toEqual([
				{ path: 'src/index.ts', additions: 10, deletions: 5 },
				{ path: 'src/new.ts', additions: 20, deletions: 0 },
			]);
		});

		it('handles binary files (- values)', () => {
			const output = '-\t-\timage.png\n10\t5\ttext.ts\n';
			const result = parseGitNumstat(output);
			expect(result).toEqual([
				{ path: 'image.png', additions: 0, deletions: 0 },
				{ path: 'text.ts', additions: 10, deletions: 5 },
			]);
		});

		it('handles null/undefined input gracefully', () => {
			expect(parseGitNumstat(null as unknown as string)).toEqual([]);
			expect(parseGitNumstat(undefined as unknown as string)).toEqual([]);
		});
	});

	describe('parseGitBehindAhead', () => {
		it('parses empty output', () => {
			expect(parseGitBehindAhead('')).toEqual({ behind: 0, ahead: 0 });
			expect(parseGitBehindAhead('   ')).toEqual({ behind: 0, ahead: 0 });
		});

		it('parses behind/ahead counts', () => {
			expect(parseGitBehindAhead('3\t5')).toEqual({ behind: 3, ahead: 5 });
			expect(parseGitBehindAhead('0\t10')).toEqual({ behind: 0, ahead: 10 });
			expect(parseGitBehindAhead('5\t0')).toEqual({ behind: 5, ahead: 0 });
		});

		it('handles whitespace variations', () => {
			expect(parseGitBehindAhead('  3  5  ')).toEqual({ behind: 3, ahead: 5 });
			expect(parseGitBehindAhead('3\t\t5\n')).toEqual({ behind: 3, ahead: 5 });
		});

		it('handles invalid input gracefully', () => {
			// parseInt on invalid string returns NaN, which || 0 converts to 0
			expect(parseGitBehindAhead('invalid')).toEqual({ behind: 0, ahead: 0 });
			expect(parseGitBehindAhead(null as unknown as string)).toEqual({ behind: 0, ahead: 0 });
		});
	});

	describe('parseGitBranches', () => {
		it('parses empty output', () => {
			expect(parseGitBranches('')).toEqual([]);
			expect(parseGitBranches('   ')).toEqual([]);
		});

		it('parses local branches', () => {
			const output = 'main\nfeature/foo\ndevelop\n';
			expect(parseGitBranches(output)).toEqual(['main', 'feature/foo', 'develop']);
		});

		it('removes origin/ prefix and deduplicates', () => {
			const output = 'main\norigin/main\nfeature/foo\norigin/feature/foo\n';
			expect(parseGitBranches(output)).toEqual(['main', 'feature/foo']);
		});

		it('filters out HEAD', () => {
			const output = 'main\nHEAD\nfeature\n';
			expect(parseGitBranches(output)).toEqual(['main', 'feature']);
		});

		it('handles whitespace', () => {
			const output = '  main  \n  feature  \n';
			expect(parseGitBranches(output)).toEqual(['main', 'feature']);
		});
	});

	describe('parseGitTags', () => {
		it('parses empty output', () => {
			expect(parseGitTags('')).toEqual([]);
			expect(parseGitTags('   ')).toEqual([]);
		});

		it('parses tags', () => {
			const output = 'v1.0.0\nv1.1.0\nv2.0.0\n';
			expect(parseGitTags(output)).toEqual(['v1.0.0', 'v1.1.0', 'v2.0.0']);
		});

		it('handles whitespace', () => {
			const output = '  v1.0.0  \n  v2.0.0  \n';
			expect(parseGitTags(output)).toEqual(['v1.0.0', 'v2.0.0']);
		});
	});

	describe('cleanBranchName', () => {
		it('trims whitespace', () => {
			expect(cleanBranchName('  main  ')).toBe('main');
			expect(cleanBranchName('feature/foo\n')).toBe('feature/foo');
		});

		it('handles empty/null input', () => {
			expect(cleanBranchName('')).toBe('');
			expect(cleanBranchName(null as unknown as string)).toBe('');
			expect(cleanBranchName(undefined as unknown as string)).toBe('');
		});
	});

	describe('cleanGitPath', () => {
		it('trims whitespace', () => {
			expect(cleanGitPath('  /path/to/repo  ')).toBe('/path/to/repo');
			expect(cleanGitPath('/path/to/repo\n')).toBe('/path/to/repo');
		});

		it('handles empty/null input', () => {
			expect(cleanGitPath('')).toBe('');
			expect(cleanGitPath(null as unknown as string)).toBe('');
		});
	});

	describe('remoteUrlToBrowserUrl', () => {
		it('handles empty/null input', () => {
			expect(remoteUrlToBrowserUrl('')).toBeNull();
			expect(remoteUrlToBrowserUrl(null as unknown as string)).toBeNull();
		});

		it('converts SSH format', () => {
			expect(remoteUrlToBrowserUrl('git@github.com:user/repo.git')).toBe(
				'https://github.com/user/repo'
			);
			expect(remoteUrlToBrowserUrl('git@gitlab.com:user/repo.git')).toBe(
				'https://gitlab.com/user/repo'
			);
		});

		it('converts HTTPS format', () => {
			expect(remoteUrlToBrowserUrl('https://github.com/user/repo.git')).toBe(
				'https://github.com/user/repo'
			);
			expect(remoteUrlToBrowserUrl('https://github.com/user/repo')).toBe(
				'https://github.com/user/repo'
			);
		});

		it('converts HTTP format', () => {
			expect(remoteUrlToBrowserUrl('http://github.com/user/repo.git')).toBe(
				'http://github.com/user/repo'
			);
		});

		it('converts ssh:// format', () => {
			expect(remoteUrlToBrowserUrl('ssh://git@github.com/user/repo.git')).toBe(
				'https://github.com/user/repo'
			);
			expect(remoteUrlToBrowserUrl('ssh://github.com/user/repo.git')).toBe(
				'https://github.com/user/repo'
			);
		});

		it('handles whitespace', () => {
			expect(remoteUrlToBrowserUrl('  git@github.com:user/repo.git  ')).toBe(
				'https://github.com/user/repo'
			);
		});

		it('returns null for unknown formats', () => {
			expect(remoteUrlToBrowserUrl('unknown://something')).toBeNull();
			expect(remoteUrlToBrowserUrl('just-a-string')).toBeNull();
		});
	});

	describe('isImageFile', () => {
		it('identifies image files', () => {
			expect(isImageFile('image.png')).toBe(true);
			expect(isImageFile('photo.jpg')).toBe(true);
			expect(isImageFile('photo.jpeg')).toBe(true);
			expect(isImageFile('animation.gif')).toBe(true);
			expect(isImageFile('icon.svg')).toBe(true);
			expect(isImageFile('icon.ico')).toBe(true);
			expect(isImageFile('image.webp')).toBe(true);
			expect(isImageFile('image.bmp')).toBe(true);
		});

		it('rejects non-image files', () => {
			expect(isImageFile('code.ts')).toBe(false);
			expect(isImageFile('data.json')).toBe(false);
			expect(isImageFile('readme.md')).toBe(false);
			expect(isImageFile('noextension')).toBe(false);
		});

		it('handles paths with directories', () => {
			expect(isImageFile('/path/to/image.png')).toBe(true);
			expect(isImageFile('folder/code.ts')).toBe(false);
		});

		it('is case insensitive', () => {
			expect(isImageFile('image.PNG')).toBe(true);
			expect(isImageFile('image.Jpg')).toBe(true);
		});
	});

	describe('getImageMimeType', () => {
		it('returns correct MIME types', () => {
			expect(getImageMimeType('png')).toBe('image/png');
			expect(getImageMimeType('jpg')).toBe('image/jpeg');
			expect(getImageMimeType('jpeg')).toBe('image/jpeg');
			expect(getImageMimeType('gif')).toBe('image/gif');
			expect(getImageMimeType('svg')).toBe('image/svg+xml');
			expect(getImageMimeType('webp')).toBe('image/webp');
			expect(getImageMimeType('ico')).toBe('image/ico');
			expect(getImageMimeType('bmp')).toBe('image/bmp');
		});
	});
});
