/**
 * @file AutoRunLightbox.test.tsx
 * @description Tests for the AutoRunLightbox component - a full-screen image viewer with navigation, copy, delete
 *
 * The AutoRunLightbox:
 * - Displays images in a full-screen overlay
 * - Provides carousel navigation (left/right arrows, keyboard)
 * - Supports copy to clipboard functionality
 * - Supports delete button for local attachments (not external URLs)
 * - Keyboard shortcuts: Escape (close), Arrow keys (navigate), Delete/Backspace (remove)
 * - Closes via backdrop click or close button
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { AutoRunLightbox } from '../../../renderer/components/AutoRunLightbox';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../renderer/types';

// Helper to wrap component in LayerStackProvider
const renderWithProviders = (component: React.ReactElement) => {
	return render(<LayerStackProvider>{component}</LayerStackProvider>);
};

// Mock Lucide icons
vi.mock('lucide-react', () => ({
	X: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="x-icon" className={className} style={style} />
	),
	ChevronLeft: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="chevron-left-icon" className={className} style={style} />
	),
	ChevronRight: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="chevron-right-icon" className={className} style={style} />
	),
	Copy: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="copy-icon" className={className} style={style} />
	),
	Check: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="check-icon" className={className} style={style} />
	),
	Trash2: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="trash2-icon" className={className} style={style} />
	),
	FileText: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="file-text-icon" className={className} style={style} />
	),
	AlertTriangle: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="alert-triangle-icon" className={className} style={style} />
	),
}));

// Mock navigator.clipboard at module level
const mockClipboardWrite = vi.fn();
Object.defineProperty(navigator, 'clipboard', {
	value: { write: mockClipboardWrite },
	writable: true,
	configurable: true,
});

// Mock ClipboardItem at module level
class MockClipboardItem {
	constructor(public items: Record<string, Blob>) {}
}
global.ClipboardItem = MockClipboardItem as unknown as typeof ClipboardItem;

// Mock fetch at module level for clipboard tests
global.fetch = vi.fn();

// Create a mock theme for testing
const createMockTheme = (): Theme => ({
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgSidebar: '#252525',
		bgPanel: '#2d2d2d',
		bgActivity: '#333333',
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#0066ff',
		accentForeground: '#ffffff',
		border: '#333333',
		highlight: '#0066ff33',
		success: '#00aa00',
		warning: '#ffaa00',
		error: '#ff0000',
	},
});

// Create a mock attachment previews map
const createMockPreviews = (filenames: string[]): Map<string, string> => {
	const map = new Map<string, string>();
	filenames.forEach((filename) => {
		map.set(filename, `data:image/png;base64,mock-data-${filename}`);
	});
	return map;
};

// Default props for AutoRunLightbox
const createDefaultProps = (
	overrides: Partial<React.ComponentProps<typeof AutoRunLightbox>> = {}
) => {
	const attachmentsList = ['image1.png', 'image2.png', 'image3.png'];
	return {
		theme: createMockTheme(),
		attachmentsList,
		attachmentPreviews: createMockPreviews(attachmentsList),
		lightboxFilename: 'image1.png',
		lightboxExternalUrl: null,
		onClose: vi.fn(),
		onNavigate: vi.fn(),
		onDelete: vi.fn(),
		...overrides,
	};
};

describe('AutoRunLightbox', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();

		// Mock console.error for clipboard error tests
		vi.spyOn(console, 'error').mockImplementation(() => {});

		// Setup fetch mock to return a blob
		(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			blob: () => Promise.resolve(new Blob(['mock-image-data'], { type: 'image/png' })),
		});

		// Setup clipboard mock
		mockClipboardWrite.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// ===========================================================================
	// Basic Rendering
	// ===========================================================================
	describe('Basic Rendering', () => {
		it('should render the lightbox when lightboxFilename is provided', () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			// Should render the backdrop container (rendered via portal to document.body)
			const backdrop = document.querySelector('.fixed.inset-0.z-\\[9999\\]');
			expect(backdrop).toBeInTheDocument();
		});

		it('should render the image with correct src from attachmentPreviews', () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			const img = screen.getByRole('img');
			expect(img).toHaveAttribute('src', 'data:image/png;base64,mock-data-image1.png');
			expect(img).toHaveAttribute('alt', 'image1.png');
		});

		it('should render with external URL when lightboxExternalUrl is provided', () => {
			const props = createDefaultProps({
				lightboxExternalUrl: 'https://example.com/image.png',
			});
			renderWithProviders(<AutoRunLightbox {...props} />);

			const img = screen.getByRole('img');
			expect(img).toHaveAttribute('src', 'https://example.com/image.png');
		});

		it('should render the close button', () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			expect(screen.getByTitle('Close (ESC)')).toBeInTheDocument();
			expect(screen.getByTestId('x-icon')).toBeInTheDocument();
		});

		it('should render the copy button', () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			expect(screen.getByTitle('Copy image to clipboard (⌘C)')).toBeInTheDocument();
			expect(screen.getByTestId('copy-icon')).toBeInTheDocument();
		});

		it('should render the delete button for local attachments', () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			expect(screen.getByTitle('Delete image (Delete key)')).toBeInTheDocument();
			expect(screen.getByTestId('trash2-icon')).toBeInTheDocument();
		});

		it('should NOT render delete button when onDelete is not provided', () => {
			const props = createDefaultProps({ onDelete: undefined });
			renderWithProviders(<AutoRunLightbox {...props} />);

			expect(screen.queryByTitle('Delete image (Delete key)')).not.toBeInTheDocument();
			expect(screen.queryByTestId('trash2-icon')).not.toBeInTheDocument();
		});

		it('should NOT render delete button for external URLs', () => {
			const props = createDefaultProps({
				lightboxExternalUrl: 'https://example.com/image.png',
			});
			renderWithProviders(<AutoRunLightbox {...props} />);

			expect(screen.queryByTitle('Delete image (Delete key)')).not.toBeInTheDocument();
			expect(screen.queryByTestId('trash2-icon')).not.toBeInTheDocument();
		});

		it('should return null when lightboxFilename is null', () => {
			const props = createDefaultProps({ lightboxFilename: null });
			const { container } = renderWithProviders(<AutoRunLightbox {...props} />);

			expect(container.firstChild).toBeNull();
		});

		it('should return null when no image URL is available', () => {
			const props = createDefaultProps({
				lightboxFilename: 'nonexistent.png',
				attachmentPreviews: new Map(),
			});
			const { container } = renderWithProviders(<AutoRunLightbox {...props} />);

			expect(container.firstChild).toBeNull();
		});
	});

	// ===========================================================================
	// Navigation Buttons Rendering
	// ===========================================================================
	describe('Navigation Buttons Rendering', () => {
		it('should render navigation buttons when multiple images exist', () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			expect(screen.getByTitle('Previous image (←)')).toBeInTheDocument();
			expect(screen.getByTitle('Next image (→)')).toBeInTheDocument();
			expect(screen.getByTestId('chevron-left-icon')).toBeInTheDocument();
			expect(screen.getByTestId('chevron-right-icon')).toBeInTheDocument();
		});

		it('should NOT render navigation buttons for single image', () => {
			const singleAttachment = ['image1.png'];
			const props = createDefaultProps({
				attachmentsList: singleAttachment,
				attachmentPreviews: createMockPreviews(singleAttachment),
			});
			renderWithProviders(<AutoRunLightbox {...props} />);

			expect(screen.queryByTitle('Previous image (←)')).not.toBeInTheDocument();
			expect(screen.queryByTitle('Next image (→)')).not.toBeInTheDocument();
		});

		it('should NOT render navigation buttons for external URLs', () => {
			const props = createDefaultProps({
				lightboxExternalUrl: 'https://example.com/image.png',
			});
			renderWithProviders(<AutoRunLightbox {...props} />);

			expect(screen.queryByTitle('Previous image (←)')).not.toBeInTheDocument();
			expect(screen.queryByTitle('Next image (→)')).not.toBeInTheDocument();
		});
	});

	// ===========================================================================
	// Image Navigation via Buttons
	// ===========================================================================
	describe('Image Navigation via Buttons', () => {
		it('should navigate to next image on next button click', () => {
			const onNavigate = vi.fn();
			const props = createDefaultProps({ onNavigate });
			renderWithProviders(<AutoRunLightbox {...props} />);

			fireEvent.click(screen.getByTitle('Next image (→)'));

			expect(onNavigate).toHaveBeenCalledWith('image2.png');
		});

		it('should navigate to previous image on previous button click', () => {
			const onNavigate = vi.fn();
			const props = createDefaultProps({
				onNavigate,
				lightboxFilename: 'image2.png',
			});
			renderWithProviders(<AutoRunLightbox {...props} />);

			fireEvent.click(screen.getByTitle('Previous image (←)'));

			expect(onNavigate).toHaveBeenCalledWith('image1.png');
		});

		it('should wrap to last image when going previous from first', () => {
			const onNavigate = vi.fn();
			const props = createDefaultProps({ onNavigate });
			renderWithProviders(<AutoRunLightbox {...props} />);

			fireEvent.click(screen.getByTitle('Previous image (←)'));

			expect(onNavigate).toHaveBeenCalledWith('image3.png');
		});

		it('should wrap to first image when going next from last', () => {
			const onNavigate = vi.fn();
			const props = createDefaultProps({
				onNavigate,
				lightboxFilename: 'image3.png',
			});
			renderWithProviders(<AutoRunLightbox {...props} />);

			fireEvent.click(screen.getByTitle('Next image (→)'));

			expect(onNavigate).toHaveBeenCalledWith('image1.png');
		});

		it('should stop propagation on navigation button click', () => {
			const onNavigate = vi.fn();
			const onClose = vi.fn();
			const props = createDefaultProps({ onNavigate, onClose });
			renderWithProviders(<AutoRunLightbox {...props} />);

			fireEvent.click(screen.getByTitle('Next image (→)'));

			// onClose should NOT be called because stopPropagation prevents backdrop click
			expect(onClose).not.toHaveBeenCalled();
			expect(onNavigate).toHaveBeenCalled();
		});
	});

	// ===========================================================================
	// Keyboard Navigation (Arrow keys)
	// ===========================================================================
	describe('Keyboard Navigation (Arrow keys)', () => {
		it('should navigate to next image on ArrowRight key', () => {
			const onNavigate = vi.fn();
			const props = createDefaultProps({ onNavigate });
			renderWithProviders(<AutoRunLightbox {...props} />);

			const backdrop = document.querySelector('.fixed.inset-0.z-\\[9999\\]');
			fireEvent.keyDown(backdrop!, { key: 'ArrowRight' });

			expect(onNavigate).toHaveBeenCalledWith('image2.png');
		});

		it('should navigate to previous image on ArrowLeft key', () => {
			const onNavigate = vi.fn();
			const props = createDefaultProps({
				onNavigate,
				lightboxFilename: 'image2.png',
			});
			renderWithProviders(<AutoRunLightbox {...props} />);

			const backdrop = document.querySelector('.fixed.inset-0.z-\\[9999\\]');
			fireEvent.keyDown(backdrop!, { key: 'ArrowLeft' });

			expect(onNavigate).toHaveBeenCalledWith('image1.png');
		});

		it('should prevent default on ArrowRight key', () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			const backdrop = document.querySelector('.fixed.inset-0.z-\\[9999\\]');
			const event = fireEvent.keyDown(backdrop!, { key: 'ArrowRight' });

			// fireEvent.keyDown returns false when preventDefault is called
			expect(event).toBe(false);
		});

		it('should prevent default on ArrowLeft key', () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			const backdrop = document.querySelector('.fixed.inset-0.z-\\[9999\\]');
			const event = fireEvent.keyDown(backdrop!, { key: 'ArrowLeft' });

			expect(event).toBe(false);
		});

		it('should NOT navigate on arrow keys when viewing external URL', () => {
			const onNavigate = vi.fn();
			const props = createDefaultProps({
				onNavigate,
				lightboxExternalUrl: 'https://example.com/image.png',
			});
			renderWithProviders(<AutoRunLightbox {...props} />);

			const backdrop = document.querySelector('.fixed.inset-0.z-\\[9999\\]');
			fireEvent.keyDown(backdrop!, { key: 'ArrowRight' });

			expect(onNavigate).not.toHaveBeenCalled();
		});

		it('should NOT navigate on arrow keys when single image', () => {
			const onNavigate = vi.fn();
			const singleAttachment = ['image1.png'];
			const props = createDefaultProps({
				onNavigate,
				attachmentsList: singleAttachment,
				attachmentPreviews: createMockPreviews(singleAttachment),
			});
			renderWithProviders(<AutoRunLightbox {...props} />);

			const backdrop = document.querySelector('.fixed.inset-0.z-\\[9999\\]');
			fireEvent.keyDown(backdrop!, { key: 'ArrowRight' });

			expect(onNavigate).not.toHaveBeenCalled();
		});
	});

	// ===========================================================================
	// Escape Key - Close Lightbox (via LayerStack)
	// ===========================================================================
	describe('Escape Key - Close Lightbox', () => {
		it('should call onClose on Escape key via LayerStack', () => {
			const onClose = vi.fn();
			const props = createDefaultProps({ onClose });
			renderWithProviders(<AutoRunLightbox {...props} />);

			// Escape is handled by LayerStack via window event listener
			fireEvent.keyDown(window, { key: 'Escape' });

			expect(onClose).toHaveBeenCalled();
		});

		it('should close lightbox on Escape via LayerStack', () => {
			const onClose = vi.fn();
			const props = createDefaultProps({ onClose });
			renderWithProviders(<AutoRunLightbox {...props} />);

			// Escape is handled by LayerStack which calls the registered onEscape handler
			fireEvent.keyDown(window, { key: 'Escape' });

			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});

	// ===========================================================================
	// Delete Key - Delete Confirmation
	// ===========================================================================
	describe('Delete Key - Delete Functionality', () => {
		it('should show confirm modal on Delete key and call onDelete after confirmation', async () => {
			vi.useRealTimers(); // Need real timers for async findByRole
			const onDelete = vi.fn();
			const props = createDefaultProps({ onDelete });
			renderWithProviders(<AutoRunLightbox {...props} />);

			const backdrop = document.querySelector('.fixed.inset-0.z-\\[9999\\]');
			fireEvent.keyDown(backdrop!, { key: 'Delete' });

			// Confirm modal should appear
			const confirmButton = await screen.findByRole('button', { name: 'Confirm' });
			expect(confirmButton).toBeInTheDocument();

			// Click confirm to trigger delete
			fireEvent.click(confirmButton);

			expect(onDelete).toHaveBeenCalledWith('image1.png');
		});

		it('should show confirm modal on Backspace key and call onDelete after confirmation', async () => {
			vi.useRealTimers(); // Need real timers for async findByRole
			const onDelete = vi.fn();
			const props = createDefaultProps({ onDelete });
			renderWithProviders(<AutoRunLightbox {...props} />);

			const backdrop = document.querySelector('.fixed.inset-0.z-\\[9999\\]');
			fireEvent.keyDown(backdrop!, { key: 'Backspace' });

			// Confirm modal should appear
			const confirmButton = await screen.findByRole('button', { name: 'Confirm' });
			expect(confirmButton).toBeInTheDocument();

			// Click confirm to trigger delete
			fireEvent.click(confirmButton);

			expect(onDelete).toHaveBeenCalledWith('image1.png');
		});

		it('should prevent default on Delete key', () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			const backdrop = document.querySelector('.fixed.inset-0.z-\\[9999\\]');
			const event = fireEvent.keyDown(backdrop!, { key: 'Delete' });

			expect(event).toBe(false);
		});

		it('should NOT call onDelete on Delete key when viewing external URL', () => {
			const onDelete = vi.fn();
			const props = createDefaultProps({
				onDelete,
				lightboxExternalUrl: 'https://example.com/image.png',
			});
			renderWithProviders(<AutoRunLightbox {...props} />);

			const backdrop = document.querySelector('.fixed.inset-0.z-\\[9999\\]');
			fireEvent.keyDown(backdrop!, { key: 'Delete' });

			expect(onDelete).not.toHaveBeenCalled();
		});

		it('should NOT call onDelete on Delete key when onDelete is not provided', () => {
			const props = createDefaultProps({ onDelete: undefined });
			renderWithProviders(<AutoRunLightbox {...props} />);

			const backdrop = document.querySelector('.fixed.inset-0.z-\\[9999\\]');
			// This should not throw or cause issues
			fireEvent.keyDown(backdrop!, { key: 'Delete' });
			// No assertion needed - just verifying it doesn't throw
		});
	});

	// ===========================================================================
	// Delete Button Click
	// ===========================================================================
	describe('Delete Button Click', () => {
		it('should show confirm modal and call onDelete after confirmation', async () => {
			vi.useRealTimers(); // Need real timers for async findByRole
			const onDelete = vi.fn();
			const props = createDefaultProps({ onDelete });
			renderWithProviders(<AutoRunLightbox {...props} />);

			fireEvent.click(screen.getByTitle('Delete image (Delete key)'));

			// Confirm modal should appear
			const confirmButton = await screen.findByRole('button', { name: 'Confirm' });
			fireEvent.click(confirmButton);

			expect(onDelete).toHaveBeenCalledWith('image1.png');
		});

		it('should stop propagation on delete button click and show confirm modal', async () => {
			vi.useRealTimers(); // Need real timers for async findByRole
			const onDelete = vi.fn();
			const onClose = vi.fn();
			const props = createDefaultProps({ onDelete, onClose });
			renderWithProviders(<AutoRunLightbox {...props} />);

			fireEvent.click(screen.getByTitle('Delete image (Delete key)'));

			// onClose should NOT be called because stopPropagation prevents backdrop click
			expect(onClose).not.toHaveBeenCalled();

			// Confirm modal should appear - click confirm to complete delete
			const confirmButton = await screen.findByRole('button', { name: 'Confirm' });
			fireEvent.click(confirmButton);

			expect(onDelete).toHaveBeenCalled();
		});

		it('should navigate to next image after confirming delete when not last', async () => {
			vi.useRealTimers(); // Need real timers for async findByRole
			const onDelete = vi.fn();
			const onNavigate = vi.fn();
			const props = createDefaultProps({ onDelete, onNavigate });
			renderWithProviders(<AutoRunLightbox {...props} />);

			fireEvent.click(screen.getByTitle('Delete image (Delete key)'));

			// Confirm the delete
			const confirmButton = await screen.findByRole('button', { name: 'Confirm' });
			fireEvent.click(confirmButton);

			// After deleting image1.png, should navigate to image2.png (same index in new list)
			expect(onNavigate).toHaveBeenCalledWith('image2.png');
		});

		it('should navigate to previous image after confirming delete when last', async () => {
			vi.useRealTimers(); // Need real timers for async findByRole
			const onDelete = vi.fn();
			const onNavigate = vi.fn();
			const props = createDefaultProps({
				onDelete,
				onNavigate,
				lightboxFilename: 'image3.png',
			});
			renderWithProviders(<AutoRunLightbox {...props} />);

			fireEvent.click(screen.getByTitle('Delete image (Delete key)'));

			// Confirm the delete
			const confirmButton = await screen.findByRole('button', { name: 'Confirm' });
			fireEvent.click(confirmButton);

			// After deleting image3.png (last), should navigate to image2.png
			expect(onNavigate).toHaveBeenCalledWith('image2.png');
		});

		it('should close lightbox after confirming delete of only image', async () => {
			vi.useRealTimers(); // Need real timers for async findByRole
			const onDelete = vi.fn();
			const onClose = vi.fn();
			const singleAttachment = ['image1.png'];
			const props = createDefaultProps({
				onDelete,
				onClose,
				attachmentsList: singleAttachment,
				attachmentPreviews: createMockPreviews(singleAttachment),
			});
			renderWithProviders(<AutoRunLightbox {...props} />);

			fireEvent.click(screen.getByTitle('Delete image (Delete key)'));

			// Confirm the delete
			const confirmButton = await screen.findByRole('button', { name: 'Confirm' });
			fireEvent.click(confirmButton);

			expect(onDelete).toHaveBeenCalledWith('image1.png');
			expect(onClose).toHaveBeenCalled();
		});
	});

	// ===========================================================================
	// Copy to Clipboard (mocked)
	// ===========================================================================
	describe('Copy to Clipboard', () => {
		beforeEach(() => {
			// Use real timers for async tests
			vi.useRealTimers();
		});

		afterEach(() => {
			vi.useFakeTimers();
		});

		it('should copy image to clipboard when copy button is clicked', async () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			fireEvent.click(screen.getByTitle('Copy image to clipboard (⌘C)'));

			await waitFor(() => {
				expect(global.fetch).toHaveBeenCalledWith('data:image/png;base64,mock-data-image1.png');
				expect(mockClipboardWrite).toHaveBeenCalled();
			});
		});

		it('should copy image to clipboard when Cmd+C is pressed', async () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			const backdrop = document.querySelector('.fixed.inset-0.z-\\[9999\\]');
			fireEvent.keyDown(backdrop!, { key: 'c', metaKey: true });

			await waitFor(() => {
				expect(global.fetch).toHaveBeenCalledWith('data:image/png;base64,mock-data-image1.png');
				expect(mockClipboardWrite).toHaveBeenCalled();
			});
		});

		it('should copy image to clipboard when Ctrl+C is pressed', async () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			const backdrop = document.querySelector('.fixed.inset-0.z-\\[9999\\]');
			fireEvent.keyDown(backdrop!, { key: 'c', ctrlKey: true });

			await waitFor(() => {
				expect(global.fetch).toHaveBeenCalledWith('data:image/png;base64,mock-data-image1.png');
				expect(mockClipboardWrite).toHaveBeenCalled();
			});
		});

		it('should show "Copied!" indicator after successful copy', async () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			// Initially shows copy icon
			expect(screen.getByTestId('copy-icon')).toBeInTheDocument();

			fireEvent.click(screen.getByTitle('Copy image to clipboard (⌘C)'));

			await waitFor(() => {
				expect(screen.getByTestId('check-icon')).toBeInTheDocument();
				expect(screen.getByText('Copied!')).toBeInTheDocument();
			});
		});

		it('should reset copied indicator after 2 seconds', async () => {
			vi.useFakeTimers();

			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			const copyButton = screen.getByTitle('Copy image to clipboard (⌘C)');

			// Trigger copy and immediately resolve the promise chain
			await act(async () => {
				fireEvent.click(copyButton);
				// Allow microtasks to complete
				await Promise.resolve();
				await Promise.resolve();
			});

			// Check that check icon appears
			expect(screen.getByTestId('check-icon')).toBeInTheDocument();

			// Fast forward 2 seconds
			act(() => {
				vi.advanceTimersByTime(2000);
			});

			expect(screen.getByTestId('copy-icon')).toBeInTheDocument();
			expect(screen.queryByText('Copied!')).not.toBeInTheDocument();
		});

		it('should stop propagation on copy button click', () => {
			const onClose = vi.fn();
			const props = createDefaultProps({ onClose });
			renderWithProviders(<AutoRunLightbox {...props} />);

			fireEvent.click(screen.getByTitle('Copy image to clipboard (⌘C)'));

			// onClose should NOT be called because stopPropagation prevents backdrop click
			expect(onClose).not.toHaveBeenCalled();
		});

		it('should handle copy failure gracefully', async () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			mockClipboardWrite.mockRejectedValueOnce(new Error('Clipboard error'));

			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			fireEvent.click(screen.getByTitle('Copy image to clipboard (⌘C)'));

			await waitFor(() => {
				expect(consoleSpy).toHaveBeenCalledWith(
					'Failed to copy image to clipboard:',
					expect.any(Error)
				);
			});

			// Should still show copy icon (not check)
			expect(screen.getByTestId('copy-icon')).toBeInTheDocument();

			consoleSpy.mockRestore();
		});

		it('should copy external URL when viewing external image', async () => {
			const props = createDefaultProps({
				lightboxExternalUrl: 'https://example.com/image.png',
			});
			renderWithProviders(<AutoRunLightbox {...props} />);

			fireEvent.click(screen.getByTitle('Copy image to clipboard (⌘C)'));

			await waitFor(() => {
				expect(global.fetch).toHaveBeenCalledWith('https://example.com/image.png');
			});
		});

		it('should NOT copy when lightboxFilename is null', async () => {
			// This scenario shouldn't render, but test the guard
			const props = createDefaultProps({ lightboxFilename: null });
			const { container } = renderWithProviders(<AutoRunLightbox {...props} />);

			// Component returns null, so no button to click
			expect(container.firstChild).toBeNull();
		});
	});

	// ===========================================================================
	// Backdrop Click - Close
	// ===========================================================================
	describe('Backdrop Click - Close', () => {
		it('should call onClose when backdrop is clicked', () => {
			const onClose = vi.fn();
			const props = createDefaultProps({ onClose });
			renderWithProviders(<AutoRunLightbox {...props} />);

			const backdrop = document.querySelector('.fixed.inset-0.z-\\[9999\\]');
			fireEvent.click(backdrop!);

			expect(onClose).toHaveBeenCalled();
		});

		it('should NOT close when image is clicked', () => {
			const onClose = vi.fn();
			const props = createDefaultProps({ onClose });
			renderWithProviders(<AutoRunLightbox {...props} />);

			const img = screen.getByRole('img');
			fireEvent.click(img);

			// onClose should NOT be called because stopPropagation on image
			expect(onClose).not.toHaveBeenCalled();
		});
	});

	// ===========================================================================
	// Close Button
	// ===========================================================================
	describe('Close Button', () => {
		it('should call onClose when close button is clicked', () => {
			const onClose = vi.fn();
			const props = createDefaultProps({ onClose });
			renderWithProviders(<AutoRunLightbox {...props} />);

			fireEvent.click(screen.getByTitle('Close (ESC)'));

			expect(onClose).toHaveBeenCalled();
		});

		it('should stop propagation on close button click', () => {
			const onClose = vi.fn();
			const props = createDefaultProps({ onClose });
			renderWithProviders(<AutoRunLightbox {...props} />);

			fireEvent.click(screen.getByTitle('Close (ESC)'));

			// onClose should be called exactly once (not twice from propagation)
			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});

	// ===========================================================================
	// Bottom Info Display
	// ===========================================================================
	describe('Bottom Info Display', () => {
		it('should display the current filename', () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			expect(screen.getByText('image1.png')).toBeInTheDocument();
		});

		it('should display image position when multiple images', () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			expect(screen.getByText(/Image 1 of 3/)).toBeInTheDocument();
		});

		it('should display navigation hint when multiple images', () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			expect(screen.getByText(/← → to navigate/)).toBeInTheDocument();
		});

		it('should display delete hint when onDelete is provided', () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			expect(screen.getByText(/Delete to remove/)).toBeInTheDocument();
		});

		it('should NOT display delete hint when onDelete is not provided', () => {
			const props = createDefaultProps({ onDelete: undefined });
			renderWithProviders(<AutoRunLightbox {...props} />);

			expect(screen.queryByText(/Delete to remove/)).not.toBeInTheDocument();
		});

		it('should NOT display delete hint for external URLs', () => {
			const props = createDefaultProps({
				lightboxExternalUrl: 'https://example.com/image.png',
			});
			renderWithProviders(<AutoRunLightbox {...props} />);

			expect(screen.queryByText(/Delete to remove/)).not.toBeInTheDocument();
		});

		it('should always display ESC to close hint', () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			expect(screen.getByText(/ESC to close/)).toBeInTheDocument();
		});

		it('should NOT display navigation info for single image', () => {
			const singleAttachment = ['image1.png'];
			const props = createDefaultProps({
				attachmentsList: singleAttachment,
				attachmentPreviews: createMockPreviews(singleAttachment),
			});
			renderWithProviders(<AutoRunLightbox {...props} />);

			expect(screen.queryByText(/Image 1 of 1/)).not.toBeInTheDocument();
			expect(screen.queryByText(/← → to navigate/)).not.toBeInTheDocument();
		});
	});

	// ===========================================================================
	// Focus Management
	// ===========================================================================
	describe('Focus Management', () => {
		it('should auto-focus the backdrop for keyboard events', () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			const backdrop = document.querySelector('.fixed.inset-0.z-\\[9999\\]');
			expect(backdrop).toHaveAttribute('tabIndex', '-1');
			// The ref={(el) => el?.focus()} should focus the element
			expect(document.activeElement).toBe(backdrop);
		});
	});

	// ===========================================================================
	// Image Styling
	// ===========================================================================
	describe('Image Styling', () => {
		it('should apply max dimensions to image', () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			const img = screen.getByRole('img');
			expect(img).toHaveClass('max-w-[90%]');
			expect(img).toHaveClass('max-h-[90%]');
		});

		it('should apply rounded corners and shadow to image', () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			const img = screen.getByRole('img');
			expect(img).toHaveClass('rounded');
			expect(img).toHaveClass('shadow-2xl');
		});
	});

	// ===========================================================================
	// Button Styling
	// ===========================================================================
	describe('Button Styling', () => {
		it('should apply correct styling to navigation buttons', () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			const prevButton = screen.getByTitle('Previous image (←)');
			expect(prevButton).toHaveClass('bg-white/10');
			expect(prevButton).toHaveClass('hover:bg-white/20');
			expect(prevButton).toHaveClass('text-white');
			expect(prevButton).toHaveClass('rounded-full');
			expect(prevButton).toHaveClass('p-3');
		});

		it('should apply red background to delete button', () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			const deleteButton = screen.getByTitle('Delete image (Delete key)');
			expect(deleteButton).toHaveClass('bg-red-500/80');
			expect(deleteButton).toHaveClass('hover:bg-red-500');
		});

		it('should apply correct positioning to navigation buttons', () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			const prevButton = screen.getByTitle('Previous image (←)');
			const nextButton = screen.getByTitle('Next image (→)');

			expect(prevButton).toHaveClass('left-4');
			expect(prevButton).toHaveClass('top-1/2');
			expect(prevButton).toHaveClass('-translate-y-1/2');

			expect(nextButton).toHaveClass('right-4');
			expect(nextButton).toHaveClass('top-1/2');
			expect(nextButton).toHaveClass('-translate-y-1/2');
		});
	});

	// ===========================================================================
	// Overlay Styling
	// ===========================================================================
	describe('Overlay Styling', () => {
		it('should have dark semi-transparent background', () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			const backdrop = document.querySelector('.fixed.inset-0.z-\\[9999\\]');
			expect(backdrop).toHaveClass('bg-black/90');
		});

		it('should center content using flexbox', () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			const backdrop = document.querySelector('.fixed.inset-0.z-\\[9999\\]');
			expect(backdrop).toHaveClass('flex');
			expect(backdrop).toHaveClass('items-center');
			expect(backdrop).toHaveClass('justify-center');
		});
	});

	// ===========================================================================
	// Edge Cases
	// ===========================================================================
	describe('Edge Cases', () => {
		it('should handle empty attachmentsList gracefully', () => {
			const props = createDefaultProps({
				attachmentsList: [],
				attachmentPreviews: new Map(),
				lightboxFilename: null,
			});
			const { container } = renderWithProviders(<AutoRunLightbox {...props} />);

			expect(container.firstChild).toBeNull();
		});

		it('should handle filename not in attachmentsList', () => {
			const props = createDefaultProps({
				lightboxFilename: 'nonexistent.png',
			});
			const { container } = renderWithProviders(<AutoRunLightbox {...props} />);

			// Should return null because preview doesn't exist
			expect(container.firstChild).toBeNull();
		});

		it('should handle very long filename in display', () => {
			const longFilename = 'a'.repeat(200) + '.png';
			const props = createDefaultProps({
				attachmentsList: [longFilename],
				attachmentPreviews: createMockPreviews([longFilename]),
				lightboxFilename: longFilename,
			});
			renderWithProviders(<AutoRunLightbox {...props} />);

			// Should display with truncation class
			const filenameElement = screen.getByText(longFilename);
			expect(filenameElement).toHaveClass('truncate');
		});

		it('should handle special characters in filename', () => {
			const specialFilename = 'image (1) [test] {special}.png';
			const props = createDefaultProps({
				attachmentsList: [specialFilename],
				attachmentPreviews: createMockPreviews([specialFilename]),
				lightboxFilename: specialFilename,
			});
			renderWithProviders(<AutoRunLightbox {...props} />);

			expect(screen.getByText(specialFilename)).toBeInTheDocument();
		});

		it('should handle data: URLs in external URL', () => {
			const dataUrl =
				'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
			const props = createDefaultProps({
				lightboxFilename: 'inline-image',
				lightboxExternalUrl: dataUrl,
			});
			renderWithProviders(<AutoRunLightbox {...props} />);

			const img = screen.getByRole('img');
			expect(img).toHaveAttribute('src', dataUrl);
		});

		it('should handle rapid keyboard events', () => {
			const onNavigate = vi.fn();
			const props = createDefaultProps({ onNavigate });
			renderWithProviders(<AutoRunLightbox {...props} />);

			const backdrop = document.querySelector('.fixed.inset-0.z-\\[9999\\]');

			// Rapid arrow key presses
			for (let i = 0; i < 10; i++) {
				fireEvent.keyDown(backdrop!, { key: 'ArrowRight' });
			}

			expect(onNavigate).toHaveBeenCalledTimes(10);
		});

		it('should handle middle position image navigation', () => {
			const onNavigate = vi.fn();
			const props = createDefaultProps({
				onNavigate,
				lightboxFilename: 'image2.png',
			});
			renderWithProviders(<AutoRunLightbox {...props} />);

			// Check position display
			expect(screen.getByText(/Image 2 of 3/)).toBeInTheDocument();

			// Navigate both directions
			fireEvent.click(screen.getByTitle('Previous image (←)'));
			expect(onNavigate).toHaveBeenCalledWith('image1.png');

			fireEvent.click(screen.getByTitle('Next image (→)'));
			expect(onNavigate).toHaveBeenCalledWith('image3.png');
		});
	});

	// ===========================================================================
	// Memoization
	// ===========================================================================
	describe('Memoization', () => {
		it('should be wrapped in React.memo', () => {
			// Verify the component has a displayName (set for memoized components)
			expect(AutoRunLightbox.displayName).toBe('AutoRunLightbox');
		});
	});

	// ===========================================================================
	// Accessibility
	// ===========================================================================
	describe('Accessibility', () => {
		it('should have accessible alt text on image', () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			const img = screen.getByRole('img');
			expect(img).toHaveAttribute('alt', 'image1.png');
		});

		it('should have title attributes on all interactive buttons', () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			expect(screen.getByTitle('Previous image (←)')).toBeInTheDocument();
			expect(screen.getByTitle('Next image (→)')).toBeInTheDocument();
			expect(screen.getByTitle('Copy image to clipboard (⌘C)')).toBeInTheDocument();
			expect(screen.getByTitle('Delete image (Delete key)')).toBeInTheDocument();
			expect(screen.getByTitle('Close (ESC)')).toBeInTheDocument();
		});

		it('should have tabIndex for keyboard focus', () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			const backdrop = document.querySelector('.fixed.inset-0.z-\\[9999\\]');
			expect(backdrop).toHaveAttribute('tabIndex', '-1');
		});
	});

	// ===========================================================================
	// Icon Sizes
	// ===========================================================================
	describe('Icon Sizes', () => {
		it('should render navigation icons with correct size class', () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			const leftIcon = screen.getByTestId('chevron-left-icon');
			const rightIcon = screen.getByTestId('chevron-right-icon');

			expect(leftIcon).toHaveClass('w-6');
			expect(leftIcon).toHaveClass('h-6');
			expect(rightIcon).toHaveClass('w-6');
			expect(rightIcon).toHaveClass('h-6');
		});

		it('should render action icons with correct size class', () => {
			const props = createDefaultProps();
			renderWithProviders(<AutoRunLightbox {...props} />);

			const copyIcon = screen.getByTestId('copy-icon');
			const deleteIcon = screen.getByTestId('trash2-icon');
			const closeIcon = screen.getByTestId('x-icon');

			expect(copyIcon).toHaveClass('w-5');
			expect(copyIcon).toHaveClass('h-5');
			expect(deleteIcon).toHaveClass('w-5');
			expect(deleteIcon).toHaveClass('h-5');
			expect(closeIcon).toHaveClass('w-5');
			expect(closeIcon).toHaveClass('h-5');
		});
	});

	// ===========================================================================
	// Delete After Navigation State
	// ===========================================================================
	describe('Delete After Navigation State', () => {
		it('should correctly delete middle image and stay at same position after confirmation', async () => {
			vi.useRealTimers(); // Need real timers for async findByRole
			const onDelete = vi.fn();
			const onNavigate = vi.fn();
			const props = createDefaultProps({
				onDelete,
				onNavigate,
				lightboxFilename: 'image2.png',
			});
			renderWithProviders(<AutoRunLightbox {...props} />);

			fireEvent.click(screen.getByTitle('Delete image (Delete key)'));

			// Confirm the delete
			const confirmButton = await screen.findByRole('button', { name: 'Confirm' });
			fireEvent.click(confirmButton);

			// After deleting image2.png (index 1), should navigate to image3.png (new index 1)
			expect(onNavigate).toHaveBeenCalledWith('image3.png');
		});

		it('should handle delete when filename not found in list after confirmation', async () => {
			vi.useRealTimers(); // Need real timers for async findByRole
			const onDelete = vi.fn();
			const onNavigate = vi.fn();
			const props = createDefaultProps({
				onDelete,
				onNavigate,
				lightboxFilename: 'unknown.png',
				// Add to previews but not to list
				attachmentPreviews: createMockPreviews(['image1.png', 'unknown.png']),
			});
			renderWithProviders(<AutoRunLightbox {...props} />);

			fireEvent.click(screen.getByTitle('Delete image (Delete key)'));

			// Confirm the delete
			const confirmButton = await screen.findByRole('button', { name: 'Confirm' });
			fireEvent.click(confirmButton);

			// currentIndex is -1, which is >= totalImages - 1 (false for 3 images)
			// So it tries to navigate to newList[currentIndex] = newList[-1] which is undefined
			expect(onNavigate).toHaveBeenCalledWith(null);
		});
	});
});
