import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { ErrorBoundary } from '../../../renderer/components/ErrorBoundary';

// Mock the logger module
vi.mock('../../../renderer/utils/logger', () => ({
	logger: {
		error: vi.fn(),
	},
}));

// Get the mocked logger for assertions
import { logger } from '../../../renderer/utils/logger';

// Component that throws an error when rendered
function ThrowingComponent({ message = 'Test error' }: { message?: string }) {
	throw new Error(message);
}

// Component that renders normally
function NormalComponent() {
	return <div data-testid="normal-content">Normal content</div>;
}

// Component that throws conditionally
function ConditionalThrowingComponent({ shouldThrow }: { shouldThrow: boolean }) {
	if (shouldThrow) {
		throw new Error('Conditional error');
	}
	return <div data-testid="conditional-content">Conditional content</div>;
}

// Custom fallback component
function CustomFallback() {
	return <div data-testid="custom-fallback">Custom error fallback</div>;
}

describe('ErrorBoundary', () => {
	// Suppress React error boundary console errors during tests
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
	let originalLocationReload: typeof window.location.reload;

	beforeEach(() => {
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.clearAllMocks();

		// Store original reload
		originalLocationReload = window.location.reload;

		// Mock window.location.reload
		Object.defineProperty(window, 'location', {
			configurable: true,
			value: {
				...window.location,
				reload: vi.fn(),
			},
		});
	});

	afterEach(() => {
		consoleErrorSpy.mockRestore();

		// Restore original reload
		Object.defineProperty(window, 'location', {
			configurable: true,
			value: {
				...window.location,
				reload: originalLocationReload,
			},
		});
	});

	describe('normal operation', () => {
		it('should render children when no error occurs', () => {
			render(
				<ErrorBoundary>
					<NormalComponent />
				</ErrorBoundary>
			);

			expect(screen.getByTestId('normal-content')).toBeInTheDocument();
			expect(screen.getByText('Normal content')).toBeInTheDocument();
		});

		it('should render multiple children', () => {
			render(
				<ErrorBoundary>
					<div data-testid="child-1">Child 1</div>
					<div data-testid="child-2">Child 2</div>
				</ErrorBoundary>
			);

			expect(screen.getByTestId('child-1')).toBeInTheDocument();
			expect(screen.getByTestId('child-2')).toBeInTheDocument();
		});

		it('should render null children', () => {
			const { container } = render(<ErrorBoundary>{null}</ErrorBoundary>);

			expect(container.firstChild).toBeNull();
		});

		it('should render undefined children', () => {
			const { container } = render(<ErrorBoundary>{undefined}</ErrorBoundary>);

			expect(container.firstChild).toBeNull();
		});

		it('should render empty fragment', () => {
			const { container } = render(
				<ErrorBoundary>
					<></>
				</ErrorBoundary>
			);

			expect(container.firstChild).toBeNull();
		});
	});

	describe('error handling', () => {
		it('should catch errors and display fallback UI', () => {
			render(
				<ErrorBoundary>
					<ThrowingComponent />
				</ErrorBoundary>
			);

			expect(screen.getByText('Something went wrong')).toBeInTheDocument();
			expect(screen.getByText(/An unexpected error occurred/)).toBeInTheDocument();
		});

		it('should display error message in error details', () => {
			render(
				<ErrorBoundary>
					<ThrowingComponent message="Custom error message" />
				</ErrorBoundary>
			);

			expect(screen.getByText('Error Details:')).toBeInTheDocument();
			expect(screen.getByText(/Custom error message/)).toBeInTheDocument();
		});

		it('should display component stack trace in details', () => {
			render(
				<ErrorBoundary>
					<ThrowingComponent />
				</ErrorBoundary>
			);

			// The component stack trace is in a details/summary element
			const summary = screen.getByText('Component Stack Trace');
			expect(summary).toBeInTheDocument();
			expect(summary.tagName.toLowerCase()).toBe('summary');
		});

		it('should log error to console', () => {
			render(
				<ErrorBoundary>
					<ThrowingComponent message="Logged error" />
				</ErrorBoundary>
			);

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				'ErrorBoundary caught an error:',
				expect.any(Error),
				expect.any(Object)
			);
		});

		it('should log error to structured logger', () => {
			render(
				<ErrorBoundary>
					<ThrowingComponent message="Structured log error" />
				</ErrorBoundary>
			);

			expect(logger.error).toHaveBeenCalledWith(
				expect.stringContaining('React Error Boundary'),
				'ErrorBoundary',
				expect.objectContaining({
					error: expect.stringContaining('Structured log error'),
					stack: expect.any(String),
					componentStack: expect.any(String),
				})
			);
		});

		it('should catch errors in nested components', () => {
			render(
				<ErrorBoundary>
					<div>
						<div>
							<ThrowingComponent />
						</div>
					</div>
				</ErrorBoundary>
			);

			expect(screen.getByText('Something went wrong')).toBeInTheDocument();
		});
	});

	describe('custom fallback component', () => {
		it('should render custom fallback when provided', () => {
			render(
				<ErrorBoundary fallbackComponent={<CustomFallback />}>
					<ThrowingComponent />
				</ErrorBoundary>
			);

			expect(screen.getByTestId('custom-fallback')).toBeInTheDocument();
			expect(screen.getByText('Custom error fallback')).toBeInTheDocument();
		});

		it('should not render default UI when custom fallback is used', () => {
			render(
				<ErrorBoundary fallbackComponent={<CustomFallback />}>
					<ThrowingComponent />
				</ErrorBoundary>
			);

			expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
			expect(screen.queryByText('Try Again')).not.toBeInTheDocument();
		});

		it('should use default UI when fallbackComponent is undefined', () => {
			render(
				<ErrorBoundary fallbackComponent={undefined}>
					<ThrowingComponent />
				</ErrorBoundary>
			);

			expect(screen.getByText('Something went wrong')).toBeInTheDocument();
		});

		it('should handle complex custom fallback', () => {
			const ComplexFallback = () => (
				<div>
					<h1>Error!</h1>
					<p>Details here</p>
					<button>Retry</button>
				</div>
			);

			render(
				<ErrorBoundary fallbackComponent={<ComplexFallback />}>
					<ThrowingComponent />
				</ErrorBoundary>
			);

			expect(screen.getByRole('heading', { name: 'Error!' })).toBeInTheDocument();
			expect(screen.getByText('Details here')).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
		});
	});

	describe('handleReset', () => {
		it('should show Try Again button in error state', () => {
			render(
				<ErrorBoundary>
					<ThrowingComponent />
				</ErrorBoundary>
			);

			expect(screen.getByRole('button', { name: /Try Again/i })).toBeInTheDocument();
		});

		it('should call onReset callback when Try Again is clicked', () => {
			const onReset = vi.fn();

			render(
				<ErrorBoundary onReset={onReset}>
					<ThrowingComponent />
				</ErrorBoundary>
			);

			fireEvent.click(screen.getByRole('button', { name: /Try Again/i }));

			expect(onReset).toHaveBeenCalledTimes(1);
		});

		it('should reset error state when Try Again is clicked', () => {
			// We need a component that we can control the error state
			let shouldThrow = true;

			const ControlledComponent = () => {
				if (shouldThrow) {
					throw new Error('Controlled error');
				}
				return <div data-testid="recovered">Recovered!</div>;
			};

			const { rerender } = render(
				<ErrorBoundary>
					<ControlledComponent />
				</ErrorBoundary>
			);

			// Error UI should be displayed
			expect(screen.getByText('Something went wrong')).toBeInTheDocument();

			// Now stop throwing
			shouldThrow = false;

			// Click Try Again
			fireEvent.click(screen.getByRole('button', { name: /Try Again/i }));

			// Force a re-render since the component state was reset
			rerender(
				<ErrorBoundary>
					<ControlledComponent />
				</ErrorBoundary>
			);

			// Should now show the recovered content
			expect(screen.getByTestId('recovered')).toBeInTheDocument();
		});

		it('should not throw when onReset is not provided', () => {
			render(
				<ErrorBoundary>
					<ThrowingComponent />
				</ErrorBoundary>
			);

			// Should not throw
			expect(() => {
				fireEvent.click(screen.getByRole('button', { name: /Try Again/i }));
			}).not.toThrow();
		});
	});

	describe('handleReload', () => {
		it('should show Reload App button in error state', () => {
			render(
				<ErrorBoundary>
					<ThrowingComponent />
				</ErrorBoundary>
			);

			expect(screen.getByRole('button', { name: /Reload App/i })).toBeInTheDocument();
		});

		it('should call window.location.reload when Reload App is clicked', () => {
			render(
				<ErrorBoundary>
					<ThrowingComponent />
				</ErrorBoundary>
			);

			fireEvent.click(screen.getByRole('button', { name: /Reload App/i }));

			expect(window.location.reload).toHaveBeenCalledTimes(1);
		});
	});

	describe('getDerivedStateFromError', () => {
		it('should update hasError state to true', () => {
			render(
				<ErrorBoundary>
					<ThrowingComponent />
				</ErrorBoundary>
			);

			// The error UI indicates hasError is true
			expect(screen.getByText('Something went wrong')).toBeInTheDocument();
		});

		it('should capture error object', () => {
			render(
				<ErrorBoundary>
					<ThrowingComponent message="Captured error" />
				</ErrorBoundary>
			);

			// Error is displayed in the UI
			expect(screen.getByText(/Captured error/)).toBeInTheDocument();
		});
	});

	describe('componentDidCatch', () => {
		it('should set errorInfo in state after catching error', () => {
			render(
				<ErrorBoundary>
					<ThrowingComponent />
				</ErrorBoundary>
			);

			// Component stack trace is available when errorInfo is set
			expect(screen.getByText('Component Stack Trace')).toBeInTheDocument();
		});

		it('should handle error with stack trace', () => {
			render(
				<ErrorBoundary>
					<ThrowingComponent />
				</ErrorBoundary>
			);

			// Logger should receive stack trace
			expect(logger.error).toHaveBeenCalledWith(
				expect.any(String),
				expect.any(String),
				expect.objectContaining({
					stack: expect.any(String),
				})
			);
		});
	});

	describe('error UI styling', () => {
		it('should render error icon', () => {
			render(
				<ErrorBoundary>
					<ThrowingComponent />
				</ErrorBoundary>
			);

			// AlertTriangle icon is present (check for SVG or icon container)
			const errorContainer = screen.getByText('Something went wrong').closest('div');
			expect(errorContainer).toBeInTheDocument();
		});

		it('should have proper container styling', () => {
			render(
				<ErrorBoundary>
					<ThrowingComponent />
				</ErrorBoundary>
			);

			// Main container has flex layout
			const mainContainer = screen
				.getByText('Something went wrong')
				.closest('.flex.items-center.justify-center');
			expect(mainContainer).toBeInTheDocument();
		});

		it('should render error details in code block', () => {
			render(
				<ErrorBoundary>
					<ThrowingComponent message="Code block error" />
				</ErrorBoundary>
			);

			const preElement = screen.getByText(/Code block error/).closest('pre');
			expect(preElement).toBeInTheDocument();
			expect(preElement).toHaveClass('font-mono');
		});
	});

	describe('edge cases', () => {
		it('should handle errors thrown during render', () => {
			const RenderErrorComponent = () => {
				const data = null as any;
				return <div>{data.property}</div>; // TypeError
			};

			render(
				<ErrorBoundary>
					<RenderErrorComponent />
				</ErrorBoundary>
			);

			expect(screen.getByText('Something went wrong')).toBeInTheDocument();
		});

		it('should handle errors with special characters in message', () => {
			render(
				<ErrorBoundary>
					<ThrowingComponent message="<script>alert('xss')</script> & special chars" />
				</ErrorBoundary>
			);

			// Should escape HTML and render safely
			expect(screen.getByText(/<script>/)).toBeInTheDocument();
		});

		it('should handle errors with unicode characters', () => {
			render(
				<ErrorBoundary>
					<ThrowingComponent message="Unicode error: 🔥 火災 كارثة" />
				</ErrorBoundary>
			);

			expect(screen.getByText(/Unicode error/)).toBeInTheDocument();
			expect(screen.getByText(/🔥/)).toBeInTheDocument();
		});

		it('should handle error without message', () => {
			const NoMessageComponent = () => {
				throw new Error();
			};

			render(
				<ErrorBoundary>
					<NoMessageComponent />
				</ErrorBoundary>
			);

			expect(screen.getByText('Something went wrong')).toBeInTheDocument();
		});

		it('should handle non-Error objects thrown', () => {
			const StringThrowComponent = () => {
				throw 'String error';
			};

			render(
				<ErrorBoundary>
					<StringThrowComponent />
				</ErrorBoundary>
			);

			// Should still catch and display error UI
			expect(screen.getByText('Something went wrong')).toBeInTheDocument();
		});

		it('should handle multiple sequential errors', () => {
			const onReset = vi.fn();
			let errorMessage = 'First error';

			const SequentialErrorComponent = () => {
				throw new Error(errorMessage);
			};

			const { rerender } = render(
				<ErrorBoundary onReset={onReset}>
					<SequentialErrorComponent />
				</ErrorBoundary>
			);

			expect(screen.getByText(/First error/)).toBeInTheDocument();

			// Reset and throw a new error
			errorMessage = 'Second error';
			fireEvent.click(screen.getByRole('button', { name: /Try Again/i }));

			rerender(
				<ErrorBoundary onReset={onReset}>
					<SequentialErrorComponent />
				</ErrorBoundary>
			);

			expect(screen.getByText(/Second error/)).toBeInTheDocument();
		});
	});

	describe('accessibility', () => {
		it('should have proper heading hierarchy', () => {
			render(
				<ErrorBoundary>
					<ThrowingComponent />
				</ErrorBoundary>
			);

			expect(
				screen.getByRole('heading', { level: 1, name: /Something went wrong/i })
			).toBeInTheDocument();
			expect(screen.getByRole('heading', { level: 2, name: /Error Details/i })).toBeInTheDocument();
		});

		it('should have accessible buttons', () => {
			render(
				<ErrorBoundary>
					<ThrowingComponent />
				</ErrorBoundary>
			);

			const tryAgainButton = screen.getByRole('button', { name: /Try Again/i });
			const reloadButton = screen.getByRole('button', { name: /Reload App/i });

			expect(tryAgainButton).toBeVisible();
			expect(reloadButton).toBeVisible();
		});

		it('should have expandable component stack trace', () => {
			render(
				<ErrorBoundary>
					<ThrowingComponent />
				</ErrorBoundary>
			);

			const details = screen.getByText('Component Stack Trace').closest('details');
			expect(details).toBeInTheDocument();

			// Initially collapsed (no open attribute)
			expect(details).not.toHaveAttribute('open');
		});

		it('should allow keyboard navigation to buttons', () => {
			render(
				<ErrorBoundary>
					<ThrowingComponent />
				</ErrorBoundary>
			);

			const tryAgainButton = screen.getByRole('button', { name: /Try Again/i });
			const reloadButton = screen.getByRole('button', { name: /Reload App/i });

			// Buttons should be focusable (no disabled or negative tabindex)
			expect(tryAgainButton).not.toHaveAttribute('disabled');
			expect(reloadButton).not.toHaveAttribute('disabled');
		});
	});

	describe('constructor and initial state', () => {
		it('should initialize with hasError as false', () => {
			render(
				<ErrorBoundary>
					<NormalComponent />
				</ErrorBoundary>
			);

			// When hasError is false, children are rendered
			expect(screen.getByTestId('normal-content')).toBeInTheDocument();
		});

		it('should initialize with error as null', () => {
			render(
				<ErrorBoundary>
					<NormalComponent />
				</ErrorBoundary>
			);

			// No error details displayed when error is null
			expect(screen.queryByText('Error Details:')).not.toBeInTheDocument();
		});

		it('should initialize with errorInfo as null', () => {
			render(
				<ErrorBoundary>
					<NormalComponent />
				</ErrorBoundary>
			);

			// No component stack trace when errorInfo is null
			expect(screen.queryByText('Component Stack Trace')).not.toBeInTheDocument();
		});
	});

	describe('component lifecycle', () => {
		it('should pass props to constructor', () => {
			const onReset = vi.fn();

			render(
				<ErrorBoundary onReset={onReset} fallbackComponent={<CustomFallback />}>
					<ThrowingComponent />
				</ErrorBoundary>
			);

			// Custom fallback is rendered, proving props were received
			expect(screen.getByTestId('custom-fallback')).toBeInTheDocument();
		});

		it('should preserve error boundary instance across re-renders', () => {
			const { rerender } = render(
				<ErrorBoundary>
					<ThrowingComponent />
				</ErrorBoundary>
			);

			expect(screen.getByText('Something went wrong')).toBeInTheDocument();

			// Re-render without changing error boundary
			rerender(
				<ErrorBoundary>
					<ThrowingComponent />
				</ErrorBoundary>
			);

			// Error state should still be present
			expect(screen.getByText('Something went wrong')).toBeInTheDocument();
		});
	});

	describe('conditional error states', () => {
		it('should handle component that throws conditionally', () => {
			const { rerender } = render(
				<ErrorBoundary>
					<ConditionalThrowingComponent shouldThrow={false} />
				</ErrorBoundary>
			);

			expect(screen.getByTestId('conditional-content')).toBeInTheDocument();

			// Make it throw
			rerender(
				<ErrorBoundary>
					<ConditionalThrowingComponent shouldThrow={true} />
				</ErrorBoundary>
			);

			expect(screen.getByText('Something went wrong')).toBeInTheDocument();
		});

		it('should recover when component stops throwing after reset', () => {
			let shouldThrow = true;

			const ToggleThrowComponent = () => {
				if (shouldThrow) {
					throw new Error('Toggle error');
				}
				return <div data-testid="toggle-content">Toggle content</div>;
			};

			const { rerender } = render(
				<ErrorBoundary>
					<ToggleThrowComponent />
				</ErrorBoundary>
			);

			expect(screen.getByText('Something went wrong')).toBeInTheDocument();

			// Stop throwing
			shouldThrow = false;
			fireEvent.click(screen.getByRole('button', { name: /Try Again/i }));

			rerender(
				<ErrorBoundary>
					<ToggleThrowComponent />
				</ErrorBoundary>
			);

			expect(screen.getByTestId('toggle-content')).toBeInTheDocument();
		});
	});

	describe('error details visibility', () => {
		it('should show error details section when error exists', () => {
			render(
				<ErrorBoundary>
					<ThrowingComponent />
				</ErrorBoundary>
			);

			expect(screen.getByText('Error Details:')).toBeInTheDocument();
		});

		it('should show component stack in details element', () => {
			render(
				<ErrorBoundary>
					<ThrowingComponent />
				</ErrorBoundary>
			);

			const details = screen.getByText('Component Stack Trace').closest('details');
			expect(details).toBeInTheDocument();
		});

		it('should expand component stack trace on click', () => {
			render(
				<ErrorBoundary>
					<ThrowingComponent />
				</ErrorBoundary>
			);

			const summary = screen.getByText('Component Stack Trace');
			fireEvent.click(summary);

			const details = summary.closest('details');
			expect(details).toHaveAttribute('open');
		});
	});

	describe('icon rendering', () => {
		it('should render alert triangle icon', () => {
			render(
				<ErrorBoundary>
					<ThrowingComponent />
				</ErrorBoundary>
			);

			// Icon should be inside the icon container (red background)
			const iconContainer = document.querySelector('.bg-red-500\\/10');
			expect(iconContainer).toBeInTheDocument();

			// SVG icon should be present
			const svg = iconContainer?.querySelector('svg');
			expect(svg).toBeInTheDocument();
		});

		it('should render refresh icon in Try Again button', () => {
			render(
				<ErrorBoundary>
					<ThrowingComponent />
				</ErrorBoundary>
			);

			const tryAgainButton = screen.getByRole('button', { name: /Try Again/i });
			const svg = tryAgainButton.querySelector('svg');
			expect(svg).toBeInTheDocument();
		});

		it('should render home icon in Reload App button', () => {
			render(
				<ErrorBoundary>
					<ThrowingComponent />
				</ErrorBoundary>
			);

			const reloadButton = screen.getByRole('button', { name: /Reload App/i });
			const svg = reloadButton.querySelector('svg');
			expect(svg).toBeInTheDocument();
		});
	});
});
