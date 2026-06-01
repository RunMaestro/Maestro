import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dragHasOsFiles, getDroppedPaths } from '../../../renderer/utils/osFileDrop';

const mockGetPathForFile = vi.fn();
(window as any).maestro = {
	fs: { getPathForFile: (file: unknown) => mockGetPathForFile(file) },
};

function makeDataTransfer(types: string[], files: Array<{ path: string }> = []): DataTransfer {
	return { types, files } as unknown as DataTransfer;
}

describe('osFileDrop', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetPathForFile.mockImplementation((file: { path?: string }) => file.path ?? '');
	});

	describe('dragHasOsFiles', () => {
		it('returns true when the drag carries the Files type', () => {
			expect(dragHasOsFiles(makeDataTransfer(['Files']))).toBe(true);
		});

		it('returns false for internal element drags', () => {
			expect(dragHasOsFiles(makeDataTransfer(['application/x-maestro-file-path']))).toBe(false);
		});

		it('returns false for a null dataTransfer', () => {
			expect(dragHasOsFiles(null)).toBe(false);
		});
	});

	describe('getDroppedPaths', () => {
		it('resolves every dropped file to its absolute path', () => {
			const dt = makeDataTransfer(['Files'], [{ path: '/a/one.txt' }, { path: '/b/two.png' }]);
			expect(getDroppedPaths(dt)).toEqual(['/a/one.txt', '/b/two.png']);
		});

		it('skips files whose path cannot be resolved', () => {
			const dt = makeDataTransfer(['Files'], [{ path: '/a/one.txt' }, { path: '' }]);
			expect(getDroppedPaths(dt)).toEqual(['/a/one.txt']);
		});

		it('returns an empty array for a null dataTransfer', () => {
			expect(getDroppedPaths(null)).toEqual([]);
		});
	});
});
