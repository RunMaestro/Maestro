import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	dragHasOsFiles,
	getDroppedPaths,
	uploadPathlessFile,
	MAX_BROWSER_UPLOAD_BYTES,
} from '../../../renderer/utils/osFileDrop';

const mockGetPathForFile = vi.fn();
const mockSaveAttachment = vi.fn();
(window as any).maestro = {
	fs: { getPathForFile: (file: unknown) => mockGetPathForFile(file) },
	attachments: {
		save: (sessionId: string, base64: string, filename: string) =>
			mockSaveAttachment(sessionId, base64, filename),
	},
};

function makeDataTransfer(types: string[], files: Array<{ path: string }> = []): DataTransfer {
	return { types, files } as unknown as DataTransfer;
}

describe('osFileDrop', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetPathForFile.mockImplementation((file: { path?: string }) => file.path ?? '');
		// Mirror the host: the file lands under whatever name it was saved as.
		mockSaveAttachment.mockImplementation((sessionId: string, _b64: string, filename: string) =>
			Promise.resolve({ success: true, path: `/userData/attachments/${sessionId}/${filename}` })
		);
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

	describe('uploadPathlessFile', () => {
		it('uploads the bytes as raw base64 and resolves with the host path', async () => {
			const file = new File(['hello'], 'notes.pdf', { type: 'application/pdf' });

			const saved = await uploadPathlessFile(file, 'session-1');

			expect(saved).toMatch(/^\/userData\/attachments\/session-1\/notes-[0-9a-z]+\.pdf$/);
			const [sessionId, base64, filename] = mockSaveAttachment.mock.calls[0];
			expect(sessionId).toBe('session-1');
			// The readable name survives, with a token that keeps the write from
			// clobbering an earlier attachment of the same name.
			expect(filename).toMatch(/^notes-[0-9a-z]+\.pdf$/);
			// Raw base64 only - the `data:...;base64,` prefix would be written to
			// disk verbatim by attachments:save and corrupt the file.
			expect(base64).not.toContain('base64,');
			expect(atob(base64)).toBe('hello');
		});

		it('does not overwrite an earlier attachment with the same name', async () => {
			// `attachments:save` writes straight to <dir>/<filename>, so two
			// different files dropped as `notes.pdf` must not land on each other -
			// the first drop's @mention would silently start reading the second
			// file's bytes.
			const first = await uploadPathlessFile(new File(['one'], 'notes.pdf'), 'session-1');
			const second = await uploadPathlessFile(new File(['two'], 'notes.pdf'), 'session-1');

			expect(first).not.toBe(second);
		});

		it('keeps an extensionless name intact', async () => {
			await uploadPathlessFile(new File(['x'], 'Makefile'), 'session-1');

			expect(mockSaveAttachment.mock.calls[0][2]).toMatch(/^Makefile-[0-9a-z]+$/);
		});

		it('treats a dotfile name as a name, not an extension', async () => {
			await uploadPathlessFile(new File(['x'], '.env'), 'session-1');

			expect(mockSaveAttachment.mock.calls[0][2]).toMatch(/^\.env-[0-9a-z]+$/);
		});

		it('rejects files above the upload limit without calling the host', async () => {
			const file = new File(['x'], 'huge.zip');
			Object.defineProperty(file, 'size', { value: MAX_BROWSER_UPLOAD_BYTES + 1 });

			await expect(uploadPathlessFile(file, 'session-1')).rejects.toThrow(/upload limit/);
			expect(mockSaveAttachment).not.toHaveBeenCalled();
		});

		it('rejects with the host error when the save fails', async () => {
			mockSaveAttachment.mockResolvedValue({ success: false, error: 'disk full' });
			const file = new File(['hello'], 'notes.pdf');

			await expect(uploadPathlessFile(file, 'session-1')).rejects.toThrow('disk full');
		});
	});
});
