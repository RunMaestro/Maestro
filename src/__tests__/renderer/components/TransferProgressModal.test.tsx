/**
 * Tests for TransferProgressModal component
 *
 * Tests the cross-agent context transfer progress modal:
 * - Rendering with progress stages
 * - Agent transfer indicator display
 * - Progress bar visualization
 * - Cancel functionality with confirmation
 * - Complete state handling
 * - Elapsed time tracking
 * - Layer stack integration
 * - Accessibility
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { TransferProgressModal } from '../../../renderer/components/TransferProgressModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme, ToolType } from '../../../renderer/types';
import type { GroomingProgress } from '../../../renderer/types/contextMerge';

// Mock lucide-react
vi.mock('lucide-react', () => ({
	X: () => <svg data-testid="x-icon" />,
	Check: () => <svg data-testid="check-icon" />,
	Loader2: () => <svg data-testid="loader-icon" />,
	AlertTriangle: () => <svg data-testid="alert-icon" />,
	ArrowRight: () => <svg data-testid="arrow-right-icon" />,
	Wand2: () => <svg data-testid="wand-icon" />,
}));

// Mock contextGroomer for getAgentDisplayName
vi.mock('../../../renderer/services/contextGroomer', () => ({
	getAgentDisplayName: (toolType: ToolType) => {
		const names: Record<string, string> = {
			'claude-code': 'Claude Code',
			opencode: 'OpenCode',
			codex: 'OpenAI Codex',
			aider: 'Aider',
			terminal: 'Terminal',
		};
		return names[toolType] || toolType;
	},
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
		info: '#3794ff',
		textInverse: '#000000',
	},
};

// Helper to render with LayerStackProvider
const renderWithLayerStack = (ui: React.ReactElement) => {
	return render(<LayerStackProvider>{ui}</LayerStackProvider>);
};

// Default progress states for testing
const collectingProgress: GroomingProgress = {
	stage: 'collecting',
	progress: 10,
	message: 'Extracting source context...',
};

const groomingProgress: GroomingProgress = {
	stage: 'grooming',
	progress: 40,
	message: 'Grooming for OpenCode...',
};

const creatingProgress: GroomingProgress = {
	stage: 'creating',
	progress: 80,
	message: 'Creating OpenCode session...',
};

const completeProgress: GroomingProgress = {
	stage: 'complete',
	progress: 100,
	message: 'Transfer complete!',
};

describe('TransferProgressModal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	describe('rendering', () => {
		it('renders with progress stages and agent indicator', () => {
			renderWithLayerStack(
				<TransferProgressModal
					theme={testTheme}
					isOpen={true}
					progress={groomingProgress}
					sourceAgent="claude-code"
					targetAgent="opencode"
					onCancel={vi.fn()}
				/>
			);

			expect(screen.getByText('Transferring Context...')).toBeInTheDocument();
			expect(screen.getByText('Claude Code')).toBeInTheDocument();
			expect(screen.getByText('OpenCode')).toBeInTheDocument();
			expect(screen.getByTestId('arrow-right-icon')).toBeInTheDocument();
		});

		it('displays progress message', () => {
			renderWithLayerStack(
				<TransferProgressModal
					theme={testTheme}
					isOpen={true}
					progress={groomingProgress}
					sourceAgent="claude-code"
					targetAgent="opencode"
					onCancel={vi.fn()}
				/>
			);

			// The message appears in both the status area and the stage list
			const groomingMessages = screen.getAllByText('Grooming for OpenCode...');
			expect(groomingMessages.length).toBeGreaterThan(0);
		});

		it('displays progress percentage', () => {
			renderWithLayerStack(
				<TransferProgressModal
					theme={testTheme}
					isOpen={true}
					progress={groomingProgress}
					sourceAgent="claude-code"
					targetAgent="opencode"
					onCancel={vi.fn()}
				/>
			);

			expect(screen.getByText('40%')).toBeInTheDocument();
		});

		it('shows spinner during transfer', () => {
			renderWithLayerStack(
				<TransferProgressModal
					theme={testTheme}
					isOpen={true}
					progress={groomingProgress}
					sourceAgent="claude-code"
					targetAgent="opencode"
					onCancel={vi.fn()}
				/>
			);

			// Spinner is a combination of elements, check for the animate-spin class container
			const spinnerContainer = document.querySelector('.animate-spin');
			expect(spinnerContainer).toBeInTheDocument();
		});

		it('does not render when isOpen is false', () => {
			renderWithLayerStack(
				<TransferProgressModal
					theme={testTheme}
					isOpen={false}
					progress={groomingProgress}
					sourceAgent="claude-code"
					targetAgent="opencode"
					onCancel={vi.fn()}
				/>
			);

			expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		});
	});

	describe('stage progression', () => {
		it('shows collecting stage as active during extraction', () => {
			renderWithLayerStack(
				<TransferProgressModal
					theme={testTheme}
					isOpen={true}
					progress={collectingProgress}
					sourceAgent="claude-code"
					targetAgent="opencode"
					onCancel={vi.fn()}
				/>
			);

			expect(screen.getByText('Extracting context...')).toBeInTheDocument();
		});

		it('shows grooming stage as active during grooming', () => {
			renderWithLayerStack(
				<TransferProgressModal
					theme={testTheme}
					isOpen={true}
					progress={groomingProgress}
					sourceAgent="claude-code"
					targetAgent="opencode"
					onCancel={vi.fn()}
				/>
			);

			// The active stage should have target agent name in its label
			// It appears in both the status area and the stage list
			const groomingMessages = screen.getAllByText('Grooming for OpenCode...');
			expect(groomingMessages.length).toBeGreaterThan(0);
		});

		it('shows creating stage as active during session creation', () => {
			renderWithLayerStack(
				<TransferProgressModal
					theme={testTheme}
					isOpen={true}
					progress={creatingProgress}
					sourceAgent="claude-code"
					targetAgent="opencode"
					onCancel={vi.fn()}
				/>
			);

			// The creating message appears in both the status area and the stage list
			const creatingMessages = screen.getAllByText('Creating OpenCode session...');
			expect(creatingMessages.length).toBeGreaterThan(0);
		});

		it('shows check icons for completed stages', () => {
			renderWithLayerStack(
				<TransferProgressModal
					theme={testTheme}
					isOpen={true}
					progress={creatingProgress}
					sourceAgent="claude-code"
					targetAgent="opencode"
					onCancel={vi.fn()}
				/>
			);

			// Earlier stages should have check icons
			const checkIcons = screen.getAllByTestId('check-icon');
			expect(checkIcons.length).toBeGreaterThan(0);
		});
	});

	describe('complete state', () => {
		it('shows success icon when complete', () => {
			renderWithLayerStack(
				<TransferProgressModal
					theme={testTheme}
					isOpen={true}
					progress={completeProgress}
					sourceAgent="claude-code"
					targetAgent="opencode"
					onCancel={vi.fn()}
				/>
			);

			// Complete state shows a larger check icon in the center
			expect(screen.getByText('Transfer Complete')).toBeInTheDocument();
		});

		it('shows Done button when complete', () => {
			renderWithLayerStack(
				<TransferProgressModal
					theme={testTheme}
					isOpen={true}
					progress={completeProgress}
					sourceAgent="claude-code"
					targetAgent="opencode"
					onCancel={vi.fn()}
				/>
			);

			expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
		});

		it('shows X close button when complete', () => {
			renderWithLayerStack(
				<TransferProgressModal
					theme={testTheme}
					isOpen={true}
					progress={completeProgress}
					sourceAgent="claude-code"
					targetAgent="opencode"
					onCancel={vi.fn()}
				/>
			);

			expect(screen.getByTestId('x-icon')).toBeInTheDocument();
		});

		it('calls onComplete when Done is clicked', () => {
			const onComplete = vi.fn();
			renderWithLayerStack(
				<TransferProgressModal
					theme={testTheme}
					isOpen={true}
					progress={completeProgress}
					sourceAgent="claude-code"
					targetAgent="opencode"
					onCancel={vi.fn()}
					onComplete={onComplete}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Done' }));
			expect(onComplete).toHaveBeenCalledTimes(1);
		});

		it('calls onCancel if onComplete not provided when Done is clicked', () => {
			const onCancel = vi.fn();
			renderWithLayerStack(
				<TransferProgressModal
					theme={testTheme}
					isOpen={true}
					progress={completeProgress}
					sourceAgent="claude-code"
					targetAgent="opencode"
					onCancel={onCancel}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Done' }));
			expect(onCancel).toHaveBeenCalledTimes(1);
		});
	});

	describe('cancel functionality', () => {
		it('shows Cancel button during transfer', () => {
			renderWithLayerStack(
				<TransferProgressModal
					theme={testTheme}
					isOpen={true}
					progress={groomingProgress}
					sourceAgent="claude-code"
					targetAgent="opencode"
					onCancel={vi.fn()}
				/>
			);

			expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
		});

		it('shows confirmation dialog when Cancel is clicked during transfer', () => {
			renderWithLayerStack(
				<TransferProgressModal
					theme={testTheme}
					isOpen={true}
					progress={groomingProgress}
					sourceAgent="claude-code"
					targetAgent="opencode"
					onCancel={vi.fn()}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

			expect(screen.getByText('Cancel Transfer?')).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Continue Transfer' })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Cancel Transfer' })).toBeInTheDocument();
		});

		it('calls onCancel when cancel is confirmed', () => {
			const onCancel = vi.fn();
			renderWithLayerStack(
				<TransferProgressModal
					theme={testTheme}
					isOpen={true}
					progress={groomingProgress}
					sourceAgent="claude-code"
					targetAgent="opencode"
					onCancel={onCancel}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
			fireEvent.click(screen.getByRole('button', { name: 'Cancel Transfer' }));

			expect(onCancel).toHaveBeenCalledTimes(1);
		});

		it('dismisses confirmation when Continue Transfer is clicked', () => {
			renderWithLayerStack(
				<TransferProgressModal
					theme={testTheme}
					isOpen={true}
					progress={groomingProgress}
					sourceAgent="claude-code"
					targetAgent="opencode"
					onCancel={vi.fn()}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
			fireEvent.click(screen.getByRole('button', { name: 'Continue Transfer' }));

			expect(screen.queryByText('Cancel Transfer?')).not.toBeInTheDocument();
		});
	});

	describe('elapsed time', () => {
		it('shows elapsed time during transfer', () => {
			renderWithLayerStack(
				<TransferProgressModal
					theme={testTheme}
					isOpen={true}
					progress={groomingProgress}
					sourceAgent="claude-code"
					targetAgent="opencode"
					onCancel={vi.fn()}
				/>
			);

			expect(screen.getByText('Elapsed:')).toBeInTheDocument();
			expect(screen.getByText('0s')).toBeInTheDocument();
		});

		it('updates elapsed time every second', async () => {
			renderWithLayerStack(
				<TransferProgressModal
					theme={testTheme}
					isOpen={true}
					progress={groomingProgress}
					sourceAgent="claude-code"
					targetAgent="opencode"
					onCancel={vi.fn()}
				/>
			);

			expect(screen.getByText('0s')).toBeInTheDocument();

			// Use act to wrap the timer advancement
			await act(async () => {
				vi.advanceTimersByTime(3000);
			});

			expect(screen.getByText('3s')).toBeInTheDocument();
		});

		it('does not show elapsed time when complete', () => {
			renderWithLayerStack(
				<TransferProgressModal
					theme={testTheme}
					isOpen={true}
					progress={completeProgress}
					sourceAgent="claude-code"
					targetAgent="opencode"
					onCancel={vi.fn()}
				/>
			);

			expect(screen.queryByText('Elapsed:')).not.toBeInTheDocument();
		});
	});

	describe('accessibility', () => {
		it('has correct ARIA attributes', () => {
			renderWithLayerStack(
				<TransferProgressModal
					theme={testTheme}
					isOpen={true}
					progress={groomingProgress}
					sourceAgent="claude-code"
					targetAgent="opencode"
					onCancel={vi.fn()}
				/>
			);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-label', 'Transfer Progress');
		});

		it('has tabIndex on dialog for focus', () => {
			renderWithLayerStack(
				<TransferProgressModal
					theme={testTheme}
					isOpen={true}
					progress={groomingProgress}
					sourceAgent="claude-code"
					targetAgent="opencode"
					onCancel={vi.fn()}
				/>
			);

			expect(screen.getByRole('dialog')).toHaveAttribute('tabIndex', '-1');
		});

		it('has semantic button elements', () => {
			renderWithLayerStack(
				<TransferProgressModal
					theme={testTheme}
					isOpen={true}
					progress={groomingProgress}
					sourceAgent="claude-code"
					targetAgent="opencode"
					onCancel={vi.fn()}
				/>
			);

			expect(screen.getAllByRole('button')).toHaveLength(1); // Cancel button only
		});
	});

	describe('layer stack integration', () => {
		it('registers and unregisters without errors', () => {
			const { unmount } = renderWithLayerStack(
				<TransferProgressModal
					theme={testTheme}
					isOpen={true}
					progress={groomingProgress}
					sourceAgent="claude-code"
					targetAgent="opencode"
					onCancel={vi.fn()}
				/>
			);

			expect(screen.getByRole('dialog')).toBeInTheDocument();
			expect(() => unmount()).not.toThrow();
		});
	});

	describe('agent display', () => {
		it('displays different agent combinations correctly', () => {
			renderWithLayerStack(
				<TransferProgressModal
					theme={testTheme}
					isOpen={true}
					progress={groomingProgress}
					sourceAgent="opencode"
					targetAgent="claude-code"
					onCancel={vi.fn()}
				/>
			);

			expect(screen.getByText('OpenCode')).toBeInTheDocument();
			expect(screen.getByText('Claude Code')).toBeInTheDocument();
		});

		it('shows arrow between agents', () => {
			renderWithLayerStack(
				<TransferProgressModal
					theme={testTheme}
					isOpen={true}
					progress={groomingProgress}
					sourceAgent="claude-code"
					targetAgent="opencode"
					onCancel={vi.fn()}
				/>
			);

			expect(screen.getByTestId('arrow-right-icon')).toBeInTheDocument();
		});
	});
});
