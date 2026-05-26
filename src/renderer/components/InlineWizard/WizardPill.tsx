/**
 * WizardPill.tsx
 *
 * Prominent pill component for the inline wizard showing the Maestro wand icon
 * and "Wizard" text. Styled with accent background and subtle pulse animation
 * while the wizard is active. Shows a spinner when thinking.
 */

import { Wand2 } from 'lucide-react';
import { Spinner } from '../ui/Spinner';
import type { Theme } from '../../types';

interface WizardPillProps {
	theme: Theme;
	/** Optional click handler for click-to-exit functionality */
	onClick?: () => void;
	/** Whether the wizard is currently thinking/waiting for a response */
	isThinking?: boolean;
	/** Whether the wizard is performing first-load initialization */
	isInitializing?: boolean;
}

/**
 * WizardPill - Prominent indicator that wizard mode is active
 *
 * Features:
 * - Wand2 icon from lucide-react (Maestro wand icon)
 * - "Wizard" text label, changes to "Thinking..." when waiting
 * - Spinner animation when thinking
 * - Accent background with white text
 * - Subtle pulse animation while active (paused when thinking)
 */
export function WizardPill({
	theme,
	onClick,
	isThinking = false,
	isInitializing = false,
}: WizardPillProps): JSX.Element {
	// Initialization takes priority over the generic "thinking" state so the
	// first-load phase reads as "Initializing..." rather than a misleading
	// "Thinking..." before the user has sent anything.
	const busy = isInitializing || isThinking;
	const label = isInitializing ? 'Initializing...' : isThinking ? 'Thinking...' : 'Wizard';

	return (
		<button
			type="button"
			onClick={onClick}
			className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full font-medium text-sm transition-all ${busy ? '' : 'animate-wizard-pulse'}`}
			style={{
				backgroundColor: theme.colors.accent,
				color: theme.colors.accentForeground,
				cursor: onClick ? 'pointer' : 'default',
			}}
			title={
				isInitializing
					? 'Wizard is initializing...'
					: isThinking
						? 'Wizard is thinking...'
						: 'Wizard mode active - click to exit'
			}
		>
			{busy ? <Spinner size={16} /> : <Wand2 className="w-4 h-4" />}
			<span>{label}</span>

			{/* Pulse animation styles */}
			<style>{`
        @keyframes wizard-pulse {
          0%, 100% {
            box-shadow: 0 0 0 0 ${theme.colors.accent}40;
          }
          50% {
            box-shadow: 0 0 0 4px ${theme.colors.accent}20;
          }
        }
        .animate-wizard-pulse {
          animation: wizard-pulse 2s ease-in-out infinite;
        }
      `}</style>
		</button>
	);
}
