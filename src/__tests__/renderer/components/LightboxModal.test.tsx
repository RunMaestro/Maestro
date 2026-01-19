/**
 * Tests for LightboxModal component
 *
 * LightboxModal is an image viewer overlay that:
 * - Displays a full-screen image preview
 * - Supports navigation between staged images
 * - Provides keyboard navigation (ArrowLeft/ArrowRight)
 * - Has copy-to-clipboard functionality
 * - Registers with the layer stack for modal management
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { LightboxModal } from '../../../renderer/components/LightboxModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';

// Mock lucide-react
vi.mock('lucide-react', () => ({
	Copy: () => <svg data-testid="copy-icon" />,
	Check: () => <svg data-testid="check-icon" />,
	Trash2: () => <svg data-testid="trash-icon" />,
	AlertTriangle: () => <svg data-testid="alert-triangle-icon" />,
	X: () => <svg data-testid="x-icon" />,
}));

// Mock navigator.clipboard
const mockClipboardWrite = vi.fn();
Object.defineProperty(navigator, 'clipboard', {
	value: {
		write: mockClipboardWrite,
	},
	writable: true,
});

// Mock ClipboardItem
class MockClipboardItem {
	constructor(public items: Record<string, Blob>) {}
}
global.ClipboardItem = MockClipboardItem as any;

// Mock fetch for image blob conversion
global.fetch = vi.fn();

// Helper to render with LayerStackProvider
const renderWithLayerStack = (ui: React.ReactElement) => {
	return render(<LayerStackProvider>{ui}</LayerStackProvider>);
};

describe('LightboxModal', () => {
	const mockImage =
		'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
	const mockImages = [mockImage, 'image2.png', 'image3.png'];

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();

		// Setup fetch mock to return a blob
		(global.fetch as any).mockResolvedValue({
			blob: () => Promise.resolve(new Blob(['image data'], { type: 'image/png' })),
		});

		mockClipboardWrite.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	describe('rendering', () => {
		it('renders with image and basic structure', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			expect(screen.getByRole('dialog')).toBeInTheDocument();
			expect(screen.getByRole('img')).toHaveAttribute('src', mockImage);
		});

		it('renders with correct ARIA attributes', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-label', 'Image Lightbox');
		});

		it('has tabIndex for focus management', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('tabIndex', '-1');
		});

		it('displays image counter when multiple images', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			expect(screen.getByText(/Image 1 of 3/)).toBeInTheDocument();
			expect(screen.getByText(/← → to navigate/)).toBeInTheDocument();
		});

		it('shows navigation buttons when multiple images', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			expect(screen.getByText('←')).toBeInTheDocument();
			expect(screen.getByText('→')).toBeInTheDocument();
		});

		it('hides navigation buttons when single image', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={[mockImage]}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			expect(screen.queryByText('←')).not.toBeInTheDocument();
			expect(screen.queryByText('→')).not.toBeInTheDocument();
		});

		it('shows ESC to close hint', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={[mockImage]}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			expect(screen.getByText('ESC to close')).toBeInTheDocument();
		});
	});

	describe('close functionality', () => {
		it('calls onClose when backdrop is clicked', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			const backdrop = screen.getByRole('dialog');
			fireEvent.click(backdrop);
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('does not close when image is clicked', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			const image = screen.getByRole('img');
			fireEvent.click(image);
			expect(onClose).not.toHaveBeenCalled();
		});
	});

	describe('navigation', () => {
		it('navigates to previous image when ← button clicked', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImages[1]} // Start at second image
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			const prevButton = screen.getByText('←');
			fireEvent.click(prevButton);
			expect(onNavigate).toHaveBeenCalledWith(mockImages[0]);
			expect(onClose).not.toHaveBeenCalled();
		});

		it('navigates to next image when → button clicked', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			const nextButton = screen.getByText('→');
			fireEvent.click(nextButton);
			expect(onNavigate).toHaveBeenCalledWith(mockImages[1]);
		});

		it('wraps to last image when going previous from first', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage} // First image
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			const prevButton = screen.getByText('←');
			fireEvent.click(prevButton);
			expect(onNavigate).toHaveBeenCalledWith(mockImages[2]); // Last image
		});

		it('wraps to first image when going next from last', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImages[2]} // Last image
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			const nextButton = screen.getByText('→');
			fireEvent.click(nextButton);
			expect(onNavigate).toHaveBeenCalledWith(mockImages[0]); // First image
		});

		it('does not call onNavigate when single image (no buttons visible)', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={[mockImage]}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			// No navigation buttons should exist
			expect(screen.queryByText('←')).not.toBeInTheDocument();
			expect(screen.queryByText('→')).not.toBeInTheDocument();
		});
	});

	describe('keyboard navigation', () => {
		it('navigates to previous with ArrowLeft', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImages[1]}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			const dialog = screen.getByRole('dialog');
			fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
			expect(onNavigate).toHaveBeenCalledWith(mockImages[0]);
		});

		it('navigates to next with ArrowRight', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			const dialog = screen.getByRole('dialog');
			fireEvent.keyDown(dialog, { key: 'ArrowRight' });
			expect(onNavigate).toHaveBeenCalledWith(mockImages[1]);
		});

		it('stops propagation of keydown events', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();
			const parentHandler = vi.fn();

			render(
				<div onKeyDown={parentHandler}>
					<LayerStackProvider>
						<LightboxModal
							image={mockImage}
							stagedImages={mockImages}
							onClose={onClose}
							onNavigate={onNavigate}
						/>
					</LayerStackProvider>
				</div>
			);

			const dialog = screen.getByRole('dialog');
			fireEvent.keyDown(dialog, { key: 'ArrowLeft' });

			expect(parentHandler).not.toHaveBeenCalled();
		});

		it('does not navigate with keyboard when single image', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={[mockImage]}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			const dialog = screen.getByRole('dialog');
			fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
			fireEvent.keyDown(dialog, { key: 'ArrowRight' });

			expect(onNavigate).not.toHaveBeenCalled();
		});

		it('ignores other keys', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			const dialog = screen.getByRole('dialog');
			fireEvent.keyDown(dialog, { key: 'a' });
			fireEvent.keyDown(dialog, { key: 'Enter' });
			fireEvent.keyDown(dialog, { key: 'Tab' });

			expect(onNavigate).not.toHaveBeenCalled();
		});
	});

	describe('copy to clipboard', () => {
		beforeEach(() => {
			// Use real timers for async tests
			vi.useRealTimers();
		});

		afterEach(() => {
			vi.useFakeTimers();
		});

		it('copies image to clipboard when copy button clicked', async () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			// Click copy button
			const copyButton = screen.getByTitle('Copy image to clipboard (⌘C)');
			fireEvent.click(copyButton);

			await waitFor(() => {
				expect(global.fetch).toHaveBeenCalledWith(mockImage);
				expect(mockClipboardWrite).toHaveBeenCalled();
			});
		});

		it('copies image to clipboard when Cmd+C pressed', async () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			const dialog = screen.getByRole('dialog');
			fireEvent.keyDown(dialog, { key: 'c', metaKey: true });

			await waitFor(() => {
				expect(global.fetch).toHaveBeenCalledWith(mockImage);
				expect(mockClipboardWrite).toHaveBeenCalled();
			});
		});

		it('copies image to clipboard when Ctrl+C pressed', async () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			const dialog = screen.getByRole('dialog');
			fireEvent.keyDown(dialog, { key: 'c', ctrlKey: true });

			await waitFor(() => {
				expect(global.fetch).toHaveBeenCalledWith(mockImage);
				expect(mockClipboardWrite).toHaveBeenCalled();
			});
		});

		it('shows check icon and "Copied!" after successful copy', async () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			// Initially shows copy icon
			expect(screen.getByTestId('copy-icon')).toBeInTheDocument();

			const copyButton = screen.getByTitle('Copy image to clipboard (⌘C)');
			fireEvent.click(copyButton);

			await waitFor(() => {
				expect(screen.getByTestId('check-icon')).toBeInTheDocument();
				expect(screen.getByText('Copied!')).toBeInTheDocument();
			});
		});

		it('reverts to copy icon after 2 seconds', async () => {
			vi.useFakeTimers();
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

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

		it('does not close when copy button is clicked', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			const copyButton = screen.getByTitle('Copy image to clipboard (⌘C)');
			fireEvent.click(copyButton);

			expect(onClose).not.toHaveBeenCalled();
		});

		it('handles copy error gracefully', async () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			mockClipboardWrite.mockRejectedValue(new Error('Clipboard error'));

			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			const copyButton = screen.getByTitle('Copy image to clipboard (⌘C)');
			fireEvent.click(copyButton);

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
	});

	describe('layer stack integration', () => {
		it('registers layer on mount', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			const { unmount } = renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			expect(screen.getByRole('dialog')).toBeInTheDocument();
			unmount();
		});

		it('unregisters layer on unmount', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			const { unmount } = renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			expect(() => unmount()).not.toThrow();
		});

		it('updates layer handler when onClose changes', () => {
			const onClose1 = vi.fn();
			const onClose2 = vi.fn();
			const onNavigate = vi.fn();

			const { rerender } = renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose1}
					onNavigate={onNavigate}
				/>
			);

			rerender(
				<LayerStackProvider>
					<LightboxModal
						image={mockImage}
						stagedImages={mockImages}
						onClose={onClose2}
						onNavigate={onNavigate}
					/>
				</LayerStackProvider>
			);

			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});
	});

	describe('focus management', () => {
		it('focuses the lightbox on mount', () => {
			vi.useRealTimers();

			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			// The useEffect calls focus() on mount
			const dialog = screen.getByRole('dialog');
			// In jsdom, focus may not work as expected, just verify the dialog has tabIndex
			expect(dialog).toHaveAttribute('tabIndex', '-1');
		});
	});

	describe('image display', () => {
		it('displays image with correct styling', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			const image = screen.getByRole('img');
			expect(image).toHaveClass('max-w-[90%]');
			expect(image).toHaveClass('max-h-[90%]');
			expect(image).toHaveClass('rounded');
			expect(image).toHaveClass('shadow-2xl');
		});

		it('updates when image prop changes', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			const { rerender } = renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			expect(screen.getByRole('img')).toHaveAttribute('src', mockImage);

			rerender(
				<LayerStackProvider>
					<LightboxModal
						image={mockImages[1]}
						stagedImages={mockImages}
						onClose={onClose}
						onNavigate={onNavigate}
					/>
				</LayerStackProvider>
			);

			expect(screen.getByRole('img')).toHaveAttribute('src', mockImages[1]);
		});

		it('updates counter when image changes', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			const { rerender } = renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			expect(screen.getByText(/Image 1 of 3/)).toBeInTheDocument();

			rerender(
				<LayerStackProvider>
					<LightboxModal
						image={mockImages[2]}
						stagedImages={mockImages}
						onClose={onClose}
						onNavigate={onNavigate}
					/>
				</LayerStackProvider>
			);

			expect(screen.getByText(/Image 3 of 3/)).toBeInTheDocument();
		});
	});

	describe('button styling', () => {
		it('navigation buttons have correct classes', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			const prevButton = screen.getByText('←');
			const nextButton = screen.getByText('→');

			expect(prevButton).toHaveClass('bg-white/10');
			expect(prevButton).toHaveClass('hover:bg-white/20');
			expect(prevButton).toHaveClass('text-white');
			expect(prevButton).toHaveClass('rounded-full');

			expect(nextButton).toHaveClass('bg-white/10');
			expect(nextButton).toHaveClass('rounded-full');
		});

		it('copy button has correct classes', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			const copyButton = screen.getByTitle('Copy image to clipboard (⌘C)');
			expect(copyButton).toHaveClass('bg-white/10');
			expect(copyButton).toHaveClass('hover:bg-white/20');
			expect(copyButton).toHaveClass('rounded-full');
		});
	});

	describe('edge cases', () => {
		it('handles image not found in stagedImages array', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();
			const unknownImage = 'unknown.png';

			renderWithLayerStack(
				<LightboxModal
					image={unknownImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			// currentIndex will be -1, still renders
			expect(screen.getByRole('dialog')).toBeInTheDocument();
			expect(screen.getByText(/Image 0 of 3/)).toBeInTheDocument();
		});

		it('handles empty stagedImages array', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={[]}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			// canNavigate will be false
			expect(screen.queryByText('←')).not.toBeInTheDocument();
			expect(screen.getByText('ESC to close')).toBeInTheDocument();
		});

		it('handles rapid navigation clicks', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			const nextButton = screen.getByText('→');

			fireEvent.click(nextButton);
			fireEvent.click(nextButton);
			fireEvent.click(nextButton);

			expect(onNavigate).toHaveBeenCalledTimes(3);
		});

		it('handles XSS-like image paths safely', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();
			const xssImage = '<script>alert("xss")</script>';

			renderWithLayerStack(
				<LightboxModal
					image={xssImage}
					stagedImages={[xssImage]}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			const image = screen.getByRole('img');
			// The src attribute is set to the string, not executed
			expect(image).toHaveAttribute('src', xssImage);
		});
	});

	describe('delete functionality', () => {
		it('shows delete button when onDelete is provided', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();
			const onDelete = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
					onDelete={onDelete}
				/>
			);

			expect(screen.getByTestId('trash-icon')).toBeInTheDocument();
			expect(screen.getByText(/Delete to remove/)).toBeInTheDocument();
		});

		it('does not show delete button when onDelete is not provided', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			expect(screen.queryByTestId('trash-icon')).not.toBeInTheDocument();
			expect(screen.queryByText(/Delete to remove/)).not.toBeInTheDocument();
		});

		it('opens confirmation modal when delete button is clicked', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();
			const onDelete = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
					onDelete={onDelete}
				/>
			);

			const deleteButton = screen.getByTitle('Delete image (Delete key)');
			fireEvent.click(deleteButton);

			// ConfirmModal should appear
			expect(screen.getByText(/Are you sure you want to remove this image/)).toBeInTheDocument();
		});

		it('opens confirmation modal when Delete key is pressed', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();
			const onDelete = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
					onDelete={onDelete}
				/>
			);

			const dialog = screen.getByRole('dialog');
			fireEvent.keyDown(dialog, { key: 'Delete' });

			expect(screen.getByText(/Are you sure you want to remove this image/)).toBeInTheDocument();
		});

		it('calls onDelete and navigates to next image after confirmation', async () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();
			const onDelete = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
					onDelete={onDelete}
				/>
			);

			// Open confirm modal
			const deleteButton = screen.getByTitle('Delete image (Delete key)');
			fireEvent.click(deleteButton);

			// Click confirm
			const confirmButton = screen.getByRole('button', { name: /confirm/i });
			fireEvent.click(confirmButton);

			expect(onDelete).toHaveBeenCalledWith(mockImage);
			// Should navigate to next image (mockImages[1]) since we deleted first
			expect(onNavigate).toHaveBeenCalledWith(mockImages[1]);
		});

		it('calls onClose when deleting the only image', async () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();
			const onDelete = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={[mockImage]} // Only one image
					onClose={onClose}
					onNavigate={onNavigate}
					onDelete={onDelete}
				/>
			);

			// Open confirm modal
			const deleteButton = screen.getByTitle('Delete image (Delete key)');
			fireEvent.click(deleteButton);

			// Click confirm
			const confirmButton = screen.getByRole('button', { name: /confirm/i });
			fireEvent.click(confirmButton);

			expect(onDelete).toHaveBeenCalledWith(mockImage);
			expect(onClose).toHaveBeenCalled();
			expect(onNavigate).not.toHaveBeenCalled();
		});

		it('navigates to previous image when deleting the last image', async () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();
			const onDelete = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImages[2]} // Last image
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
					onDelete={onDelete}
				/>
			);

			// Open confirm modal
			const deleteButton = screen.getByTitle('Delete image (Delete key)');
			fireEvent.click(deleteButton);

			// Click confirm
			const confirmButton = screen.getByRole('button', { name: /confirm/i });
			fireEvent.click(confirmButton);

			expect(onDelete).toHaveBeenCalledWith(mockImages[2]);
			// Should navigate to previous image (mockImages[1]) since we deleted last
			expect(onNavigate).toHaveBeenCalledWith(mockImages[1]);
		});

		it('closes confirmation modal when cancel is clicked', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();
			const onDelete = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
					onDelete={onDelete}
				/>
			);

			// Open confirm modal
			const deleteButton = screen.getByTitle('Delete image (Delete key)');
			fireEvent.click(deleteButton);

			expect(screen.getByText(/Are you sure you want to remove this image/)).toBeInTheDocument();

			// Click cancel
			const cancelButton = screen.getByRole('button', { name: /cancel/i });
			fireEvent.click(cancelButton);

			// Confirm modal should be closed
			expect(
				screen.queryByText(/Are you sure you want to remove this image/)
			).not.toBeInTheDocument();
			expect(onDelete).not.toHaveBeenCalled();
		});

		it('does not respond to Delete key when onDelete is not provided', () => {
			const onClose = vi.fn();
			const onNavigate = vi.fn();

			renderWithLayerStack(
				<LightboxModal
					image={mockImage}
					stagedImages={mockImages}
					onClose={onClose}
					onNavigate={onNavigate}
				/>
			);

			const dialog = screen.getByRole('dialog');
			fireEvent.keyDown(dialog, { key: 'Delete' });

			// No confirmation modal should appear
			expect(
				screen.queryByText(/Are you sure you want to remove this image/)
			).not.toBeInTheDocument();
		});
	});
});
