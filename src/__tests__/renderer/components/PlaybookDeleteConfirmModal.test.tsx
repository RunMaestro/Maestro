/**
 * @file PlaybookDeleteConfirmModal.test.tsx
 * @description Tests for the PlaybookDeleteConfirmModal component
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import { PlaybookDeleteConfirmModal } from '../../../renderer/components/PlaybookDeleteConfirmModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../renderer/types';

// Mock lucide-react
vi.mock('lucide-react', () => ({
	X: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="x-icon" className={className} style={style} />
	),
	AlertTriangle: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="alert-triangle-icon" className={className} style={style} />
	),
	Trash2: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="trash2-icon" className={className} style={style} />
	),
}));

// Create a mock theme for testing
const createMockTheme = (): Theme => ({
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgPanel: '#252525',
		bgSidebar: '#202020',
		bgActivity: '#2d2d2d',
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

// Wrapper component to provide LayerStackContext
const TestWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
	<LayerStackProvider>{children}</LayerStackProvider>
);

describe('PlaybookDeleteConfirmModal', () => {
	const mockTheme = createMockTheme();
	let mockOnConfirm: ReturnType<typeof vi.fn>;
	let mockOnCancel: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockOnConfirm = vi.fn();
		mockOnCancel = vi.fn();
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	describe('Basic Rendering', () => {
		it('renders the modal with title', () => {
			render(
				<TestWrapper>
					<PlaybookDeleteConfirmModal
						theme={mockTheme}
						playbookName="My Test Playbook"
						onConfirm={mockOnConfirm}
						onCancel={mockOnCancel}
					/>
				</TestWrapper>
			);

			expect(screen.getByText('Delete Playbook')).toBeInTheDocument();
		});

		it('renders trash icon in header', () => {
			render(
				<TestWrapper>
					<PlaybookDeleteConfirmModal
						theme={mockTheme}
						playbookName="My Test Playbook"
						onConfirm={mockOnConfirm}
						onCancel={mockOnCancel}
					/>
				</TestWrapper>
			);

			expect(screen.getByTestId('trash2-icon')).toBeInTheDocument();
		});

		it('displays the playbook name in the message', () => {
			render(
				<TestWrapper>
					<PlaybookDeleteConfirmModal
						theme={mockTheme}
						playbookName="My Test Playbook"
						onConfirm={mockOnConfirm}
						onCancel={mockOnCancel}
					/>
				</TestWrapper>
			);

			expect(screen.getByText('My Test Playbook')).toBeInTheDocument();
		});

		it('shows warning about irreversible action', () => {
			render(
				<TestWrapper>
					<PlaybookDeleteConfirmModal
						theme={mockTheme}
						playbookName="My Test Playbook"
						onConfirm={mockOnConfirm}
						onCancel={mockOnCancel}
					/>
				</TestWrapper>
			);

			expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
		});

		it('renders Cancel button', () => {
			render(
				<TestWrapper>
					<PlaybookDeleteConfirmModal
						theme={mockTheme}
						playbookName="My Test Playbook"
						onConfirm={mockOnConfirm}
						onCancel={mockOnCancel}
					/>
				</TestWrapper>
			);

			expect(screen.getByText('Cancel')).toBeInTheDocument();
		});

		it('renders Delete button', () => {
			render(
				<TestWrapper>
					<PlaybookDeleteConfirmModal
						theme={mockTheme}
						playbookName="My Test Playbook"
						onConfirm={mockOnConfirm}
						onCancel={mockOnCancel}
					/>
				</TestWrapper>
			);

			expect(screen.getByText('Delete')).toBeInTheDocument();
		});

		it('has proper dialog accessibility attributes', () => {
			render(
				<TestWrapper>
					<PlaybookDeleteConfirmModal
						theme={mockTheme}
						playbookName="My Test Playbook"
						onConfirm={mockOnConfirm}
						onCancel={mockOnCancel}
					/>
				</TestWrapper>
			);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-label', 'Delete Playbook');
		});
	});

	describe('Button Actions', () => {
		it('calls onCancel when Cancel button is clicked', () => {
			render(
				<TestWrapper>
					<PlaybookDeleteConfirmModal
						theme={mockTheme}
						playbookName="My Test Playbook"
						onConfirm={mockOnConfirm}
						onCancel={mockOnCancel}
					/>
				</TestWrapper>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

			expect(mockOnCancel).toHaveBeenCalledTimes(1);
			expect(mockOnConfirm).not.toHaveBeenCalled();
		});

		it('calls onConfirm and onCancel when Delete button is clicked', () => {
			render(
				<TestWrapper>
					<PlaybookDeleteConfirmModal
						theme={mockTheme}
						playbookName="My Test Playbook"
						onConfirm={mockOnConfirm}
						onCancel={mockOnCancel}
					/>
				</TestWrapper>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

			expect(mockOnConfirm).toHaveBeenCalledTimes(1);
			expect(mockOnCancel).toHaveBeenCalledTimes(1);
		});

		it('calls onCancel when X button is clicked', () => {
			const { container } = render(
				<TestWrapper>
					<PlaybookDeleteConfirmModal
						theme={mockTheme}
						playbookName="My Test Playbook"
						onConfirm={mockOnConfirm}
						onCancel={mockOnCancel}
					/>
				</TestWrapper>
			);

			// Find the X button (close button in header)
			const closeIcon = screen.getAllByTestId('x-icon')[0];
			const closeButton = closeIcon.closest('button');
			expect(closeButton).toBeTruthy();
			fireEvent.click(closeButton!);

			expect(mockOnCancel).toHaveBeenCalledTimes(1);
			expect(mockOnConfirm).not.toHaveBeenCalled();
		});
	});

	describe('Auto Focus', () => {
		it('Delete button receives focus on mount', async () => {
			render(
				<TestWrapper>
					<PlaybookDeleteConfirmModal
						theme={mockTheme}
						playbookName="My Test Playbook"
						onConfirm={mockOnConfirm}
						onCancel={mockOnCancel}
					/>
				</TestWrapper>
			);

			const deleteButton = screen.getByText('Delete');

			// Wait for auto-focus effect
			await waitFor(() => {
				expect(document.activeElement).toBe(deleteButton);
			});
		});
	});

	describe('Theme Styling', () => {
		it('applies theme colors to modal container', () => {
			const { container } = render(
				<TestWrapper>
					<PlaybookDeleteConfirmModal
						theme={mockTheme}
						playbookName="My Test Playbook"
						onConfirm={mockOnConfirm}
						onCancel={mockOnCancel}
					/>
				</TestWrapper>
			);

			// Modal component uses inline width style instead of Tailwind class
			const modalBox = container.querySelector('[style*="width: 400px"]');
			expect(modalBox).toHaveStyle({
				backgroundColor: mockTheme.colors.bgSidebar,
				borderColor: mockTheme.colors.border,
			});
		});

		it('applies error color to Delete button', () => {
			render(
				<TestWrapper>
					<PlaybookDeleteConfirmModal
						theme={mockTheme}
						playbookName="My Test Playbook"
						onConfirm={mockOnConfirm}
						onCancel={mockOnCancel}
					/>
				</TestWrapper>
			);

			const deleteButton = screen.getByText('Delete');
			expect(deleteButton).toHaveStyle({
				backgroundColor: mockTheme.colors.error,
			});
		});

		it('applies theme colors to title', () => {
			render(
				<TestWrapper>
					<PlaybookDeleteConfirmModal
						theme={mockTheme}
						playbookName="My Test Playbook"
						onConfirm={mockOnConfirm}
						onCancel={mockOnCancel}
					/>
				</TestWrapper>
			);

			const title = screen.getByText('Delete Playbook');
			expect(title).toHaveStyle({
				color: mockTheme.colors.textMain,
			});
		});

		it('applies error color to alert icon', () => {
			const { container } = render(
				<TestWrapper>
					<PlaybookDeleteConfirmModal
						theme={mockTheme}
						playbookName="My Test Playbook"
						onConfirm={mockOnConfirm}
						onCancel={mockOnCancel}
					/>
				</TestWrapper>
			);

			const alertIcon = screen.getByTestId('alert-triangle-icon');
			expect(alertIcon).toHaveStyle({
				color: mockTheme.colors.error,
			});
		});

		it('applies dim color to warning text', () => {
			render(
				<TestWrapper>
					<PlaybookDeleteConfirmModal
						theme={mockTheme}
						playbookName="My Test Playbook"
						onConfirm={mockOnConfirm}
						onCancel={mockOnCancel}
					/>
				</TestWrapper>
			);

			const warning = screen.getByText('This cannot be undone.');
			expect(warning).toHaveStyle({
				color: mockTheme.colors.textDim,
			});
		});
	});

	describe('Keyboard Handling', () => {
		it('stops propagation of key events', () => {
			const parentHandler = vi.fn();

			render(
				<TestWrapper>
					<div onKeyDown={parentHandler}>
						<PlaybookDeleteConfirmModal
							theme={mockTheme}
							playbookName="My Test Playbook"
							onConfirm={mockOnConfirm}
							onCancel={mockOnCancel}
						/>
					</div>
				</TestWrapper>
			);

			const dialog = screen.getByRole('dialog');
			fireEvent.keyDown(dialog, { key: 'Enter' });

			// Key event should not propagate to parent
			expect(parentHandler).not.toHaveBeenCalled();
		});
	});

	describe('Modal Layout', () => {
		it('has fixed positioning with backdrop', () => {
			render(
				<TestWrapper>
					<PlaybookDeleteConfirmModal
						theme={mockTheme}
						playbookName="My Test Playbook"
						onConfirm={mockOnConfirm}
						onCancel={mockOnCancel}
					/>
				</TestWrapper>
			);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveClass('fixed', 'inset-0');
		});

		it('has proper width style', () => {
			const { container } = render(
				<TestWrapper>
					<PlaybookDeleteConfirmModal
						theme={mockTheme}
						playbookName="My Test Playbook"
						onConfirm={mockOnConfirm}
						onCancel={mockOnCancel}
					/>
				</TestWrapper>
			);

			// Modal component uses inline width style instead of Tailwind class
			const modalBox = container.querySelector('[style*="width: 400px"]');
			expect(modalBox).toBeInTheDocument();
		});
	});

	describe('Content Display', () => {
		it('displays confirmation message with playbook name', () => {
			render(
				<TestWrapper>
					<PlaybookDeleteConfirmModal
						theme={mockTheme}
						playbookName="Critical Production Playbook"
						onConfirm={mockOnConfirm}
						onCancel={mockOnCancel}
					/>
				</TestWrapper>
			);

			expect(screen.getByText(/Are you sure you want to delete/)).toBeInTheDocument();
			expect(screen.getByText('Critical Production Playbook')).toBeInTheDocument();
		});

		it('emphasizes playbook name in bold', () => {
			render(
				<TestWrapper>
					<PlaybookDeleteConfirmModal
						theme={mockTheme}
						playbookName="Important Playbook"
						onConfirm={mockOnConfirm}
						onCancel={mockOnCancel}
					/>
				</TestWrapper>
			);

			const boldName = screen.getByText('Important Playbook');
			expect(boldName.tagName).toBe('STRONG');
		});
	});

	describe('Edge Cases', () => {
		it('handles playbook name with special characters', () => {
			render(
				<TestWrapper>
					<PlaybookDeleteConfirmModal
						theme={mockTheme}
						playbookName="Test <script>alert('xss')</script>"
						onConfirm={mockOnConfirm}
						onCancel={mockOnCancel}
					/>
				</TestWrapper>
			);

			// React escapes HTML automatically
			expect(screen.getByText("Test <script>alert('xss')</script>")).toBeInTheDocument();
		});

		it('handles very long playbook name', () => {
			const longName = 'A'.repeat(100);
			render(
				<TestWrapper>
					<PlaybookDeleteConfirmModal
						theme={mockTheme}
						playbookName={longName}
						onConfirm={mockOnConfirm}
						onCancel={mockOnCancel}
					/>
				</TestWrapper>
			);

			expect(screen.getByText(longName)).toBeInTheDocument();
		});

		it('handles empty playbook name', () => {
			render(
				<TestWrapper>
					<PlaybookDeleteConfirmModal
						theme={mockTheme}
						playbookName=""
						onConfirm={mockOnConfirm}
						onCancel={mockOnCancel}
					/>
				</TestWrapper>
			);

			// Should still render the modal
			expect(screen.getByText('Delete Playbook')).toBeInTheDocument();
		});
	});
});
