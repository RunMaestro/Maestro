/**
 * ConnectionStatusIndicator component for Maestro mobile web
 *
 * A persistent, compact banner that shows connection status and provides
 * retry functionality. Displays as a dismissible banner when connection
 * is lost or reconnecting.
 *
 * Features:
 * - Shows reconnect attempts count
 * - Manual retry button
 * - Auto-hide when connected
 * - Dismissible (can be hidden temporarily)
 * - Haptic feedback on interactions
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { type WebSocketState } from '../hooks/useWebSocket';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';

/**
 * Props for ConnectionStatusIndicator
 */
export interface ConnectionStatusIndicatorProps {
	/** Current WebSocket connection state */
	connectionState: WebSocketState;
	/** Whether the device is offline (no network) */
	isOffline: boolean;
	/** Number of reconnection attempts made */
	reconnectAttempts: number;
	/** Maximum reconnection attempts before giving up */
	maxReconnectAttempts?: number;
	/** Error message if connection failed */
	error?: string | null;
	/** Callback to trigger manual reconnection */
	onRetry: () => void;
	/** Optional custom styles */
	style?: React.CSSProperties;
}

/**
 * Connection status configuration
 */
interface StatusConfig {
	message: string;
	subMessage?: string;
	showRetry: boolean;
	icon: string;
	bgColor: string;
	borderColor: string;
	pulse: boolean;
}

/**
 * Icon components for status states
 */
const WifiOffIcon = () => (
	<svg
		width="20"
		height="20"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<line x1="1" y1="1" x2="23" y2="23" />
		<path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
		<path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
		<path d="M10.71 5.05A16 16 0 0 1 22.58 9" />
		<path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
		<path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
		<line x1="12" y1="20" x2="12.01" y2="20" />
	</svg>
);

const DisconnectIcon = () => (
	<svg
		width="20"
		height="20"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
		<polyline points="16 17 21 12 16 7" />
		<line x1="21" y1="12" x2="9" y2="12" />
	</svg>
);

const LoadingIcon = () => (
	<svg
		width="20"
		height="20"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
		className="animate-spin"
	>
		<line x1="12" y1="2" x2="12" y2="6" />
		<line x1="12" y1="18" x2="12" y2="22" />
		<line x1="4.93" y1="4.93" x2="7.76" y2="7.76" />
		<line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
		<line x1="2" y1="12" x2="6" y2="12" />
		<line x1="18" y1="12" x2="22" y2="12" />
		<line x1="4.93" y1="19.07" x2="7.76" y2="16.24" />
		<line x1="16.24" y1="7.76" x2="19.07" y2="4.93" />
	</svg>
);

const RetryIcon = () => (
	<svg
		width="16"
		height="16"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<polyline points="23 4 23 10 17 10" />
		<path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
	</svg>
);

const CloseIcon = () => (
	<svg
		width="16"
		height="16"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<line x1="18" y1="6" x2="6" y2="18" />
		<line x1="6" y1="6" x2="18" y2="18" />
	</svg>
);

/**
 * ConnectionStatusIndicator component
 *
 * Displays a banner showing the current connection status with retry functionality.
 * Only visible when not connected (disconnected, connecting, or offline).
 *
 * @example
 * ```tsx
 * <ConnectionStatusIndicator
 *   connectionState="disconnected"
 *   isOffline={false}
 *   reconnectAttempts={3}
 *   maxReconnectAttempts={10}
 *   error="Connection refused"
 *   onRetry={() => connect()}
 * />
 * ```
 */
export function ConnectionStatusIndicator({
	connectionState,
	isOffline,
	reconnectAttempts,
	maxReconnectAttempts = 10,
	error,
	onRetry,
	style,
}: ConnectionStatusIndicatorProps) {
	const colors = useThemeColors();
	const [isDismissed, setIsDismissed] = useState(false);
	const [showDetails, setShowDetails] = useState(false);

	// Reset dismissed state when connection state changes
	useEffect(() => {
		// Show indicator again if state changes to disconnected
		if (connectionState === 'disconnected' && !isOffline) {
			setIsDismissed(false);
		}
	}, [connectionState, isOffline]);

	// Handle retry button click
	// NOTE: All hooks must be called before any early returns (React rules of hooks)
	const handleRetry = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		onRetry();
	}, [onRetry]);

	// Handle dismiss button click
	const handleDismiss = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setIsDismissed(true);
	}, []);

	// Toggle details expansion
	const handleToggleDetails = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setShowDetails((prev) => !prev);
	}, []);

	// Don't render if connected/authenticated or dismissed
	const isConnected = connectionState === 'connected' || connectionState === 'authenticated';
	if (
		isConnected ||
		(isDismissed && connectionState !== 'connecting' && connectionState !== 'authenticating')
	) {
		return null;
	}

	// Get status configuration based on current state
	const getStatusConfig = (): StatusConfig => {
		if (isOffline) {
			return {
				message: 'No internet connection',
				subMessage: 'Will reconnect automatically when online',
				showRetry: false,
				icon: 'wifi-off',
				bgColor: `${colors.error}15`,
				borderColor: colors.error,
				pulse: false,
			};
		}

		if (connectionState === 'connecting' || connectionState === 'authenticating') {
			const attemptText =
				reconnectAttempts > 0
					? `Attempt ${reconnectAttempts} of ${maxReconnectAttempts}`
					: 'Establishing connection...';
			return {
				message: connectionState === 'connecting' ? 'Connecting...' : 'Authenticating...',
				subMessage: attemptText,
				showRetry: reconnectAttempts > 2, // Show retry after a few attempts
				icon: 'loading',
				bgColor: '#f9731615', // Orange with transparency
				borderColor: '#f97316',
				pulse: true,
			};
		}

		if (connectionState === 'disconnected') {
			const isMaxAttemptsReached = reconnectAttempts >= maxReconnectAttempts;
			return {
				message: isMaxAttemptsReached ? 'Connection failed' : 'Disconnected',
				subMessage:
					error ||
					(isMaxAttemptsReached
						? `Failed after ${maxReconnectAttempts} attempts`
						: 'Tap retry to reconnect'),
				showRetry: true,
				icon: 'disconnect',
				bgColor: `${colors.error}15`,
				borderColor: colors.error,
				pulse: false,
			};
		}

		// Fallback
		return {
			message: 'Unknown state',
			showRetry: true,
			icon: 'disconnect',
			bgColor: `${colors.warning}15`,
			borderColor: colors.warning,
			pulse: false,
		};
	};

	const statusConfig = getStatusConfig();

	// Render the appropriate icon
	const renderIcon = () => {
		switch (statusConfig.icon) {
			case 'wifi-off':
				return <WifiOffIcon />;
			case 'loading':
				return <LoadingIcon />;
			case 'disconnect':
			default:
				return <DisconnectIcon />;
		}
	};

	return (
		<div
			role="alert"
			aria-live="polite"
			style={{
				position: 'fixed',
				top: 'max(56px, calc(56px + env(safe-area-inset-top)))', // Below header
				left: '8px',
				right: '8px',
				zIndex: 100,
				backgroundColor: statusConfig.bgColor,
				borderRadius: '12px',
				border: `1px solid ${statusConfig.borderColor}`,
				padding: '12px',
				boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
				animation: statusConfig.pulse ? 'pulse 2s ease-in-out infinite' : undefined,
				transition: 'all 0.3s ease',
				...style,
			}}
		>
			{/* Main content row */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: '12px',
				}}
			>
				{/* Icon */}
				<div
					style={{
						color: statusConfig.borderColor,
						flexShrink: 0,
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
					}}
				>
					{renderIcon()}
				</div>

				{/* Message content */}
				<div
					style={{
						flex: 1,
						minWidth: 0,
					}}
					onClick={handleToggleDetails}
					role="button"
					tabIndex={0}
					aria-expanded={showDetails}
				>
					<div
						style={{
							fontSize: '14px',
							fontWeight: 600,
							color: colors.textMain,
							marginBottom: statusConfig.subMessage ? '2px' : 0,
						}}
					>
						{statusConfig.message}
					</div>
					{statusConfig.subMessage && (
						<div
							style={{
								fontSize: '12px',
								color: colors.textDim,
								overflow: 'hidden',
								textOverflow: 'ellipsis',
								whiteSpace: showDetails ? 'normal' : 'nowrap',
							}}
						>
							{statusConfig.subMessage}
						</div>
					)}
				</div>

				{/* Action buttons */}
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						gap: '8px',
						flexShrink: 0,
					}}
				>
					{/* Retry button */}
					{statusConfig.showRetry && (
						<button
							onClick={handleRetry}
							style={{
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'center',
								gap: '4px',
								padding: '6px 12px',
								borderRadius: '8px',
								backgroundColor: colors.accent,
								color: '#ffffff',
								fontSize: '13px',
								fontWeight: 600,
								border: 'none',
								cursor: 'pointer',
								whiteSpace: 'nowrap',
							}}
							aria-label="Retry connection"
						>
							<RetryIcon />
							Retry
						</button>
					)}

					{/* Dismiss button - only show when disconnected (not while connecting) */}
					{connectionState === 'disconnected' && !isOffline && (
						<button
							onClick={handleDismiss}
							style={{
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'center',
								padding: '6px',
								borderRadius: '6px',
								backgroundColor: 'transparent',
								color: colors.textDim,
								border: 'none',
								cursor: 'pointer',
							}}
							aria-label="Dismiss notification"
						>
							<CloseIcon />
						</button>
					)}
				</div>
			</div>

			{/* Expanded details section */}
			{showDetails && error && (
				<div
					style={{
						marginTop: '12px',
						paddingTop: '12px',
						borderTop: `1px solid ${colors.border}`,
					}}
				>
					<div
						style={{
							fontSize: '12px',
							color: colors.textDim,
							marginBottom: '4px',
						}}
					>
						Error details:
					</div>
					<div
						style={{
							fontSize: '12px',
							color: colors.error,
							backgroundColor: `${colors.error}10`,
							padding: '8px',
							borderRadius: '6px',
							fontFamily: 'monospace',
							wordBreak: 'break-word',
						}}
					>
						{error}
					</div>
				</div>
			)}

			{/* CSS animation for pulse effect */}
			<style>
				{`
          @keyframes pulse {
            0%, 100% {
              opacity: 1;
            }
            50% {
              opacity: 0.8;
            }
          }
        `}
			</style>
		</div>
	);
}

export default ConnectionStatusIndicator;
