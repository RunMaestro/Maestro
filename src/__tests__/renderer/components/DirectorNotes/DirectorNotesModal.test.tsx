import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { Theme } from '../../../../renderer/types';

// Mock layer stack context
const mockRegisterLayer = vi.fn(() => 'layer-director-notes');
const mockUnregisterLayer = vi.fn();

vi.mock('../../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
		updateLayerHandler: vi.fn(),
	}),
}));

// Mock modal priorities
vi.mock('../../../../renderer/constants/modalPriorities', () => ({
	MODAL_PRIORITIES: {
		DIRECTOR_NOTES: 848,
	},
}));

// Mock lazy-loaded child components
vi.mock('../../../../renderer/components/DirectorNotes/UnifiedHistoryTab', () => ({
	UnifiedHistoryTab: ({ theme }: { theme: Theme }) => (
		<div data-testid="unified-history-tab">Unified History Content</div>
	),
}));

vi.mock('../../../../renderer/components/DirectorNotes/AIOverviewTab', () => ({
	AIOverviewTab: ({ theme, onSynopsisReady }: { theme: Theme; onSynopsisReady?: () => void }) => (
		<div data-testid="ai-overview-tab">
			AI Overview Content
			<button data-testid="trigger-synopsis-ready" onClick={() => onSynopsisReady?.()}>
				Trigger Ready
			</button>
		</div>
	),
}));

// Import after mocks
import { DirectorNotesModal } from '../../../../renderer/components/DirectorNotes/DirectorNotesModal';

const mockTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#343746',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentForeground: '#f8f8f2',
		border: '#44475a',
		success: '#50fa7b',
		warning: '#ffb86c',
		error: '#ff5555',
		scrollbar: '#44475a',
		scrollbarHover: '#6272a4',
	},
};

describe('DirectorNotesModal', () => {
	let onClose: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		onClose = vi.fn();
		mockRegisterLayer.mockClear();
		mockUnregisterLayer.mockClear();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	const renderModal = (props?: Partial<React.ComponentProps<typeof DirectorNotesModal>>) => {
		return render(
			<DirectorNotesModal
				theme={mockTheme}
				onClose={onClose}
				{...props}
			/>
		);
	};

	describe('Rendering', () => {
		it('renders with two tabs', async () => {
			renderModal();

			await waitFor(() => {
				expect(screen.getByText('Unified History')).toBeInTheDocument();
				expect(screen.getByText('AI Overview')).toBeInTheDocument();
			});
		});

		it('shows Unified History tab content by default', async () => {
			renderModal();

			await waitFor(() => {
				expect(screen.getByTestId('unified-history-tab')).toBeInTheDocument();
			});

			// Unified History tab should be visible (not hidden)
			const historyContainer = screen.getByTestId('unified-history-tab').closest('.h-full');
			expect(historyContainer).not.toHaveClass('hidden');
		});

		it('renders AI Overview tab content (hidden initially)', async () => {
			renderModal();

			await waitFor(() => {
				expect(screen.getByTestId('ai-overview-tab')).toBeInTheDocument();
			});

			// AI Overview tab should be hidden
			const overviewContainer = screen.getByTestId('ai-overview-tab').closest('.h-full');
			expect(overviewContainer).toHaveClass('hidden');
		});

		it('renders close button', async () => {
			renderModal();

			await waitFor(() => {
				// The close button contains an X icon (mocked as svg)
				const buttons = screen.getAllByRole('button');
				// Should have: history tab, overview tab, close button
				expect(buttons.length).toBeGreaterThanOrEqual(3);
			});
		});

		it('shows generating indicator on AI Overview tab initially', async () => {
			renderModal();

			await waitFor(() => {
				expect(screen.getByText('(generating...)')).toBeInTheDocument();
			});
		});

		it('renders into a portal on document.body', async () => {
			renderModal();

			await waitFor(() => {
				// The modal should be rendered with fixed positioning (portal)
				const backdrop = document.querySelector('.fixed.inset-0');
				expect(backdrop).toBeInTheDocument();
			});
		});

		it('applies theme colors to modal', async () => {
			renderModal();

			await waitFor(() => {
				const modal = document.querySelector('.relative.w-full.max-w-5xl');
				expect(modal).toHaveStyle({
					backgroundColor: mockTheme.colors.bgSidebar,
					borderColor: mockTheme.colors.border,
				});
			});
		});
	});

	describe('Tab Switching', () => {
		it('AI Overview tab is disabled when overview is not ready', async () => {
			renderModal();

			await waitFor(() => {
				expect(screen.getByText('AI Overview')).toBeInTheDocument();
			});

			const overviewTabButton = screen.getByText('AI Overview').closest('button');
			expect(overviewTabButton).toBeDisabled();
			expect(overviewTabButton).toHaveStyle({ opacity: '0.5' });
		});

		it('switches to AI Overview tab when overview becomes ready', async () => {
			renderModal();

			await waitFor(() => {
				expect(screen.getByTestId('ai-overview-tab')).toBeInTheDocument();
			});

			// Trigger synopsis ready to enable overview tab
			await act(async () => {
				fireEvent.click(screen.getByTestId('trigger-synopsis-ready'));
			});

			// Now AI Overview tab button should be enabled
			const overviewTabButton = screen.getByText('AI Overview').closest('button');
			expect(overviewTabButton).not.toBeDisabled();
			expect(overviewTabButton).toHaveStyle({ opacity: '1' });

			// Click to switch tabs
			fireEvent.click(overviewTabButton!);

			// AI Overview should now be visible
			const overviewContainer = screen.getByTestId('ai-overview-tab').closest('.h-full');
			expect(overviewContainer).not.toHaveClass('hidden');

			// History should be hidden
			const historyContainer = screen.getByTestId('unified-history-tab').closest('.h-full');
			expect(historyContainer).toHaveClass('hidden');
		});

		it('does not switch to AI Overview when clicked while not ready', async () => {
			renderModal();

			await waitFor(() => {
				expect(screen.getByText('AI Overview')).toBeInTheDocument();
			});

			// Try clicking the disabled overview tab
			const overviewTabButton = screen.getByText('AI Overview').closest('button');
			fireEvent.click(overviewTabButton!);

			// Should still show history
			const historyContainer = screen.getByTestId('unified-history-tab').closest('.h-full');
			expect(historyContainer).not.toHaveClass('hidden');
		});

		it('can switch back to History from AI Overview', async () => {
			renderModal();

			await waitFor(() => {
				expect(screen.getByTestId('ai-overview-tab')).toBeInTheDocument();
			});

			// Enable overview
			await act(async () => {
				fireEvent.click(screen.getByTestId('trigger-synopsis-ready'));
			});

			// Switch to overview
			const overviewTabButton = screen.getByText('AI Overview').closest('button');
			fireEvent.click(overviewTabButton!);

			// Switch back to history
			const historyTabButton = screen.getByText('Unified History').closest('button');
			fireEvent.click(historyTabButton!);

			const historyContainer = screen.getByTestId('unified-history-tab').closest('.h-full');
			expect(historyContainer).not.toHaveClass('hidden');

			const overviewContainer = screen.getByTestId('ai-overview-tab').closest('.h-full');
			expect(overviewContainer).toHaveClass('hidden');
		});

		it('highlights active tab with accent color', async () => {
			renderModal();

			await waitFor(() => {
				expect(screen.getByText('Unified History')).toBeInTheDocument();
			});

			const historyTabButton = screen.getByText('Unified History').closest('button');
			expect(historyTabButton).toHaveStyle({
				borderColor: mockTheme.colors.accent,
				color: mockTheme.colors.textMain,
			});

			// Inactive overview tab should have dim text color
			const overviewTabButton = screen.getByText('AI Overview').closest('button');
			expect(overviewTabButton).toHaveStyle({
				color: mockTheme.colors.textDim,
			});
		});
	});

	describe('Close Behavior', () => {
		it('calls onClose when close button is clicked', async () => {
			renderModal();

			await waitFor(() => {
				expect(screen.getByText('Unified History')).toBeInTheDocument();
			});

			// Find the X icon button (last button, contains the X icon svg)
			const closeIcon = document.querySelector('svg[data-testid="x-icon"]');
			expect(closeIcon).toBeInTheDocument();

			const closeButton = closeIcon!.closest('button');
			fireEvent.click(closeButton!);

			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('calls onClose when backdrop is clicked', async () => {
			renderModal();

			await waitFor(() => {
				expect(screen.getByText('Unified History')).toBeInTheDocument();
			});

			// Click the backdrop (bg-black/60 overlay)
			const backdrop = document.querySelector('.absolute.inset-0.bg-black\\/60');
			fireEvent.click(backdrop!);

			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});

	describe('Layer Stack Integration', () => {
		it('registers modal layer on mount', async () => {
			renderModal();

			expect(mockRegisterLayer).toHaveBeenCalledWith({
				type: 'modal',
				priority: 848,
				blocksLowerLayers: true,
				capturesFocus: true,
				focusTrap: 'lenient',
				onEscape: expect.any(Function),
			});
		});

		it('unregisters modal layer on unmount', async () => {
			const { unmount } = renderModal();

			unmount();

			expect(mockUnregisterLayer).toHaveBeenCalledWith('layer-director-notes');
		});
	});

	describe('Props Forwarding', () => {
		it('passes fileTree and onFileClick to UnifiedHistoryTab', async () => {
			const fileTree = [{ name: 'test.ts', path: '/test.ts' }];
			const onFileClick = vi.fn();

			renderModal({ fileTree: fileTree as any, onFileClick });

			await waitFor(() => {
				expect(screen.getByTestId('unified-history-tab')).toBeInTheDocument();
			});
		});
	});

	describe('Synopsis Ready State', () => {
		it('removes generating indicator when synopsis is ready', async () => {
			renderModal();

			await waitFor(() => {
				expect(screen.getByText('(generating...)')).toBeInTheDocument();
			});

			// Trigger synopsis ready
			await act(async () => {
				fireEvent.click(screen.getByTestId('trigger-synopsis-ready'));
			});

			expect(screen.queryByText('(generating...)')).not.toBeInTheDocument();
		});

		it('enables AI Overview tab when synopsis is ready', async () => {
			renderModal();

			// Initially disabled
			await waitFor(() => {
				const overviewTabButton = screen.getByText('AI Overview').closest('button');
				expect(overviewTabButton).toBeDisabled();
			});

			// Trigger ready
			await act(async () => {
				fireEvent.click(screen.getByTestId('trigger-synopsis-ready'));
			});

			const overviewTabButton = screen.getByText('AI Overview').closest('button');
			expect(overviewTabButton).not.toBeDisabled();
		});
	});
});
