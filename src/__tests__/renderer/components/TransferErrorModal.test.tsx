/**
 * Tests for TransferErrorModal component
 *
 * Tests the cross-agent transfer error handling modal:
 * - Rendering with different error types
 * - Recovery action buttons (retry, skip grooming, cancel)
 * - Error classification and message display
 * - Agent context display
 * - Modal accessibility
 * - Install instructions for unavailable agents
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
	TransferErrorModal,
	classifyTransferError,
	TransferError,
	TransferErrorType,
} from '../../../renderer/components/TransferErrorModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../renderer/types';

// Mock lucide-react
vi.mock('lucide-react', () => ({
	AlertCircle: () => <svg data-testid="alert-circle-icon" />,
	RefreshCw: () => <svg data-testid="refresh-icon" />,
	Zap: () => <svg data-testid="zap-icon" />,
	XCircle: () => <svg data-testid="x-circle-icon" />,
	Clock: () => <svg data-testid="clock-icon" />,
	Download: () => <svg data-testid="download-icon" />,
	Loader2: () => <svg data-testid="loader-icon" />,
	HardDrive: () => <svg data-testid="hard-drive-icon" />,
	ArrowRight: () => <svg data-testid="arrow-right-icon" />,
	X: () => <svg data-testid="x-icon" />,
}));

// Mock contextGroomer for getAgentDisplayName
vi.mock('../../../renderer/services/contextGroomer', () => ({
	getAgentDisplayName: (toolType: string) => {
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

// Test error factory functions
const createTestError = (
	type: TransferErrorType,
	overrides: Partial<TransferError> = {}
): TransferError => ({
	type,
	message: `Test ${type} error message`,
	recoverable: true,
	sourceAgent: 'claude-code',
	targetAgent: 'opencode',
	timestamp: Date.now(),
	...overrides,
});

describe('TransferErrorModal', () => {
	const defaultProps = {
		theme: testTheme,
		isOpen: true,
		error: createTestError('unknown'),
		onRetry: vi.fn(),
		onSkipGrooming: vi.fn(),
		onCancel: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('rendering', () => {
		it('renders with error message', () => {
			renderWithLayerStack(<TransferErrorModal {...defaultProps} />);

			expect(screen.getByText('Test unknown error message')).toBeInTheDocument();
		});

		it('renders agent transfer indicator', () => {
			renderWithLayerStack(<TransferErrorModal {...defaultProps} />);

			expect(screen.getByText('Claude Code')).toBeInTheDocument();
			expect(screen.getByText('OpenCode')).toBeInTheDocument();
			expect(screen.getByTestId('arrow-right-icon')).toBeInTheDocument();
		});

		it('renders error timestamp', () => {
			const now = new Date();
			renderWithLayerStack(
				<TransferErrorModal
					{...defaultProps}
					error={createTestError('unknown', { timestamp: now.getTime() })}
				/>
			);

			expect(screen.getByText(now.toLocaleTimeString())).toBeInTheDocument();
		});

		it('renders cancel button', () => {
			renderWithLayerStack(<TransferErrorModal {...defaultProps} />);

			expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
		});
	});

	describe('error types', () => {
		it('shows correct title for agent_not_installed', () => {
			renderWithLayerStack(
				<TransferErrorModal {...defaultProps} error={createTestError('agent_not_installed')} />
			);

			expect(screen.getByText('Agent Not Available')).toBeInTheDocument();
			expect(screen.getByTestId('download-icon')).toBeInTheDocument();
		});

		it('shows correct title for agent_busy', () => {
			renderWithLayerStack(
				<TransferErrorModal {...defaultProps} error={createTestError('agent_busy')} />
			);

			expect(screen.getByText('Agent Busy')).toBeInTheDocument();
		});

		it('shows correct title for grooming_timeout', () => {
			renderWithLayerStack(
				<TransferErrorModal {...defaultProps} error={createTestError('grooming_timeout')} />
			);

			expect(screen.getByText('Grooming Timed Out')).toBeInTheDocument();
			expect(screen.getByTestId('clock-icon')).toBeInTheDocument();
		});

		it('shows correct title for grooming_failed', () => {
			renderWithLayerStack(
				<TransferErrorModal {...defaultProps} error={createTestError('grooming_failed')} />
			);

			expect(screen.getByText('Grooming Failed')).toBeInTheDocument();
		});

		it('shows correct title for context_too_large', () => {
			renderWithLayerStack(
				<TransferErrorModal {...defaultProps} error={createTestError('context_too_large')} />
			);

			expect(screen.getByText('Context Too Large')).toBeInTheDocument();
			expect(screen.getByTestId('hard-drive-icon')).toBeInTheDocument();
		});

		it('shows correct title for session_creation_failed', () => {
			renderWithLayerStack(
				<TransferErrorModal {...defaultProps} error={createTestError('session_creation_failed')} />
			);

			expect(screen.getByText('Session Creation Failed')).toBeInTheDocument();
		});

		it('shows correct title for network_error', () => {
			renderWithLayerStack(
				<TransferErrorModal {...defaultProps} error={createTestError('network_error')} />
			);

			expect(screen.getByText('Connection Error')).toBeInTheDocument();
		});
	});

	describe('recovery actions', () => {
		it('shows retry button for recoverable errors', () => {
			renderWithLayerStack(
				<TransferErrorModal {...defaultProps} error={createTestError('network_error')} />
			);

			expect(screen.getByText('Retry')).toBeInTheDocument();
		});

		it('calls onRetry when retry button is clicked', () => {
			const onRetry = vi.fn();
			renderWithLayerStack(
				<TransferErrorModal
					{...defaultProps}
					error={createTestError('network_error')}
					onRetry={onRetry}
				/>
			);

			fireEvent.click(screen.getByText('Retry'));
			expect(onRetry).toHaveBeenCalledTimes(1);
		});

		it('shows skip grooming option for grooming_timeout', () => {
			renderWithLayerStack(
				<TransferErrorModal {...defaultProps} error={createTestError('grooming_timeout')} />
			);

			expect(screen.getByText('Skip Grooming')).toBeInTheDocument();
		});

		it('shows skip grooming option for grooming_failed', () => {
			renderWithLayerStack(
				<TransferErrorModal {...defaultProps} error={createTestError('grooming_failed')} />
			);

			expect(screen.getByText('Skip Grooming')).toBeInTheDocument();
		});

		it('calls onSkipGrooming when skip grooming is clicked', () => {
			const onSkipGrooming = vi.fn();
			renderWithLayerStack(
				<TransferErrorModal
					{...defaultProps}
					error={createTestError('grooming_timeout')}
					onSkipGrooming={onSkipGrooming}
				/>
			);

			fireEvent.click(screen.getByText('Skip Grooming'));
			expect(onSkipGrooming).toHaveBeenCalledTimes(1);
		});

		it('does not show retry for agent_not_installed', () => {
			renderWithLayerStack(
				<TransferErrorModal
					{...defaultProps}
					error={createTestError('agent_not_installed', { recoverable: false })}
				/>
			);

			expect(screen.queryByText('Retry')).not.toBeInTheDocument();
		});

		it('calls onCancel when cancel button is clicked', () => {
			const onCancel = vi.fn();
			renderWithLayerStack(<TransferErrorModal {...defaultProps} onCancel={onCancel} />);

			fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
			expect(onCancel).toHaveBeenCalledTimes(1);
		});

		it('shows grooming option for context_too_large', () => {
			renderWithLayerStack(
				<TransferErrorModal {...defaultProps} error={createTestError('context_too_large')} />
			);

			expect(screen.getByText('Try with Grooming')).toBeInTheDocument();
		});
	});

	describe('retrying state', () => {
		it('disables buttons when retrying', () => {
			renderWithLayerStack(
				<TransferErrorModal
					{...defaultProps}
					error={createTestError('network_error')}
					isRetrying={true}
				/>
			);

			expect(screen.getByText('Retrying...')).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
		});

		it('shows loader icon when retrying', () => {
			renderWithLayerStack(
				<TransferErrorModal
					{...defaultProps}
					error={createTestError('network_error')}
					isRetrying={true}
				/>
			);

			expect(screen.getByTestId('loader-icon')).toBeInTheDocument();
		});
	});

	describe('error details', () => {
		it('shows token details for context_too_large', () => {
			renderWithLayerStack(
				<TransferErrorModal
					{...defaultProps}
					error={createTestError('context_too_large', {
						details: {
							estimatedTokens: 50000,
							targetLimit: 30000,
						},
					})}
				/>
			);

			expect(screen.getByText('Context size: ~50,000 tokens (limit: 30,000)')).toBeInTheDocument();
		});

		it('shows elapsed time for grooming_timeout', () => {
			renderWithLayerStack(
				<TransferErrorModal
					{...defaultProps}
					error={createTestError('grooming_timeout', {
						details: {
							elapsedTimeMs: 30000,
						},
					})}
				/>
			);

			expect(screen.getByText('Elapsed time: 30s')).toBeInTheDocument();
		});

		it('shows busy session count for agent_busy', () => {
			renderWithLayerStack(
				<TransferErrorModal
					{...defaultProps}
					error={createTestError('agent_busy', {
						details: {
							busySessions: 2,
						},
					})}
				/>
			);

			expect(screen.getByText('2 sessions currently active')).toBeInTheDocument();
		});

		it('shows install instructions for agent_not_installed', () => {
			renderWithLayerStack(
				<TransferErrorModal
					{...defaultProps}
					error={createTestError('agent_not_installed', {
						recoverable: false,
						details: {
							installInstructions: 'Run: brew install opencode',
						},
					})}
				/>
			);

			expect(screen.getByText('Run: brew install opencode')).toBeInTheDocument();
		});
	});
});

describe('classifyTransferError', () => {
	it('classifies agent not installed errors', () => {
		const error = classifyTransferError('Target agent is not installed');
		expect(error.type).toBe('agent_not_installed');
		expect(error.recoverable).toBe(false);
	});

	it('classifies agent not available errors', () => {
		const error = classifyTransferError('Agent unavailable');
		expect(error.type).toBe('agent_not_installed');
	});

	it('classifies agent busy errors', () => {
		const error = classifyTransferError('Agent is busy processing');
		expect(error.type).toBe('agent_busy');
		expect(error.recoverable).toBe(true);
	});

	it('classifies grooming timeout errors', () => {
		const error = classifyTransferError('Grooming timed out', { wasGrooming: true });
		expect(error.type).toBe('grooming_timeout');
		expect(error.recoverable).toBe(true);
	});

	it('classifies grooming failed errors', () => {
		const error = classifyTransferError('Context grooming failed');
		expect(error.type).toBe('grooming_failed');
		expect(error.recoverable).toBe(true);
	});

	it('classifies context too large errors', () => {
		const error = classifyTransferError('Context is too large for target agent');
		expect(error.type).toBe('context_too_large');
		expect(error.recoverable).toBe(true);
	});

	it('classifies session creation failed errors', () => {
		const error = classifyTransferError('Failed to create session');
		expect(error.type).toBe('session_creation_failed');
		expect(error.recoverable).toBe(true);
	});

	it('classifies network errors', () => {
		const error = classifyTransferError('Network connection failed');
		expect(error.type).toBe('network_error');
		expect(error.recoverable).toBe(true);
	});

	it('classifies source not found errors', () => {
		const error = classifyTransferError('Source tab not found');
		expect(error.type).toBe('source_not_found');
		expect(error.recoverable).toBe(false);
	});

	it('classifies cancelled errors', () => {
		const error = classifyTransferError('Transfer cancelled by user');
		expect(error.type).toBe('cancelled');
		expect(error.recoverable).toBe(false);
	});

	it('preserves agent context in classified error', () => {
		const error = classifyTransferError('Network error', {
			sourceAgent: 'claude-code',
			targetAgent: 'opencode',
		});
		expect(error.sourceAgent).toBe('claude-code');
		expect(error.targetAgent).toBe('opencode');
	});

	it('includes elapsed time in timeout error details', () => {
		const error = classifyTransferError('Operation timed out', {
			wasGrooming: true,
			elapsedTimeMs: 45000,
		});
		expect(error.type).toBe('grooming_timeout');
		expect(error.details?.elapsedTimeMs).toBe(45000);
	});

	it('classifies unknown errors with the original message', () => {
		const error = classifyTransferError('Some weird unexpected error');
		expect(error.type).toBe('unknown');
		expect(error.originalError).toBe('Some weird unexpected error');
		expect(error.recoverable).toBe(true);
	});

	it('sets timestamp on all errors', () => {
		const before = Date.now();
		const error = classifyTransferError('Any error');
		const after = Date.now();

		expect(error.timestamp).toBeGreaterThanOrEqual(before);
		expect(error.timestamp).toBeLessThanOrEqual(after);
	});
});
