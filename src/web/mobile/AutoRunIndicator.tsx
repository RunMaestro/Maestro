/**
 * AutoRunIndicator component for mobile web interface
 *
 * Displays a PROMINENT banner when AutoRun (batch processing) is active on the desktop app.
 * Shows task progress, error-pause recovery actions, and indicates that AI input is read-only.
 * This banner is designed to be highly visible on mobile devices.
 */

import { useState, useCallback } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import type { AutoRunState } from '../hooks/useWebSocket';

interface AutoRunIndicatorProps {
	/** AutoRun state from WebSocket - null when not running */
	state: AutoRunState | null;
	/** Name of the session running AutoRun */
	sessionName?: string;
	/** Handler when the indicator is tapped - opens the full Auto Run panel */
	onTap?: () => void;
	/**
	 * Optional error-recovery handlers. When the run is paused on an error
	 * (state.errorPaused), tapping Resume / Skip / Abort calls these handlers.
	 * Resume is only shown when state.errorRecoverable is not explicitly false.
	 */
	onResume?: () => Promise<unknown> | void;
	onSkipDocument?: () => Promise<unknown> | void;
	onAbort?: () => Promise<unknown> | void;
}

/**
 * AutoRun indicator banner component.
 * Shows task progress when batch processing is active.
 * When the run is paused due to an agent error, surfaces Resume / Skip / Abort
 * buttons mirroring the desktop AutoRunErrorBanner.
 */
export function AutoRunIndicator({
	state,
	sessionName,
	onTap,
	onResume,
	onSkipDocument,
	onAbort,
}: AutoRunIndicatorProps) {
	const colors = useThemeColors();
	const [pendingAction, setPendingAction] = useState<'resume' | 'skip' | 'abort' | null>(null);

	const runAction = useCallback(
		async (action: 'resume' | 'skip' | 'abort', handler?: () => Promise<unknown> | void) => {
			if (!handler || pendingAction) return;
			setPendingAction(action);
			try {
				await handler();
			} finally {
				setPendingAction(null);
			}
		},
		[pendingAction]
	);

	// Don't render if no state or not running
	if (!state?.isRunning) {
		return null;
	}

	const {
		totalTasks,
		completedTasks,
		currentTaskIndex,
		isStopping,
		errorPaused,
		errorMessage,
		errorRecoverable,
		errorTaskDescription,
	} = state;
	const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
	const currentTask = currentTaskIndex + 1;

	// errorPaused takes visual precedence over isStopping — the user can still
	// abort from a paused state, so we want them to see the error context first.
	const bannerColor = errorPaused ? colors.error : isStopping ? colors.warning : colors.accent;
	const badgeTextColor = errorPaused ? colors.error : isStopping ? colors.warning : colors.accent;
	const titleText = errorPaused ? 'Auto Run Paused' : isStopping ? 'Stopping...' : 'AutoRun Active';

	// Compute per-button visibility first so we can gate the wrapper on at
	// least one visible action; otherwise a paused run with only a non-recoverable
	// onResume handler would render an empty actions row.
	const canResume = errorPaused && errorRecoverable !== false && Boolean(onResume);
	const canSkip = errorPaused && Boolean(onSkipDocument);
	const canAbort = errorPaused && Boolean(onAbort);
	const showRecoveryActions = canResume || canSkip || canAbort;

	return (
		<div
			onClick={errorPaused ? undefined : onTap}
			role={onTap && !errorPaused ? 'button' : undefined}
			tabIndex={onTap && !errorPaused ? 0 : undefined}
			onKeyDown={
				onTap && !errorPaused
					? (e) => {
							// Mirror the mouse activation (onTap) for keyboard users.
							// Space also covers the legacy 'Spacebar' value some browsers
							// still emit. preventDefault for Space avoids page scroll.
							if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
								e.preventDefault();
								onTap();
							}
						}
					: undefined
			}
			style={{
				backgroundColor: bannerColor,
				padding: '12px 16px',
				display: 'flex',
				flexDirection: 'column',
				gap: '12px',
				boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
				cursor: onTap && !errorPaused ? 'pointer' : 'default',
				touchAction: onTap && !errorPaused ? 'manipulation' : undefined,
				WebkitTapHighlightColor: onTap && !errorPaused ? 'transparent' : undefined,
			}}
		>
			<div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
				{/* Animated indicator icon - white circle with icon */}
				<div
					style={{
						width: '32px',
						height: '32px',
						borderRadius: '50%',
						backgroundColor: 'rgba(255,255,255,0.25)',
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						flexShrink: 0,
						animation: errorPaused ? undefined : 'autorun-pulse 1.5s ease-in-out infinite',
					}}
				>
					{errorPaused ? (
						// Warning icon
						<svg
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="white"
							strokeWidth="3"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
							<line x1="12" y1="9" x2="12" y2="13" />
							<line x1="12" y1="17" x2="12.01" y2="17" />
						</svg>
					) : isStopping ? (
						// Pause icon (stopping)
						<svg
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="white"
							strokeWidth="3"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<rect x="6" y="4" width="4" height="16" />
							<rect x="14" y="4" width="4" height="16" />
						</svg>
					) : (
						// Play/running icon
						<svg width="16" height="16" viewBox="0 0 24 24" fill="white" stroke="none">
							<polygon points="5,3 19,12 5,21" />
						</svg>
					)}
				</div>

				{/* Status text and progress */}
				<div style={{ flex: 1, minWidth: 0 }}>
					<div
						style={{
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'space-between',
							gap: '8px',
						}}
					>
						<div style={{ minWidth: 0, flex: 1 }}>
							<div
								style={{
									fontSize: '15px',
									fontWeight: 700,
									color: 'white',
									whiteSpace: 'nowrap',
									overflow: 'hidden',
									textOverflow: 'ellipsis',
								}}
							>
								{titleText}
							</div>
							<div
								style={{
									fontSize: '12px',
									color: 'rgba(255,255,255,0.85)',
									marginTop: '2px',
								}}
							>
								{sessionName && <span>{sessionName} - </span>}
								Task {currentTask} of {totalTasks}
								{completedTasks > 0 && ` (${completedTasks} done)`}
							</div>
						</div>

						{/* Progress badge - white with accent text */}
						<div
							style={{
								fontSize: '14px',
								fontWeight: 700,
								color: badgeTextColor,
								backgroundColor: 'white',
								padding: '6px 12px',
								borderRadius: '16px',
								flexShrink: 0,
							}}
						>
							{progress}%
						</div>
					</div>

					{/* Progress bar - white background */}
					<div
						style={{
							height: '6px',
							backgroundColor: 'rgba(255,255,255,0.3)',
							borderRadius: '3px',
							marginTop: '8px',
							overflow: 'hidden',
						}}
					>
						<div
							style={{
								width: `${progress}%`,
								height: '100%',
								backgroundColor: 'white',
								borderRadius: '3px',
								transition: 'width 0.3s ease-out',
							}}
						/>
					</div>
				</div>
			</div>

			{/* Error context + recovery actions */}
			{errorPaused && (
				<div
					style={{
						display: 'flex',
						flexDirection: 'column',
						gap: '8px',
						padding: '10px 12px',
						borderRadius: '8px',
						backgroundColor: 'rgba(255,255,255,0.18)',
					}}
				>
					{(errorMessage || errorTaskDescription) && (
						<div
							style={{
								fontSize: '12px',
								color: 'white',
								lineHeight: 1.4,
							}}
						>
							{errorTaskDescription && (
								<div style={{ fontWeight: 600, marginBottom: '2px' }}>{errorTaskDescription}</div>
							)}
							{errorMessage && (
								<div style={{ opacity: 0.9, wordBreak: 'break-word' }}>{errorMessage}</div>
							)}
						</div>
					)}

					{showRecoveryActions && (
						<div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
							{canResume && (
								<button
									onClick={(e) => {
										e.stopPropagation();
										void runAction('resume', onResume);
									}}
									disabled={pendingAction !== null}
									style={{
										flex: 1,
										minWidth: '90px',
										padding: '8px 10px',
										borderRadius: '8px',
										border: 'none',
										backgroundColor: 'white',
										color: bannerColor,
										fontSize: '13px',
										fontWeight: 600,
										cursor: pendingAction ? 'not-allowed' : 'pointer',
										touchAction: 'manipulation',
										WebkitTapHighlightColor: 'transparent',
									}}
									aria-label="Resume Auto Run after error"
								>
									{pendingAction === 'resume' ? 'Resuming...' : 'Resume'}
								</button>
							)}
							{canSkip && (
								<button
									onClick={(e) => {
										e.stopPropagation();
										void runAction('skip', onSkipDocument);
									}}
									disabled={pendingAction !== null}
									style={{
										flex: 1,
										minWidth: '90px',
										padding: '8px 10px',
										borderRadius: '8px',
										border: '1px solid white',
										backgroundColor: 'transparent',
										color: 'white',
										fontSize: '13px',
										fontWeight: 600,
										cursor: pendingAction ? 'not-allowed' : 'pointer',
										touchAction: 'manipulation',
										WebkitTapHighlightColor: 'transparent',
									}}
									aria-label="Skip current document"
								>
									{pendingAction === 'skip' ? 'Skipping...' : 'Skip Doc'}
								</button>
							)}
							{canAbort && (
								<button
									onClick={(e) => {
										e.stopPropagation();
										void runAction('abort', onAbort);
									}}
									disabled={pendingAction !== null}
									style={{
										flex: 1,
										minWidth: '90px',
										padding: '8px 10px',
										borderRadius: '8px',
										border: '1px solid white',
										backgroundColor: 'transparent',
										color: 'white',
										fontSize: '13px',
										fontWeight: 600,
										cursor: pendingAction ? 'not-allowed' : 'pointer',
										touchAction: 'manipulation',
										WebkitTapHighlightColor: 'transparent',
									}}
									aria-label="Abort Auto Run"
								>
									{pendingAction === 'abort' ? 'Aborting...' : 'Abort'}
								</button>
							)}
						</div>
					)}
				</div>
			)}

			{/* Pulse animation keyframes */}
			<style>{`
        @keyframes autorun-pulse {
          0%, 100% {
            transform: scale(1);
            opacity: 1;
          }
          50% {
            transform: scale(1.15);
            opacity: 0.85;
          }
        }
      `}</style>
		</div>
	);
}

export default AutoRunIndicator;
