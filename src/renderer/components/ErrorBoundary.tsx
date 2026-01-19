import React, { Component, ReactNode } from 'react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';
import * as Sentry from '@sentry/electron/renderer';
import { logger } from '../utils/logger';

interface Props {
	children: ReactNode;
	fallbackComponent?: ReactNode;
	onReset?: () => void;
}

interface State {
	hasError: boolean;
	error: Error | null;
	errorInfo: React.ErrorInfo | null;
}

/**
 * ErrorBoundary component catches JavaScript errors anywhere in the child component tree,
 * logs those errors, and displays a fallback UI instead of crashing the entire app.
 *
 * Usage:
 * ```tsx
 * <ErrorBoundary>
 *   <YourComponent />
 * </ErrorBoundary>
 * ```
 */
export class ErrorBoundary extends Component<Props, State> {
	constructor(props: Props) {
		super(props);
		this.state = {
			hasError: false,
			error: null,
			errorInfo: null,
		};
	}

	static getDerivedStateFromError(error: Error): State {
		// Update state so the next render will show the fallback UI
		return {
			hasError: true,
			error,
			errorInfo: null,
		};
	}

	componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
		// Log error details to structured logger
		logger.error(`React Error Boundary: ${error.message}`, 'ErrorBoundary', {
			error: error.toString(),
			stack: error.stack,
			componentStack: errorInfo.componentStack,
		});

		// Report to Sentry with component stack context
		Sentry.captureException(error, {
			extra: {
				componentStack: errorInfo.componentStack,
			},
		});

		// Also log to console for debugging
		console.error('ErrorBoundary caught an error:', error, errorInfo);

		// Update state with error info
		this.setState({
			error,
			errorInfo,
		});
	}

	handleReset = () => {
		// Reset error state
		this.setState({
			hasError: false,
			error: null,
			errorInfo: null,
		});

		// Call optional reset handler
		if (this.props.onReset) {
			this.props.onReset();
		}
	};

	handleReload = () => {
		// Reload the entire app
		window.location.reload();
	};

	render() {
		if (this.state.hasError) {
			// If a custom fallback is provided, use it
			if (this.props.fallbackComponent) {
				return this.props.fallbackComponent;
			}

			// Default error UI
			return (
				<div className="flex items-center justify-center min-h-screen bg-gray-900 text-gray-100 p-6">
					<div className="max-w-2xl w-full bg-gray-800 rounded-lg shadow-xl p-8">
						<div className="flex items-start gap-4 mb-6">
							<div className="flex-shrink-0 bg-red-500/10 p-3 rounded-lg">
								<AlertTriangle className="w-8 h-8 text-red-500" />
							</div>
							<div className="flex-1">
								<h1 className="text-2xl font-bold mb-2 text-red-400">Something went wrong</h1>
								<p className="text-gray-300">
									An unexpected error occurred in the application. You can try to recover or reload
									the app.
								</p>
							</div>
						</div>

						{this.state.error && (
							<div className="mb-6">
								<h2 className="text-sm font-semibold text-gray-400 mb-2">Error Details:</h2>
								<div className="bg-gray-900 rounded p-4 overflow-auto max-h-40">
									<pre className="text-xs text-red-300 font-mono whitespace-pre-wrap">
										{this.state.error.toString()}
									</pre>
								</div>
							</div>
						)}

						{this.state.errorInfo && (
							<details className="mb-6">
								<summary className="text-sm font-semibold text-gray-400 cursor-pointer hover:text-gray-300">
									Component Stack Trace
								</summary>
								<div className="bg-gray-900 rounded p-4 overflow-auto max-h-60 mt-2">
									<pre className="text-xs text-gray-400 font-mono whitespace-pre-wrap">
										{this.state.errorInfo.componentStack}
									</pre>
								</div>
							</details>
						)}

						<div className="flex gap-3">
							<button
								onClick={this.handleReset}
								className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
							>
								<RefreshCw className="w-4 h-4" />
								Try Again
							</button>
							<button
								onClick={this.handleReload}
								className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
							>
								<Home className="w-4 h-4" />
								Reload App
							</button>
						</div>
					</div>
				</div>
			);
		}

		return this.props.children;
	}
}
