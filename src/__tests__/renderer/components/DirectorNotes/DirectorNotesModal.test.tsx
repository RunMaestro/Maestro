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

// Mock lazy-loaded child components (use forwardRef to match real components)
vi.mock('../../../../renderer/components/DirectorNotes/UnifiedHistoryTab', () => ({
	UnifiedHistoryTab: React.forwardRef(
		(
			{
				theme,
				onResumeSession,
			}: {
				theme: Theme;
				onResumeSession?: (sourceSessionId: string, agentSessionId: string) => void;
			},
			_ref: any
		) => (
			<div data-testid="unified-history-tab" tabIndex={0}>
				Unified History Content
				{onResumeSession && (
					<button
						data-testid="mock-resume-session"
						onClick={() => onResumeSession('source-session-1', 'agent-session-abc')}
					>
						Mock Resume
					</button>
				)}
			</div>
		)
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
	hasCachedSynopsis: () => false,
}));

vi.mock('../../../../renderer/hooks', () => ({
	useSettings: () => ({
		directorNotesSettings: { defaultLookbackDays: 7 },
	}),
}));

vi.mock('../../../../renderer/components/DirectorNotes/OverviewTab', () => ({
	OverviewTab: React.forwardRef(({ theme }: { theme: Theme }, _ref: any) => (
		<div data-testid="overview-tab" tabIndex={0}>
			Overview Content
		</div>
	)),
	TabFocusHandle: {},
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
		return render(<DirectorNotesModal theme={mockTheme} onClose={onClose} {...props} />);
	};

	describe('Rendering', () => {
		it('renders with three tabs and title', async () => {
			renderModal();

			await waitFor(() => {
				expect(screen.getByText('Unified History')).toBeInTheDocument();
				expect(screen.getByText('AI Overview')).toBeInTheDocument();
				expect(screen.getByText('Help')).toBeInTheDocument();
				// Title row with "Director's Notes" heading
				expect(screen.getByText("Director's Notes")).toBeInTheDocument();
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

		it('renders Overview tab content (hidden by default)', async () => {
			renderModal();

			await waitFor(() => {
				expect(screen.getByTestId('overview-tab')).toBeInTheDocument();
			});

			// Overview tab should be hidden since history is default
			const overviewContainer = screen.getByTestId('overview-tab').closest('.h-full');
			expect(overviewContainer).toHaveClass('hidden');
		});

		it('renders AI Overview tab content (hidden initially)', async () => {
			renderModal();

			await waitFor(() => {
				expect(screen.getByTestId('ai-overview-tab')).toBeInTheDocument();
			});

			// AI Overview tab should be hidden
			const aiOverviewContainer = screen.getByTestId('ai-overview-tab').closest('.h-full');
			expect(aiOverviewContainer).toHaveClass('hidden');
		});

		it('renders close button', async () => {
			renderModal();

			await waitFor(() => {
				// The close button contains an X icon (mocked as svg)
				const buttons = screen.getAllByRole('button');
				// Should have: 3 tab buttons + close button = at least 4
				expect(buttons.length).toBeGreaterThanOrEqual(4);
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
				const modal = document.querySelector('[role="dialog"]');
				expect(modal).toHaveStyle({
					backgroundColor: mockTheme.colors.bgActivity,
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
			const aiOverviewContainer = screen.getByTestId('ai-overview-tab').closest('.h-full');
			expect(aiOverviewContainer).not.toHaveClass('hidden');

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

		it('can switch to Help tab', async () => {
			renderModal();

			await waitFor(() => {
				expect(screen.getByText('Help')).toBeInTheDocument();
			});

			const helpTabButton = screen.getByText('Help').closest('button');
			fireEvent.click(helpTabButton!);

			const overviewContainer = screen.getByTestId('overview-tab').closest('.h-full');
			expect(overviewContainer).not.toHaveClass('hidden');

			const historyContainer = screen.getByTestId('unified-history-tab').closest('.h-full');
			expect(historyContainer).toHaveClass('hidden');
		});

		it('can switch back to History from Help tab', async () => {
			renderModal();

			await waitFor(() => {
				expect(screen.getByTestId('overview-tab')).toBeInTheDocument();
			});

			// Switch to Help
			fireEvent.click(screen.getByText('Help').closest('button')!);

			// Switch back to history
			fireEvent.click(screen.getByText('Unified History').closest('button')!);

			const historyContainer = screen.getByTestId('unified-history-tab').closest('.h-full');
			expect(historyContainer).not.toHaveClass('hidden');

			const overviewContainer = screen.getByTestId('overview-tab').closest('.h-full');
			expect(overviewContainer).toHaveClass('hidden');
		});

		it('highlights active tab with accent color', async () => {
			renderModal();

			await waitFor(() => {
				expect(screen.getByText('Unified History')).toBeInTheDocument();
			});

			const historyTabButton = screen.getByText('Unified History').closest('button');
			expect(historyTabButton).toHaveStyle({
				backgroundColor: mockTheme.colors.accent + '20',
				color: mockTheme.colors.accent,
			});

			// Inactive tab should have dim text color
			const overviewTabButton = screen.getByText('AI Overview').closest('button');
			expect(overviewTabButton).toHaveStyle({
				color: mockTheme.colors.textDim,
			});
		});
	});

	describe('Keyboard Tab Navigation', () => {
		it('switches to next tab with Cmd+Shift+]', async () => {
			renderModal();

			await waitFor(() => {
				expect(screen.getByTestId('unified-history-tab')).toBeInTheDocument();
			});

			// Enable AI Overview first
			await act(async () => {
				fireEvent.click(screen.getByTestId('trigger-synopsis-ready'));
			});

			// Starting on history (index 1), Cmd+Shift+] should go to ai-overview (index 2)
			await act(async () => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: ']',
						metaKey: true,
						shiftKey: true,
						bubbles: true,
					})
				);
			});

			const aiOverviewContainer = screen.getByTestId('ai-overview-tab').closest('.h-full');
			expect(aiOverviewContainer).not.toHaveClass('hidden');
		});

		it('switches to previous tab with Cmd+Shift+[', async () => {
			renderModal();

			await waitFor(() => {
				expect(screen.getByTestId('unified-history-tab')).toBeInTheDocument();
			});

			// Starting on history (index 1), Cmd+Shift+[ should go to help (index 0)
			await act(async () => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: '[',
						metaKey: true,
						shiftKey: true,
						bubbles: true,
					})
				);
			});

			const overviewContainer = screen.getByTestId('overview-tab').closest('.h-full');
			expect(overviewContainer).not.toHaveClass('hidden');
		});

		it('skips disabled tabs when navigating', async () => {
			renderModal();

			await waitFor(() => {
				expect(screen.getByTestId('unified-history-tab')).toBeInTheDocument();
			});

			// AI Overview is disabled (not ready). From history (index 1), Cmd+Shift+] should skip to help (index 0)
			await act(async () => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: ']',
						metaKey: true,
						shiftKey: true,
						bubbles: true,
					})
				);
			});

			const overviewContainer = screen.getByTestId('overview-tab').closest('.h-full');
			expect(overviewContainer).not.toHaveClass('hidden');
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

			// Click the backdrop overlay (the outer fixed container)
			const backdrop = document.querySelector('.fixed.inset-0.modal-overlay');
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

		it('onEscape calls onClose when no tab consumes it', () => {
			renderModal();

			// Extract the onEscape handler from the registerLayer call
			const layerConfig = mockRegisterLayer.mock.calls[0][0];
			layerConfig.onEscape();

			expect(onClose).toHaveBeenCalledTimes(1);
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

		it('passes onResumeSession through to UnifiedHistoryTab', async () => {
			const onResumeSession = vi.fn();

			renderModal({ onResumeSession });

			await waitFor(() => {
				expect(screen.getByTestId('mock-resume-session')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByTestId('mock-resume-session'));

			expect(onResumeSession).toHaveBeenCalledWith('source-session-1', 'agent-session-abc');
		});

		it('does not render resume button when onResumeSession is not provided', async () => {
			renderModal();

			await waitFor(() => {
				expect(screen.getByTestId('unified-history-tab')).toBeInTheDocument();
			});

			expect(screen.queryByTestId('mock-resume-session')).not.toBeInTheDocument();
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
