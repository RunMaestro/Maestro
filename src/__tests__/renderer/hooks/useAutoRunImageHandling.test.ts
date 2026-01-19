/**
 * @file useAutoRunImageHandling.test.ts
 * @description Unit tests for the useAutoRunImageHandling hook
 *
 * Tests cover:
 * - loadAttachments - reads images from folder (via useEffect on mount)
 * - saveImageToFolder - saves with correct naming (via handlePaste and handleFileSelect)
 * - deleteImage - removes file and clears markdown reference
 * - imageCache eviction and cleanup
 * - Clipboard paste handling (DataTransfer mocking)
 * - Lightbox operations (open, close, navigate, delete)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
	useAutoRunImageHandling,
	imageCache,
	type UseAutoRunImageHandlingDeps,
} from '../../../renderer/hooks';
import React from 'react';

// ============================================================================
// Test Helpers
// ============================================================================

const createMockDeps = (
	overrides: Partial<UseAutoRunImageHandlingDeps> = {}
): UseAutoRunImageHandlingDeps => {
	const textareaRef = { current: null } as React.RefObject<HTMLTextAreaElement>;
	const lastUndoSnapshotRef = { current: '' };

	return {
		folderPath: '/test/autorun',
		selectedFile: 'Phase 1',
		localContent: '# Phase 1\n\nSome content',
		setLocalContent: vi.fn(),
		handleContentChange: vi.fn(),
		isLocked: false,
		textareaRef,
		pushUndoState: vi.fn(),
		lastUndoSnapshotRef,
		...overrides,
	};
};

const createMockTextarea = (selectionStart = 0): HTMLTextAreaElement => {
	const textarea = document.createElement('textarea');
	textarea.value = '# Phase 1\n\nSome content';
	textarea.selectionStart = selectionStart;
	textarea.selectionEnd = selectionStart;
	// Mock setSelectionRange
	textarea.setSelectionRange = vi.fn();
	textarea.focus = vi.fn();
	return textarea;
};

const createMockClipboardEvent = (imageType = 'image/png'): React.ClipboardEvent => {
	const mockFile = new File(['test image data'], 'test.png', { type: imageType });

	const mockDataTransferItem: DataTransferItem = {
		kind: 'file',
		type: imageType,
		getAsFile: () => mockFile,
		getAsString: () => {},
		webkitGetAsEntry: () => null,
	};

	const mockDataTransferItemList: DataTransferItemList = {
		length: 1,
		add: () => null,
		clear: () => {},
		remove: () => {},
		item: (index: number) => (index === 0 ? mockDataTransferItem : null),
		[Symbol.iterator]: function* () {
			yield mockDataTransferItem;
		},
		0: mockDataTransferItem,
	} as unknown as DataTransferItemList;

	return {
		clipboardData: {
			items: mockDataTransferItemList,
			getData: () => '',
			setData: () => {},
			clearData: () => {},
			types: ['Files'],
			files: [mockFile] as unknown as FileList,
			dropEffect: 'none',
			effectAllowed: 'none',
			setDragImage: () => {},
		},
		preventDefault: vi.fn(),
		stopPropagation: vi.fn(),
		nativeEvent: { type: 'paste' },
		currentTarget: document.createElement('div'),
		target: document.createElement('div'),
		bubbles: true,
		cancelable: true,
		defaultPrevented: false,
		eventPhase: 2,
		isTrusted: true,
		timeStamp: Date.now(),
		type: 'paste',
		isDefaultPrevented: () => false,
		isPropagationStopped: () => false,
		persist: () => {},
	} as unknown as React.ClipboardEvent;
};

const createMockFileInputEvent = (
	filename = 'test.png',
	fileType = 'image/png'
): React.ChangeEvent<HTMLInputElement> => {
	const mockFile = new File(['test image data'], filename, { type: fileType });

	const input = document.createElement('input');
	input.type = 'file';
	Object.defineProperty(input, 'files', {
		value: [mockFile],
	});

	return {
		target: input,
		currentTarget: input,
		nativeEvent: new Event('change'),
		bubbles: true,
		cancelable: false,
		defaultPrevented: false,
		eventPhase: 2,
		isTrusted: true,
		timeStamp: Date.now(),
		type: 'change',
		isDefaultPrevented: () => false,
		isPropagationStopped: () => false,
		persist: () => {},
		preventDefault: vi.fn(),
		stopPropagation: vi.fn(),
	} as unknown as React.ChangeEvent<HTMLInputElement>;
};

// ============================================================================
// Mock Setup
// ============================================================================

// Create a proper FileReader mock class
class MockFileReader {
	result: string | ArrayBuffer | null = null;
	onload: ((ev: ProgressEvent<FileReader>) => any) | null = null;
	onerror: ((ev: ProgressEvent<FileReader>) => any) | null = null;
	readyState = 0;
	error: DOMException | null = null;
	onabort: ((ev: ProgressEvent<FileReader>) => any) | null = null;
	onloadend: ((ev: ProgressEvent<FileReader>) => any) | null = null;
	onloadstart: ((ev: ProgressEvent<FileReader>) => any) | null = null;
	onprogress: ((ev: ProgressEvent<FileReader>) => any) | null = null;
	EMPTY = 0;
	LOADING = 1;
	DONE = 2;

	abort = vi.fn();
	readAsArrayBuffer = vi.fn();
	readAsBinaryString = vi.fn();
	readAsText = vi.fn();

	readAsDataURL = vi.fn(function (this: MockFileReader) {
		setTimeout(() => {
			this.result =
				'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
			this.readyState = 2;
			if (this.onload) {
				this.onload({ target: { result: this.result } } as unknown as ProgressEvent<FileReader>);
			}
		}, 0);
	});

	addEventListener = vi.fn();
	removeEventListener = vi.fn();
	dispatchEvent = vi.fn().mockReturnValue(true);
}

// Extend the global mock with image-related methods
beforeEach(() => {
	vi.clearAllMocks();
	imageCache.clear();

	// Add/reset image-related mocks on window.maestro.autorun
	(window.maestro.autorun as any).listImages = vi.fn().mockResolvedValue({
		success: true,
		images: [],
	});
	(window.maestro.autorun as any).saveImage = vi.fn().mockResolvedValue({
		success: true,
		relativePath: 'images/Phase 1-1234567890.png',
	});
	(window.maestro.autorun as any).deleteImage = vi.fn().mockResolvedValue({
		success: true,
	});

	// Mock FileReader with a proper class constructor
	global.FileReader = MockFileReader as unknown as typeof FileReader;
});

afterEach(() => {
	vi.useRealTimers();
	imageCache.clear();
});

// ============================================================================
// Tests for loadAttachments (useEffect on mount)
// ============================================================================

describe('useAutoRunImageHandling', () => {
	describe('loadAttachments (useEffect behavior)', () => {
		it('should load existing images when folderPath and selectedFile are provided', async () => {
			const mockDeps = createMockDeps();

			(window.maestro.autorun as any).listImages.mockResolvedValue({
				success: true,
				images: [
					{ filename: 'Phase 1-123.png', relativePath: 'images/Phase 1-123.png' },
					{ filename: 'Phase 1-456.jpg', relativePath: 'images/Phase 1-456.jpg' },
				],
			});

			(window.maestro.fs.readFile as any).mockResolvedValue('data:image/png;base64,abc123');

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			await waitFor(() => {
				expect(result.current.attachmentsList).toHaveLength(2);
			});

			expect(window.maestro.autorun.listImages).toHaveBeenCalledWith('/test/autorun', 'Phase 1');
			expect(result.current.attachmentsList).toContain('images/Phase 1-123.png');
			expect(result.current.attachmentsList).toContain('images/Phase 1-456.jpg');
		});

		it('should load previews for images from fs.readFile', async () => {
			const mockDeps = createMockDeps();

			(window.maestro.autorun as any).listImages.mockResolvedValue({
				success: true,
				images: [{ filename: 'test.png', relativePath: 'images/test.png' }],
			});

			(window.maestro.fs.readFile as any).mockResolvedValue('data:image/png;base64,preview123');

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			await waitFor(() => {
				expect(result.current.attachmentPreviews.size).toBe(1);
			});

			expect(window.maestro.fs.readFile).toHaveBeenCalledWith(
				'/test/autorun/images/test.png',
				undefined
			);
			expect(result.current.attachmentPreviews.get('images/test.png')).toBe(
				'data:image/png;base64,preview123'
			);
		});

		it('should clear attachments when folderPath is null', async () => {
			const mockDeps = createMockDeps({ folderPath: null });

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			expect(result.current.attachmentsList).toEqual([]);
			expect(result.current.attachmentPreviews.size).toBe(0);
			expect(window.maestro.autorun.listImages).not.toHaveBeenCalled();
		});

		it('should clear attachments when selectedFile is null', async () => {
			const mockDeps = createMockDeps({ selectedFile: null });

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			expect(result.current.attachmentsList).toEqual([]);
			expect(result.current.attachmentPreviews.size).toBe(0);
			expect(window.maestro.autorun.listImages).not.toHaveBeenCalled();
		});

		it('should handle listImages failure gracefully', async () => {
			const mockDeps = createMockDeps();

			(window.maestro.autorun as any).listImages.mockResolvedValue({
				success: false,
				error: 'Failed to list images',
			});

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			await waitFor(() => {
				expect(window.maestro.autorun.listImages).toHaveBeenCalled();
			});

			// Should have empty list on failure
			expect(result.current.attachmentsList).toEqual([]);
		});

		it('should handle fs.readFile failure gracefully (missing image file)', async () => {
			const mockDeps = createMockDeps();

			(window.maestro.autorun as any).listImages.mockResolvedValue({
				success: true,
				images: [{ filename: 'missing.png', relativePath: 'images/missing.png' }],
			});

			(window.maestro.fs.readFile as any).mockRejectedValue(new Error('File not found'));

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			await waitFor(() => {
				expect(result.current.attachmentsList).toHaveLength(1);
			});

			// Should still have the attachment in list even if preview failed
			expect(result.current.attachmentsList).toContain('images/missing.png');
			// But preview should not be set
			expect(result.current.attachmentPreviews.get('images/missing.png')).toBeUndefined();
		});

		it('should reload attachments when selectedFile changes', async () => {
			const mockDeps = createMockDeps();

			(window.maestro.autorun as any).listImages.mockResolvedValue({
				success: true,
				images: [{ filename: 'doc1-img.png', relativePath: 'images/doc1-img.png' }],
			});

			const { result, rerender } = renderHook(({ deps }) => useAutoRunImageHandling(deps), {
				initialProps: { deps: mockDeps },
			});

			await waitFor(() => {
				expect(result.current.attachmentsList).toHaveLength(1);
			});

			// Change selectedFile
			(window.maestro.autorun as any).listImages.mockResolvedValue({
				success: true,
				images: [{ filename: 'doc2-img.png', relativePath: 'images/doc2-img.png' }],
			});

			rerender({ deps: { ...mockDeps, selectedFile: 'Phase 2' } });

			await waitFor(() => {
				expect(result.current.attachmentsList).toContain('images/doc2-img.png');
			});

			expect(window.maestro.autorun.listImages).toHaveBeenLastCalledWith(
				'/test/autorun',
				'Phase 2'
			);
		});
	});

	// ============================================================================
	// Tests for handlePaste (clipboard image handling)
	// ============================================================================

	describe('handlePaste (clipboard image handling)', () => {
		it('should save pasted image and insert markdown at cursor position', async () => {
			vi.useFakeTimers();

			const textarea = createMockTextarea(10); // Cursor at position 10
			const mockDeps = createMockDeps({
				textareaRef: { current: textarea },
				localContent: '# Phase 1\n\nSome content',
			});

			(window.maestro.autorun as any).saveImage.mockResolvedValue({
				success: true,
				relativePath: 'images/Phase 1-1234567890.png',
			});

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			const clipboardEvent = createMockClipboardEvent();

			await act(async () => {
				await result.current.handlePaste(clipboardEvent);
				vi.runAllTimers();
			});

			expect(clipboardEvent.preventDefault).toHaveBeenCalled();
			expect(window.maestro.autorun.saveImage).toHaveBeenCalledWith(
				'/test/autorun',
				'Phase 1',
				expect.any(String), // base64 content
				'png'
			);
		});

		it('should NOT paste when isLocked is true', async () => {
			const mockDeps = createMockDeps({ isLocked: true });

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			const clipboardEvent = createMockClipboardEvent();

			await act(async () => {
				await result.current.handlePaste(clipboardEvent);
			});

			expect(clipboardEvent.preventDefault).not.toHaveBeenCalled();
			expect(window.maestro.autorun.saveImage).not.toHaveBeenCalled();
		});

		it('should NOT paste when folderPath is null', async () => {
			const mockDeps = createMockDeps({ folderPath: null });

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			const clipboardEvent = createMockClipboardEvent();

			await act(async () => {
				await result.current.handlePaste(clipboardEvent);
			});

			expect(window.maestro.autorun.saveImage).not.toHaveBeenCalled();
		});

		it('should NOT paste when selectedFile is null', async () => {
			const mockDeps = createMockDeps({ selectedFile: null });

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			const clipboardEvent = createMockClipboardEvent();

			await act(async () => {
				await result.current.handlePaste(clipboardEvent);
			});

			expect(window.maestro.autorun.saveImage).not.toHaveBeenCalled();
		});

		it('should handle different image types (jpeg)', async () => {
			vi.useFakeTimers();

			const textarea = createMockTextarea(0);
			const mockDeps = createMockDeps({
				textareaRef: { current: textarea },
			});

			(window.maestro.autorun as any).saveImage.mockResolvedValue({
				success: true,
				relativePath: 'images/Phase 1-123.jpeg',
			});

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			const clipboardEvent = createMockClipboardEvent('image/jpeg');

			await act(async () => {
				await result.current.handlePaste(clipboardEvent);
				vi.runAllTimers();
			});

			expect(window.maestro.autorun.saveImage).toHaveBeenCalledWith(
				'/test/autorun',
				'Phase 1',
				expect.any(String),
				'jpeg'
			);
		});

		it('should push undo state before modifying content', async () => {
			vi.useFakeTimers();

			const textarea = createMockTextarea(0);
			const mockDeps = createMockDeps({
				textareaRef: { current: textarea },
			});

			(window.maestro.autorun as any).saveImage.mockResolvedValue({
				success: true,
				relativePath: 'images/Phase 1-123.png',
			});

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			const clipboardEvent = createMockClipboardEvent();

			await act(async () => {
				await result.current.handlePaste(clipboardEvent);
				vi.runAllTimers();
			});

			expect(mockDeps.pushUndoState).toHaveBeenCalled();
		});

		it('should update attachmentsList after successful paste', async () => {
			vi.useFakeTimers();

			const textarea = createMockTextarea(0);
			const mockDeps = createMockDeps({
				textareaRef: { current: textarea },
			});

			(window.maestro.autorun as any).saveImage.mockResolvedValue({
				success: true,
				relativePath: 'images/Phase 1-newimg.png',
			});

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			const clipboardEvent = createMockClipboardEvent();

			await act(async () => {
				await result.current.handlePaste(clipboardEvent);
				vi.runAllTimers();
			});

			expect(result.current.attachmentsList).toContain('images/Phase 1-newimg.png');
		});

		it('should NOT update state when saveImage fails', async () => {
			vi.useFakeTimers();

			const textarea = createMockTextarea(0);
			const mockDeps = createMockDeps({
				textareaRef: { current: textarea },
			});

			(window.maestro.autorun as any).saveImage.mockResolvedValue({
				success: false,
				error: 'Failed to save',
			});

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			const clipboardEvent = createMockClipboardEvent();

			await act(async () => {
				await result.current.handlePaste(clipboardEvent);
				vi.runAllTimers();
			});

			expect(result.current.attachmentsList).toEqual([]);
			expect(mockDeps.setLocalContent).not.toHaveBeenCalled();
		});

		it('should ignore non-image clipboard items', async () => {
			const mockDeps = createMockDeps();

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			// Create a clipboard event with text/plain item
			const textItem: DataTransferItem = {
				kind: 'string',
				type: 'text/plain',
				getAsFile: () => null,
				getAsString: (callback) => callback?.('some text'),
				webkitGetAsEntry: () => null,
			};

			const clipboardEvent = {
				clipboardData: {
					items: {
						length: 1,
						0: textItem,
						item: (i: number) => (i === 0 ? textItem : null),
						[Symbol.iterator]: function* () {
							yield textItem;
						},
					} as unknown as DataTransferItemList,
				},
				preventDefault: vi.fn(),
			} as unknown as React.ClipboardEvent;

			await act(async () => {
				await result.current.handlePaste(clipboardEvent);
			});

			expect(clipboardEvent.preventDefault).not.toHaveBeenCalled();
			expect(window.maestro.autorun.saveImage).not.toHaveBeenCalled();
		});
	});

	// ============================================================================
	// Tests for handleFileSelect (manual upload)
	// ============================================================================

	describe('handleFileSelect (manual upload)', () => {
		it('should save uploaded file and insert markdown at end', async () => {
			vi.useFakeTimers();

			const mockDeps = createMockDeps();

			(window.maestro.autorun as any).saveImage.mockResolvedValue({
				success: true,
				relativePath: 'images/Phase 1-uploaded.png',
			});

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			const fileEvent = createMockFileInputEvent('uploaded.png', 'image/png');

			await act(async () => {
				await result.current.handleFileSelect(fileEvent);
				vi.runAllTimers();
			});

			expect(window.maestro.autorun.saveImage).toHaveBeenCalledWith(
				'/test/autorun',
				'Phase 1',
				expect.any(String),
				'png'
			);
		});

		it('should update attachmentsList after successful upload', async () => {
			vi.useFakeTimers();

			const mockDeps = createMockDeps();

			(window.maestro.autorun as any).saveImage.mockResolvedValue({
				success: true,
				relativePath: 'images/Phase 1-upload.png',
			});

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			const fileEvent = createMockFileInputEvent();

			await act(async () => {
				await result.current.handleFileSelect(fileEvent);
				vi.runAllTimers();
			});

			expect(result.current.attachmentsList).toContain('images/Phase 1-upload.png');
		});

		it('should reset file input value after selection', async () => {
			vi.useFakeTimers();

			const mockDeps = createMockDeps();

			(window.maestro.autorun as any).saveImage.mockResolvedValue({
				success: true,
				relativePath: 'images/test.png',
			});

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			const fileEvent = createMockFileInputEvent();

			await act(async () => {
				await result.current.handleFileSelect(fileEvent);
				vi.runAllTimers();
			});

			expect(fileEvent.target.value).toBe('');
		});

		it('should NOT upload when folderPath is null', async () => {
			const mockDeps = createMockDeps({ folderPath: null });

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			const fileEvent = createMockFileInputEvent();

			await act(async () => {
				await result.current.handleFileSelect(fileEvent);
			});

			expect(window.maestro.autorun.saveImage).not.toHaveBeenCalled();
		});

		it('should NOT upload when selectedFile is null', async () => {
			const mockDeps = createMockDeps({ selectedFile: null });

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			const fileEvent = createMockFileInputEvent();

			await act(async () => {
				await result.current.handleFileSelect(fileEvent);
			});

			expect(window.maestro.autorun.saveImage).not.toHaveBeenCalled();
		});

		it('should do nothing when no file is selected', async () => {
			const mockDeps = createMockDeps();

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			const input = document.createElement('input');
			input.type = 'file';
			Object.defineProperty(input, 'files', { value: [] });

			const fileEvent = {
				target: input,
			} as unknown as React.ChangeEvent<HTMLInputElement>;

			await act(async () => {
				await result.current.handleFileSelect(fileEvent);
			});

			expect(window.maestro.autorun.saveImage).not.toHaveBeenCalled();
		});

		it('should push undo state before modifying content', async () => {
			vi.useFakeTimers();

			const mockDeps = createMockDeps();

			(window.maestro.autorun as any).saveImage.mockResolvedValue({
				success: true,
				relativePath: 'images/test.png',
			});

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			const fileEvent = createMockFileInputEvent();

			await act(async () => {
				await result.current.handleFileSelect(fileEvent);
				vi.runAllTimers();
			});

			expect(mockDeps.pushUndoState).toHaveBeenCalled();
		});

		it('should extract extension from filename', async () => {
			vi.useFakeTimers();

			const mockDeps = createMockDeps();

			(window.maestro.autorun as any).saveImage.mockResolvedValue({
				success: true,
				relativePath: 'images/test.gif',
			});

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			const fileEvent = createMockFileInputEvent('animation.gif', 'image/gif');

			await act(async () => {
				await result.current.handleFileSelect(fileEvent);
				vi.runAllTimers();
			});

			expect(window.maestro.autorun.saveImage).toHaveBeenCalledWith(
				'/test/autorun',
				'Phase 1',
				expect.any(String),
				'gif'
			);
		});
	});

	// ============================================================================
	// Tests for handleRemoveAttachment (delete image)
	// ============================================================================

	describe('handleRemoveAttachment (delete image)', () => {
		it('should delete image file and remove from attachmentsList', async () => {
			const mockDeps = createMockDeps({
				localContent: '# Phase 1\n\n![test.png](images/test.png)\n\nMore content',
			});

			(window.maestro.autorun as any).listImages.mockResolvedValue({
				success: true,
				images: [{ filename: 'test.png', relativePath: 'images/test.png' }],
			});

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			await waitFor(() => {
				expect(result.current.attachmentsList).toContain('images/test.png');
			});

			await act(async () => {
				await result.current.handleRemoveAttachment('images/test.png');
			});

			expect(window.maestro.autorun.deleteImage).toHaveBeenCalledWith(
				'/test/autorun',
				'images/test.png'
			);
			expect(result.current.attachmentsList).not.toContain('images/test.png');
		});

		it('should remove markdown reference from content', async () => {
			const mockDeps = createMockDeps({
				localContent: '# Phase 1\n\n![test.png](images/test.png)\n\nMore content',
			});

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			await act(async () => {
				await result.current.handleRemoveAttachment('images/test.png');
			});

			expect(mockDeps.setLocalContent).toHaveBeenCalled();
			const newContent = (mockDeps.setLocalContent as any).mock.calls[0][0];
			expect(newContent).not.toContain('![test.png](images/test.png)');
		});

		it('should push undo state before removing', async () => {
			const mockDeps = createMockDeps();

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			await act(async () => {
				await result.current.handleRemoveAttachment('images/test.png');
			});

			expect(mockDeps.pushUndoState).toHaveBeenCalled();
		});

		it('should remove from attachmentPreviews', async () => {
			const mockDeps = createMockDeps();

			(window.maestro.autorun as any).listImages.mockResolvedValue({
				success: true,
				images: [{ filename: 'test.png', relativePath: 'images/test.png' }],
			});
			(window.maestro.fs.readFile as any).mockResolvedValue('data:image/png;base64,preview');

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			await waitFor(() => {
				expect(result.current.attachmentPreviews.size).toBe(1);
			});

			await act(async () => {
				await result.current.handleRemoveAttachment('images/test.png');
			});

			expect(result.current.attachmentPreviews.get('images/test.png')).toBeUndefined();
		});

		it('should do nothing when folderPath is null', async () => {
			const mockDeps = createMockDeps({ folderPath: null });

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			await act(async () => {
				await result.current.handleRemoveAttachment('images/test.png');
			});

			expect(window.maestro.autorun.deleteImage).not.toHaveBeenCalled();
		});

		it('should clear from imageCache', async () => {
			const mockDeps = createMockDeps();

			// Pre-populate the cache
			imageCache.set('/test/autorun:images/test.png', 'data:image/png;base64,cached');

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			await act(async () => {
				await result.current.handleRemoveAttachment('images/test.png');
			});

			expect(imageCache.get('/test/autorun:images/test.png')).toBeUndefined();
		});

		it('should handle special characters in filename', async () => {
			const mockDeps = createMockDeps({
				localContent: '# Phase 1\n\n![file (1).png](images/file (1).png)\n',
			});

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			await act(async () => {
				await result.current.handleRemoveAttachment('images/file (1).png');
			});

			expect(window.maestro.autorun.deleteImage).toHaveBeenCalledWith(
				'/test/autorun',
				'images/file (1).png'
			);
			const newContent = (mockDeps.setLocalContent as any).mock.calls[0][0];
			expect(newContent).not.toContain('file (1).png');
		});
	});

	// ============================================================================
	// Tests for imageCache behavior
	// ============================================================================

	describe('imageCache behavior', () => {
		it('should be a module-level singleton', () => {
			// imageCache is exported from the module
			expect(imageCache).toBeInstanceOf(Map);
		});

		it('should be cleared in beforeEach (test isolation)', () => {
			expect(imageCache.size).toBe(0);
		});

		it('should clear specific entry on image removal', async () => {
			const mockDeps = createMockDeps();

			// Pre-populate cache with multiple entries
			imageCache.set('/test/autorun:images/img1.png', 'data1');
			imageCache.set('/test/autorun:images/img2.png', 'data2');

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			await act(async () => {
				await result.current.handleRemoveAttachment('images/img1.png');
			});

			// Only img1 should be removed
			expect(imageCache.get('/test/autorun:images/img1.png')).toBeUndefined();
			expect(imageCache.get('/test/autorun:images/img2.png')).toBe('data2');
		});

		it('should clear specific entry on lightbox delete', async () => {
			const mockDeps = createMockDeps();

			imageCache.set('/test/autorun:images/lightbox-img.png', 'dataUrl');

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			await act(async () => {
				await result.current.handleLightboxDelete('images/lightbox-img.png');
			});

			expect(imageCache.get('/test/autorun:images/lightbox-img.png')).toBeUndefined();
		});
	});

	// ============================================================================
	// Tests for lightbox operations
	// ============================================================================

	describe('lightbox operations', () => {
		describe('openLightboxByFilename', () => {
			it('should open lightbox with attachment filename', () => {
				const mockDeps = createMockDeps();

				const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

				act(() => {
					result.current.openLightboxByFilename('images/photo.png');
				});

				expect(result.current.lightboxFilename).toBe('images/photo.png');
				expect(result.current.lightboxExternalUrl).toBeNull();
			});

			it('should handle http URL', () => {
				const mockDeps = createMockDeps();

				const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

				act(() => {
					result.current.openLightboxByFilename('http://example.com/image.png');
				});

				expect(result.current.lightboxFilename).toBe('http://example.com/image.png');
				expect(result.current.lightboxExternalUrl).toBe('http://example.com/image.png');
			});

			it('should handle https URL', () => {
				const mockDeps = createMockDeps();

				const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

				act(() => {
					result.current.openLightboxByFilename('https://secure.example.com/image.jpg');
				});

				expect(result.current.lightboxFilename).toBe('https://secure.example.com/image.jpg');
				expect(result.current.lightboxExternalUrl).toBe('https://secure.example.com/image.jpg');
			});

			it('should handle data: URL', () => {
				const mockDeps = createMockDeps();

				const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

				const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAE=';

				act(() => {
					result.current.openLightboxByFilename(dataUrl);
				});

				expect(result.current.lightboxFilename).toBe(dataUrl);
				expect(result.current.lightboxExternalUrl).toBe(dataUrl);
			});
		});

		describe('closeLightbox', () => {
			it('should clear lightbox state', () => {
				const mockDeps = createMockDeps();

				const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

				// Open first
				act(() => {
					result.current.openLightboxByFilename('images/photo.png');
				});

				expect(result.current.lightboxFilename).toBe('images/photo.png');

				// Then close
				act(() => {
					result.current.closeLightbox();
				});

				expect(result.current.lightboxFilename).toBeNull();
				expect(result.current.lightboxExternalUrl).toBeNull();
			});
		});

		describe('handleLightboxNavigate', () => {
			it('should update lightboxFilename', () => {
				const mockDeps = createMockDeps();

				const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

				act(() => {
					result.current.openLightboxByFilename('images/photo1.png');
				});

				act(() => {
					result.current.handleLightboxNavigate('images/photo2.png');
				});

				expect(result.current.lightboxFilename).toBe('images/photo2.png');
			});

			it('should handle null to close', () => {
				const mockDeps = createMockDeps();

				const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

				act(() => {
					result.current.openLightboxByFilename('images/photo.png');
				});

				act(() => {
					result.current.handleLightboxNavigate(null);
				});

				expect(result.current.lightboxFilename).toBeNull();
			});
		});

		describe('handleLightboxDelete', () => {
			it('should delete image and remove markdown reference', async () => {
				const mockDeps = createMockDeps({
					localContent: '# Doc\n\n![img.png](images/img.png)\n',
				});

				const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

				await act(async () => {
					await result.current.handleLightboxDelete('images/img.png');
				});

				expect(window.maestro.autorun.deleteImage).toHaveBeenCalledWith(
					'/test/autorun',
					'images/img.png'
				);
				expect(mockDeps.pushUndoState).toHaveBeenCalled();
				expect(mockDeps.setLocalContent).toHaveBeenCalled();
			});

			it('should remove markdown reference with raw path characters', async () => {
				const mockDeps = createMockDeps({
					localContent: '# Doc\n\n![file (1).png](images/file (1).png)\n',
				});

				const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

				await act(async () => {
					await result.current.handleLightboxDelete('images/file (1).png');
				});

				const newContent = (mockDeps.setLocalContent as any).mock.calls[0][0];
				expect(newContent).not.toContain('file (1).png');
			});

			it('should remove from attachmentsList', async () => {
				const mockDeps = createMockDeps();

				(window.maestro.autorun as any).listImages.mockResolvedValue({
					success: true,
					images: [{ filename: 'todelete.png', relativePath: 'images/todelete.png' }],
				});

				const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

				await waitFor(() => {
					expect(result.current.attachmentsList).toContain('images/todelete.png');
				});

				await act(async () => {
					await result.current.handleLightboxDelete('images/todelete.png');
				});

				expect(result.current.attachmentsList).not.toContain('images/todelete.png');
			});

			it('should do nothing when folderPath is null', async () => {
				const mockDeps = createMockDeps({ folderPath: null });

				const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

				await act(async () => {
					await result.current.handleLightboxDelete('images/test.png');
				});

				expect(window.maestro.autorun.deleteImage).not.toHaveBeenCalled();
			});
		});
	});

	// ============================================================================
	// Tests for attachmentsExpanded state
	// ============================================================================

	describe('attachmentsExpanded state', () => {
		it('should default to true', () => {
			const mockDeps = createMockDeps();

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			expect(result.current.attachmentsExpanded).toBe(true);
		});

		it('should toggle via setAttachmentsExpanded', () => {
			const mockDeps = createMockDeps();

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			act(() => {
				result.current.setAttachmentsExpanded(false);
			});

			expect(result.current.attachmentsExpanded).toBe(false);

			act(() => {
				result.current.setAttachmentsExpanded(true);
			});

			expect(result.current.attachmentsExpanded).toBe(true);
		});
	});

	// ============================================================================
	// Tests for fileInputRef
	// ============================================================================

	describe('fileInputRef', () => {
		it('should provide a ref for file input element', () => {
			const mockDeps = createMockDeps();

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			expect(result.current.fileInputRef).toBeDefined();
			expect(result.current.fileInputRef.current).toBeNull(); // Initially null until attached
		});
	});

	// ============================================================================
	// Tests for handler stability (memoization)
	// ============================================================================

	describe('handler memoization', () => {
		it('should maintain stable handler references when deps unchanged', () => {
			const mockDeps = createMockDeps();

			const { result, rerender } = renderHook(() => useAutoRunImageHandling(mockDeps));

			const firstRender = {
				handlePaste: result.current.handlePaste,
				handleFileSelect: result.current.handleFileSelect,
				handleRemoveAttachment: result.current.handleRemoveAttachment,
				openLightboxByFilename: result.current.openLightboxByFilename,
				closeLightbox: result.current.closeLightbox,
				handleLightboxNavigate: result.current.handleLightboxNavigate,
				handleLightboxDelete: result.current.handleLightboxDelete,
			};

			rerender();

			// Due to useCallback with stable deps, these should be the same references
			expect(result.current.openLightboxByFilename).toBe(firstRender.openLightboxByFilename);
			expect(result.current.closeLightbox).toBe(firstRender.closeLightbox);
			expect(result.current.handleLightboxNavigate).toBe(firstRender.handleLightboxNavigate);
		});

		it('should update handlers when localContent changes', () => {
			const mockDeps = createMockDeps();

			const { result, rerender } = renderHook(({ deps }) => useAutoRunImageHandling(deps), {
				initialProps: { deps: mockDeps },
			});

			const firstPaste = result.current.handlePaste;

			rerender({ deps: { ...mockDeps, localContent: 'New content' } });

			// Handler depends on localContent, so should change
			expect(result.current.handlePaste).not.toBe(firstPaste);
		});
	});

	// ============================================================================
	// Edge cases and error handling
	// ============================================================================

	describe('edge cases', () => {
		it('should handle empty attachments list', async () => {
			const mockDeps = createMockDeps();

			(window.maestro.autorun as any).listImages.mockResolvedValue({
				success: true,
				images: [],
			});

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			await waitFor(() => {
				expect(window.maestro.autorun.listImages).toHaveBeenCalled();
			});

			expect(result.current.attachmentsList).toEqual([]);
			expect(result.current.attachmentPreviews.size).toBe(0);
		});

		it('should handle markdown reference with newline removal', async () => {
			const mockDeps = createMockDeps({
				localContent: 'Before\n![img.png](images/img.png)\nAfter',
			});

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			await act(async () => {
				await result.current.handleRemoveAttachment('images/img.png');
			});

			const newContent = (mockDeps.setLocalContent as any).mock.calls[0][0];
			// Should remove the image reference and trailing newline
			expect(newContent).toBe('Before\nAfter');
		});

		it('should handle multiple image references in content', async () => {
			const mockDeps = createMockDeps({
				localContent: '![img.png](images/img.png)\nText\n![img.png](images/img.png)\n',
			});

			const { result } = renderHook(() => useAutoRunImageHandling(mockDeps));

			await act(async () => {
				await result.current.handleRemoveAttachment('images/img.png');
			});

			const newContent = (mockDeps.setLocalContent as any).mock.calls[0][0];
			// Should remove all occurrences
			expect(newContent).not.toContain('images/img.png');
		});
	});
});
