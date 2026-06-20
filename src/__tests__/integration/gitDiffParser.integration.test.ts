import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../renderer/utils/logger';

const parseDiffMock = vi.hoisted(() => vi.fn());

vi.mock('react-diff-view', async (importOriginal) => {
	const actual = await importOriginal<typeof import('react-diff-view')>();
	return {
		...actual,
		parseDiff: parseDiffMock,
	};
});

import { getDiffStats, getFileName, parseGitDiff } from '../../renderer/utils/gitDiffParser';

describe('gitDiffParser integration', () => {
	let loggerError: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		parseDiffMock.mockReset();
		loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		loggerError.mockRestore();
	});

	it('returns no files for blank diff text', () => {
		expect(parseGitDiff('')).toEqual([]);
		expect(parseGitDiff('   \n\t')).toEqual([]);
		expect(parseDiffMock).not.toHaveBeenCalled();
	});

	it('parses text, binary image, new, deleted, and unknown-path file sections', () => {
		parseDiffMock.mockReturnValue([{ type: 'modify', hunks: [] }]);
		const diffText = [
			'diff --git a/src/app.ts b/src/app.ts',
			'index 111..222 100644',
			'--- a/src/app.ts',
			'+++ b/src/app.ts',
			'@@ -1 +1 @@',
			'-old',
			'+new',
			'diff --git a/assets/logo.png b/assets/logo.png',
			'new file mode 100644',
			'Binary files /dev/null and b/assets/logo.png differ',
			'diff --git a/src/old.ts b/src/old.ts',
			'deleted file mode 100644',
			'--- a/src/old.ts',
			'+++ /dev/null',
			'diff --git malformed header',
			'@@ -1 +1 @@',
			'-x',
			'+y',
			'diff --git a/src/no-extension b/src/no-extension.',
			'@@ -1 +1 @@',
			'-empty',
			'+path',
		].join('\n');

		const files = parseGitDiff(diffText);

		expect(files).toHaveLength(5);
		expect(files[0]).toMatchObject({
			oldPath: 'src/app.ts',
			newPath: 'src/app.ts',
			isBinary: false,
			isImage: false,
			isNewFile: false,
			isDeletedFile: false,
		});
		expect(files[0].parsedDiff).toEqual([{ type: 'modify', hunks: [] }]);
		expect(files[1]).toMatchObject({
			oldPath: 'assets/logo.png',
			newPath: 'assets/logo.png',
			isBinary: true,
			isImage: true,
			isNewFile: true,
			isDeletedFile: false,
			parsedDiff: [],
		});
		expect(files[2]).toMatchObject({
			oldPath: 'src/old.ts',
			newPath: 'src/old.ts',
			isDeletedFile: true,
		});
		expect(files[3]).toMatchObject({
			oldPath: 'unknown',
			newPath: 'unknown',
			isImage: false,
		});
		expect(files[4]).toMatchObject({
			oldPath: 'src/no-extension',
			newPath: 'src/no-extension.',
			isImage: false,
		});
		expect(parseDiffMock).toHaveBeenCalledTimes(4);
	});

	it('falls back to an unparsed file structure when react diff parsing fails', () => {
		parseDiffMock.mockImplementation(() => {
			throw new Error('parse failed');
		});
		const diffText = [
			'diff --git a/src/broken.ts b/src/broken.ts',
			'--- a/src/broken.ts',
			'+++ b/src/broken.ts',
			'@@ -1 +1 @@',
			'-broken',
			'+fixed',
		].join('\n');

		expect(parseGitDiff(diffText)).toEqual([
			expect.objectContaining({
				oldPath: 'src/broken.ts',
				newPath: 'src/broken.ts',
				parsedDiff: [],
				isBinary: false,
				isImage: false,
			}),
		]);
		expect(loggerError).toHaveBeenCalledWith(
			'Failed to parse diff section:',
			undefined,
			expect.any(Error)
		);
	});

	it('extracts filenames and counts inserted and deleted changes', () => {
		expect(getFileName('/workspaces/maestro/src/app.ts')).toBe('app.ts');

		const stats = getDiffStats([
			{
				hunks: [
					{
						changes: [
							{ type: 'insert' },
							{ type: 'delete' },
							{ type: 'normal' },
							{ type: 'insert' },
						],
					},
				],
			},
		] as never);

		expect(stats).toEqual({ additions: 2, deletions: 1 });
	});
});
