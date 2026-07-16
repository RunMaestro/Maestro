import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockWriteFile, mockRename, mockUnlink, mockOpen } = vi.hoisted(() => ({
	mockWriteFile: vi.fn(),
	mockRename: vi.fn(),
	mockUnlink: vi.fn(),
	mockOpen: vi.fn(),
}));

vi.mock('fs/promises', () => ({
	writeFile: mockWriteFile,
	rename: mockRename,
	unlink: mockUnlink,
	open: mockOpen,
}));

import { atomicWriteFile } from '../../../main/utils/atomic-json-store';

function errno(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(code), { code });
}

describe('atomicWriteFile policy', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		mockWriteFile.mockResolvedValue(undefined);
		mockRename.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('writes a deterministic sibling temp file with the requested permissions before replacement', async () => {
		await atomicWriteFile('/state/plugin.json', '{"enabled":true}', { mode: 0o600 });

		expect(mockWriteFile).toHaveBeenCalledWith('/state/plugin.json.tmp', '{"enabled":true}', {
			encoding: 'utf-8',
			mode: 0o600,
		});
		expect(mockRename).toHaveBeenCalledWith('/state/plugin.json.tmp', '/state/plugin.json');
	});

	it('retries Windows-style transient replacement locks with exponential backoff', async () => {
		mockRename.mockRejectedValueOnce(errno('EPERM')).mockRejectedValueOnce(errno('EBUSY'));
		const write = atomicWriteFile('C:\\Users\\Ada\\state.json', 'next');

		await vi.advanceTimersByTimeAsync(300);
		await write;

		expect(mockRename).toHaveBeenCalledTimes(3);
		expect(mockRename).toHaveBeenLastCalledWith(
			'C:\\Users\\Ada\\state.json.tmp',
			'C:\\Users\\Ada\\state.json'
		);
	});

	it('surfaces a non-transient replacement failure without broadening cleanup or fsync policy', async () => {
		mockRename.mockRejectedValueOnce(errno('EACCES'));

		await expect(atomicWriteFile('/state/plugin.json', 'next')).rejects.toMatchObject({
			code: 'EACCES',
		});
		expect(mockUnlink).not.toHaveBeenCalled();
		expect(mockOpen).not.toHaveBeenCalled();
	});
});
