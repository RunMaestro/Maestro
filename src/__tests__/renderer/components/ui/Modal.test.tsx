/**
 * Tests for Modal component
 *
 * The Modal component provides consistent UI structure for all modals,
 * combining useModalLayer hook with standardized styling patterns.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { Modal, ModalFooter } from '../../../../renderer/components/ui/Modal';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../../renderer/types';

// Mock theme for testing
const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgSidebar: '#242424',
		bgActivity: '#2a2a2a',
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#3b82f6',
		accentForeground: '#ffffff',
		border: '#333333',
		error: '#ef4444',
		success: '#22c55e',
		warning: '#f59e0b',
		cursor: '#ffffff',
		terminalBg: '#1a1a1a',
	},
};

// Test wrapper with LayerStackProvider
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
	<LayerStackProvider>{children}</LayerStackProvider>
);

describe('Modal', () => {
	// Store original NODE_ENV
	const originalNodeEnv = process.env.NODE_ENV;

	beforeEach(() => {
		process.env.NODE_ENV = 'production';
		delete (window as unknown as Record<string, unknown>).__MAESTRO_DEBUG__;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.env.NODE_ENV = originalNodeEnv;
		delete (window as unknown as Record<string, unknown>).__MAESTRO_DEBUG__;
	});

	describe('rendering', () => {
		it('should render with required props', () => {
			const onClose = vi.fn();

			render(
				<Modal theme={mockTheme} title="Test Modal" priority={100} onClose={onClose}>
					<p>Modal content</p>
				</Modal>,
				{ wrapper: TestWrapper }
			);

			expect(screen.getByRole('dialog')).toBeInTheDocument();
			expect(screen.getByText('Test Modal')).toBeInTheDocument();
			expect(screen.getByText('Modal content')).toBeInTheDocument();
		});

		it('should apply correct aria attributes', () => {
			const onClose = vi.fn();

			render(
				<Modal theme={mockTheme} title="Accessible Modal" priority={100} onClose={onClose}>
					<p>Content</p>
				</Modal>,
				{ wrapper: TestWrapper }
			);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-label', 'Accessible Modal');
		});

		it('should render header with title and close button', () => {
			const onClose = vi.fn();

			render(
				<Modal theme={mockTheme} title="Header Test" priority={100} onClose={onClose}>
					<p>Content</p>
				</Modal>,
				{ wrapper: TestWrapper }
			);

			expect(screen.getByText('Header Test')).toBeInTheDocument();
			expect(screen.getByLabelText('Close modal')).toBeInTheDocument();
		});

		it('should render header icon when provided', () => {
			const onClose = vi.fn();
			const TestIcon = () => <span data-testid="test-icon">Icon</span>;

			render(
				<Modal
					theme={mockTheme}
					title="Icon Test"
					priority={100}
					onClose={onClose}
					headerIcon={<TestIcon />}
				>
					<p>Content</p>
				</Modal>,
				{ wrapper: TestWrapper }
			);

			expect(screen.getByTestId('test-icon')).toBeInTheDocument();
		});

		it('should render custom header when provided', () => {
			const onClose = vi.fn();

			render(
				<Modal
					theme={mockTheme}
					title="Test"
					priority={100}
					onClose={onClose}
					customHeader={<div data-testid="custom-header">Custom Header</div>}
				>
					<p>Content</p>
				</Modal>,
				{ wrapper: TestWrapper }
			);

			expect(screen.getByTestId('custom-header')).toBeInTheDocument();
			// Default title should not be rendered when custom header is provided
			expect(screen.queryByText('Test')).not.toBeInTheDocument();
		});

		it('should hide header when showHeader is false', () => {
			const onClose = vi.fn();

			render(
				<Modal
					theme={mockTheme}
					title="Hidden Header"
					priority={100}
					onClose={onClose}
					showHeader={false}
				>
					<p>Content only</p>
				</Modal>,
				{ wrapper: TestWrapper }
			);

			expect(screen.queryByText('Hidden Header')).not.toBeInTheDocument();
			expect(screen.getByText('Content only')).toBeInTheDocument();
		});

		it('should hide close button when showCloseButton is false', () => {
			const onClose = vi.fn();

			render(
				<Modal
					theme={mockTheme}
					title="No Close Button"
					priority={100}
					onClose={onClose}
					showCloseButton={false}
				>
					<p>Content</p>
				</Modal>,
				{ wrapper: TestWrapper }
			);

			expect(screen.getByText('No Close Button')).toBeInTheDocument();
			expect(screen.queryByLabelText('Close modal')).not.toBeInTheDocument();
		});

		it('should render footer when provided', () => {
			const onClose = vi.fn();

			render(
				<Modal
					theme={mockTheme}
					title="Footer Test"
					priority={100}
					onClose={onClose}
					footer={<button>Save</button>}
				>
					<p>Content</p>
				</Modal>,
				{ wrapper: TestWrapper }
			);

			expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
		});

		it('should not render footer section when footer is not provided', () => {
			const onClose = vi.fn();

			const { container } = render(
				<Modal theme={mockTheme} title="No Footer" priority={100} onClose={onClose}>
					<p>Content</p>
				</Modal>,
				{ wrapper: TestWrapper }
			);

			// Footer section should have border-t class - count them
			const footerSections = container.querySelectorAll('.border-t');
			expect(footerSections.length).toBe(0);
		});

		it('should apply test ID when provided', () => {
			const onClose = vi.fn();

			render(
				<Modal theme={mockTheme} title="Test" priority={100} onClose={onClose} testId="my-modal">
					<p>Content</p>
				</Modal>,
				{ wrapper: TestWrapper }
			);

			expect(screen.getByTestId('my-modal')).toBeInTheDocument();
		});
	});

	describe('styling', () => {
		it('should apply custom width', () => {
			const onClose = vi.fn();

			const { container } = render(
				<Modal theme={mockTheme} title="Wide Modal" priority={100} onClose={onClose} width={600}>
					<p>Content</p>
				</Modal>,
				{ wrapper: TestWrapper }
			);

			const modalContainer = container.querySelector('.rounded-lg');
			expect(modalContainer).toHaveStyle({ width: '600px' });
		});

		it('should apply custom maxHeight', () => {
			const onClose = vi.fn();

			const { container } = render(
				<Modal
					theme={mockTheme}
					title="Short Modal"
					priority={100}
					onClose={onClose}
					maxHeight="50vh"
				>
					<p>Content</p>
				</Modal>,
				{ wrapper: TestWrapper }
			);

			const modalContainer = container.querySelector('.rounded-lg');
			expect(modalContainer).toHaveStyle({ maxHeight: '50vh' });
		});

		it('should apply custom zIndex', () => {
			const onClose = vi.fn();

			render(
				<Modal
					theme={mockTheme}
					title="High Z Modal"
					priority={100}
					onClose={onClose}
					zIndex={15000}
				>
					<p>Content</p>
				</Modal>,
				{ wrapper: TestWrapper }
			);

			const backdrop = screen.getByRole('dialog');
			expect(backdrop).toHaveStyle({ zIndex: 15000 });
		});

		it('should apply theme colors correctly', () => {
			const onClose = vi.fn();

			const { container } = render(
				<Modal theme={mockTheme} title="Themed Modal" priority={100} onClose={onClose}>
					<p>Content</p>
				</Modal>,
				{ wrapper: TestWrapper }
			);

			const modalContainer = container.querySelector('.rounded-lg');
			expect(modalContainer).toHaveStyle({
				backgroundColor: mockTheme.colors.bgSidebar,
				borderColor: mockTheme.colors.border,
			});
		});
	});

	describe('interactions', () => {
		it('should call onClose when close button is clicked', () => {
			const onClose = vi.fn();

			render(
				<Modal theme={mockTheme} title="Test" priority={100} onClose={onClose}>
					<p>Content</p>
				</Modal>,
				{ wrapper: TestWrapper }
			);

			fireEvent.click(screen.getByLabelText('Close modal'));
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('should call onClose when backdrop is clicked and closeOnBackdropClick is true', () => {
			const onClose = vi.fn();

			render(
				<Modal
					theme={mockTheme}
					title="Test"
					priority={100}
					onClose={onClose}
					closeOnBackdropClick={true}
				>
					<p>Content</p>
				</Modal>,
				{ wrapper: TestWrapper }
			);

			// Click directly on the backdrop (dialog element)
			fireEvent.click(screen.getByRole('dialog'));
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('should NOT call onClose when backdrop is clicked and closeOnBackdropClick is false', () => {
			const onClose = vi.fn();

			render(
				<Modal
					theme={mockTheme}
					title="Test"
					priority={100}
					onClose={onClose}
					closeOnBackdropClick={false}
				>
					<p>Content</p>
				</Modal>,
				{ wrapper: TestWrapper }
			);

			// Click directly on the backdrop
			fireEvent.click(screen.getByRole('dialog'));
			expect(onClose).not.toHaveBeenCalled();
		});

		it('should NOT call onClose when clicking inside modal content', () => {
			const onClose = vi.fn();

			render(
				<Modal
					theme={mockTheme}
					title="Test"
					priority={100}
					onClose={onClose}
					closeOnBackdropClick={true}
				>
					<p data-testid="content">Content</p>
				</Modal>,
				{ wrapper: TestWrapper }
			);

			// Click on the content inside modal
			fireEvent.click(screen.getByTestId('content'));
			expect(onClose).not.toHaveBeenCalled();
		});
	});

	describe('focus management', () => {
		it('should focus initial focus ref when provided', async () => {
			const onClose = vi.fn();

			const TestComponent = () => {
				const inputRef = React.useRef<HTMLInputElement>(null);
				return (
					<Modal
						theme={mockTheme}
						title="Focus Test"
						priority={100}
						onClose={onClose}
						initialFocusRef={inputRef}
					>
						<input ref={inputRef} data-testid="focus-input" />
					</Modal>
				);
			};

			render(<TestComponent />, { wrapper: TestWrapper });

			await waitFor(() => {
				expect(screen.getByTestId('focus-input')).toHaveFocus();
			});
		});

		it('should focus container when no initial focus ref is provided', async () => {
			const onClose = vi.fn();

			render(
				<Modal
					theme={mockTheme}
					title="Container Focus"
					priority={100}
					onClose={onClose}
					testId="modal-container"
				>
					<p>Content</p>
				</Modal>,
				{ wrapper: TestWrapper }
			);

			await waitFor(() => {
				expect(screen.getByTestId('modal-container')).toHaveFocus();
			});
		});
	});

	describe('layer options', () => {
		it('should pass layer options to useModalLayer', () => {
			const onClose = vi.fn();
			const onBeforeClose = vi.fn().mockResolvedValue(false);

			render(
				<Modal
					theme={mockTheme}
					title="Options Test"
					priority={100}
					onClose={onClose}
					layerOptions={{
						isDirty: true,
						onBeforeClose,
						focusTrap: 'lenient',
					}}
				>
					<p>Content</p>
				</Modal>,
				{ wrapper: TestWrapper }
			);

			// Modal should render successfully with options
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});
	});
});

describe('ModalFooter', () => {
	it('should render cancel and confirm buttons', () => {
		const onCancel = vi.fn();
		const onConfirm = vi.fn();

		render(<ModalFooter theme={mockTheme} onCancel={onCancel} onConfirm={onConfirm} />);

		expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
	});

	it('should use custom button labels', () => {
		const onCancel = vi.fn();
		const onConfirm = vi.fn();

		render(
			<ModalFooter
				theme={mockTheme}
				onCancel={onCancel}
				onConfirm={onConfirm}
				cancelLabel="Discard"
				confirmLabel="Save Changes"
			/>
		);

		expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();
	});

	it('should call onCancel when cancel button is clicked', () => {
		const onCancel = vi.fn();
		const onConfirm = vi.fn();

		render(<ModalFooter theme={mockTheme} onCancel={onCancel} onConfirm={onConfirm} />);

		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it('should call onConfirm when confirm button is clicked', () => {
		const onCancel = vi.fn();
		const onConfirm = vi.fn();

		render(<ModalFooter theme={mockTheme} onCancel={onCancel} onConfirm={onConfirm} />);

		fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
		expect(onConfirm).toHaveBeenCalledTimes(1);
		expect(onCancel).not.toHaveBeenCalled();
	});

	it('should disable confirm button when confirmDisabled is true', () => {
		const onCancel = vi.fn();
		const onConfirm = vi.fn();

		render(
			<ModalFooter
				theme={mockTheme}
				onCancel={onCancel}
				onConfirm={onConfirm}
				confirmDisabled={true}
			/>
		);

		const confirmButton = screen.getByRole('button', { name: 'Confirm' });
		expect(confirmButton).toBeDisabled();
	});

	it('should hide cancel button when showCancel is false', () => {
		const onCancel = vi.fn();
		const onConfirm = vi.fn();

		render(
			<ModalFooter theme={mockTheme} onCancel={onCancel} onConfirm={onConfirm} showCancel={false} />
		);

		expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
	});

	it('should apply destructive styling when destructive is true', () => {
		const onCancel = vi.fn();
		const onConfirm = vi.fn();

		render(
			<ModalFooter theme={mockTheme} onCancel={onCancel} onConfirm={onConfirm} destructive={true} />
		);

		const confirmButton = screen.getByRole('button', { name: 'Confirm' });
		expect(confirmButton).toHaveStyle({ backgroundColor: mockTheme.colors.error });
	});

	it('should apply accent styling when not destructive', () => {
		const onCancel = vi.fn();
		const onConfirm = vi.fn();

		render(
			<ModalFooter
				theme={mockTheme}
				onCancel={onCancel}
				onConfirm={onConfirm}
				destructive={false}
			/>
		);

		const confirmButton = screen.getByRole('button', { name: 'Confirm' });
		expect(confirmButton).toHaveStyle({ backgroundColor: mockTheme.colors.accent });
	});

	it('should apply custom className to confirm button', () => {
		const onCancel = vi.fn();
		const onConfirm = vi.fn();

		render(
			<ModalFooter
				theme={mockTheme}
				onCancel={onCancel}
				onConfirm={onConfirm}
				confirmClassName="custom-confirm"
			/>
		);

		const confirmButton = screen.getByRole('button', { name: 'Confirm' });
		expect(confirmButton).toHaveClass('custom-confirm');
	});
});
