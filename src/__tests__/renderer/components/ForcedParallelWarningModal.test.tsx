/**
 * Tests for ForcedParallelWarningModal component
 *
 * Tests the one-time acknowledgment modal for forced parallel execution:
 * - Rendering when open/closed
 * - Confirm and Cancel button handlers
 * - Layer stack integration
 * - Warning content display
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ForcedParallelWarningModal } from '../../../renderer/components/ForcedParallelWarningModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../renderer/types';

// Mock lucide-react
vi.mock('lucide-react', () => ({
	X: () => <svg data-testid="x-icon" />,
	AlertTriangle: () => <svg data-testid="alert-triangle-icon" />,
}));

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

const renderWithLayerStack = (ui: React.ReactElement) => {
	return render(<LayerStackProvider>{ui}</LayerStackProvider>);
};

describe('ForcedParallelWarningModal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('rendering', () => {
		it('renders when isOpen is true', () => {
			renderWithLayerStack(
				<ForcedParallelWarningModal
					isOpen={true}
					onConfirm={vi.fn()}
					onCancel={vi.fn()}
					theme={testTheme}
				/>
			);

			expect(screen.getByRole('dialog')).toBeInTheDocument();
			expect(
				screen.getByRole('heading', { name: 'Forced Parallel Execution' })
			).toBeInTheDocument();
		});

		it('does not render when isOpen is false', () => {
			renderWithLayerStack(
				<ForcedParallelWarningModal
					isOpen={false}
					onConfirm={vi.fn()}
					onCancel={vi.fn()}
					theme={testTheme}
				/>
			);

			expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		});

		it('displays warning content', () => {
			renderWithLayerStack(
				<ForcedParallelWarningModal
					isOpen={true}
					onConfirm={vi.fn()}
					onCancel={vi.fn()}
					theme={testTheme}
				/>
			);

			expect(screen.getByText(/queue messages that skip the cross-tab wait/i)).toBeInTheDocument();
			expect(screen.getByText(/force-send while the agent is busy/i)).toBeInTheDocument();
		});

		it('displays alert triangle icon', () => {
			renderWithLayerStack(
				<ForcedParallelWarningModal
					isOpen={true}
					onConfirm={vi.fn()}
					onCancel={vi.fn()}
					theme={testTheme}
				/>
			);

			expect(screen.getByTestId('alert-triangle-icon')).toBeInTheDocument();
		});

		it('displays confirm and cancel buttons', () => {
			renderWithLayerStack(
				<ForcedParallelWarningModal
					isOpen={true}
					onConfirm={vi.fn()}
					onCancel={vi.fn()}
					theme={testTheme}
				/>
			);

			expect(screen.getByRole('button', { name: 'I understand, enable it' })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
		});
	});

	describe('button handlers', () => {
		it('calls onConfirm when confirm button is clicked', () => {
			const onConfirm = vi.fn();
			renderWithLayerStack(
				<ForcedParallelWarningModal
					isOpen={true}
					onConfirm={onConfirm}
					onCancel={vi.fn()}
					theme={testTheme}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: 'I understand, enable it' }));
			expect(onConfirm).toHaveBeenCalledTimes(1);
		});

		it('calls onCancel when cancel button is clicked', () => {
			const onCancel = vi.fn();
			renderWithLayerStack(
				<ForcedParallelWarningModal
					isOpen={true}
					onConfirm={vi.fn()}
					onCancel={onCancel}
					theme={testTheme}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
			expect(onCancel).toHaveBeenCalledTimes(1);
		});

		it('calls onCancel when X close button is clicked', () => {
			const onCancel = vi.fn();
			renderWithLayerStack(
				<ForcedParallelWarningModal
					isOpen={true}
					onConfirm={vi.fn()}
					onCancel={onCancel}
					theme={testTheme}
				/>
			);

			const closeButton = screen.getByTestId('x-icon').closest('button');
			fireEvent.click(closeButton!);
			expect(onCancel).toHaveBeenCalledTimes(1);
		});
	});

	describe('focus management', () => {
		it('focuses confirm button on mount', async () => {
			renderWithLayerStack(
				<ForcedParallelWarningModal
					isOpen={true}
					onConfirm={vi.fn()}
					onCancel={vi.fn()}
					theme={testTheme}
				/>
			);

			await waitFor(() => {
				expect(document.activeElement).toBe(
					screen.getByRole('button', { name: 'I understand, enable it' })
				);
			});
		});
	});

	describe('layer stack integration', () => {
		it('registers and unregisters without errors', () => {
			const { unmount } = renderWithLayerStack(
				<ForcedParallelWarningModal
					isOpen={true}
					onConfirm={vi.fn()}
					onCancel={vi.fn()}
					theme={testTheme}
				/>
			);

			expect(screen.getByRole('dialog')).toBeInTheDocument();
			expect(() => unmount()).not.toThrow();
		});
	});
});
