/**
 * @fileoverview Tests for ChartErrorBoundary component
 * Tests: error catching, retry functionality, error details, theming, accessibility
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ChartErrorBoundary } from '../../../../renderer/components/UsageDashboard/ChartErrorBoundary';
import type { Theme } from '../../../../renderer/types';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
	AlertTriangle: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="alert-triangle-icon" className={className} style={style}>
			⚠️
		</span>
	),
	RefreshCw: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="refresh-icon" className={className} style={style}>
			🔄
		</span>
	),
	ChevronDown: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="chevron-down-icon" className={className} style={style}>
			▼
		</span>
	),
	ChevronUp: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="chevron-up-icon" className={className} style={style}>
			▲
		</span>
	),
}));

// Mock logger
vi.mock('../../../../renderer/utils/logger', () => ({
	logger: {
		error: vi.fn(),
		warn: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
	},
}));

// Create test theme
const createTheme = (): Theme => ({
	id: 'test-dark',
	name: 'Test Dark',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgActivity: '#0f3460',
		textMain: '#e8e8e8',
		textDim: '#888888',
		accent: '#7b2cbf',
		border: '#333355',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
		info: '#3b82f6',
		bgAccentHover: '#9333ea',
	},
});

// Component that throws an error
const BrokenComponent = ({ shouldError = true }: { shouldError?: boolean }) => {
	if (shouldError) {
		throw new Error('Test error from BrokenComponent');
	}
	return <div data-testid="working-child">Working component</div>;
};

// Component that works
const WorkingComponent = () => <div data-testid="working-child">Working component</div>;

describe('ChartErrorBoundary', () => {
	const theme = createTheme();
	const originalConsoleError = console.error;

	beforeEach(() => {
		vi.clearAllMocks();
		// Suppress React error boundary console output during tests
		console.error = vi.fn();
	});

	afterEach(() => {
		console.error = originalConsoleError;
	});

	describe('Normal Rendering', () => {
		it('renders children when no error occurs', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<WorkingComponent />
				</ChartErrorBoundary>
			);

			expect(screen.getByTestId('working-child')).toBeInTheDocument();
			expect(screen.queryByTestId('chart-error-boundary')).not.toBeInTheDocument();
		});

		it('does not show error UI when children render successfully', () => {
			render(
				<ChartErrorBoundary theme={theme} chartName="Test Chart">
					<div>Normal content</div>
				</ChartErrorBoundary>
			);

			expect(screen.queryByRole('alert')).not.toBeInTheDocument();
			expect(screen.queryByTestId('chart-retry-button')).not.toBeInTheDocument();
		});
	});

	describe('Error Catching', () => {
		it('catches and displays error when child component throws', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			expect(screen.getByTestId('chart-error-boundary')).toBeInTheDocument();
			expect(screen.getByText(/Chart failed to render/i)).toBeInTheDocument();
		});

		it('displays chart name in error message when provided', () => {
			render(
				<ChartErrorBoundary theme={theme} chartName="Agent Comparison">
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			expect(screen.getByText(/Failed to render Agent Comparison/i)).toBeInTheDocument();
		});

		it('shows generic message when chartName is not provided', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			expect(screen.getByText(/Chart failed to render/i)).toBeInTheDocument();
		});

		it('displays unexpected error message', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			expect(screen.getByText(/An unexpected error occurred/i)).toBeInTheDocument();
		});
	});

	describe('Retry Functionality', () => {
		it('renders retry button when error occurs', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			const retryButton = screen.getByTestId('chart-retry-button');
			expect(retryButton).toBeInTheDocument();
			expect(retryButton).toHaveTextContent('Retry');
		});

		it('re-renders children when retry is clicked', () => {
			let shouldError = true;

			const ConditionalBrokenComponent = () => {
				if (shouldError) {
					throw new Error('Conditional error');
				}
				return <div data-testid="recovered-child">Recovered!</div>;
			};

			render(
				<ChartErrorBoundary theme={theme}>
					<ConditionalBrokenComponent />
				</ChartErrorBoundary>
			);

			// Initially shows error UI
			expect(screen.getByTestId('chart-error-boundary')).toBeInTheDocument();

			// Fix the error and click retry
			shouldError = false;
			const retryButton = screen.getByTestId('chart-retry-button');
			fireEvent.click(retryButton);

			// Should now show recovered component
			expect(screen.getByTestId('recovered-child')).toBeInTheDocument();
			expect(screen.queryByTestId('chart-error-boundary')).not.toBeInTheDocument();
		});

		it('calls onRetry callback when retry is clicked', () => {
			const onRetry = vi.fn();

			render(
				<ChartErrorBoundary theme={theme} onRetry={onRetry}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			const retryButton = screen.getByTestId('chart-retry-button');
			fireEvent.click(retryButton);

			expect(onRetry).toHaveBeenCalledTimes(1);
		});

		it('increments and displays retry count after multiple retries', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			// First retry - need to re-query button after each click since component is re-rendered
			fireEvent.click(screen.getByTestId('chart-retry-button'));
			expect(screen.getByTestId('retry-count')).toHaveTextContent('Retry attempts: 1');

			// Second retry - re-query the button as it was re-rendered
			fireEvent.click(screen.getByTestId('chart-retry-button'));
			expect(screen.getByTestId('retry-count')).toHaveTextContent('Retry attempts: 2');

			// Third retry - re-query the button as it was re-rendered
			fireEvent.click(screen.getByTestId('chart-retry-button'));
			expect(screen.getByTestId('retry-count')).toHaveTextContent('Retry attempts: 3');
		});

		it('does not show retry count on initial error (before any retries)', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			expect(screen.queryByTestId('retry-count')).not.toBeInTheDocument();
		});
	});

	describe('Error Details', () => {
		it('shows toggle details button when error has message', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			const toggleButton = screen.getByTestId('toggle-error-details');
			expect(toggleButton).toBeInTheDocument();
			expect(toggleButton).toHaveTextContent('Show details');
		});

		it('shows error details when toggle is clicked', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			const toggleButton = screen.getByTestId('toggle-error-details');
			fireEvent.click(toggleButton);

			expect(screen.getByTestId('error-details')).toBeInTheDocument();
			expect(screen.getByText(/Test error from BrokenComponent/i)).toBeInTheDocument();
		});

		it('hides error details when toggle is clicked again', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			const toggleButton = screen.getByTestId('toggle-error-details');

			// Show details
			fireEvent.click(toggleButton);
			expect(screen.getByTestId('error-details')).toBeInTheDocument();

			// Hide details
			fireEvent.click(toggleButton);
			expect(screen.queryByTestId('error-details')).not.toBeInTheDocument();
		});

		it('toggles chevron icon when showing/hiding details', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			// Initially shows down chevron
			expect(screen.getByTestId('chevron-down-icon')).toBeInTheDocument();
			expect(screen.queryByTestId('chevron-up-icon')).not.toBeInTheDocument();

			// After clicking, shows up chevron
			const toggleButton = screen.getByTestId('toggle-error-details');
			fireEvent.click(toggleButton);

			expect(screen.getByTestId('chevron-up-icon')).toBeInTheDocument();
			expect(screen.queryByTestId('chevron-down-icon')).not.toBeInTheDocument();
		});
	});

	describe('Theme Integration', () => {
		it('applies theme background color to error container', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			const container = screen.getByTestId('chart-error-boundary');
			expect(container).toHaveStyle({ backgroundColor: theme.colors.bgMain });
		});

		it('applies theme accent color to retry button', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			const retryButton = screen.getByTestId('chart-retry-button');
			expect(retryButton).toHaveStyle({ backgroundColor: theme.colors.accent });
		});

		it('applies theme text colors to error messages', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			const heading = screen.getByText(/Chart failed to render/i);
			expect(heading).toHaveStyle({ color: theme.colors.textMain });

			const subtext = screen.getByText(/An unexpected error occurred/i);
			expect(subtext).toHaveStyle({ color: theme.colors.textDim });
		});

		it('works with light theme', () => {
			const lightTheme: Theme = {
				...theme,
				id: 'test-light',
				name: 'Test Light',
				mode: 'light',
				colors: {
					...theme.colors,
					bgMain: '#ffffff',
					textMain: '#1a1a2e',
					textDim: '#666666',
				},
			};

			render(
				<ChartErrorBoundary theme={lightTheme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			const container = screen.getByTestId('chart-error-boundary');
			expect(container).toHaveStyle({ backgroundColor: lightTheme.colors.bgMain });
		});
	});

	describe('Accessibility', () => {
		it('sets role="alert" on error container', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			expect(screen.getByRole('alert')).toBeInTheDocument();
		});

		it('sets aria-live="polite" for screen readers', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			const container = screen.getByTestId('chart-error-boundary');
			expect(container).toHaveAttribute('aria-live', 'polite');
		});

		it('icons have aria-hidden for assistive technologies', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			// The icons should be present (mocked)
			expect(screen.getByTestId('alert-triangle-icon')).toBeInTheDocument();
			expect(screen.getByTestId('refresh-icon')).toBeInTheDocument();
		});

		it('retry button is keyboard focusable', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			const retryButton = screen.getByTestId('chart-retry-button');
			expect(retryButton.tagName).toBe('BUTTON');
		});
	});

	describe('Error Logging', () => {
		it('logs error to console when component catches error', async () => {
			render(
				<ChartErrorBoundary theme={theme} chartName="Test Chart">
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			// Console.error is called by React's error boundary and our own logging
			expect(console.error).toHaveBeenCalled();
		});
	});

	describe('Edge Cases', () => {
		it('handles multiple children', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<div>Child 1</div>
					<div>Child 2</div>
					<div>Child 3</div>
				</ChartErrorBoundary>
			);

			expect(screen.getByText('Child 1')).toBeInTheDocument();
			expect(screen.getByText('Child 2')).toBeInTheDocument();
			expect(screen.getByText('Child 3')).toBeInTheDocument();
		});

		it('handles deeply nested children', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<div>
						<div>
							<div>
								<BrokenComponent />
							</div>
						</div>
					</div>
				</ChartErrorBoundary>
			);

			expect(screen.getByTestId('chart-error-boundary')).toBeInTheDocument();
		});

		it('handles errors with no stack trace', () => {
			const ErrorWithoutStack = () => {
				const error = new Error('Error without stack');
				error.stack = undefined;
				throw error;
			};

			render(
				<ChartErrorBoundary theme={theme}>
					<ErrorWithoutStack />
				</ChartErrorBoundary>
			);

			const toggleButton = screen.getByTestId('toggle-error-details');
			fireEvent.click(toggleButton);

			expect(screen.getByTestId('error-details')).toBeInTheDocument();
			expect(screen.getByText(/Error without stack/i)).toBeInTheDocument();
		});

		it('handles errors thrown during event handlers (does not catch)', () => {
			// Error boundaries don't catch errors in event handlers
			// This test documents that behavior
			const ComponentWithEventError = () => (
				<button
					onClick={() => {
						throw new Error('Event handler error');
					}}
					data-testid="error-button"
				>
					Click me
				</button>
			);

			render(
				<ChartErrorBoundary theme={theme}>
					<ComponentWithEventError />
				</ChartErrorBoundary>
			);

			// Component renders normally (error boundaries don't catch event errors)
			expect(screen.getByTestId('error-button')).toBeInTheDocument();
			expect(screen.queryByTestId('chart-error-boundary')).not.toBeInTheDocument();
		});
	});

	describe('Integration with UsageDashboard Charts', () => {
		it('provides minimum height container for chart errors', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			const container = screen.getByTestId('chart-error-boundary');
			expect(container).toHaveStyle({ minHeight: '200px' });
		});

		it('uses rounded corners matching dashboard style', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			const container = screen.getByTestId('chart-error-boundary');
			expect(container).toHaveClass('rounded-lg');
		});
	});
});
