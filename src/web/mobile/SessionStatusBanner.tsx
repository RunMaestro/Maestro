/**
 * SessionStatusBanner component for Maestro mobile web interface
 *
 * Displays a compact status banner showing the current session's key information.
 * Positioned below the header/session pill bar, this provides at-a-glance
 * visibility into what the active session is doing.
 *
 * Features:
 * - Session name and working directory (truncated)
 * - Color-coded status indicator
 * - Thinking indicator when AI is processing
 * - Elapsed time display while AI is thinking (mm:ss or hh:mm:ss)
 * - Token count display (total tokens, compact format for mobile)
 * - Cost tracker showing session spend
 * - Context window usage bar
 * - Collapsible last response preview (first 3 lines)
 * - Share button to copy last response to clipboard
 * - Compact design optimized for mobile viewports
 */

import React, { useState, useCallback, useEffect, memo } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { StatusDot, type SessionStatus } from '../components/Badge';
import type { Session, UsageStats, LastResponsePreview } from '../hooks/useSessions';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import { webLogger } from '../utils/logger';
import {
	formatRelativeTime,
	formatCost,
	formatElapsedTimeColon,
	truncatePath,
} from '../../shared/formatters';
import { stripAnsiCodes } from '../../shared/stringUtils';
// SYNC: Uses estimateContextUsage() from shared/contextUsage.ts
// See that file for the canonical formula and all locations that must stay in sync.
import { estimateContextUsage } from '../../shared/contextUsage';

/**
 * Props for SessionStatusBanner component
 */
export interface SessionStatusBannerProps {
	/** The currently active session to display */
	session: Session | null;
	/** Optional className for additional styling */
	className?: string;
	/** Optional inline styles */
	style?: React.CSSProperties;
	/** Callback when user taps to expand the full response (for task 1.30) */
	onExpandResponse?: (lastResponse: LastResponsePreview) => void;
}

/**
 * CostTracker component - displays session cost in a compact format
 */
function CostTracker({ usageStats }: { usageStats?: UsageStats | null }) {
	const colors = useThemeColors();

	// Don't render if no usage stats or no cost data
	if (!usageStats || usageStats.totalCostUsd === undefined || usageStats.totalCostUsd === null) {
		return null;
	}

	const cost = usageStats.totalCostUsd;

	return (
		<span
			style={{
				display: 'inline-flex',
				alignItems: 'center',
				gap: '3px',
				fontSize: '11px',
				fontWeight: 500,
				color: colors.textDim,
				backgroundColor: `${colors.textDim}15`,
				padding: '2px 6px',
				borderRadius: '4px',
				lineHeight: 1,
				flexShrink: 0,
			}}
			title={`Session cost: ${formatCost(cost)}`}
			aria-label={`Session cost: ${formatCost(cost)}`}
		>
			{/* Dollar icon using Unicode */}
			<span style={{ fontSize: '10px' }}>💰</span>
			<span>{formatCost(cost)}</span>
		</span>
	);
}

/**
 * Get color for context usage bar based on percentage
 * Green for low usage, yellow for medium, red for high
 */
function getContextBarColor(percentage: number, colors: ReturnType<typeof useThemeColors>): string {
	if (percentage >= 90) return colors.error;
	if (percentage >= 70) return colors.warning;
	return colors.success;
}

/**
 * ContextUsageBar component - displays context window usage as a progress bar
 * Shows a visual indicator of how much of the context window has been used.
 */
function ContextUsageBar({
	usageStats,
	toolType,
}: {
	usageStats?: UsageStats | null;
	toolType?: string;
}) {
	const colors = useThemeColors();

	const percentage = usageStats ? estimateContextUsage(usageStats, toolType) : null;

	// Don't render if we can't calculate percentage
	if (percentage === null) {
		return null;
	}

	const barColor = getContextBarColor(percentage, colors);

	return (
		<div
			style={{
				display: 'flex',
				alignItems: 'center',
				gap: '4px',
				flexShrink: 0,
			}}
			title={`Context window: ${percentage}% used`}
			aria-label={`Context window ${percentage}% used`}
			role="progressbar"
			aria-valuenow={percentage}
			aria-valuemin={0}
			aria-valuemax={100}
		>
			{/* Progress bar container */}
			<div
				style={{
					width: '40px',
					height: '6px',
					backgroundColor: `${colors.textDim}20`,
					borderRadius: '3px',
					overflow: 'hidden',
				}}
			>
				{/* Progress bar fill */}
				<div
					style={{
						width: `${percentage}%`,
						height: '100%',
						backgroundColor: barColor,
						borderRadius: '3px',
						transition: 'width 0.3s ease-out, background-color 0.3s ease-out',
					}}
				/>
			</div>
			{/* Percentage label */}
			<span
				style={{
					fontSize: '10px',
					fontWeight: 500,
					color: colors.textDim,
					minWidth: '28px',
					textAlign: 'right',
				}}
			>
				{percentage}%
			</span>
		</div>
	);
}

/**
 * Thinking animation component - three dots that animate in sequence
 */
function ThinkingIndicator() {
	const colors = useThemeColors();

	return (
		<span
			style={{
				display: 'inline-flex',
				alignItems: 'center',
				gap: '2px',
				marginLeft: '4px',
			}}
			aria-label="AI is thinking"
		>
			{[0, 1, 2].map((index) => (
				<span
					key={index}
					style={{
						width: '4px',
						height: '4px',
						borderRadius: '50%',
						backgroundColor: colors.warning,
						animation: `thinkingBounce 1.4s infinite ease-in-out both`,
						animationDelay: `${index * 0.16}s`,
					}}
				/>
			))}
			<style>{`
        @keyframes thinkingBounce {
          0%, 80%, 100% {
            transform: scale(0.6);
            opacity: 0.5;
          }
          40% {
            transform: scale(1);
            opacity: 1;
          }
        }
      `}</style>
		</span>
	);
}

/**
 * ElapsedTimeDisplay component - shows live elapsed time while AI is thinking
 * Displays time in mm:ss or hh:mm:ss format, updating every second.
 */
const ElapsedTimeDisplay = memo(function ElapsedTimeDisplay({
	thinkingStartTime,
}: {
	thinkingStartTime: number;
}) {
	const colors = useThemeColors();
	const [elapsedSeconds, setElapsedSeconds] = useState(
		Math.floor((Date.now() - thinkingStartTime) / 1000)
	);

	useEffect(() => {
		// Update immediately with current value
		setElapsedSeconds(Math.floor((Date.now() - thinkingStartTime) / 1000));

		// Update every second
		const interval = setInterval(() => {
			setElapsedSeconds(Math.floor((Date.now() - thinkingStartTime) / 1000));
		}, 1000);

		return () => clearInterval(interval);
	}, [thinkingStartTime]);

	return (
		<span
			style={{
				display: 'inline-flex',
				alignItems: 'center',
				gap: '3px',
				fontSize: '11px',
				fontWeight: 600,
				fontFamily: 'monospace',
				color: colors.warning,
				backgroundColor: `${colors.warning}15`,
				padding: '2px 6px',
				borderRadius: '4px',
				lineHeight: 1,
				flexShrink: 0,
			}}
			title={`Thinking for ${formatElapsedTimeColon(elapsedSeconds)}`}
			aria-label={`AI has been thinking for ${formatElapsedTimeColon(elapsedSeconds)}`}
		>
			<span style={{ fontSize: '10px' }}>⏱</span>
			<span>{formatElapsedTimeColon(elapsedSeconds)}</span>
		</span>
	);
});

/**
 * TokenCount component - displays total token count in a compact format
 * Shows total tokens (input + output) for mobile-friendly display.
 */
function TokenCount({ usageStats }: { usageStats?: UsageStats | null }) {
	const colors = useThemeColors();

	// Don't render if no usage stats or no token data
	if (!usageStats) {
		return null;
	}

	const inputTokens = usageStats.inputTokens ?? 0;
	const outputTokens = usageStats.outputTokens ?? 0;
	const totalTokens = inputTokens + outputTokens;

	// Don't show if no tokens yet
	if (totalTokens === 0) {
		return null;
	}

	// Format with K suffix for thousands
	const formatTokens = (count: number): string => {
		if (count >= 1000000) {
			return `${(count / 1000000).toFixed(1)}M`;
		}
		if (count >= 1000) {
			return `${(count / 1000).toFixed(1)}K`;
		}
		return count.toString();
	};

	return (
		<span
			style={{
				display: 'inline-flex',
				alignItems: 'center',
				gap: '3px',
				fontSize: '11px',
				fontWeight: 500,
				color: colors.textDim,
				backgroundColor: `${colors.textDim}15`,
				padding: '2px 6px',
				borderRadius: '4px',
				lineHeight: 1,
				flexShrink: 0,
			}}
			title={`Input: ${inputTokens.toLocaleString('en-US')} | Output: ${outputTokens.toLocaleString('en-US')} | Total: ${totalTokens.toLocaleString('en-US')} tokens`}
			aria-label={`${totalTokens.toLocaleString('en-US')} tokens used`}
		>
			<span style={{ fontSize: '10px' }}>📊</span>
			<span>{formatTokens(totalTokens)}</span>
		</span>
	);
}

// formatRelativeTime imported from ../../shared/formatters

/**
 * Props for LastResponsePreviewSection component
 */
interface LastResponsePreviewSectionProps {
	lastResponse: LastResponsePreview | null | undefined;
	isExpanded: boolean;
	onToggle: () => void;
	onExpand?: (lastResponse: LastResponsePreview) => void;
	/** Callback when share/copy button is pressed */
	onShare?: (text: string) => void;
}

/**
 * LastResponsePreviewSection component
 *
 * Displays a collapsible preview of the last AI response.
 * Shows first 3 lines with option to expand to full response viewer.
 * Includes share button to copy response text to clipboard.
 */
function LastResponsePreviewSection({
	lastResponse,
	isExpanded,
	onToggle,
	onExpand,
	onShare,
}: LastResponsePreviewSectionProps) {
	const colors = useThemeColors();
	const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');

	// Don't render if no last response
	if (!lastResponse || !lastResponse.text) {
		return null;
	}

	const hasMoreContent = lastResponse.fullLength > lastResponse.text.length;

	/**
	 * Handle share/copy button click
	 * Copies the response text to clipboard and provides visual feedback
	 */
	const handleShare = async (e: React.MouseEvent) => {
		e.stopPropagation(); // Prevent toggling the collapsible section

		const textToCopy = lastResponse.text;

		try {
			// Try using the Clipboard API
			if (navigator.clipboard && navigator.clipboard.writeText) {
				await navigator.clipboard.writeText(textToCopy);
			} else {
				// Fallback for older browsers
				const textArea = document.createElement('textarea');
				textArea.value = textToCopy;
				textArea.style.position = 'fixed';
				textArea.style.left = '-9999px';
				textArea.style.top = '-9999px';
				document.body.appendChild(textArea);
				textArea.focus();
				textArea.select();
				document.execCommand('copy');
				document.body.removeChild(textArea);
			}

			// Success feedback
			setCopyState('copied');
			triggerHaptic(HAPTIC_PATTERNS.success);

			// Notify parent if callback provided
			onShare?.(textToCopy);

			// Reset state after 2 seconds
			setTimeout(() => setCopyState('idle'), 2000);
		} catch (err) {
			// Error feedback
			setCopyState('error');
			triggerHaptic(HAPTIC_PATTERNS.error);
			webLogger.error('Failed to copy to clipboard', 'SessionStatusBanner', err);

			// Reset state after 2 seconds
			setTimeout(() => setCopyState('idle'), 2000);
		}
	};

	return (
		<div
			style={{
				borderTop: `1px solid ${colors.border}`,
				backgroundColor: `${colors.bgSidebar}80`,
			}}
		>
			{/* Collapsible header */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					width: '100%',
					padding: '8px 16px',
				}}
			>
				{/* Toggle button - takes most of the space */}
				<button
					onClick={onToggle}
					style={{
						display: 'flex',
						alignItems: 'center',
						flex: 1,
						backgroundColor: 'transparent',
						border: 'none',
						cursor: 'pointer',
						color: colors.textDim,
						fontSize: '11px',
						fontWeight: 500,
						textAlign: 'left',
						padding: 0,
					}}
					aria-expanded={isExpanded}
					aria-label={isExpanded ? 'Collapse last response' : 'Expand last response'}
				>
					<span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
						{/* Chevron icon */}
						<span
							style={{
								display: 'inline-block',
								transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
								transition: 'transform 0.2s ease',
								fontSize: '10px',
							}}
						>
							▶
						</span>
						<span>Last Response</span>
						<span style={{ opacity: 0.7 }}>({formatRelativeTime(lastResponse.timestamp)})</span>
					</span>
				</button>

				{/* Right side: char count and share button */}
				<div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
					{hasMoreContent && !isExpanded && (
						<span style={{ opacity: 0.7, fontSize: '10px', color: colors.textDim }}>
							{lastResponse.fullLength} chars
						</span>
					)}

					{/* Share/Copy button */}
					<button
						onClick={handleShare}
						style={{
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							padding: '4px 8px',
							backgroundColor:
								copyState === 'copied'
									? `${colors.success}20`
									: copyState === 'error'
										? `${colors.error}20`
										: `${colors.textDim}15`,
							border: 'none',
							borderRadius: '4px',
							cursor: 'pointer',
							color:
								copyState === 'copied'
									? colors.success
									: copyState === 'error'
										? colors.error
										: colors.textDim,
							fontSize: '10px',
							fontWeight: 500,
							gap: '4px',
							transition: 'background-color 0.2s ease, color 0.2s ease',
							minWidth: '54px', // Prevent layout shift between states
						}}
						aria-label={
							copyState === 'copied'
								? 'Copied to clipboard'
								: copyState === 'error'
									? 'Failed to copy'
									: 'Copy response to clipboard'
						}
						title="Copy response to clipboard"
					>
						{copyState === 'copied' ? (
							<>
								<span aria-hidden="true">✓</span>
								<span>Copied</span>
							</>
						) : copyState === 'error' ? (
							<>
								<span aria-hidden="true">✗</span>
								<span>Failed</span>
							</>
						) : (
							<>
								{/* Share/Copy icon */}
								<span aria-hidden="true" style={{ fontSize: '11px' }}>
									📋
								</span>
								<span>Copy</span>
							</>
						)}
					</button>
				</div>
			</div>

			{/* Expandable content */}
			{isExpanded && (
				<div
					style={{
						padding: '0 16px 12px 16px',
					}}
				>
					{/* Preview text */}
					<div
						onClick={() => onExpand?.(lastResponse)}
						style={{
							fontFamily: 'monospace',
							fontSize: '11px',
							lineHeight: 1.4,
							color: colors.textMain,
							backgroundColor: colors.bgMain,
							padding: '10px 12px',
							borderRadius: '6px',
							border: `1px solid ${colors.border}`,
							whiteSpace: 'pre-wrap',
							wordBreak: 'break-word',
							maxHeight: '120px',
							overflow: 'hidden',
							cursor: onExpand ? 'pointer' : 'default',
							position: 'relative',
						}}
						role={onExpand ? 'button' : undefined}
						tabIndex={onExpand ? 0 : undefined}
						aria-label={onExpand ? 'Tap to view full response' : undefined}
					>
						{stripAnsiCodes(lastResponse.text)}

						{/* Fade gradient at bottom if there's more content */}
						{hasMoreContent && (
							<div
								style={{
									position: 'absolute',
									bottom: 0,
									left: 0,
									right: 0,
									height: '40px',
									background: `linear-gradient(transparent, ${colors.bgMain})`,
									pointerEvents: 'none',
								}}
							/>
						)}
					</div>

					{/* Tap to expand hint */}
					{hasMoreContent && onExpand && (
						<div
							style={{
								marginTop: '6px',
								textAlign: 'center',
								fontSize: '10px',
								color: colors.textDim,
								opacity: 0.8,
							}}
						>
							Tap to view full response
						</div>
					)}
				</div>
			)}
		</div>
	);
}

/**
 * SessionStatusBanner component
 *
 * Renders a compact banner showing the active session's status.
 * Designed to sit directly below the header/session pill bar.
 *
 * @example
 * ```tsx
 * <SessionStatusBanner session={activeSession} />
 * ```
 */
export function SessionStatusBanner({
	session,
	className = '',
	style,
	onExpandResponse,
}: SessionStatusBannerProps) {
	const colors = useThemeColors();
	const [isResponseExpanded, setIsResponseExpanded] = useState(false);

	// Toggle handler for the collapsible last response preview
	const handleToggleResponse = useCallback(() => {
		setIsResponseExpanded((prev) => !prev);
	}, []);

	// Don't render if no session is selected
	if (!session) {
		return null;
	}

	const sessionState = (session.state as string) || 'idle';
	const status: SessionStatus =
		sessionState === 'idle' ||
		sessionState === 'busy' ||
		sessionState === 'connecting' ||
		sessionState === 'error'
			? (sessionState as SessionStatus)
			: 'error';
	const isThinking = sessionState === 'busy';
	const truncatedCwd = truncatePath(session.cwd, 30);

	// Access lastResponse and thinkingStartTime from session (if available from web data)
	const lastResponse = (session as any).lastResponse as LastResponsePreview | undefined;
	const thinkingStartTime = (session as any).thinkingStartTime as number | undefined;

	return (
		<div
			className={className}
			style={{
				display: 'flex',
				flexDirection: 'column',
				backgroundColor: colors.bgMain,
				borderBottom: `1px solid ${colors.border}`,
				...style,
			}}
			role="status"
			aria-live="polite"
			aria-label={`Current session: ${session.name}, status: ${status}`}
		>
			{/* Main status row */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					padding: '10px 16px',
				}}
			>
				{/* Left side: Session name and working directory */}
				<div
					style={{
						display: 'flex',
						flexDirection: 'column',
						gap: '2px',
						flex: 1,
						minWidth: 0, // Allow text truncation
					}}
				>
					{/* Session name */}
					<div
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: '8px',
						}}
					>
						<span
							style={{
								fontSize: '14px',
								fontWeight: 600,
								color: colors.textMain,
								overflow: 'hidden',
								textOverflow: 'ellipsis',
								whiteSpace: 'nowrap',
							}}
						>
							{session.name}
						</span>

						{/* Mode indicator */}
						<span
							style={{
								fontSize: '10px',
								fontWeight: 600,
								color: session.inputMode === 'ai' ? colors.accent : colors.textDim,
								backgroundColor:
									session.inputMode === 'ai' ? `${colors.accent}20` : `${colors.textDim}20`,
								padding: '2px 5px',
								borderRadius: '4px',
								lineHeight: 1,
								flexShrink: 0,
							}}
						>
							{session.inputMode === 'ai' ? 'AI' : 'Terminal'}
						</span>

						{/* Cost tracker */}
						<CostTracker usageStats={session.usageStats} />

						{/* Token count (compact, total only for mobile) */}
						<TokenCount usageStats={session.usageStats} />

						{/* Elapsed time when thinking */}
						{isThinking && thinkingStartTime && (
							<ElapsedTimeDisplay thinkingStartTime={thinkingStartTime} />
						)}

						{/* Context usage bar */}
						<ContextUsageBar usageStats={session.usageStats} toolType={session.toolType} />
					</div>

					{/* Working directory */}
					<span
						style={{
							fontSize: '11px',
							color: colors.textDim,
							fontFamily: 'monospace',
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							whiteSpace: 'nowrap',
						}}
						title={session.cwd}
					>
						{truncatedCwd}
					</span>
				</div>

				{/* Right side: Session ID pill + Status indicator */}
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						gap: '8px',
						flexShrink: 0,
						paddingLeft: '12px',
					}}
				>
					{/* Session ID pill */}
					<span
						style={{
							fontSize: '9px',
							fontFamily: 'monospace',
							color: colors.textDim,
							backgroundColor: `${colors.textDim}15`,
							padding: '2px 6px',
							borderRadius: '4px',
							letterSpacing: '0.5px',
						}}
						title={`Session ID: ${session.id}`}
					>
						{session.id.slice(0, 8)}
					</span>

					{/* Status dot only (no text for idle) */}
					<div
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: '4px',
						}}
					>
						<StatusDot status={status} size="sm" />
						{isThinking && <ThinkingIndicator />}
					</div>
				</div>
			</div>

			{/* Collapsible last response preview */}
			<LastResponsePreviewSection
				lastResponse={lastResponse}
				isExpanded={isResponseExpanded}
				onToggle={handleToggleResponse}
				onExpand={onExpandResponse}
			/>
		</div>
	);
}

export default SessionStatusBanner;
