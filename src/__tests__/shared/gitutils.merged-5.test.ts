// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/shared/gitUtils.test.ts
// Source: src/__tests__/shared/mermaidSource.test.ts
import { describe, it, expect } from 'vitest';
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
	remoteUrlToBrowserUrl,
	isImageFile,
	getImageMimeType,
	isWorktreeAlreadyUsedError,
	isNotAGitRepositoryError,
	parseWorktreePathForBranch,
	sanitizeGitBranchName,
	formatGitChangeSummary,
} from '../../shared/gitUtils';
import { normalizeMermaidSource } from '../../shared/mermaidSource';
// Source: src/__tests__/shared/gitUtils.test.ts
describe('', () => {
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
			it('handles malformed HTTPS+SSH hybrid URLs (MAESTRO-43)', () => {
				// Some git clients may produce malformed URLs that mix HTTPS and SSH formats
				expect(remoteUrlToBrowserUrl('https://git@github.com:chancegraff/project-aig')).toBe(
					'https://github.com/chancegraff/project-aig'
				);
				expect(remoteUrlToBrowserUrl('http://git@github.com:user/repo.git')).toBe(
					'https://github.com/user/repo'
				);
				expect(remoteUrlToBrowserUrl('https://git@gitlab.com:org/project.git')).toBe(
					'https://gitlab.com/org/project'
				);
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
				expect(getImageMimeType('ico')).toBe('image/x-icon');
				expect(getImageMimeType('bmp')).toBe('image/bmp');
			});
			// A JPEG labeled `image/jpg` decodes to an empty NativeImage, which is what
			// broke "Copy Image" on every .jpg in the app.
			it('normalizes case and a leading dot', () => {
				expect(getImageMimeType('.JPG')).toBe('image/jpeg');
				expect(getImageMimeType('.PNG')).toBe('image/png');
				expect(getImageMimeType('SVG')).toBe('image/svg+xml');
			});
		});
		describe('isNotAGitRepositoryError', () => {
			it('detects the message git prints outside a repo', () => {
				expect(
					isNotAGitRepositoryError(
						'fatal: not a git repository (or any of the parent directories): .git'
					)
				).toBe(true);
			});
			it('detects a broken .git file pointing at a missing gitdir', () => {
				expect(
					isNotAGitRepositoryError('fatal: not a git repository: /repo/.git/worktrees/feature')
				).toBe(true);
			});
			it('returns false for connection, path, and empty errors', () => {
				expect(
					isNotAGitRepositoryError('ssh: connect to host example port 22: Connection refused')
				).toBe(false);
				expect(isNotAGitRepositoryError('cd: /missing: No such file or directory')).toBe(false);
				expect(isNotAGitRepositoryError('')).toBe(false);
				expect(isNotAGitRepositoryError(undefined)).toBe(false);
			});
		});
		describe('isWorktreeAlreadyUsedError', () => {
			it('detects modern git "already checked out" message', () => {
				expect(
					isWorktreeAlreadyUsedError(
						"fatal: 'fix/files-panel-polish' is already checked out at '/home/chris/code/wt/fix/files-panel-polish'"
					)
				).toBe(true);
			});
			it('detects legacy "already used by worktree" message', () => {
				expect(
					isWorktreeAlreadyUsedError(
						"fatal: 'main' is already used by worktree at '/home/chris/code/repo'"
					)
				).toBe(true);
			});
			it('is case insensitive', () => {
				expect(isWorktreeAlreadyUsedError("FATAL: 'b' IS ALREADY CHECKED OUT AT '/x'")).toBe(true);
			});
			it('returns false for unrelated errors', () => {
				expect(isWorktreeAlreadyUsedError('fatal: not a git repository')).toBe(false);
				expect(isWorktreeAlreadyUsedError("fatal: '/x' already exists")).toBe(false);
				expect(isWorktreeAlreadyUsedError('')).toBe(false);
			});
		});
		describe('parseWorktreePathForBranch', () => {
			const sample = [
				'worktree /home/chris/code/repo',
				'HEAD abc123',
				'branch refs/heads/main',
				'',
				'worktree /home/chris/code/wt/fix/files-panel-polish',
				'HEAD def456',
				'branch refs/heads/fix/files-panel-polish',
				'',
				'worktree /home/chris/code/wt/detached',
				'HEAD 789abc',
				'detached',
			].join('\n');
			it('returns the worktree path for a matching branch', () => {
				expect(parseWorktreePathForBranch(sample, 'fix/files-panel-polish')).toBe(
					'/home/chris/code/wt/fix/files-panel-polish'
				);
			});
			it('returns the worktree path for the main repo branch', () => {
				expect(parseWorktreePathForBranch(sample, 'main')).toBe('/home/chris/code/repo');
			});
			it('returns null when the branch is not found', () => {
				expect(parseWorktreePathForBranch(sample, 'nope')).toBeNull();
			});
			it('skips detached worktrees', () => {
				expect(parseWorktreePathForBranch(sample, 'detached')).toBeNull();
			});
			it('handles CRLF line endings', () => {
				const crlf = sample.replace(/\n/g, '\r\n');
				expect(parseWorktreePathForBranch(crlf, 'main')).toBe('/home/chris/code/repo');
			});
			it('returns null for empty input', () => {
				expect(parseWorktreePathForBranch('', 'main')).toBeNull();
				expect(parseWorktreePathForBranch(sample, '')).toBeNull();
			});
		});
		describe('sanitizeGitBranchName', () => {
			it('replaces internal whitespace with a single hyphen', () => {
				expect(sanitizeGitBranchName('Cue Dashboard')).toBe('Cue-Dashboard');
				expect(sanitizeGitBranchName('feature   xyz')).toBe('feature-xyz');
				expect(sanitizeGitBranchName('  leading and trailing  ')).toBe('leading-and-trailing');
			});
			it('substitutes characters that git refuses', () => {
				expect(sanitizeGitBranchName('feat~bad')).toBe('feat-bad');
				expect(sanitizeGitBranchName('with:colon')).toBe('with-colon');
				expect(sanitizeGitBranchName('star*name')).toBe('star-name');
				expect(sanitizeGitBranchName('back\\slash')).toBe('back-slash');
			});
			it('preserves valid characters and slashes', () => {
				expect(sanitizeGitBranchName('feature/auth-flow_v2.1')).toBe('feature/auth-flow_v2.1');
			});
			it('flattens forbidden sequences', () => {
				expect(sanitizeGitBranchName('a..b')).toBe('a.b');
				expect(sanitizeGitBranchName('a@{b')).toBe('a-b');
				expect(sanitizeGitBranchName('a//b')).toBe('a/b');
			});
			it('strips leading and trailing junk', () => {
				expect(sanitizeGitBranchName('-leading')).toBe('leading');
				expect(sanitizeGitBranchName('/leading')).toBe('leading');
				expect(sanitizeGitBranchName('trailing/')).toBe('trailing');
				expect(sanitizeGitBranchName('trailing.')).toBe('trailing');
				expect(sanitizeGitBranchName('feat.lock')).toBe('feat');
			});
			it('keeps a trailing hyphen because git branch names allow it', () => {
				expect(sanitizeGitBranchName('cue-dashboard-')).toBe('cue-dashboard-');
			});
			it('can preserve incomplete suffixes while editing a branch name', () => {
				expect(sanitizeGitBranchName('cue-', { allowIncomplete: true })).toBe('cue-');
				expect(sanitizeGitBranchName('feature/', { allowIncomplete: true })).toBe('feature/');
				expect(sanitizeGitBranchName('release/v1.', { allowIncomplete: true })).toBe('release/v1.');
				expect(sanitizeGitBranchName('feat.lock', { allowIncomplete: true })).toBe('feat.lock');
			});
			it('returns an empty string for input that has nothing usable', () => {
				expect(sanitizeGitBranchName('')).toBe('');
				expect(sanitizeGitBranchName('   ')).toBe('');
				expect(sanitizeGitBranchName('///')).toBe('');
			});
		});
		describe('formatGitChangeSummary', () => {
			it('reads out the line counts and the file total', () => {
				expect(
					formatGitChangeSummary({ fileCount: 5, additions: 206, deletions: 37, modified: 5 })
				).toBe('+206 −37 ~5 in 5 files');
			});
			it('omits the parts that are zero', () => {
				expect(
					formatGitChangeSummary({ fileCount: 1, additions: 12, deletions: 0, modified: 0 })
				).toBe('+12 in 1 file');
			});
			// Only the active agent is polled with numstat, so the rest have counts only.
			it('falls back to the file count when no lines were counted', () => {
				expect(
					formatGitChangeSummary({ fileCount: 4, additions: 0, deletions: 0, modified: 0 })
				).toBe('4 files changed');
			});
			it('reports a clean tree', () => {
				expect(
					formatGitChangeSummary({ fileCount: 0, additions: 0, deletions: 0, modified: 0 })
				).toBe('No uncommitted changes');
			});
		});
	});
});
// Source: src/__tests__/shared/mermaidSource.test.ts
describe('', () => {
	describe('normalizeMermaidSource', () => {
		describe('escapes @ where the edge-id rule would swallow it', () => {
			it('escapes an edge label that starts with @', () => {
				expect(normalizeMermaidSource('flowchart LR\n  C -->|@maestro from user| E[send]')).toBe(
					'flowchart LR\n  C -->|#64;maestro from user| E[send]'
				);
			});
			it('escapes @ inside an edge label regardless of arrow style', () => {
				for (const arrow of ['-->', '-.->', '==>', '---']) {
					expect(normalizeMermaidSource(`flowchart LR\n  A ${arrow}|a@b| B`)).toBe(
						`flowchart LR\n  A ${arrow}|a#64;b| B`
					);
				}
			});
			it('escapes @ in node labels of every bracket shape', () => {
				for (const [open, close] of [
					['[', ']'],
					['(', ')'],
					['{', '}'],
					['([', '])'],
				]) {
					expect(normalizeMermaidSource(`flowchart LR\n  A${open}a@b${close} --> B`)).toBe(
						`flowchart LR\n  A${open}a#64;b${close} --> B`
					);
				}
			});
			it('quotes a bare subgraph title containing @', () => {
				// `#64;` is no help here: the `;` reads as a statement separator, so
				// quoting is the only repair the grammar accepts.
				expect(normalizeMermaidSource('flowchart LR\n  subgraph @maestro team\n  end')).toBe(
					'flowchart LR\n  subgraph "@maestro team"\n  end'
				);
			});
			it('leaves the `subgraph id [Title]` form to the bracket scanner', () => {
				expect(normalizeMermaidSource('flowchart LR\n  subgraph one [Title @x]\n  end')).toBe(
					'flowchart LR\n  subgraph one [Title #64;x]\n  end'
				);
			});
		});
		describe('leaves @ alone where the grammar owns it', () => {
			it('preserves an edge id', () => {
				const source = 'flowchart LR\n  A e1@--> B\n  e1@{ animate: true }';
				expect(normalizeMermaidSource(source)).toBe(source);
			});
			it('preserves shape data, including an @ inside its quoted label', () => {
				const source = 'flowchart LR\n  A@{ shape: rect, label: "a@b" } --> B';
				expect(normalizeMermaidSource(source)).toBe(source);
			});
			it('preserves a quoted label, which the lexer rule already stops at', () => {
				const source = 'flowchart LR\n  A["a@b"] -->|"@x"| B';
				expect(normalizeMermaidSource(source)).toBe(source);
			});
			it('preserves comments and quoted click targets', () => {
				const source =
					'flowchart LR\n  %% ping @bob\n  A --> B\n  click A href "https://x.com/@user" _blank';
				expect(normalizeMermaidSource(source)).toBe(source);
			});
			it('leaves non-flowchart diagrams untouched', () => {
				// Only the flowchart grammar has the edge-id rule.
				const source = 'sequenceDiagram\n  Alice->>Bob: hi @bob';
				expect(normalizeMermaidSource(source)).toBe(source);
			});
			it('returns the source unchanged when it has no @ at all', () => {
				const source = 'flowchart LR\n  A[one] --> B[two]';
				expect(normalizeMermaidSource(source)).toBe(source);
			});
		});
		describe('quotes a dotted-link label the lexer would read as syntax', () => {
			it('quotes a label carrying a filename, spaced or not', () => {
				expect(normalizeMermaidSource('flowchart LR\n  A -. persists in a.json .-> B')).toBe(
					'flowchart LR\n  A -. "persists in a.json" .-> B'
				);
				expect(normalizeMermaidSource('flowchart LR\n  A-.persists in a.json.->B')).toBe(
					'flowchart LR\n  A-."persists in a.json".->B'
				);
			});
			it('quotes the label of every dotted arrow head and length', () => {
				for (const close of ['.->', '.-', '.-x', '.-o', '..->', '...->']) {
					expect(normalizeMermaidSource(`flowchart LR\n  A -. a.json ${close} B`)).toBe(
						`flowchart LR\n  A -. "a.json" ${close} B`
					);
				}
			});
			it('leaves a bracket alone, which an inline label reads as prose', () => {
				const source = 'flowchart LR\n  A -. reads (json) .-> B';
				expect(normalizeMermaidSource(source)).toBe(source);
			});
			it('quotes a thick link whose label carries an =', () => {
				expect(normalizeMermaidSource('flowchart LR\n  A == a = b ==> B')).toBe(
					'flowchart LR\n  A == "a = b" ==> B'
				);
			});
			it('leaves a bare thick connector alone', () => {
				for (const link of ['==>', '===>', '==', '==x', '==o']) {
					const source = `flowchart LR\n  A ${link} B`;
					expect(normalizeMermaidSource(source)).toBe(source);
				}
			});
			it('quotes rather than escapes a dotted label that also carries @', () => {
				expect(normalizeMermaidSource('flowchart LR\n  A -. from @maestro v1.2 .-> B')).toBe(
					'flowchart LR\n  A -. "from @maestro v1.2" .-> B'
				);
			});
			it('leaves a bare dotted connector alone', () => {
				for (const link of ['-.->', '-.-', '-..->', '-.-x', '-.-o']) {
					const source = `flowchart LR\n  A ${link} B`;
					expect(normalizeMermaidSource(source)).toBe(source);
				}
			});
			it('leaves a dotted label that already parses alone', () => {
				for (const source of [
					'flowchart LR\n  A -. reads it .-> B',
					'flowchart LR\n  A -. "a.json" .-> B',
					'flowchart LR\n  A -.->|reads a.json| B',
				]) {
					expect(normalizeMermaidSource(source)).toBe(source);
				}
			});
			it('leaves a dotted link in a non-flowchart diagram alone', () => {
				const source = 'sequenceDiagram\n  A->>B: reads a.json';
				expect(normalizeMermaidSource(source)).toBe(source);
			});
			it('is idempotent - a second pass finds nothing left to quote', () => {
				const once = normalizeMermaidSource('flowchart LR\n  A -. persists in a.json .-> B');
				expect(normalizeMermaidSource(once)).toBe(once);
			});
		});
		describe('quotes a node or pipe label carrying a bracket', () => {
			it('quotes a bracketed label in every node shape', () => {
				for (const [open, close] of [
					['[', ']'],
					['(', ')'],
					['([', '])'],
					['[[', ']]'],
					['[(', ')]'],
					['((', '))'],
					['{', '}'],
					['{{', '}}'],
					['[/', '/]'],
					['[\\', '\\]'],
				]) {
					expect(normalizeMermaidSource(`flowchart LR\n  A${open}reads (json)${close} --> B`)).toBe(
						`flowchart LR\n  A${open}"reads (json)"${close} --> B`
					);
				}
			});
			it('quotes a pipe label carrying a bracket', () => {
				expect(normalizeMermaidSource('flowchart LR\n  A -->|writes {a,b}| B')).toBe(
					'flowchart LR\n  A -->|"writes {a,b}"| B'
				);
			});
			it('quotes a label whose own brackets balance', () => {
				expect(normalizeMermaidSource('flowchart LR\n  A[a [b] c] --> B')).toBe(
					'flowchart LR\n  A["a [b] c"] --> B'
				);
			});
			it('quotes rather than escapes when a label carries both a bracket and @', () => {
				expect(normalizeMermaidSource('flowchart LR\n  A[reads (json) from @svc] --> B')).toBe(
					'flowchart LR\n  A["reads (json) from @svc"] --> B'
				);
			});
			it('keeps surrounding whitespace outside the quotes', () => {
				expect(normalizeMermaidSource('flowchart LR\n  A[ a (b) ] --> C')).toBe(
					'flowchart LR\n  A[ "a (b)" ] --> C'
				);
			});
			it('quotes each label on a line that carries several', () => {
				expect(normalizeMermaidSource('flowchart LR\n  A[x (1)] -->|to (2)| B[y (3)]')).toBe(
					'flowchart LR\n  A["x (1)"] -->|"to (2)"| B["y (3)"]'
				);
			});
			it('leaves a label with no bracket alone', () => {
				const source = 'flowchart LR\n  A[reads a.json] -->|then| B[two]';
				expect(normalizeMermaidSource(source)).toBe(source);
			});
			it('leaves a bracket that is not glued to a node id alone', () => {
				const source = 'flowchart LR\n  A -- reads (json) --> B';
				expect(normalizeMermaidSource(source)).toBe(source);
			});
			it('leaves an already quoted label and a markdown string alone', () => {
				for (const source of [
					'flowchart LR\n  A["reads (json)"] --> B',
					'flowchart LR\n  A["`**bold** (text)`"] --> B',
				]) {
					expect(normalizeMermaidSource(source)).toBe(source);
				}
			});
			it('leaves shape data, comments, and statement lines alone', () => {
				for (const source of [
					'flowchart LR\n  A@{ shape: rect, label: "hi (there)" }\n  A --> B',
					'flowchart LR\n  %% a (comment) here\n  A --> B',
					'flowchart LR\n  A --> B\n  click A "https://x.com" "tip (here)"',
					'flowchart LR\n  A --> B\n  style A fill:#f00,stroke-width:2px',
				]) {
					expect(normalizeMermaidSource(source)).toBe(source);
				}
			});
			it('leaves an unbalanced bracket alone rather than guessing where a label ends', () => {
				const source = 'flowchart LR\n  A[unclosed (\n  B --> C';
				expect(normalizeMermaidSource(source)).toBe(source);
			});
			it('is idempotent - a second pass finds nothing left to quote', () => {
				const once = normalizeMermaidSource('flowchart LR\n  A[reads (json)] -->|to {x}| B');
				expect(normalizeMermaidSource(once)).toBe(once);
			});
			it('quotes a pipe inside a node label', () => {
				expect(normalizeMermaidSource('flowchart LR\n  A[a|b] --> B')).toBe(
					'flowchart LR\n  A["a|b"] --> B'
				);
			});
			it('leaves a pipe alone in the slash shapes, which tolerate one', () => {
				for (const [open, close] of [
					['[/', '/]'],
					['[\\', '\\]'],
					['[/', '\\]'],
					['[\\', '/]'],
				]) {
					const source = `flowchart LR\n  A${open}a|b${close} --> B`;
					expect(normalizeMermaidSource(source)).toBe(source);
				}
			});
			it('does not mistake a pipe inside a node label for an edge delimiter', () => {
				expect(normalizeMermaidSource('flowchart LR\n  A --> B((a|b))')).toBe(
					'flowchart LR\n  A --> B(("a|b"))'
				);
			});
			it('finds the label end when its own brackets do not balance', () => {
				expect(normalizeMermaidSource('flowchart LR\n  A([a b) c]) --> B')).toBe(
					'flowchart LR\n  A(["a b) c"]) --> B'
				);
				expect(normalizeMermaidSource('flowchart LR\n  A(a (b c) --> B')).toBe(
					'flowchart LR\n  A("a (b c") --> B'
				);
			});
			it('bounds that search at the link, so a later node is not swallowed', () => {
				expect(normalizeMermaidSource('flowchart LR\n  A(a (b c) --> B(x (y z)')).toBe(
					'flowchart LR\n  A("a (b c") --> B("x (y z")'
				);
			});
			it('declines the two ambiguous inputs rather than guessing', () => {
				for (const source of [
					// Which `|` closes the label is unknowable.
					'flowchart LR\n  A -->|a|b| B',
					// A bare quote cannot be told from the quoting this module adds.
					'flowchart LR\n  A[a "q" b] --> B',
				]) {
					expect(normalizeMermaidSource(source)).toBe(source);
				}
			});
		});
		describe('quotes a subgraph title in either of its forms', () => {
			it('quotes a bracketed title carrying a bracket', () => {
				expect(normalizeMermaidSource('flowchart LR\n  subgraph S1 [My (Title)]\n  end')).toBe(
					'flowchart LR\n  subgraph S1 ["My (Title)"]\n  end'
				);
			});
			it('quotes a bare title carrying a bracket or an @', () => {
				expect(normalizeMermaidSource('flowchart LR\n  subgraph My (Title)\n  end')).toBe(
					'flowchart LR\n  subgraph "My (Title)"\n  end'
				);
				expect(normalizeMermaidSource('flowchart LR\n  subgraph @maestro team\n  end')).toBe(
					'flowchart LR\n  subgraph "@maestro team"\n  end'
				);
			});
			it('leaves a title that already parses alone', () => {
				for (const source of [
					'flowchart LR\n  subgraph S1 [My Title]\n  end',
					'flowchart LR\n  subgraph Preview\n  end',
					'flowchart LR\n  subgraph S1 ["My (Title)"]\n  end',
				]) {
					expect(normalizeMermaidSource(source)).toBe(source);
				}
			});
		});
		describe('repairs a direction the header lexer does not recognize', () => {
			it('honours the first letter when the pair names two axes', () => {
				// `flowchart LD` is a lexical error on line 1 and takes the whole
				// diagram with it; `L` says the graph starts at the left.
				for (const [written, repaired] of [
					['LD', 'LR'],
					['TL', 'TB'],
					['RD', 'RL'],
					['BL', 'BT'],
				]) {
					expect(normalizeMermaidSource(`flowchart ${written}\n  A --> B`)).toBe(
						`flowchart ${repaired}\n  A --> B`
					);
				}
			});
			it('reads up/down as the same axis mermaid spells top/bottom', () => {
				expect(normalizeMermaidSource('flowchart UD\n  A --> B')).toBe('flowchart TB\n  A --> B');
				expect(normalizeMermaidSource('flowchart DU\n  A --> B')).toBe('flowchart BT\n  A --> B');
			});
			it('upper-cases a direction written in lower case', () => {
				for (const written of ['lr', 'Tb', 'td', 'bT', 'rl']) {
					expect(normalizeMermaidSource(`flowchart ${written}\n  A --> B`)).toBe(
						`flowchart ${written.toUpperCase()}\n  A --> B`
					);
				}
			});
			it('leaves the rest of the header line alone', () => {
				expect(normalizeMermaidSource('graph ld;A-->B')).toBe('graph LR;A-->B');
				expect(normalizeMermaidSource('flowchart-elk LD\n  A --> B')).toBe(
					'flowchart-elk LR\n  A --> B'
				);
			});
			it('repairs a per-subgraph direction statement, whose set excludes BR', () => {
				expect(normalizeMermaidSource('flowchart TB\n  subgraph S\n    direction ld\n  end')).toBe(
					'flowchart TB\n  subgraph S\n    direction LR\n  end'
				);
				expect(normalizeMermaidSource('flowchart TB\n  subgraph S\n    direction BR\n  end')).toBe(
					'flowchart TB\n  subgraph S\n    direction BT\n  end'
				);
			});
			it('repairs a direction behind frontmatter and init directives', () => {
				expect(
					normalizeMermaidSource(
						'---\ntitle: Flow\n---\n%%{init: {"theme":"dark"}}%%\nflowchart ud\n  A --> B'
					)
				).toContain('flowchart TB');
			});
			it('leaves a direction the parser already accepts byte-for-byte alone', () => {
				// `BR` and the arrow forms are in the header lexer; a header with no
				// direction at all parses too.
				for (const source of [
					'flowchart TD\n  A --> B',
					'flowchart LR;\n  A-->B',
					'graph BR\n  A --> B',
					'flowchart v\n  A --> B',
					'flowchart\n  A --> B',
					'flowchart TB\n  subgraph S\n    direction RL\n  end',
				]) {
					expect(normalizeMermaidSource(source)).toBe(source);
				}
			});
			it('leaves a token that is not two direction letters alone', () => {
				// Already a parse error, but guessing here would turn a failed render
				// into a wrong one.
				for (const source of [
					'graph D --> B',
					'flowchart XY\n  A --> B',
					'graph TOPDOWN\n  A --> B',
				]) {
					expect(normalizeMermaidSource(source)).toBe(source);
				}
			});
			it('leaves a non-flowchart diagram alone', () => {
				const source = 'stateDiagram-v2\n  direction lr\n  [*] --> S';
				expect(normalizeMermaidSource(source)).toBe(source);
			});
			it('is idempotent', () => {
				const once = normalizeMermaidSource('flowchart ld\n  A[a (b)] --> B');
				expect(normalizeMermaidSource(once)).toBe(once);
			});
		});
		describe('escapes what a timeline period cannot carry', () => {
			it('escapes a clock time in a period, leaving the events alone', () => {
				expect(
					normalizeMermaidSource('timeline\n    16:18 : Email received\n    21:57 : Fix at 22:23')
				).toBe('timeline\n    16#58;18 : Email received\n    21#58;57 : Fix at 22:23');
			});
			it('escapes a period that stands alone above its events', () => {
				expect(normalizeMermaidSource('timeline\n    16:18\n      : Email')).toBe(
					'timeline\n    16#58;18\n      : Email'
				);
			});
			it('escapes a # so the rest of the line is not read as a comment', () => {
				expect(normalizeMermaidSource('timeline\n    Issue #1710 : opened')).toBe(
					'timeline\n    Issue #35;1710 : opened'
				);
			});
			it('escapes every : in a section title, which cannot carry events', () => {
				expect(
					normalizeMermaidSource('timeline\n    section 12:00 - 14:00\n    section Day 1: start')
				).toBe('timeline\n    section 12#58;00 - 14#58;00\n    section Day 1#58; start');
			});
			it('leaves a timeline that already parses byte-for-byte alone', () => {
				const source =
					'---\ntitle: a:b\n---\ntimeline LR\n    title Report: (UTC)\n    accTitle: a:b\n    accDescr {\n    a:b\n    }\n    %% x:y\n    Oct 4 : 16:18 email : 17:23 fix\n    Oct 5:';
				expect(normalizeMermaidSource(source)).toBe(source);
			});
			it('is idempotent - existing entity codes pass through', () => {
				const once = normalizeMermaidSource(
					'timeline\n    16:18 #9 : a\n    section 12:00\n    x : y'
				);
				expect(normalizeMermaidSource(once)).toBe(once);
			});
			it('leaves : in a flowchart label alone', () => {
				const source = 'flowchart LR\n  A[a:b] --> B';
				expect(normalizeMermaidSource(source)).toBe(source);
			});
		});
		it('detects a flowchart behind frontmatter, comments, and init directives', () => {
			const source =
				'---\ntitle: Flow\n---\n%%{init: {"theme":"dark"}}%%\n%% note\n\nflowchart LR\n  A[a@b] --> B';
			expect(normalizeMermaidSource(source)).toContain('A[a#64;b]');
		});
		it('is idempotent - a second pass finds nothing left to escape', () => {
			const source = 'flowchart LR\n  C -->|@maestro| E[a@b]\n  subgraph @team\n  end';
			const once = normalizeMermaidSource(source);
			expect(normalizeMermaidSource(once)).toBe(once);
		});
		it('does not let an unbalanced bracket leak label state into the next line', () => {
			const source = 'flowchart LR\n  A[unclosed\n  B --> C\n  D e1@--> E';
			expect(normalizeMermaidSource(source)).toBe(source);
		});
	});
});
