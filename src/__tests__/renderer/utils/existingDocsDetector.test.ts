/**
 * Tests for existingDocsDetector.ts - Utility to detect existing Auto Run documents
 *
 * Functions tested:
 * - getAutoRunFolderPath
 * - hasExistingAutoRunDocs
 * - getExistingAutoRunDocs
 * - getExistingAutoRunDocsCount
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	AUTO_RUN_FOLDER_NAME,
	getAutoRunFolderPath,
	hasExistingAutoRunDocs,
	getExistingAutoRunDocs,
	getExistingAutoRunDocsCount,
	ExistingDocument,
} from '../../../renderer/utils/existingDocsDetector';

// Mock window.maestro.autorun API
const mockAutorunApi = {
	listDocs: vi.fn(),
};

// Store original window.maestro
const originalMaestro = (global as any).window?.maestro;

describe('existingDocsDetector', () => {
	beforeEach(() => {
		vi.clearAllMocks();

		// Setup window.maestro mock
		(global as any).window = {
			maestro: {
				autorun: mockAutorunApi,
			},
		};
	});

	afterEach(() => {
		// Restore original window.maestro if it existed
		if (originalMaestro) {
			(global as any).window = { maestro: originalMaestro };
		} else {
			delete (global as any).window;
		}
	});

	describe('AUTO_RUN_FOLDER_NAME', () => {
		it('equals "Auto Run Docs"', () => {
			expect(AUTO_RUN_FOLDER_NAME).toBe('Auto Run Docs');
		});
	});

	describe('getAutoRunFolderPath', () => {
		it('appends Auto Run Docs folder to project path', () => {
			const result = getAutoRunFolderPath('/path/to/project');
			expect(result).toBe('/path/to/project/Auto Run Docs');
		});

		it('handles trailing slash in project path', () => {
			const result = getAutoRunFolderPath('/path/to/project/');
			expect(result).toBe('/path/to/project/Auto Run Docs');
		});

		it('handles empty path', () => {
			const result = getAutoRunFolderPath('');
			expect(result).toBe('/Auto Run Docs');
		});

		it('handles home directory paths', () => {
			const result = getAutoRunFolderPath('/Users/user/Projects/myapp');
			expect(result).toBe('/Users/user/Projects/myapp/Auto Run Docs');
		});

		it('handles Windows-style paths', () => {
			const result = getAutoRunFolderPath('C:/Users/user/Projects');
			expect(result).toBe('C:/Users/user/Projects/Auto Run Docs');
		});
	});

	describe('hasExistingAutoRunDocs', () => {
		it('returns true when documents exist', async () => {
			mockAutorunApi.listDocs.mockResolvedValue({
				success: true,
				files: ['phase-1', 'phase-2', 'roadmap'],
			});

			const result = await hasExistingAutoRunDocs('/path/to/project');

			expect(result).toBe(true);
			expect(mockAutorunApi.listDocs).toHaveBeenCalledWith('/path/to/project/Auto Run Docs');
		});

		it('returns false when no documents exist', async () => {
			mockAutorunApi.listDocs.mockResolvedValue({
				success: true,
				files: [],
			});

			const result = await hasExistingAutoRunDocs('/path/to/project');

			expect(result).toBe(false);
		});

		it('returns false when folder does not exist', async () => {
			mockAutorunApi.listDocs.mockResolvedValue({
				success: false,
				error: 'ENOENT: no such file or directory',
			});

			const result = await hasExistingAutoRunDocs('/path/to/project');

			expect(result).toBe(false);
		});

		it('returns false when API throws an error', async () => {
			mockAutorunApi.listDocs.mockRejectedValue(new Error('Permission denied'));

			const result = await hasExistingAutoRunDocs('/path/to/project');

			expect(result).toBe(false);
		});

		it('returns true for single document', async () => {
			mockAutorunApi.listDocs.mockResolvedValue({
				success: true,
				files: ['single-doc'],
			});

			const result = await hasExistingAutoRunDocs('/path/to/project');

			expect(result).toBe(true);
		});

		it('handles paths with trailing slash', async () => {
			mockAutorunApi.listDocs.mockResolvedValue({
				success: true,
				files: ['doc1'],
			});

			const result = await hasExistingAutoRunDocs('/path/to/project/');

			expect(result).toBe(true);
			expect(mockAutorunApi.listDocs).toHaveBeenCalledWith('/path/to/project/Auto Run Docs');
		});
	});

	describe('getExistingAutoRunDocs', () => {
		it('returns documents with correct structure', async () => {
			mockAutorunApi.listDocs.mockResolvedValue({
				success: true,
				files: ['phase-1', 'phase-2'],
			});

			const result = await getExistingAutoRunDocs('/path/to/project');

			expect(result).toHaveLength(2);
			expect(result[0]).toEqual({
				name: 'phase-1',
				filename: 'phase-1.md',
				path: '/path/to/project/Auto Run Docs/phase-1.md',
			});
			expect(result[1]).toEqual({
				name: 'phase-2',
				filename: 'phase-2.md',
				path: '/path/to/project/Auto Run Docs/phase-2.md',
			});
		});

		it('returns empty array when no documents exist', async () => {
			mockAutorunApi.listDocs.mockResolvedValue({
				success: true,
				files: [],
			});

			const result = await getExistingAutoRunDocs('/path/to/project');

			expect(result).toEqual([]);
		});

		it('returns empty array when folder does not exist', async () => {
			mockAutorunApi.listDocs.mockResolvedValue({
				success: false,
				error: 'ENOENT: no such file or directory',
			});

			const result = await getExistingAutoRunDocs('/path/to/project');

			expect(result).toEqual([]);
		});

		it('returns empty array when API throws an error', async () => {
			mockAutorunApi.listDocs.mockRejectedValue(new Error('Network error'));

			const result = await getExistingAutoRunDocs('/path/to/project');

			expect(result).toEqual([]);
		});

		it('handles single document', async () => {
			mockAutorunApi.listDocs.mockResolvedValue({
				success: true,
				files: ['roadmap'],
			});

			const result = await getExistingAutoRunDocs('/path/to/project');

			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('roadmap');
			expect(result[0].filename).toBe('roadmap.md');
		});

		it('handles documents with special characters in names', async () => {
			mockAutorunApi.listDocs.mockResolvedValue({
				success: true,
				files: ['phase-1 (draft)', 'feature-add-user-auth'],
			});

			const result = await getExistingAutoRunDocs('/path/to/project');

			expect(result).toHaveLength(2);
			expect(result[0].name).toBe('phase-1 (draft)');
			expect(result[0].filename).toBe('phase-1 (draft).md');
		});

		it('returns empty array when files is undefined', async () => {
			mockAutorunApi.listDocs.mockResolvedValue({
				success: true,
				// files is undefined
			});

			const result = await getExistingAutoRunDocs('/path/to/project');

			expect(result).toEqual([]);
		});
	});

	describe('getExistingAutoRunDocsCount', () => {
		it('returns correct count for multiple documents', async () => {
			mockAutorunApi.listDocs.mockResolvedValue({
				success: true,
				files: ['phase-1', 'phase-2', 'phase-3', 'roadmap'],
			});

			const result = await getExistingAutoRunDocsCount('/path/to/project');

			expect(result).toBe(4);
		});

		it('returns 0 when no documents exist', async () => {
			mockAutorunApi.listDocs.mockResolvedValue({
				success: true,
				files: [],
			});

			const result = await getExistingAutoRunDocsCount('/path/to/project');

			expect(result).toBe(0);
		});

		it('returns 0 when folder does not exist', async () => {
			mockAutorunApi.listDocs.mockResolvedValue({
				success: false,
				error: 'ENOENT: no such file or directory',
			});

			const result = await getExistingAutoRunDocsCount('/path/to/project');

			expect(result).toBe(0);
		});

		it('returns 0 when API throws an error', async () => {
			mockAutorunApi.listDocs.mockRejectedValue(new Error('Timeout'));

			const result = await getExistingAutoRunDocsCount('/path/to/project');

			expect(result).toBe(0);
		});

		it('returns 1 for single document', async () => {
			mockAutorunApi.listDocs.mockResolvedValue({
				success: true,
				files: ['only-doc'],
			});

			const result = await getExistingAutoRunDocsCount('/path/to/project');

			expect(result).toBe(1);
		});

		it('returns 0 when files is undefined', async () => {
			mockAutorunApi.listDocs.mockResolvedValue({
				success: true,
				// files is undefined
			});

			const result = await getExistingAutoRunDocsCount('/path/to/project');

			expect(result).toBe(0);
		});
	});

	describe('type exports', () => {
		it('ExistingDocument interface has correct shape', () => {
			const doc: ExistingDocument = {
				name: 'test',
				filename: 'test.md',
				path: '/path/to/test.md',
			};

			expect(doc.name).toBe('test');
			expect(doc.filename).toBe('test.md');
			expect(doc.path).toBe('/path/to/test.md');
		});
	});

	describe('integration scenarios', () => {
		it('handles project with many documents', async () => {
			const manyFiles = Array.from({ length: 100 }, (_, i) => `document-${i + 1}`);
			mockAutorunApi.listDocs.mockResolvedValue({
				success: true,
				files: manyFiles,
			});

			const hasDocsResult = await hasExistingAutoRunDocs('/project');
			const countResult = await getExistingAutoRunDocsCount('/project');
			const docsResult = await getExistingAutoRunDocs('/project');

			expect(hasDocsResult).toBe(true);
			expect(countResult).toBe(100);
			expect(docsResult).toHaveLength(100);
		});

		it('consistent behavior across all functions when folder is empty', async () => {
			mockAutorunApi.listDocs.mockResolvedValue({
				success: true,
				files: [],
			});

			const hasDocsResult = await hasExistingAutoRunDocs('/project');
			const countResult = await getExistingAutoRunDocsCount('/project');
			const docsResult = await getExistingAutoRunDocs('/project');

			expect(hasDocsResult).toBe(false);
			expect(countResult).toBe(0);
			expect(docsResult).toEqual([]);
		});

		it('consistent behavior across all functions when folder does not exist', async () => {
			mockAutorunApi.listDocs.mockResolvedValue({
				success: false,
				error: 'ENOENT',
			});

			const hasDocsResult = await hasExistingAutoRunDocs('/project');
			const countResult = await getExistingAutoRunDocsCount('/project');
			const docsResult = await getExistingAutoRunDocs('/project');

			expect(hasDocsResult).toBe(false);
			expect(countResult).toBe(0);
			expect(docsResult).toEqual([]);
		});

		it('uses correct folder path for real project paths', async () => {
			mockAutorunApi.listDocs.mockResolvedValue({
				success: true,
				files: ['doc'],
			});

			await hasExistingAutoRunDocs('/Users/developer/Projects/my-awesome-app');

			expect(mockAutorunApi.listDocs).toHaveBeenCalledWith(
				'/Users/developer/Projects/my-awesome-app/Auto Run Docs'
			);
		});
	});
});
