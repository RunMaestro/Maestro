/**
 * Tests for QuitConfirmModal component
 *
 * Tests the core behavior of the quit confirmation dialog:
 * - Rendering with busy agent count and names
 * - Auto Run detection and message text variation
 * - Button click handlers (Quit Anyway, Cancel)
 * - Focus management (Cancel button focused by default)
 * - Layer stack integration
 * - Accessibility
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QuitConfirmModal } from '../../../renderer/components/QuitConfirmModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../renderer/types';

// Mock lucide-react
vi.mock('lucide-react', () => ({
	AlertTriangle: () => <svg data-testid="alert-triangle-icon" />,
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
		accentForeground: '#ffffff',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
	},
};

// Helper to render with LayerStackProvider
const renderWithLayerStack = (ui: React.ReactElement) => {
	return render(<LayerStackProvider>{ui}</LayerStackProvider>);
};

describe('QuitConfirmModal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('rendering', () => {
		it('renders with busy agent count and names', () => {
			renderWithLayerStack(
				<QuitConfirmModal
					theme={testTheme}
					busyAgentCount={2}
					busyAgentNames={['Agent A', 'Agent B']}
					onConfirmQuit={vi.fn()}
					onCancel={vi.fn()}
				/>
			);

			expect(screen.getByText(/2 agents are currently thinking/)).toBeInTheDocument();
			expect(screen.getByText('Agent A')).toBeInTheDocument();
			expect(screen.getByText('Agent B')).toBeInTheDocument();
		});

		it('renders singular text for one busy agent', () => {
			renderWithLayerStack(
				<QuitConfirmModal
					theme={testTheme}
					busyAgentCount={1}
					busyAgentNames={['Agent A']}
					onConfirmQuit={vi.fn()}
					onCancel={vi.fn()}
				/>
			);

			expect(screen.getByText(/1 agent is currently thinking/)).toBeInTheDocument();
		});

		it('renders Quit Anyway and Cancel buttons', () => {
			renderWithLayerStack(
				<QuitConfirmModal
					theme={testTheme}
					busyAgentCount={1}
					busyAgentNames={['Agent A']}
					onConfirmQuit={vi.fn()}
					onCancel={vi.fn()}
				/>
			);

			expect(screen.getByRole('button', { name: 'Quit Anyway' })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
		});

		it('shows +N more when more than 3 agents', () => {
			renderWithLayerStack(
				<QuitConfirmModal
					theme={testTheme}
					busyAgentCount={5}
					busyAgentNames={['A', 'B', 'C', 'D', 'E']}
					onConfirmQuit={vi.fn()}
					onCancel={vi.fn()}
				/>
			);

			expect(screen.getByText('+2 more')).toBeInTheDocument();
		});
	});

	describe('Auto Run detection', () => {
		it('shows "active" instead of "thinking" when Auto Run sessions are present', () => {
			renderWithLayerStack(
				<QuitConfirmModal
					theme={testTheme}
					busyAgentCount={1}
					busyAgentNames={['My Session (Auto Run)']}
					onConfirmQuit={vi.fn()}
					onCancel={vi.fn()}
				/>
			);

			expect(screen.getByText(/currently active/)).toBeInTheDocument();
			expect(screen.queryByText(/currently thinking/)).not.toBeInTheDocument();
		});

		it('shows "thinking" when no Auto Run sessions are present', () => {
			renderWithLayerStack(
				<QuitConfirmModal
					theme={testTheme}
					busyAgentCount={2}
					busyAgentNames={['Agent A', 'Agent B']}
					onConfirmQuit={vi.fn()}
					onCancel={vi.fn()}
				/>
			);

			expect(screen.getByText(/currently thinking/)).toBeInTheDocument();
			expect(screen.queryByText(/currently active/)).not.toBeInTheDocument();
		});

		it('shows "active" when mix of busy agents and Auto Run sessions', () => {
			renderWithLayerStack(
				<QuitConfirmModal
					theme={testTheme}
					busyAgentCount={2}
					busyAgentNames={['Agent A', 'My Session (Auto Run)']}
					onConfirmQuit={vi.fn()}
					onCancel={vi.fn()}
				/>
			);

			expect(screen.getByText(/currently active/)).toBeInTheDocument();
		});
	});

	describe('button handlers', () => {
		it('calls onConfirmQuit when Quit Anyway is clicked', () => {
			const onConfirmQuit = vi.fn();
			renderWithLayerStack(
				<QuitConfirmModal
					theme={testTheme}
					busyAgentCount={1}
					busyAgentNames={['Agent A']}
					onConfirmQuit={onConfirmQuit}
					onCancel={vi.fn()}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Quit Anyway' }));
			expect(onConfirmQuit).toHaveBeenCalledTimes(1);
		});

		it('calls onCancel when Cancel is clicked', () => {
			const onCancel = vi.fn();
			renderWithLayerStack(
				<QuitConfirmModal
					theme={testTheme}
					busyAgentCount={1}
					busyAgentNames={['Agent A']}
					onConfirmQuit={vi.fn()}
					onCancel={onCancel}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
			expect(onCancel).toHaveBeenCalledTimes(1);
		});
	});

	describe('focus management', () => {
		it('focuses Cancel button on mount (safe default)', async () => {
			renderWithLayerStack(
				<QuitConfirmModal
					theme={testTheme}
					busyAgentCount={1}
					busyAgentNames={['Agent A']}
					onConfirmQuit={vi.fn()}
					onCancel={vi.fn()}
				/>
			);

			await waitFor(() => {
				expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
			});
		});
	});

	describe('accessibility', () => {
		it('has correct ARIA attributes', () => {
			renderWithLayerStack(
				<QuitConfirmModal
					theme={testTheme}
					busyAgentCount={1}
					busyAgentNames={['Agent A']}
					onConfirmQuit={vi.fn()}
					onCancel={vi.fn()}
				/>
			);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-labelledby', 'quit-confirm-title');
			expect(dialog).toHaveAttribute('aria-describedby', 'quit-confirm-description');
		});

		it('has heading with title', () => {
			renderWithLayerStack(
				<QuitConfirmModal
					theme={testTheme}
					busyAgentCount={1}
					busyAgentNames={['Agent A']}
					onConfirmQuit={vi.fn()}
					onCancel={vi.fn()}
				/>
			);

			expect(screen.getByText('Quit Maestro?')).toBeInTheDocument();
		});
	});

	describe('layer stack integration', () => {
		it('registers and unregisters without errors', () => {
			const { unmount } = renderWithLayerStack(
				<QuitConfirmModal
					theme={testTheme}
					busyAgentCount={1}
					busyAgentNames={['Agent A']}
					onConfirmQuit={vi.fn()}
					onCancel={vi.fn()}
				/>
			);

			expect(screen.getByRole('dialog')).toBeInTheDocument();
			expect(() => unmount()).not.toThrow();
		});
	});
});
