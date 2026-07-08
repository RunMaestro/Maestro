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
import { QuitConfirmModal } from '../../renderer/components/QuitConfirmModal';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../renderer/types';

// Mock lucide-react
vi.mock('lucide-react', () => ({
	AlertTriangle: () => <svg data-testid="alert-triangle-icon" />,
	Hourglass: () => <svg data-testid="hourglass-icon" />,
	MessageSquare: () => <svg data-testid="message-square-icon" />,
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

		it('calls the cancel handler when Escape closes the registered layer', async () => {
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

			fireEvent.keyDown(window, { key: 'Escape' });

			await waitFor(() => {
				expect(onCancel).toHaveBeenCalledTimes(1);
			});
		});

		it('registers an initial Escape handler and tolerates an undefined layer id', async () => {
			vi.resetModules();
			let onEscape: (() => void) | undefined;
			const unregisterLayer = vi.fn();
			const updateLayerHandler = vi.fn();
			vi.doMock('../../renderer/contexts/LayerStackContext', () => ({
				useLayerStack: () => ({
					registerLayer: vi.fn((options: { onEscape?: () => void }) => {
						onEscape = options.onEscape;
						return undefined;
					}),
					unregisterLayer,
					updateLayerHandler,
				}),
			}));

			try {
				const { QuitConfirmModal: MockedQuitConfirmModal } =
					await import('../../renderer/components/QuitConfirmModal');
				const onCancel = vi.fn();
				const { unmount } = render(
					<MockedQuitConfirmModal
						theme={testTheme}
						busyAgentCount={1}
						busyAgentNames={['Agent A']}
						onConfirmQuit={vi.fn()}
						onCancel={onCancel}
					/>
				);

				onEscape?.();
				unmount();

				expect(onCancel).toHaveBeenCalledTimes(1);
				expect(updateLayerHandler).not.toHaveBeenCalled();
				expect(unregisterLayer).not.toHaveBeenCalled();
			} finally {
				vi.doUnmock('../../renderer/contexts/LayerStackContext');
				vi.resetModules();
			}
		});

		it('uses the latest cancel handler when Escape closes the top layer', async () => {
			const firstCancel = vi.fn();
			const secondCancel = vi.fn();
			const { rerender } = renderWithLayerStack(
				<QuitConfirmModal
					theme={testTheme}
					busyAgentCount={1}
					busyAgentNames={['Agent A']}
					onConfirmQuit={vi.fn()}
					onCancel={firstCancel}
				/>
			);

			rerender(
				<LayerStackProvider>
					<QuitConfirmModal
						theme={testTheme}
						busyAgentCount={1}
						busyAgentNames={['Agent A']}
						onConfirmQuit={vi.fn()}
						onCancel={secondCancel}
					/>
				</LayerStackProvider>
			);

			fireEvent.keyDown(window, { key: 'Escape' });

			await waitFor(() => {
				expect(secondCancel).toHaveBeenCalledTimes(1);
			});
			expect(firstCancel).not.toHaveBeenCalled();
		});
	});

	describe('keyboard propagation', () => {
		it('allows Tab to flow naturally and stops other dialog key presses', () => {
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

			const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
			const tabStopPropagation = vi.spyOn(tabEvent, 'stopPropagation');
			dialog.dispatchEvent(tabEvent);

			const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
			const enterStopPropagation = vi.spyOn(enterEvent, 'stopPropagation');
			dialog.dispatchEvent(enterEvent);

			expect(tabStopPropagation).not.toHaveBeenCalled();
			expect(enterStopPropagation).toHaveBeenCalled();
		});
	});
});
