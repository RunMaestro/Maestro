/**
 * WizardConfidenceGauge.tsx
 *
 * Compact horizontal confidence gauge for the wizard input panel.
 * Shows the AI's confidence level as a percentage with a thin progress bar.
 * When confidence >= 80, adds a green glow effect to indicate readiness.
 */

import type { Theme } from '../../types';
import { getConfidenceColor } from '../Wizard/services/wizardPrompts';

/**
 * Threshold at which the gauge shows the "ready" glow effect
 */
const READY_THRESHOLD = 80;

interface WizardConfidenceGaugeProps {
	/** Current confidence level (0-100) */
	confidence: number;
	/** Theme for styling */
	theme: Theme;
}

/**
 * WizardConfidenceGauge - Compact horizontal confidence indicator
 *
 * Features:
 * - Percentage number display
 * - Thin horizontal progress bar
 * - Color transitions: red (0-39) -> orange (40) -> yellow (79) -> green (80+)
 * - Green only appears at/above the ready threshold (80)
 * - Green glow effect when confidence >= 80
 */
export function WizardConfidenceGauge({
	confidence,
	theme,
}: WizardConfidenceGaugeProps): JSX.Element {
	// Clamp confidence to valid range
	const clampedConfidence = Math.max(0, Math.min(100, Math.round(confidence)));
	const isReady = clampedConfidence >= READY_THRESHOLD;
	const color = getConfidenceColor(clampedConfidence);

	return (
		<div
			className="flex items-center gap-2"
			title={`Project Understanding Confidence: ${clampedConfidence}%${isReady ? ' - Ready to proceed' : ''}`}
		>
			{/* Label */}
			<span className="text-[10px] uppercase tracking-wide" style={{ color: theme.colors.textDim }}>
				Project Understanding Confidence
			</span>

			{/* Percentage display */}
			<span
				className="text-xs font-medium tabular-nums min-w-[2.5rem] text-right"
				style={{ color }}
			>
				{clampedConfidence}%
			</span>

			{/* Progress bar container */}
			<div
				className="relative w-16 h-1.5 rounded-full overflow-hidden"
				style={{ backgroundColor: theme.colors.bgActivity }}
			>
				{/* Progress fill */}
				<div
					className={`absolute inset-y-0 left-0 rounded-full transition-all duration-300 ${
						isReady ? 'animate-confidence-glow' : ''
					}`}
					style={{
						width: `${clampedConfidence}%`,
						backgroundColor: color,
						boxShadow: isReady ? `0 0 8px ${color}, 0 0 4px ${color}` : 'none',
					}}
				/>
			</div>

			{/* Glow animation styles */}
			<style>{`
        @keyframes confidence-glow {
          0%, 100% {
            filter: brightness(1);
          }
          50% {
            filter: brightness(1.2);
          }
        }
        .animate-confidence-glow {
          animation: confidence-glow 1.5s ease-in-out infinite;
        }
      `}</style>
		</div>
	);
}
