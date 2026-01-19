/**
 * AutoRunIndicator component for mobile web interface
 *
 * Displays a PROMINENT banner when AutoRun (batch processing) is active on the desktop app.
 * Shows task progress and indicates that AI input is in read-only mode.
 * This banner is designed to be highly visible on mobile devices.
 */

import { useThemeColors } from '../components/ThemeProvider';
import type { AutoRunState } from '../hooks/useWebSocket';

interface AutoRunIndicatorProps {
	/** AutoRun state from WebSocket - null when not running */
	state: AutoRunState | null;
	/** Name of the session running AutoRun */
	sessionName?: string;
}

/**
 * AutoRun indicator banner component
 * Shows task progress when batch processing is active
 * PROMINENT: Uses bold colors and large text for visibility
 */
export function AutoRunIndicator({ state, sessionName }: AutoRunIndicatorProps) {
	const colors = useThemeColors();

	// Don't render if no state or not running
	if (!state?.isRunning) {
		return null;
	}

	const { totalTasks, completedTasks, currentTaskIndex, isStopping } = state;
	const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
	const currentTask = currentTaskIndex + 1;

	return (
		<div
			style={{
				// PROMINENT: Use solid, vibrant background color
				backgroundColor: isStopping ? colors.warning : colors.accent,
				// PROMINENT: Add extra padding for visibility
				padding: '12px 16px',
				display: 'flex',
				alignItems: 'center',
				gap: '12px',
				// Add shadow to stand out
				boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
			}}
		>
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
					animation: 'autorun-pulse 1.5s ease-in-out infinite',
				}}
			>
				{/* Play or pause icon */}
				{isStopping ? (
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
							{isStopping ? 'Stopping...' : 'AutoRun Active'}
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
							color: isStopping ? colors.warning : colors.accent,
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
