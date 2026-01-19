/**
 * Tests for ConfirmModal component
 *
 * Tests the core behavior of the confirmation dialog:
 * - Rendering with message and buttons
 * - Button click handlers (Cancel, Confirm, Close)
 * - Focus management
 * - Layer stack integration
 * - Accessibility
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConfirmModal } from '../../../renderer/components/ConfirmModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../renderer/types';

// Mock lucide-react
vi.mock('lucide-react', () => ({
	X: () => <svg data-testid="x-icon" />,
	AlertTriangle: () => <svg data-testid="alert-triangle-icon" />,
	Trash2: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="trash2-icon" className={className} style={style} />
	),
}));

// Create a test theme
const testTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#d4d4d4',
		textDim: '#808080',
		accent: '#007acc',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
		info: '#3794ff',
		textInverse: '#000000',
	},
};

// Helper to render with LayerStackProvider
const renderWithLayerStack = (ui: React.ReactElement) => {
	return render(<LayerStackProvider>{ui}</LayerStackProvider>);
};

describe('ConfirmModal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('rendering', () => {
		it('renders with message and buttons', () => {
			renderWithLayerStack(
				<ConfirmModal
					theme={testTheme}
					message="Are you sure?"
					onConfirm={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			expect(screen.getByText('Are you sure?')).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
		});

		it('renders header with title and close button', () => {
			renderWithLayerStack(
				<ConfirmModal theme={testTheme} message="Test" onConfirm={vi.fn()} onClose={vi.fn()} />
			);

			expect(screen.getByText('Confirm Delete')).toBeInTheDocument();
			expect(screen.getByTestId('x-icon')).toBeInTheDocument();
		});

		it('renders trash icon in header', () => {
			renderWithLayerStack(
				<ConfirmModal theme={testTheme} message="Test" onConfirm={vi.fn()} onClose={vi.fn()} />
			);

			expect(screen.getByTestId('trash2-icon')).toBeInTheDocument();
		});

		it('has correct ARIA attributes', () => {
			renderWithLayerStack(
				<ConfirmModal theme={testTheme} message="Test" onConfirm={null} onClose={vi.fn()} />
			);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-label', 'Confirm Delete');
		});
	});

	describe('focus management', () => {
		it('focuses confirm button on mount', async () => {
			renderWithLayerStack(
				<ConfirmModal theme={testTheme} message="Test" onConfirm={vi.fn()} onClose={vi.fn()} />
			);

			await waitFor(() => {
				expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Confirm' }));
			});
		});
	});

	describe('button handlers', () => {
		it('calls onClose when X button is clicked', () => {
			const onClose = vi.fn();
			renderWithLayerStack(
				<ConfirmModal theme={testTheme} message="Test" onConfirm={vi.fn()} onClose={onClose} />
			);

			const closeButton = screen.getByTestId('x-icon').closest('button');
			fireEvent.click(closeButton!);
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('calls onClose when Cancel is clicked', () => {
			const onClose = vi.fn();
			renderWithLayerStack(
				<ConfirmModal theme={testTheme} message="Test" onConfirm={vi.fn()} onClose={onClose} />
			);

			fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('calls onConfirm then onClose when Confirm is clicked', () => {
			const callOrder: string[] = [];
			const onClose = vi.fn(() => callOrder.push('close'));
			const onConfirm = vi.fn(() => callOrder.push('confirm'));

			renderWithLayerStack(
				<ConfirmModal theme={testTheme} message="Test" onConfirm={onConfirm} onClose={onClose} />
			);

			fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
			expect(callOrder).toEqual(['confirm', 'close']);
		});

		it('only calls onClose when onConfirm is null', () => {
			const onClose = vi.fn();

			renderWithLayerStack(
				<ConfirmModal theme={testTheme} message="Test" onConfirm={null} onClose={onClose} />
			);

			fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('Cancel does not call onConfirm', () => {
			const onConfirm = vi.fn();
			renderWithLayerStack(
				<ConfirmModal theme={testTheme} message="Test" onConfirm={onConfirm} onClose={vi.fn()} />
			);

			fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
			expect(onConfirm).not.toHaveBeenCalled();
		});
	});

	describe('keyboard interaction', () => {
		it('stops propagation of keydown events', () => {
			const parentHandler = vi.fn();

			render(
				<div onKeyDown={parentHandler}>
					<LayerStackProvider>
						<ConfirmModal theme={testTheme} message="Test" onConfirm={vi.fn()} onClose={vi.fn()} />
					</LayerStackProvider>
				</div>
			);

			fireEvent.keyDown(screen.getByRole('dialog'), { key: 'a' });
			expect(parentHandler).not.toHaveBeenCalled();
		});
	});

	describe('layer stack integration', () => {
		it('registers and unregisters without errors', () => {
			const { unmount } = renderWithLayerStack(
				<ConfirmModal theme={testTheme} message="Test" onConfirm={vi.fn()} onClose={vi.fn()} />
			);

			expect(screen.getByRole('dialog')).toBeInTheDocument();
			expect(() => unmount()).not.toThrow();
		});
	});

	describe('accessibility', () => {
		it('has tabIndex on dialog for focus', () => {
			renderWithLayerStack(
				<ConfirmModal theme={testTheme} message="Test" onConfirm={vi.fn()} onClose={vi.fn()} />
			);

			expect(screen.getByRole('dialog')).toHaveAttribute('tabIndex', '-1');
		});

		it('has semantic button elements', () => {
			renderWithLayerStack(
				<ConfirmModal theme={testTheme} message="Test" onConfirm={vi.fn()} onClose={vi.fn()} />
			);

			expect(screen.getAllByRole('button')).toHaveLength(3); // X, Cancel, Confirm
		});

		it('has heading for modal title', () => {
			renderWithLayerStack(
				<ConfirmModal theme={testTheme} message="Test" onConfirm={vi.fn()} onClose={vi.fn()} />
			);

			expect(screen.getByRole('heading', { name: 'Confirm Delete' })).toBeInTheDocument();
		});
	});
});
