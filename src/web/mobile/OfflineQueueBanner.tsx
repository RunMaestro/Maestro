/**
 * OfflineQueueBanner - Displays status of offline queued commands
 *
 * Shows a banner when there are commands waiting to be sent,
 * with options to view, clear, or manually retry the queue.
 *
 * Features:
 * - Shows count of queued commands
 * - Progress indicator during processing
 * - Options to clear or retry queue
 * - Expandable list of queued commands
 * - Haptic feedback on interactions
 */

import { useState, useCallback } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { Badge } from '../components/Badge';
import type { QueuedCommand, QueueStatus } from '../hooks/useOfflineQueue';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import { formatRelativeTime, truncateCommand } from '../../shared/formatters';

export interface OfflineQueueBannerProps {
	/** Queued commands */
	queue: QueuedCommand[];
	/** Current queue processing status */
	status: QueueStatus;
	/** Callback to clear all queued commands */
	onClearQueue: () => void;
	/** Callback to manually process the queue */
	onProcessQueue: () => void;
	/** Callback to remove a specific command */
	onRemoveCommand: (commandId: string) => void;
	/** Whether the device is offline */
	isOffline: boolean;
	/** Whether connected to server */
	isConnected: boolean;
}

export function OfflineQueueBanner({
	queue,
	status,
	onClearQueue,
	onProcessQueue,
	onRemoveCommand,
	isOffline,
	isConnected,
}: OfflineQueueBannerProps) {
	const colors = useThemeColors();
	const [isExpanded, setIsExpanded] = useState(false);

	const isProcessing = status === 'processing';
	const canRetry = !isOffline && isConnected && status !== 'processing';

	const handleToggleExpand = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setIsExpanded((prev) => !prev);
	}, []);

	const handleClear = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		onClearQueue();
	}, [onClearQueue]);

	const handleRetry = useCallback(() => {
		if (canRetry) {
			triggerHaptic(HAPTIC_PATTERNS.tap);
			onProcessQueue();
		}
	}, [canRetry, onProcessQueue]);

	const handleRemoveCommand = useCallback(
		(commandId: string) => {
			triggerHaptic(HAPTIC_PATTERNS.tap);
			onRemoveCommand(commandId);
		},
		[onRemoveCommand]
	);

	// Don't show if queue is empty
	if (queue.length === 0) {
		return null;
	}

	return (
		<div
			style={{
				margin: '8px 16px',
				padding: '12px',
				borderRadius: '12px',
				backgroundColor: isOffline ? `${colors.warning}15` : `${colors.accent}15`,
				border: `1px solid ${isOffline ? colors.warning : colors.accent}40`,
			}}
		>
			{/* Header row */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					gap: '8px',
				}}
			>
				{/* Queue icon and count */}
				<button
					onClick={handleToggleExpand}
					style={{
						display: 'flex',
						alignItems: 'center',
						gap: '8px',
						background: 'none',
						border: 'none',
						padding: 0,
						cursor: 'pointer',
						WebkitTapHighlightColor: 'transparent',
					}}
				>
					{/* Queue/clock icon */}
					<svg
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						stroke={isOffline ? colors.warning : colors.accent}
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<circle cx="12" cy="12" r="10" />
						<polyline points="12 6 12 12 16 14" />
					</svg>

					<span
						style={{
							fontSize: '14px',
							fontWeight: 500,
							color: colors.textMain,
						}}
					>
						{queue.length} command{queue.length !== 1 ? 's' : ''} queued
					</span>

					{/* Processing indicator */}
					{isProcessing && (
						<Badge variant="connecting" badgeStyle="subtle" size="sm" pulse>
							Sending...
						</Badge>
					)}

					{/* Expand/collapse indicator */}
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke={colors.textDim}
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
						style={{
							transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
							transition: 'transform 200ms ease',
						}}
					>
						<polyline points="6 9 12 15 18 9" />
					</svg>
				</button>

				{/* Action buttons */}
				<div style={{ display: 'flex', gap: '8px' }}>
					{/* Retry button - only show when connected */}
					{canRetry && (
						<button
							onClick={handleRetry}
							style={{
								padding: '6px 12px',
								borderRadius: '6px',
								backgroundColor: colors.accent,
								color: '#fff',
								fontSize: '12px',
								fontWeight: 500,
								border: 'none',
								cursor: 'pointer',
								WebkitTapHighlightColor: 'transparent',
							}}
						>
							Send Now
						</button>
					)}

					{/* Clear button */}
					<button
						onClick={handleClear}
						disabled={isProcessing}
						style={{
							padding: '6px 12px',
							borderRadius: '6px',
							backgroundColor: 'transparent',
							color: colors.textDim,
							fontSize: '12px',
							fontWeight: 500,
							border: `1px solid ${colors.border}`,
							cursor: isProcessing ? 'not-allowed' : 'pointer',
							opacity: isProcessing ? 0.5 : 1,
							WebkitTapHighlightColor: 'transparent',
						}}
					>
						Clear
					</button>
				</div>
			</div>

			{/* Status message */}
			<p
				style={{
					fontSize: '12px',
					color: colors.textDim,
					marginTop: '6px',
					marginBottom: 0,
				}}
			>
				{isOffline
					? 'Commands will be sent when you reconnect.'
					: isProcessing
						? 'Sending queued commands...'
						: 'Commands ready to send.'}
			</p>

			{/* Expanded queue list */}
			{isExpanded && (
				<div
					style={{
						marginTop: '12px',
						borderTop: `1px solid ${colors.border}`,
						paddingTop: '12px',
					}}
				>
					<div
						style={{
							display: 'flex',
							flexDirection: 'column',
							gap: '8px',
							maxHeight: '200px',
							overflowY: 'auto',
						}}
					>
						{queue.map((cmd) => (
							<div
								key={cmd.id}
								style={{
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'space-between',
									gap: '8px',
									padding: '8px',
									borderRadius: '6px',
									backgroundColor: colors.bgMain,
								}}
							>
								{/* Command info */}
								<div style={{ flex: 1, minWidth: 0 }}>
									<div
										style={{
											fontSize: '13px',
											color: colors.textMain,
											fontFamily: 'monospace',
											overflow: 'hidden',
											textOverflow: 'ellipsis',
											whiteSpace: 'nowrap',
										}}
									>
										{truncateCommand(cmd.command)}
									</div>
									<div
										style={{
											fontSize: '11px',
											color: colors.textDim,
											marginTop: '2px',
										}}
									>
										{formatRelativeTime(cmd.timestamp)}
										{cmd.attempts > 0 &&
											` - ${cmd.attempts} attempt${cmd.attempts !== 1 ? 's' : ''}`}
										{cmd.lastError && (
											<span style={{ color: colors.error }}> - {cmd.lastError}</span>
										)}
									</div>
								</div>

								{/* Mode badge */}
								<Badge
									variant={cmd.inputMode === 'ai' ? 'default' : 'info'}
									badgeStyle="subtle"
									size="sm"
								>
									{cmd.inputMode === 'ai' ? 'AI' : 'CLI'}
								</Badge>

								{/* Remove button */}
								<button
									onClick={() => handleRemoveCommand(cmd.id)}
									disabled={isProcessing}
									style={{
										padding: '4px',
										borderRadius: '4px',
										backgroundColor: 'transparent',
										border: 'none',
										cursor: isProcessing ? 'not-allowed' : 'pointer',
										opacity: isProcessing ? 0.5 : 1,
										WebkitTapHighlightColor: 'transparent',
									}}
									aria-label="Remove command"
								>
									<svg
										width="16"
										height="16"
										viewBox="0 0 24 24"
										fill="none"
										stroke={colors.textDim}
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<line x1="18" y1="6" x2="6" y2="18" />
										<line x1="6" y1="6" x2="18" y2="18" />
									</svg>
								</button>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

export default OfflineQueueBanner;
