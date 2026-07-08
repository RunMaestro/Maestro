import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

const { mockTmpdir, mockUnlink, mockWriteFileSync } = vi.hoisted(() => ({
	mockTmpdir: vi.fn(),
	mockUnlink: vi.fn(),
	mockWriteFileSync: vi.fn(),
}));

vi.mock('fs', () => ({
	default: {
		writeFileSync: mockWriteFileSync,
	},
	writeFileSync: mockWriteFileSync,
}));

vi.mock('fs/promises', () => ({
	default: {
		unlink: mockUnlink,
	},
	unlink: mockUnlink,
}));

vi.mock('os', () => ({
	default: {
		tmpdir: mockTmpdir,
	},
	tmpdir: mockTmpdir,
}));

vi.mock('../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

import { logger } from '../../main/utils/logger';
import {
	buildImagePromptPrefix,
	cleanupTempFiles,
	parseDataUrl,
	saveImageToTempFile,
} from '../../main/process-manager/utils/imageUtils';

describe('imageUtils', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockTmpdir.mockReturnValue('/tmp/maestro-tests');
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('parseDataUrl', () => {
		it('parses image data URLs into media type and base64 payload', () => {
			expect(parseDataUrl('data:image/png;base64,abc123')).toEqual({
				mediaType: 'image/png',
				base64: 'abc123',
			});
			expect(parseDataUrl('data:image/jpeg;base64,a+b/c=')).toEqual({
				mediaType: 'image/jpeg',
				base64: 'a+b/c=',
			});
		});

		it('rejects malformed or non-image data URLs', () => {
			expect(parseDataUrl('data:text/plain;base64,abc123')).toBeNull();
			expect(parseDataUrl('data:image/png,abc123')).toBeNull();
			expect(parseDataUrl('not-a-data-url')).toBeNull();
		});
	});

	describe('saveImageToTempFile', () => {
		it('writes a parsed data URL image to a deterministic temp path', () => {
			vi.spyOn(Date, 'now').mockReturnValue(123456);

			const result = saveImageToTempFile('data:image/png;base64,aGVsbG8=', 2);

			expect(result).toBe('/tmp/maestro-tests/maestro-image-123456-2.png');
			expect(mockWriteFileSync).toHaveBeenCalledWith(
				'/tmp/maestro-tests/maestro-image-123456-2.png',
				Buffer.from('aGVsbG8=', 'base64')
			);
			expect(logger.debug).toHaveBeenCalledWith(
				'[ProcessManager] Saved image to temp file',
				'ProcessManager',
				{
					tempPath: '/tmp/maestro-tests/maestro-image-123456-2.png',
					size: 5,
				}
			);
		});

		it('returns null and logs a warning for invalid data URLs', () => {
			expect(saveImageToTempFile('invalid', 0)).toBeNull();

			expect(mockWriteFileSync).not.toHaveBeenCalled();
			expect(logger.warn).toHaveBeenCalledWith(
				'[ProcessManager] Failed to parse data URL for temp file',
				'ProcessManager'
			);
		});

		it('returns null and logs an error when writing the temp file fails', () => {
			vi.spyOn(Date, 'now').mockReturnValue(999);
			mockWriteFileSync.mockImplementation(() => {
				throw new Error('disk full');
			});

			expect(saveImageToTempFile('data:image/webp;base64,abc123', 1)).toBeNull();

			expect(logger.error).toHaveBeenCalledWith(
				'[ProcessManager] Failed to save image to temp file',
				'ProcessManager',
				{ error: 'Error: disk full' }
			);
		});
	});

	describe('buildImagePromptPrefix', () => {
		it('should return empty string for empty array', () => {
			expect(buildImagePromptPrefix([])).toBe('');
		});

		it('should return prefix with single image path', () => {
			const result = buildImagePromptPrefix(['/tmp/maestro-image-123-0.png']);
			expect(result).toBe('[Attached images: /tmp/maestro-image-123-0.png]\n\n');
		});

		it('should return prefix with multiple image paths', () => {
			const result = buildImagePromptPrefix([
				'/tmp/maestro-image-123-0.png',
				'/tmp/maestro-image-123-1.jpg',
			]);
			expect(result).toBe(
				'[Attached images: /tmp/maestro-image-123-0.png, /tmp/maestro-image-123-1.jpg]\n\n'
			);
		});

		it('should handle Windows-style paths', () => {
			const result = buildImagePromptPrefix([
				'C:\\Users\\test\\AppData\\Local\\Temp\\maestro-image-0.png',
			]);
			expect(result).toBe(
				'[Attached images: C:\\Users\\test\\AppData\\Local\\Temp\\maestro-image-0.png]\n\n'
			);
		});
	});

	describe('cleanupTempFiles', () => {
		it('unlinks files and logs successful cleanup asynchronously', async () => {
			mockUnlink.mockResolvedValue(undefined);

			cleanupTempFiles(['/tmp/a.png', '/tmp/b.jpg']);
			await Promise.resolve();

			expect(mockUnlink).toHaveBeenCalledWith('/tmp/a.png');
			expect(mockUnlink).toHaveBeenCalledWith('/tmp/b.jpg');
			expect(logger.debug).toHaveBeenCalledWith(
				'[ProcessManager] Cleaned up temp file',
				'ProcessManager',
				{ file: '/tmp/a.png' }
			);
			expect(logger.debug).toHaveBeenCalledWith(
				'[ProcessManager] Cleaned up temp file',
				'ProcessManager',
				{ file: '/tmp/b.jpg' }
			);
		});

		it('ignores ENOENT cleanup failures', async () => {
			const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
			mockUnlink.mockRejectedValue(error);

			cleanupTempFiles(['/tmp/missing.png']);
			await Promise.resolve();
			await Promise.resolve();

			expect(logger.warn).not.toHaveBeenCalled();
		});

		it('logs non-ENOENT cleanup failures', async () => {
			mockUnlink.mockRejectedValue(
				Object.assign(new Error('permission denied'), { code: 'EACCES' })
			);

			cleanupTempFiles(['/tmp/protected.png']);
			await Promise.resolve();
			await Promise.resolve();

			expect(logger.warn).toHaveBeenCalledWith(
				'[ProcessManager] Failed to clean up temp file',
				'ProcessManager',
				{
					file: '/tmp/protected.png',
					error: 'Error: permission denied',
				}
			);
		});
	});
});
