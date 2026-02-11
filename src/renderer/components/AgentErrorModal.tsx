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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addHeaderEntry(headers: Record<string, string>, key: string, value: unknown): void {
	if (typeof value === 'string' || typeof value === 'number') {
		headers[key.toLowerCase()] = String(value);
	}
}

function collectHeadersFromContainer(headers: Record<string, string>, container: unknown): void {
	if (isRecord(container)) {
		for (const [hKey, hValue] of Object.entries(container)) {
			addHeaderEntry(headers, hKey, hValue);
		}
		return;
	}

	if (Array.isArray(container)) {
		for (const entry of container) {
			if (Array.isArray(entry) && entry.length >= 2 && typeof entry[0] === 'string') {
				addHeaderEntry(headers, entry[0], entry[1]);
			} else if (isRecord(entry) && typeof entry.key === 'string') {
				addHeaderEntry(headers, entry.key, entry.value);
			}
		}
	}
}

function isHeaderContainerKey(keyLower: string): boolean {
	return (
		keyLower === 'headers' ||
		keyLower === 'responseheaders' ||
		keyLower === 'response_headers' ||
		keyLower === 'httpheaders' ||
		keyLower === 'http_headers' ||
		keyLower.endsWith('_headers') ||
		keyLower.endsWith('-headers')
	);
}

function collectHeaderMaps(parsedJson: unknown): Record<string, string> {
	const headers: Record<string, string> = {};

	const stack: Array<{ value: unknown; depth: number }> = [{ value: parsedJson, depth: 0 }];
	const seen = new Set<object>();

	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) break;

		const { value, depth } = current;
		if (depth > 6 || value === null || value === undefined) continue;

		if (Array.isArray(value)) {
			for (const item of value) {
				stack.push({ value: item, depth: depth + 1 });
			}
			continue;
		}

		if (!isRecord(value)) continue;
		if (seen.has(value)) continue;
		seen.add(value);

		for (const [key, child] of Object.entries(value)) {
			if (isHeaderContainerKey(key.toLowerCase())) {
				collectHeadersFromContainer(headers, child);
			}

			stack.push({ value: child, depth: depth + 1 });
		}
	}

	return headers;
}

function parseFiniteInt(value: string | undefined): number | null {
	if (!value) return null;
	const normalized = value.trim();
	if (!/^-?\d+$/.test(normalized)) return null;
	const n = Number(normalized);
	return Number.isSafeInteger(n) ? n : null;
}

function formatResetValue(raw: string | undefined): string | null {
	if (!raw) return null;
	const v = raw.trim();
	if (!v) return null;

	// Duration formats (e.g., "30s", "120ms", "2m", "1h")
	const durationMatch = v.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
	if (durationMatch) {
		const amount = Number(durationMatch[1]);
		const unit = durationMatch[2].toLowerCase();
		if (!Number.isFinite(amount)) return v;
		const seconds =
			unit === 'ms' ? amount / 1000 : unit === 'm' ? amount * 60 : unit === 'h' ? amount * 3600 : amount;
		const rounded = Math.max(0, Math.round(seconds));
		return `in ${rounded}s`;
	}

	// Plain seconds (common for reset values)
	if (/^\d{1,9}$/.test(v)) {
		return `in ${parseInt(v, 10)}s`;
	}

	// Epoch seconds/ms
	if (/^\d{10,}$/.test(v)) {
		const asNumber = Number(v);
		const ms = asNumber > 1e12 ? asNumber : asNumber > 1e9 ? asNumber * 1000 : asNumber;
		const d = new Date(ms);
		if (!Number.isNaN(d.getTime())) {
			return `at ${d.toLocaleTimeString()}`;
		}
	}

	// ISO-8601 timestamps
	if (/[a-z]/i.test(v) || v.includes('-') || v.includes('T') || v.includes(':') || v.includes(',')) {
		const d = new Date(v);
		if (!Number.isNaN(d.getTime())) {
			return `at ${d.toLocaleTimeString()}`;
		}
	}

	return v;
}

function extractRateLimitInfoLines(parsedJson: unknown): string[] {
	if (parsedJson === undefined || parsedJson === null) return [];

	const headers = collectHeaderMaps(parsedJson);
	const getHeader = (...names: string[]) => {
		for (const name of names) {
			const v = headers[name.toLowerCase()];
			if (v !== undefined) return v;
		}
		return undefined;
	};

	const retryAfterRaw = getHeader('retry-after');
	const retryAfter = parseFiniteInt(retryAfterRaw);
	const retryAfterFormatted = retryAfter === null ? formatResetValue(retryAfterRaw) : null;

	const requestsRemaining = parseFiniteInt(
		getHeader('x-ratelimit-remaining-requests', 'anthropic-ratelimit-requests-remaining')
	);
	const requestsLimit = parseFiniteInt(
		getHeader('x-ratelimit-limit-requests', 'anthropic-ratelimit-requests-limit')
	);
	const requestsReset = formatResetValue(
		getHeader('x-ratelimit-reset-requests', 'anthropic-ratelimit-requests-reset')
	);

	const tokensRemaining = parseFiniteInt(
		getHeader('x-ratelimit-remaining-tokens', 'anthropic-ratelimit-tokens-remaining')
	);
	const tokensLimit = parseFiniteInt(getHeader('x-ratelimit-limit-tokens', 'anthropic-ratelimit-tokens-limit'));
	const tokensReset = formatResetValue(getHeader('x-ratelimit-reset-tokens', 'anthropic-ratelimit-tokens-reset'));

	const lines: string[] = [];
	if (retryAfter !== null) {
		lines.push(`Retry after: ${retryAfter}s`);
	} else if (retryAfterFormatted) {
		lines.push(`Retry after: ${retryAfterFormatted}`);
	}

	if (requestsRemaining !== null || requestsLimit !== null) {
		const remainingText = requestsRemaining !== null ? `${requestsRemaining}` : '?';
		const limitText = requestsLimit !== null ? `${requestsLimit}` : '?';
		lines.push(`Requests: ${remainingText}/${limitText}${requestsReset ? ` (${requestsReset})` : ''}`);
	} else if (requestsReset) {
		lines.push(`Requests reset: ${requestsReset}`);
	}

	if (tokensRemaining !== null || tokensLimit !== null) {
		const remainingText = tokensRemaining !== null ? `${tokensRemaining.toLocaleString('en-US')}` : '?';
		const limitText = tokensLimit !== null ? `${tokensLimit.toLocaleString('en-US')}` : '?';
		lines.push(`Tokens: ${remainingText}/${limitText}${tokensReset ? ` (${tokensReset})` : ''}`);
	} else if (tokensReset) {
		lines.push(`Tokens reset: ${tokensReset}`);
	}

	return lines;
}

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
	const rateLimitInfoLines = useMemo(
		() => (error.type === 'rate_limited' ? extractRateLimitInfoLines(error.parsedJson) : []),
		[error.type, error.parsedJson]
	);

	const errorColor = getErrorColor(error, theme);
	const errorIcon = getErrorIcon(error.type);
	const errorTitle =
		error.type === 'rate_limited' && !error.recoverable
			? 'Usage Limit Reached'
			: getErrorTitle(error.type);

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

				{/* Rate limit details (when available in provider error JSON) */}
				{rateLimitInfoLines.length > 0 && (
					<div
						className="text-xs border rounded px-3 py-2 space-y-1"
						style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
					>
						<div className="font-medium" style={{ color: theme.colors.textMain }}>
							Rate limit info
						</div>
						{rateLimitInfoLines.map((line, idx) => (
							<div key={`${idx}:${line}`}>{line}</div>
						))}
					</div>
				)}

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
