/**
 * @file RenameTabModal.test.tsx
 * @description Tests for the RenameTabModal component
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import { RenameTabModal } from '../../../renderer/components/RenameTabModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../renderer/types';

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

describe('RenameTabModal', () => {
	const mockTheme = createMockTheme();
	let mockOnClose: ReturnType<typeof vi.fn>;
	let mockOnRename: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockOnClose = vi.fn();
		mockOnRename = vi.fn();
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	describe('Basic Rendering', () => {
		it('renders the modal with title', () => {
			render(
				<TestWrapper>
					<RenameTabModal
						theme={mockTheme}
						initialName="My Tab"
						onClose={mockOnClose}
						onRename={mockOnRename}
					/>
				</TestWrapper>
			);

			expect(screen.getByText('Rename Tab')).toBeInTheDocument();
		});

		it('renders input with initial name', () => {
			render(
				<TestWrapper>
					<RenameTabModal
						theme={mockTheme}
						initialName="My Tab"
						onClose={mockOnClose}
						onRename={mockOnRename}
					/>
				</TestWrapper>
			);

			const input = screen.getByRole('textbox');
			expect(input).toHaveValue('My Tab');
		});

		it('renders Cancel button', () => {
			render(
				<TestWrapper>
					<RenameTabModal
						theme={mockTheme}
						initialName="My Tab"
						onClose={mockOnClose}
						onRename={mockOnRename}
					/>
				</TestWrapper>
			);

			expect(screen.getByText('Cancel')).toBeInTheDocument();
		});

		it('renders Rename button', () => {
			render(
				<TestWrapper>
					<RenameTabModal
						theme={mockTheme}
						initialName="My Tab"
						onClose={mockOnClose}
						onRename={mockOnRename}
					/>
				</TestWrapper>
			);

			expect(screen.getByText('Rename')).toBeInTheDocument();
		});

		it('has proper dialog accessibility attributes', () => {
			render(
				<TestWrapper>
					<RenameTabModal
						theme={mockTheme}
						initialName="My Tab"
						onClose={mockOnClose}
						onRename={mockOnRename}
					/>
				</TestWrapper>
			);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-label', 'Rename Tab');
		});
	});

	describe('Placeholder', () => {
		it('shows default placeholder when no agentSessionId', () => {
			render(
				<TestWrapper>
					<RenameTabModal
						theme={mockTheme}
						initialName=""
						onClose={mockOnClose}
						onRename={mockOnRename}
					/>
				</TestWrapper>
			);

			const input = screen.getByRole('textbox');
			expect(input).toHaveAttribute('placeholder', 'Enter tab name...');
		});

		it('shows UUID-based placeholder when agentSessionId is provided', () => {
			render(
				<TestWrapper>
					<RenameTabModal
						theme={mockTheme}
						initialName=""
						agentSessionId="abc123-def456-ghi789"
						onClose={mockOnClose}
						onRename={mockOnRename}
					/>
				</TestWrapper>
			);

			const input = screen.getByRole('textbox');
			expect(input).toHaveAttribute('placeholder', 'Rename ABC123...');
		});

		it('handles null agentSessionId', () => {
			render(
				<TestWrapper>
					<RenameTabModal
						theme={mockTheme}
						initialName=""
						agentSessionId={null}
						onClose={mockOnClose}
						onRename={mockOnRename}
					/>
				</TestWrapper>
			);

			const input = screen.getByRole('textbox');
			expect(input).toHaveAttribute('placeholder', 'Enter tab name...');
		});
	});

	describe('Button Actions', () => {
		it('calls onClose when Cancel button is clicked', () => {
			render(
				<TestWrapper>
					<RenameTabModal
						theme={mockTheme}
						initialName="My Tab"
						onClose={mockOnClose}
						onRename={mockOnRename}
					/>
				</TestWrapper>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

			expect(mockOnClose).toHaveBeenCalledTimes(1);
			expect(mockOnRename).not.toHaveBeenCalled();
		});

		it('calls onRename and onClose when Rename button is clicked', () => {
			render(
				<TestWrapper>
					<RenameTabModal
						theme={mockTheme}
						initialName="My Tab"
						onClose={mockOnClose}
						onRename={mockOnRename}
					/>
				</TestWrapper>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

			expect(mockOnRename).toHaveBeenCalledWith('My Tab');
			expect(mockOnClose).toHaveBeenCalledTimes(1);
		});

		it('calls onClose when X button is clicked', () => {
			const { container } = render(
				<TestWrapper>
					<RenameTabModal
						theme={mockTheme}
						initialName="My Tab"
						onClose={mockOnClose}
						onRename={mockOnRename}
					/>
				</TestWrapper>
			);

			// Find the X button (close button in header)
			const closeIcon = screen.getAllByTestId('x-icon')[0];
			const closeButton = closeIcon.closest('button');
			expect(closeButton).toBeTruthy();
			fireEvent.click(closeButton!);

			expect(mockOnClose).toHaveBeenCalledTimes(1);
			expect(mockOnRename).not.toHaveBeenCalled();
		});
	});

	describe('Input Handling', () => {
		it('updates value when typing', () => {
			render(
				<TestWrapper>
					<RenameTabModal
						theme={mockTheme}
						initialName="My Tab"
						onClose={mockOnClose}
						onRename={mockOnRename}
					/>
				</TestWrapper>
			);

			const input = screen.getByRole('textbox');
			fireEvent.change(input, { target: { value: 'New Name' } });

			expect(input).toHaveValue('New Name');
		});

		it('submits on Enter key', () => {
			render(
				<TestWrapper>
					<RenameTabModal
						theme={mockTheme}
						initialName="My Tab"
						onClose={mockOnClose}
						onRename={mockOnRename}
					/>
				</TestWrapper>
			);

			const input = screen.getByRole('textbox');
			fireEvent.keyDown(input, { key: 'Enter' });

			expect(mockOnRename).toHaveBeenCalledWith('My Tab');
			expect(mockOnClose).toHaveBeenCalledTimes(1);
		});

		it('trims whitespace when submitting', () => {
			render(
				<TestWrapper>
					<RenameTabModal
						theme={mockTheme}
						initialName="  Padded Name  "
						onClose={mockOnClose}
						onRename={mockOnRename}
					/>
				</TestWrapper>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

			expect(mockOnRename).toHaveBeenCalledWith('Padded Name');
		});

		it('submits trimmed value on Enter', () => {
			render(
				<TestWrapper>
					<RenameTabModal
						theme={mockTheme}
						initialName="My Tab"
						onClose={mockOnClose}
						onRename={mockOnRename}
					/>
				</TestWrapper>
			);

			const input = screen.getByRole('textbox');
			fireEvent.change(input, { target: { value: '  New Name  ' } });
			fireEvent.keyDown(input, { key: 'Enter' });

			expect(mockOnRename).toHaveBeenCalledWith('New Name');
		});
	});

	describe('Auto Focus', () => {
		it('input receives focus on mount', async () => {
			render(
				<TestWrapper>
					<RenameTabModal
						theme={mockTheme}
						initialName="My Tab"
						onClose={mockOnClose}
						onRename={mockOnRename}
					/>
				</TestWrapper>
			);

			const input = screen.getByRole('textbox');

			// Wait for requestAnimationFrame to complete
			await waitFor(() => {
				expect(document.activeElement).toBe(input);
			});
		});
	});

	describe('Theme Styling', () => {
		it('applies theme colors to modal container', () => {
			const { container } = render(
				<TestWrapper>
					<RenameTabModal
						theme={mockTheme}
						initialName="My Tab"
						onClose={mockOnClose}
						onRename={mockOnRename}
					/>
				</TestWrapper>
			);

			// Modal component uses inline style for width instead of Tailwind class
			const modalBox = container.querySelector('[style*="width: 400px"]');
			expect(modalBox).toHaveStyle({
				backgroundColor: mockTheme.colors.bgSidebar,
				borderColor: mockTheme.colors.border,
			});
		});

		it('applies accent color to Rename button', () => {
			render(
				<TestWrapper>
					<RenameTabModal
						theme={mockTheme}
						initialName="My Tab"
						onClose={mockOnClose}
						onRename={mockOnRename}
					/>
				</TestWrapper>
			);

			const renameButton = screen.getByText('Rename');
			expect(renameButton).toHaveStyle({
				backgroundColor: mockTheme.colors.accent,
				color: mockTheme.colors.accentForeground,
			});
		});

		it('applies theme colors to title', () => {
			render(
				<TestWrapper>
					<RenameTabModal
						theme={mockTheme}
						initialName="My Tab"
						onClose={mockOnClose}
						onRename={mockOnRename}
					/>
				</TestWrapper>
			);

			const title = screen.getByText('Rename Tab');
			expect(title).toHaveStyle({
				color: mockTheme.colors.textMain,
			});
		});

		it('applies theme colors to input', () => {
			render(
				<TestWrapper>
					<RenameTabModal
						theme={mockTheme}
						initialName="My Tab"
						onClose={mockOnClose}
						onRename={mockOnRename}
					/>
				</TestWrapper>
			);

			const input = screen.getByRole('textbox');
			expect(input).toHaveStyle({
				borderColor: mockTheme.colors.border,
				color: mockTheme.colors.textMain,
			});
		});

		it('applies dim color to close button', () => {
			const { container } = render(
				<TestWrapper>
					<RenameTabModal
						theme={mockTheme}
						initialName="My Tab"
						onClose={mockOnClose}
						onRename={mockOnRename}
					/>
				</TestWrapper>
			);

			const closeIcon = screen.getAllByTestId('x-icon')[0];
			const closeButton = closeIcon.closest('button');
			expect(closeButton).toHaveStyle({
				color: mockTheme.colors.textDim,
			});
		});
	});

	describe('Modal Layout', () => {
		it('has fixed positioning with backdrop', () => {
			render(
				<TestWrapper>
					<RenameTabModal
						theme={mockTheme}
						initialName="My Tab"
						onClose={mockOnClose}
						onRename={mockOnRename}
					/>
				</TestWrapper>
			);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveClass('fixed', 'inset-0');
		});

		it('has proper width style', () => {
			const { container } = render(
				<TestWrapper>
					<RenameTabModal
						theme={mockTheme}
						initialName="My Tab"
						onClose={mockOnClose}
						onRename={mockOnRename}
					/>
				</TestWrapper>
			);

			// Modal component uses inline style for width instead of Tailwind class
			const modalBox = container.querySelector('[style*="width: 400px"]');
			expect(modalBox).toBeInTheDocument();
		});
	});

	describe('Edge Cases', () => {
		it('handles empty initial name', () => {
			render(
				<TestWrapper>
					<RenameTabModal
						theme={mockTheme}
						initialName=""
						onClose={mockOnClose}
						onRename={mockOnRename}
					/>
				</TestWrapper>
			);

			const input = screen.getByRole('textbox');
			expect(input).toHaveValue('');
		});

		it('handles renaming to empty string', () => {
			render(
				<TestWrapper>
					<RenameTabModal
						theme={mockTheme}
						initialName="My Tab"
						onClose={mockOnClose}
						onRename={mockOnRename}
					/>
				</TestWrapper>
			);

			const input = screen.getByRole('textbox');
			fireEvent.change(input, { target: { value: '' } });
			fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

			expect(mockOnRename).toHaveBeenCalledWith('');
		});

		it('handles special characters in name', () => {
			render(
				<TestWrapper>
					<RenameTabModal
						theme={mockTheme}
						initialName="Tab <script>alert('xss')</script>"
						onClose={mockOnClose}
						onRename={mockOnRename}
					/>
				</TestWrapper>
			);

			const input = screen.getByRole('textbox');
			expect(input).toHaveValue("Tab <script>alert('xss')</script>");
		});

		it('handles very long name', () => {
			const longName = 'A'.repeat(200);
			render(
				<TestWrapper>
					<RenameTabModal
						theme={mockTheme}
						initialName={longName}
						onClose={mockOnClose}
						onRename={mockOnRename}
					/>
				</TestWrapper>
			);

			const input = screen.getByRole('textbox');
			expect(input).toHaveValue(longName);
		});
	});

	describe('Other Keys', () => {
		it('does not submit on other keys', () => {
			render(
				<TestWrapper>
					<RenameTabModal
						theme={mockTheme}
						initialName="My Tab"
						onClose={mockOnClose}
						onRename={mockOnRename}
					/>
				</TestWrapper>
			);

			const input = screen.getByRole('textbox');
			fireEvent.keyDown(input, { key: 'Tab' });
			fireEvent.keyDown(input, { key: 'Escape' });
			fireEvent.keyDown(input, { key: 'a' });

			expect(mockOnRename).not.toHaveBeenCalled();
		});
	});
});
