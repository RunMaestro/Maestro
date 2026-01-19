/**
 * TransferErrorModal - Modal for handling cross-agent transfer errors
 *
 * Displays when a context transfer operation fails and provides recovery options:
 * - Retry: Attempt the transfer again
 * - Skip Grooming: Retry without AI-powered context grooming
 * - Cancel: Abandon the transfer operation
 *
 * Handles specific error types:
 * - Target agent not installed → Show install instructions
 * - Target agent busy → Offer to queue or wait
 * - Grooming timeout → Offer to skip grooming
 * - Context too large → Offer to summarize further
 *
 * Based on AgentErrorModal patterns, adapted for transfer-specific errors.
 */

import React, { useRef, useMemo } from 'react';
import {
	AlertCircle,
	RefreshCw,
	Zap,
	XCircle,
	Clock,
	Download,
	Loader2,
	HardDrive,
	ArrowRight,
} from 'lucide-react';
import type { Theme, ToolType } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal } from './ui/Modal';
import { getAgentDisplayName } from '../services/contextGroomer';

/**
 * Types of transfer errors that can occur
 */
export type TransferErrorType =
	| 'agent_not_installed' // Target agent is not installed/configured
	| 'agent_busy' // Target agent has active sessions in busy state
	| 'grooming_timeout' // AI grooming operation timed out
	| 'grooming_failed' // AI grooming operation failed
	| 'context_too_large' // Context exceeds target agent's limits
	| 'session_creation_failed' // Failed to create new session
	| 'source_not_found' // Source tab/session not found
	| 'network_error' // Network connectivity issues
	| 'cancelled' // User cancelled the operation
	| 'unknown'; // Unrecognized error

/**
 * Structured transfer error information
 */
export interface TransferError {
	/** The category of error */
	type: TransferErrorType;
	/** Human-readable error message */
	message: string;
	/** Whether the error is recoverable */
	recoverable: boolean;
	/** Source agent type */
	sourceAgent?: ToolType;
	/** Target agent type */
	targetAgent?: ToolType;
	/** Original error for debugging */
	originalError?: string;
	/** Timestamp when the error occurred */
	timestamp: number;
	/** Additional context-specific details */
	details?: {
		/** For context_too_large: estimated tokens */
		estimatedTokens?: number;
		/** For context_too_large: target limit */
		targetLimit?: number;
		/** For grooming_timeout: elapsed time in ms */
		elapsedTimeMs?: number;
		/** For agent_busy: number of busy sessions */
		busySessions?: number;
		/** For agent_not_installed: install instructions */
		installInstructions?: string;
	};
}

/**
 * Props for TransferErrorModal
 */
export interface TransferErrorModalProps {
	theme: Theme;
	isOpen: boolean;
	error: TransferError;
	/** Callback to retry the transfer operation */
	onRetry: () => void;
	/** Callback to retry without grooming */
	onSkipGrooming: () => void;
	/** Callback to cancel and close the modal */
	onCancel: () => void;
	/** Whether a retry is currently in progress */
	isRetrying?: boolean;
}

/**
 * Get the appropriate icon for an error type
 */
function getErrorIcon(type: TransferErrorType): React.ReactNode {
	switch (type) {
		case 'agent_not_installed':
			return <Download className="w-6 h-6" />;
		case 'agent_busy':
			return <Loader2 className="w-6 h-6" />;
		case 'grooming_timeout':
		case 'grooming_failed':
			return <Clock className="w-6 h-6" />;
		case 'context_too_large':
			return <HardDrive className="w-6 h-6" />;
		case 'session_creation_failed':
			return <XCircle className="w-6 h-6" />;
		case 'network_error':
			return <AlertCircle className="w-6 h-6" />;
		default:
			return <AlertCircle className="w-6 h-6" />;
	}
}

/**
 * Get a human-readable title for an error type
 */
function getErrorTitle(type: TransferErrorType): string {
	switch (type) {
		case 'agent_not_installed':
			return 'Agent Not Available';
		case 'agent_busy':
			return 'Agent Busy';
		case 'grooming_timeout':
			return 'Grooming Timed Out';
		case 'grooming_failed':
			return 'Grooming Failed';
		case 'context_too_large':
			return 'Context Too Large';
		case 'session_creation_failed':
			return 'Session Creation Failed';
		case 'source_not_found':
			return 'Source Not Found';
		case 'network_error':
			return 'Connection Error';
		case 'cancelled':
			return 'Transfer Cancelled';
		default:
			return 'Transfer Error';
	}
}

/**
 * Determine which recovery actions are available based on error type
 */
function getAvailableActions(error: TransferError): {
	canRetry: boolean;
	canSkipGrooming: boolean;
	retryLabel: string;
	retryDescription?: string;
	skipGroomingLabel?: string;
	skipGroomingDescription?: string;
} {
	switch (error.type) {
		case 'agent_not_installed':
			return {
				canRetry: false,
				canSkipGrooming: false,
				retryLabel: 'Retry',
			};

		case 'agent_busy':
			return {
				canRetry: true,
				canSkipGrooming: false,
				retryLabel: 'Retry Now',
				retryDescription: 'Try again immediately',
			};

		case 'grooming_timeout':
			return {
				canRetry: true,
				canSkipGrooming: true,
				retryLabel: 'Retry with Grooming',
				retryDescription: 'Try grooming again',
				skipGroomingLabel: 'Skip Grooming',
				skipGroomingDescription: 'Transfer raw context without optimization',
			};

		case 'grooming_failed':
			return {
				canRetry: true,
				canSkipGrooming: true,
				retryLabel: 'Retry Grooming',
				retryDescription: 'Attempt to groom the context again',
				skipGroomingLabel: 'Skip Grooming',
				skipGroomingDescription: 'Transfer raw context without AI optimization',
			};

		case 'context_too_large':
			return {
				canRetry: false,
				canSkipGrooming: true,
				retryLabel: 'Retry',
				skipGroomingLabel: 'Try with Grooming',
				skipGroomingDescription: 'Use AI to summarize and reduce context size',
			};

		case 'session_creation_failed':
			return {
				canRetry: true,
				canSkipGrooming: false,
				retryLabel: 'Retry',
				retryDescription: 'Try creating the session again',
			};

		case 'network_error':
			return {
				canRetry: true,
				canSkipGrooming: false,
				retryLabel: 'Retry',
				retryDescription: 'Check connection and try again',
			};

		case 'source_not_found':
		case 'cancelled':
			return {
				canRetry: false,
				canSkipGrooming: false,
				retryLabel: 'Retry',
			};

		default:
			return {
				canRetry: true,
				canSkipGrooming: false,
				retryLabel: 'Retry',
				retryDescription: 'Try the transfer again',
			};
	}
}

/**
 * Format details for display
 */
function formatDetails(error: TransferError): string | null {
	const { details } = error;
	if (!details) return null;

	const parts: string[] = [];

	if (details.estimatedTokens && details.targetLimit) {
		parts.push(
			`Context size: ~${details.estimatedTokens.toLocaleString()} tokens (limit: ${details.targetLimit.toLocaleString()})`
		);
	}

	if (details.elapsedTimeMs) {
		const seconds = Math.round(details.elapsedTimeMs / 1000);
		parts.push(`Elapsed time: ${seconds}s`);
	}

	if (details.busySessions) {
		parts.push(
			`${details.busySessions} session${details.busySessions > 1 ? 's' : ''} currently active`
		);
	}

	return parts.length > 0 ? parts.join(' • ') : null;
}

/**
 * TransferErrorModal Component
 */
export function TransferErrorModal({
	theme,
	isOpen: _isOpen,
	error,
	onRetry,
	onSkipGrooming,
	onCancel,
	isRetrying = false,
}: TransferErrorModalProps) {
	const primaryButtonRef = useRef<HTMLButtonElement>(null);

	// Determine available actions
	const actions = useMemo(() => getAvailableActions(error), [error]);

	// Format agent names for display
	const sourceAgentName = error.sourceAgent
		? getAgentDisplayName(error.sourceAgent)
		: 'Source Agent';
	const targetAgentName = error.targetAgent
		? getAgentDisplayName(error.targetAgent)
		: 'Target Agent';

	// Format error details
	const detailsText = useMemo(() => formatDetails(error), [error]);

	// Error display color based on recoverability
	const errorColor = error.recoverable ? theme.colors.warning : theme.colors.error;

	// Install instructions for agent_not_installed
	const installInstructions =
		error.details?.installInstructions ||
		(error.type === 'agent_not_installed'
			? `Please install ${targetAgentName} and try again.`
			: null);

	return (
		<Modal
			theme={theme}
			title={getErrorTitle(error.type)}
			priority={MODAL_PRIORITIES.TRANSFER_ERROR}
			onClose={onCancel}
			width={500}
			zIndex={9999}
			showCloseButton={true}
			headerIcon={<span style={{ color: errorColor }}>{getErrorIcon(error.type)}</span>}
			initialFocusRef={primaryButtonRef}
		>
			{/* Agent Transfer Context */}
			{(error.sourceAgent || error.targetAgent) && (
				<div
					className="flex items-center justify-center gap-2 mb-4 pb-4 border-b"
					style={{ borderColor: theme.colors.border }}
				>
					{error.sourceAgent && (
						<span
							className="text-xs font-medium px-2 py-1 rounded"
							style={{
								backgroundColor: theme.colors.bgMain,
								color: theme.colors.textDim,
							}}
						>
							{sourceAgentName}
						</span>
					)}
					<ArrowRight className="w-4 h-4" style={{ color: theme.colors.textDim }} />
					{error.targetAgent && (
						<span
							className="text-xs font-medium px-2 py-1 rounded"
							style={{
								backgroundColor: `${errorColor}20`,
								color: errorColor,
							}}
						>
							{targetAgentName}
						</span>
					)}
				</div>
			)}

			{/* Error Message */}
			<div className="space-y-3">
				<p className="text-sm leading-relaxed" style={{ color: theme.colors.textMain }}>
					{error.message}
				</p>

				{/* Details */}
				{detailsText && (
					<div
						className="text-xs px-3 py-2 rounded"
						style={{
							backgroundColor: theme.colors.bgMain,
							color: theme.colors.textDim,
						}}
					>
						{detailsText}
					</div>
				)}

				{/* Install Instructions */}
				{installInstructions && (
					<div
						className="text-xs px-3 py-2 rounded border-l-2"
						style={{
							backgroundColor: `${theme.colors.accent}10`,
							borderColor: theme.colors.accent,
							color: theme.colors.textMain,
						}}
					>
						{installInstructions}
					</div>
				)}

				{/* Timestamp */}
				<div className="text-xs" style={{ color: theme.colors.textDim }}>
					{new Date(error.timestamp).toLocaleTimeString()}
				</div>
			</div>

			{/* Recovery Actions */}
			<div className="mt-6 space-y-2">
				{/* Skip Grooming (secondary, shown first if available for grooming errors) */}
				{actions.canSkipGrooming && error.type !== 'context_too_large' && (
					<button
						type="button"
						onClick={onSkipGrooming}
						disabled={isRetrying}
						className="w-full flex items-center gap-3 px-4 py-3 rounded border transition-colors hover:bg-white/5 disabled:opacity-50"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					>
						<Zap className="w-4 h-4 shrink-0" style={{ color: theme.colors.warning }} />
						<div className="flex-1 min-w-0 text-left">
							<div className="text-sm font-medium">
								{actions.skipGroomingLabel || 'Skip Grooming'}
							</div>
							{actions.skipGroomingDescription && (
								<div className="text-xs mt-0.5 truncate" style={{ color: theme.colors.textDim }}>
									{actions.skipGroomingDescription}
								</div>
							)}
						</div>
					</button>
				)}

				{/* Retry (primary action) */}
				{actions.canRetry && (
					<button
						ref={primaryButtonRef}
						type="button"
						onClick={onRetry}
						disabled={isRetrying}
						className="w-full flex items-center gap-3 px-4 py-3 rounded border transition-colors hover:brightness-110 disabled:opacity-50"
						style={{
							backgroundColor: theme.colors.accent,
							borderColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
					>
						{isRetrying ? (
							<Loader2 className="w-4 h-4 shrink-0 animate-spin" />
						) : (
							<RefreshCw className="w-4 h-4 shrink-0" />
						)}
						<div className="flex-1 min-w-0 text-left">
							<div className="text-sm font-medium">
								{isRetrying ? 'Retrying...' : actions.retryLabel}
							</div>
							{actions.retryDescription && !isRetrying && (
								<div
									className="text-xs mt-0.5 truncate"
									style={{ color: `${theme.colors.accentForeground}99` }}
								>
									{actions.retryDescription}
								</div>
							)}
						</div>
					</button>
				)}

				{/* Context too large: Skip grooming is actually "enable grooming" to summarize */}
				{error.type === 'context_too_large' && actions.canSkipGrooming && (
					<button
						ref={primaryButtonRef}
						type="button"
						onClick={onSkipGrooming}
						disabled={isRetrying}
						className="w-full flex items-center gap-3 px-4 py-3 rounded border transition-colors hover:brightness-110 disabled:opacity-50"
						style={{
							backgroundColor: theme.colors.accent,
							borderColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
					>
						<Zap className="w-4 h-4 shrink-0" />
						<div className="flex-1 min-w-0 text-left">
							<div className="text-sm font-medium">
								{actions.skipGroomingLabel || 'Summarize Context'}
							</div>
							{actions.skipGroomingDescription && (
								<div
									className="text-xs mt-0.5 truncate"
									style={{ color: `${theme.colors.accentForeground}99` }}
								>
									{actions.skipGroomingDescription}
								</div>
							)}
						</div>
					</button>
				)}
			</div>

			{/* Cancel Button */}
			<div className="mt-4 pt-4 border-t" style={{ borderColor: theme.colors.border }}>
				<button
					type="button"
					onClick={onCancel}
					disabled={isRetrying}
					className="w-full text-center text-sm py-2 rounded hover:bg-white/5 transition-colors disabled:opacity-50"
					style={{ color: theme.colors.textDim }}
				>
					Cancel
				</button>
			</div>
		</Modal>
	);
}

export default TransferErrorModal;

/**
 * Helper function to classify an error message into a TransferErrorType
 */
export function classifyTransferError(
	errorMessage: string,
	context?: {
		sourceAgent?: ToolType;
		targetAgent?: ToolType;
		wasGrooming?: boolean;
		elapsedTimeMs?: number;
	}
): TransferError {
	const normalizedMessage = errorMessage.toLowerCase();

	// Source not found (check first to avoid matching as agent_not_installed)
	if (
		(normalizedMessage.includes('source') && normalizedMessage.includes('not found')) ||
		(normalizedMessage.includes('source') && normalizedMessage.includes('missing')) ||
		normalizedMessage.includes('source tab not found')
	) {
		return {
			type: 'source_not_found',
			message: `The source tab or session could not be found. It may have been closed.`,
			recoverable: false,
			sourceAgent: context?.sourceAgent,
			targetAgent: context?.targetAgent,
			timestamp: Date.now(),
		};
	}

	// Agent not installed/available
	if (
		normalizedMessage.includes('not installed') ||
		normalizedMessage.includes('not found') ||
		normalizedMessage.includes('not available') ||
		normalizedMessage.includes('unavailable')
	) {
		return {
			type: 'agent_not_installed',
			message: `The target agent is not installed or configured.`,
			recoverable: false,
			sourceAgent: context?.sourceAgent,
			targetAgent: context?.targetAgent,
			timestamp: Date.now(),
		};
	}

	// Agent busy
	if (
		normalizedMessage.includes('busy') ||
		normalizedMessage.includes('in use') ||
		normalizedMessage.includes('active session')
	) {
		return {
			type: 'agent_busy',
			message: `The target agent is currently processing another request. Please wait and try again.`,
			recoverable: true,
			sourceAgent: context?.sourceAgent,
			targetAgent: context?.targetAgent,
			timestamp: Date.now(),
		};
	}

	// Grooming timeout
	if (
		(normalizedMessage.includes('timeout') || normalizedMessage.includes('timed out')) &&
		(context?.wasGrooming || normalizedMessage.includes('groom'))
	) {
		return {
			type: 'grooming_timeout',
			message: `Context grooming took too long and timed out. You can retry or skip grooming to transfer the raw context.`,
			recoverable: true,
			sourceAgent: context?.sourceAgent,
			targetAgent: context?.targetAgent,
			timestamp: Date.now(),
			details: context?.elapsedTimeMs ? { elapsedTimeMs: context.elapsedTimeMs } : undefined,
		};
	}

	// Grooming failed
	if (
		normalizedMessage.includes('grooming failed') ||
		(normalizedMessage.includes('groom') && normalizedMessage.includes('failed'))
	) {
		return {
			type: 'grooming_failed',
			message: `Failed to groom the context. You can retry or skip grooming to transfer the raw context.`,
			recoverable: true,
			sourceAgent: context?.sourceAgent,
			targetAgent: context?.targetAgent,
			timestamp: Date.now(),
		};
	}

	// Context too large
	if (
		normalizedMessage.includes('too large') ||
		normalizedMessage.includes('context limit') ||
		normalizedMessage.includes('exceeds') ||
		normalizedMessage.includes('token limit')
	) {
		return {
			type: 'context_too_large',
			message: `The context is too large for the target agent. Try enabling grooming to automatically summarize and reduce the context size.`,
			recoverable: true,
			sourceAgent: context?.sourceAgent,
			targetAgent: context?.targetAgent,
			timestamp: Date.now(),
		};
	}

	// Session creation failed
	if (
		normalizedMessage.includes('session') &&
		(normalizedMessage.includes('create') || normalizedMessage.includes('failed'))
	) {
		return {
			type: 'session_creation_failed',
			message: `Failed to create a new session for the target agent. Please try again.`,
			recoverable: true,
			sourceAgent: context?.sourceAgent,
			targetAgent: context?.targetAgent,
			timestamp: Date.now(),
		};
	}

	// Network error
	if (
		normalizedMessage.includes('network') ||
		normalizedMessage.includes('connection') ||
		normalizedMessage.includes('offline')
	) {
		return {
			type: 'network_error',
			message: `A network error occurred. Please check your connection and try again.`,
			recoverable: true,
			sourceAgent: context?.sourceAgent,
			targetAgent: context?.targetAgent,
			timestamp: Date.now(),
		};
	}

	// Cancelled
	if (normalizedMessage.includes('cancel')) {
		return {
			type: 'cancelled',
			message: `The transfer was cancelled.`,
			recoverable: false,
			sourceAgent: context?.sourceAgent,
			targetAgent: context?.targetAgent,
			timestamp: Date.now(),
		};
	}

	// Unknown/default
	return {
		type: 'unknown',
		message: errorMessage || 'An unexpected error occurred during the transfer.',
		recoverable: true,
		sourceAgent: context?.sourceAgent,
		targetAgent: context?.targetAgent,
		originalError: errorMessage,
		timestamp: Date.now(),
	};
}
