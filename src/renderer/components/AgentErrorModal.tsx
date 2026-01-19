/**
 * AgentErrorModal - Displays agent errors with recovery options
 *
 * This modal appears when an agent encounters an error such as:
 * - Authentication failure
 * - Token/context exhaustion
 * - Rate limiting
 * - Network errors
 * - Agent crashes
 *
 * The modal provides:
 * - Clear error description with type indicator
 * - Collapsible JSON details viewer for structured error data
 * - Recovery action buttons (re-authenticate, start new session, retry, etc.)
 * - Dismiss option for non-critical errors
 * - Auto-focus on primary recovery action
 */

import React, { useRef, useMemo, useState } from 'react';
import {
	AlertCircle,
	RefreshCw,
	KeyRound,
	MessageSquarePlus,
	Wifi,
	XCircle,
	Clock,
	ShieldAlert,
	ChevronDown,
	ChevronRight,
	Code2,
} from 'lucide-react';
import type { Theme, AgentError, AgentErrorType } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal } from './ui/Modal';
import { CollapsibleJsonViewer } from './CollapsibleJsonViewer';

/**
 * Props for recovery action buttons
 */
export interface RecoveryAction {
	id: string;
	label: string;
	description?: string;
	primary?: boolean;
	icon?: React.ReactNode;
	onClick: () => void;
}

interface AgentErrorModalProps {
	theme: Theme;
	error: AgentError;
	agentName?: string;
	sessionName?: string;
	recoveryActions: RecoveryAction[];
	onDismiss: () => void;
	/** Whether the error can be dismissed (vs. requiring action) */
	dismissible?: boolean;
}

/**
 * Get the icon for an error type
 */
function getErrorIcon(type: AgentErrorType): React.ReactNode {
	switch (type) {
		case 'auth_expired':
			return <KeyRound className="w-6 h-6" />;
		case 'token_exhaustion':
			return <MessageSquarePlus className="w-6 h-6" />;
		case 'rate_limited':
			return <Clock className="w-6 h-6" />;
		case 'network_error':
			return <Wifi className="w-6 h-6" />;
		case 'agent_crashed':
			return <XCircle className="w-6 h-6" />;
		case 'permission_denied':
			return <ShieldAlert className="w-6 h-6" />;
		default:
			return <AlertCircle className="w-6 h-6" />;
	}
}

/**
 * Get a human-readable title for an error type
 */
function getErrorTitle(type: AgentErrorType): string {
	switch (type) {
		case 'auth_expired':
			return 'Authentication Required';
		case 'token_exhaustion':
			return 'Context Limit Reached';
		case 'rate_limited':
			return 'Rate Limit Exceeded';
		case 'network_error':
			return 'Connection Error';
		case 'agent_crashed':
			return 'Agent Error';
		case 'permission_denied':
			return 'Permission Denied';
		default:
			return 'Error';
	}
}

/**
 * Get the error color based on recoverability
 */
function getErrorColor(error: AgentError, theme: Theme): string {
	if (!error.recoverable) {
		return theme.colors.error;
	}
	// Use warning color for recoverable errors
	return theme.colors.warning;
}

export function AgentErrorModal({
	theme,
	error,
	agentName,
	sessionName,
	recoveryActions,
	onDismiss,
	dismissible = true,
}: AgentErrorModalProps) {
	const primaryButtonRef = useRef<HTMLButtonElement>(null);
	const [showJsonDetails, setShowJsonDetails] = useState(false);

	// Find the primary recovery action for initial focus
	const primaryAction = useMemo(
		() => recoveryActions.find((a) => a.primary) || recoveryActions[0],
		[recoveryActions]
	);

	// Check if we have JSON details to show
	const hasJsonDetails = error.parsedJson !== undefined;

	const errorColor = getErrorColor(error, theme);
	const errorIcon = getErrorIcon(error.type);
	const errorTitle = getErrorTitle(error.type);

	return (
		<Modal
			theme={theme}
			title={errorTitle}
			priority={MODAL_PRIORITIES.AGENT_ERROR}
			onClose={onDismiss}
			width={hasJsonDetails && showJsonDetails ? 600 : 480}
			zIndex={10001}
			showCloseButton={dismissible}
			headerIcon={<span style={{ color: errorColor }}>{errorIcon}</span>}
			initialFocusRef={primaryButtonRef}
		>
			{/* Error Details */}
			<div className="space-y-4">
				{/* Agent and session context */}
				{(agentName || sessionName) && (
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						{agentName && <span>{agentName}</span>}
						{agentName && sessionName && <span> • </span>}
						{sessionName && <span>{sessionName}</span>}
					</div>
				)}

				{/* Error message */}
				<p className="text-sm leading-relaxed" style={{ color: theme.colors.textMain }}>
					{error.message}
				</p>

				{/* Timestamp */}
				<div className="text-xs" style={{ color: theme.colors.textDim }}>
					{new Date(error.timestamp).toLocaleTimeString()}
				</div>

				{/* Collapsible JSON Details */}
				{hasJsonDetails && (
					<div className="border rounded" style={{ borderColor: theme.colors.border }}>
						<button
							type="button"
							onClick={() => setShowJsonDetails(!showJsonDetails)}
							className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-white/5 transition-colors rounded"
							style={{ color: theme.colors.textDim }}
						>
							{showJsonDetails ? (
								<ChevronDown className="w-3 h-3" />
							) : (
								<ChevronRight className="w-3 h-3" />
							)}
							<Code2 className="w-3 h-3" />
							<span>Error Details (JSON)</span>
						</button>
						{showJsonDetails && (
							<div className="px-2 pb-2">
								<CollapsibleJsonViewer
									data={error.parsedJson}
									theme={theme}
									initialExpandLevel={2}
									maxStringLength={80}
								/>
							</div>
						)}
					</div>
				)}
			</div>

			{/* Recovery Actions - only show if there are actions */}
			{recoveryActions.length > 0 && (
				<div className="mt-6 space-y-2">
					{recoveryActions.map((action, index) => (
						<button
							key={action.id}
							ref={action.primary || (!primaryAction && index === 0) ? primaryButtonRef : undefined}
							type="button"
							onClick={action.onClick}
							className={`w-full flex items-center gap-3 px-4 py-3 rounded border transition-colors text-left ${
								action.primary ? 'hover:brightness-110' : 'hover:bg-white/5'
							}`}
							style={{
								backgroundColor: action.primary ? theme.colors.accent : 'transparent',
								borderColor: action.primary ? theme.colors.accent : theme.colors.border,
								color: action.primary ? theme.colors.accentForeground : theme.colors.textMain,
							}}
						>
							{action.icon || <RefreshCw className="w-4 h-4 shrink-0" />}
							<div className="flex-1 min-w-0">
								<div className="text-sm font-medium">{action.label}</div>
								{action.description && (
									<div
										className="text-xs mt-0.5 truncate"
										style={{
											color: action.primary
												? `${theme.colors.accentForeground}99`
												: theme.colors.textDim,
										}}
									>
										{action.description}
									</div>
								)}
							</div>
						</button>
					))}
				</div>
			)}

			{/* Dismiss option */}
			{dismissible && (
				<div
					className={recoveryActions.length > 0 ? 'mt-4 pt-4 border-t' : 'mt-6'}
					style={{ borderColor: recoveryActions.length > 0 ? theme.colors.border : undefined }}
				>
					<button
						type="button"
						onClick={onDismiss}
						className="w-full text-center text-sm py-2 rounded hover:bg-white/5 transition-colors"
						style={{ color: theme.colors.textDim }}
					>
						Dismiss
					</button>
				</div>
			)}
		</Modal>
	);
}

export default AgentErrorModal;
