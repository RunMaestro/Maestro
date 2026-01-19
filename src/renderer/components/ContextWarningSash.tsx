import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import type { Theme } from '../types';

export interface ContextWarningSashProps {
	theme: Theme;
	contextUsage: number; // 0-100 percentage
	yellowThreshold: number;
	redThreshold: number;
	enabled: boolean;
	onSummarizeClick: () => void;
	// Optional: track tab ID for per-tab dismissal
	tabId?: string;
}

/**
 * ContextWarningSash displays a warning banner when context window usage
 * reaches configurable thresholds (yellow at 60%, red at 80% by default).
 *
 * The sash includes:
 * - Visual warning indicator (yellow or red based on severity)
 * - Current usage percentage
 * - "Summarize & Continue" button for quick action
 * - Dismiss button that hides the warning until usage increases 10%+ or crosses threshold
 */
export function ContextWarningSash({
	theme: _theme,
	contextUsage,
	yellowThreshold,
	redThreshold,
	enabled,
	onSummarizeClick,
	tabId,
}: ContextWarningSashProps) {
	// Track dismissal state per-tab
	const [dismissedAtUsage, setDismissedAtUsage] = useState<number | null>(null);
	const [dismissedLevel, setDismissedLevel] = useState<'yellow' | 'red' | null>(null);

	// Determine warning level
	const warningLevel = useMemo(() => {
		if (contextUsage >= redThreshold) return 'red';
		if (contextUsage >= yellowThreshold) return 'yellow';
		return null;
	}, [contextUsage, yellowThreshold, redThreshold]);

	// Reset dismissal when tab changes
	useEffect(() => {
		setDismissedAtUsage(null);
		setDismissedLevel(null);
	}, [tabId]);

	// Check if warning should be shown based on dismissal rules
	const shouldShowWarning = useMemo(() => {
		// Don't show if disabled or no warning level
		if (!enabled || !warningLevel) return false;

		// Show if never dismissed for this tab
		if (dismissedAtUsage === null) return true;

		// Show again if usage has increased by 10% or more since dismissal
		if (contextUsage >= dismissedAtUsage + 10) return true;

		// Show again if crossed from yellow to red threshold
		if (dismissedLevel === 'yellow' && warningLevel === 'red') return true;

		return false;
	}, [enabled, warningLevel, dismissedAtUsage, dismissedLevel, contextUsage]);

	// Handle dismiss action
	const handleDismiss = useCallback(() => {
		setDismissedAtUsage(contextUsage);
		setDismissedLevel(warningLevel);
	}, [contextUsage, warningLevel]);

	// Don't render if warning shouldn't be shown
	if (!shouldShowWarning) return null;

	const isRed = warningLevel === 'red';

	// Color values from spec
	const backgroundColor = isRed
		? 'rgba(239, 68, 68, 0.15)' // red-500 with low opacity
		: 'rgba(234, 179, 8, 0.15)'; // yellow-500 with low opacity

	const borderColor = isRed ? 'rgba(239, 68, 68, 0.5)' : 'rgba(234, 179, 8, 0.5)';

	const textColor = isRed
		? '#fca5a5' // red-300
		: '#fde047'; // yellow-300

	const iconColor = isRed ? '#ef4444' : '#eab308';
	const buttonBgColor = isRed ? '#ef4444' : '#eab308';

	return (
		<div
			role="alert"
			aria-live="polite"
			aria-label={`Context window at ${contextUsage}% capacity`}
			className="context-warning-sash flex items-center justify-between px-2 py-1 text-xs rounded-lg"
			style={{
				backgroundColor,
				border: `1px solid ${borderColor}`,
				marginTop: '8px',
			}}
		>
			<div className="flex items-center gap-1.5">
				{/* Warning icon with pulse animation for red level */}
				<div
					className={isRed ? 'warning-icon-pulse' : ''}
					style={{ display: 'flex', alignItems: 'center' }}
				>
					<AlertTriangle className="w-3 h-3" style={{ color: iconColor }} />
				</div>

				{/* Warning message */}
				<span style={{ color: textColor }}>
					{isRed ? (
						<>
							Context window at <strong>{contextUsage}%</strong> — consider compacting to continue
						</>
					) : (
						<>
							Context window reaching <strong>{contextUsage}%</strong> capacity
						</>
					)}
				</span>
			</div>

			<div className="flex items-center gap-1.5">
				{/* Compact button */}
				<button
					onClick={onSummarizeClick}
					onKeyDown={(e) => e.key === 'Enter' && onSummarizeClick()}
					tabIndex={0}
					className="px-1.5 py-0.5 text-[10px] font-medium rounded transition-colors hover:opacity-90"
					style={{
						backgroundColor: buttonBgColor,
						color: '#000',
					}}
				>
					Compact & Continue
				</button>

				{/* Dismiss button */}
				<button
					onClick={handleDismiss}
					onKeyDown={(e) => e.key === 'Enter' && handleDismiss()}
					tabIndex={0}
					className="p-0.5 rounded hover:bg-white/10 transition-colors"
					style={{ color: textColor }}
					title="Dismiss"
					aria-label="Dismiss warning"
				>
					<X className="w-3 h-3" />
				</button>
			</div>

			{/* CSS animations */}
			<style>{`
        @keyframes slideDown {
          from {
            opacity: 0;
            transform: translateY(-100%);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.7; }
        }

        .warning-icon-pulse {
          animation: pulse 2s infinite;
        }
      `}</style>
		</div>
	);
}

export default ContextWarningSash;
