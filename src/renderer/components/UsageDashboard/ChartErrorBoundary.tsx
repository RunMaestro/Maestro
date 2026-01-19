/**
 * ChartErrorBoundary
 *
 * A theme-aware React error boundary specifically designed for Usage Dashboard charts.
 * Catches JavaScript errors in chart components and displays a retry UI.
 *
 * Features:
 * - Theme-aware styling matching the dashboard design
 * - Retry button to re-render the failed component
 * - Error details (collapsed by default)
 * - Compact design suitable for inline chart containers
 * - Accessible error messaging
 */

import React, { Component, ReactNode } from 'react';
import { AlertTriangle, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import type { Theme } from '../../types';
import { logger } from '../../utils/logger';

interface Props {
	children: ReactNode;
	/** Theme for styling the error UI */
	theme: Theme;
	/** Name of the chart for error context (e.g., "Agent Comparison Chart") */
	chartName?: string;
	/** Optional callback when retry is clicked */
	onRetry?: () => void;
}

interface State {
	hasError: boolean;
	error: Error | null;
	showDetails: boolean;
	retryCount: number;
}

/**
 * ChartErrorBoundary catches render errors in chart components and provides
 * a user-friendly error UI with retry functionality.
 *
 * Usage:
 * ```tsx
 * <ChartErrorBoundary theme={theme} chartName="Agent Comparison">
 *   <AgentComparisonChart data={data} theme={theme} />
 * </ChartErrorBoundary>
 * ```
 */
export class ChartErrorBoundary extends Component<Props, State> {
	constructor(props: Props) {
		super(props);
		this.state = {
			hasError: false,
			error: null,
			showDetails: false,
			retryCount: 0,
		};
	}

	static getDerivedStateFromError(error: Error): Partial<State> {
		return {
			hasError: true,
			error,
		};
	}

	componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
		const chartName = this.props.chartName || 'Unknown Chart';

		// Log to structured logger
		logger.error(`Chart Error Boundary: ${chartName} - ${error.message}`, 'ChartErrorBoundary', {
			chartName,
			error: error.toString(),
			stack: error.stack,
			componentStack: errorInfo.componentStack,
		});

		// Also log to console for development
		console.error(`[ChartErrorBoundary] Error in ${chartName}:`, error, errorInfo);
	}

	handleRetry = () => {
		// Increment retry count for tracking
		const newRetryCount = this.state.retryCount + 1;

		// Reset error state to trigger re-render
		this.setState({
			hasError: false,
			error: null,
			showDetails: false,
			retryCount: newRetryCount,
		});

		// Call optional retry callback
		if (this.props.onRetry) {
			this.props.onRetry();
		}
	};

	toggleDetails = () => {
		this.setState((prev) => ({
			showDetails: !prev.showDetails,
		}));
	};

	render() {
		const { theme, chartName, children } = this.props;
		const { hasError, error, showDetails, retryCount } = this.state;

		if (hasError) {
			return (
				<div
					className="flex flex-col items-center justify-center p-6 rounded-lg"
					style={{
						backgroundColor: theme.colors.bgMain,
						minHeight: '200px',
					}}
					role="alert"
					aria-live="polite"
					data-testid="chart-error-boundary"
				>
					{/* Error Icon and Message */}
					<div className="flex items-center gap-3 mb-4">
						<div
							className="p-2 rounded-full"
							style={{ backgroundColor: `${theme.colors.error}20` }}
						>
							<AlertTriangle
								className="w-5 h-5"
								style={{ color: theme.colors.error }}
								aria-hidden="true"
							/>
						</div>
						<div className="text-center">
							<h4 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
								{chartName ? `Failed to render ${chartName}` : 'Chart failed to render'}
							</h4>
							<p className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
								An unexpected error occurred
							</p>
						</div>
					</div>

					{/* Retry Button */}
					<button
						onClick={this.handleRetry}
						className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
						style={{
							backgroundColor: theme.colors.accent,
							color: '#ffffff',
						}}
						onMouseEnter={(e) => {
							e.currentTarget.style.opacity = '0.9';
						}}
						onMouseLeave={(e) => {
							e.currentTarget.style.opacity = '1';
						}}
						data-testid="chart-retry-button"
					>
						<RefreshCw className="w-4 h-4" aria-hidden="true" />
						Retry
					</button>

					{/* Retry Count Indicator */}
					{retryCount > 0 && (
						<p
							className="text-xs mt-2"
							style={{ color: theme.colors.textDim }}
							data-testid="retry-count"
						>
							Retry attempts: {retryCount}
						</p>
					)}

					{/* Collapsible Error Details */}
					{error && (
						<div className="mt-4 w-full max-w-md">
							<button
								onClick={this.toggleDetails}
								className="flex items-center gap-1 text-xs w-full justify-center"
								style={{ color: theme.colors.textDim }}
								data-testid="toggle-error-details"
							>
								{showDetails ? (
									<>
										<ChevronUp className="w-3 h-3" />
										Hide details
									</>
								) : (
									<>
										<ChevronDown className="w-3 h-3" />
										Show details
									</>
								)}
							</button>

							{showDetails && (
								<div
									className="mt-2 p-3 rounded text-xs overflow-auto max-h-32"
									style={{
										backgroundColor: `${theme.colors.border}30`,
										color: theme.colors.textDim,
									}}
									data-testid="error-details"
								>
									<pre className="whitespace-pre-wrap font-mono">
										{error.message}
										{error.stack && (
											<>
												{'\n\n'}
												{error.stack}
											</>
										)}
									</pre>
								</div>
							)}
						</div>
					)}
				</div>
			);
		}

		// Pass a key based on retryCount to force remount on retry
		return <React.Fragment key={retryCount}>{children}</React.Fragment>;
	}
}

export default ChartErrorBoundary;
