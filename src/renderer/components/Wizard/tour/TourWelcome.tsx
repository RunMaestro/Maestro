/**
 * TourWelcome.tsx
 *
 * Welcome screen shown before the tour steps begin. Displays the
 * shared welcome content with a "Let's Take a Tour" button to start
 * the actual tour steps.
 */

import type { Theme } from '../../../types';
import { WelcomeContent } from '../../WelcomeContent';

interface TourWelcomeProps {
	theme: Theme;
	/** Callback to start the tour (move to step 1) */
	onStartTour: () => void;
	/** Callback to skip the tour entirely */
	onSkip: () => void;
}

/**
 * TourWelcome - Welcome overlay before tour steps
 *
 * Renders a centered modal with the welcome content and
 * navigation options to start or skip the tour.
 */
export function TourWelcome({ theme, onStartTour, onSkip }: TourWelcomeProps): JSX.Element {
	return (
		<div
			className="tour-step-tooltip rounded-xl shadow-2xl overflow-hidden tour-welcome-enter"
			style={{
				position: 'fixed',
				top: '50%',
				left: '50%',
				transform: 'translate(-50%, -50%)',
				width: 552,
				maxWidth: '90vw',
				maxHeight: '90vh',
				overflowY: 'auto',
				backgroundColor: theme.colors.bgSidebar,
				border: `1px solid ${theme.colors.border}`,
			}}
		>
			{/* Header */}
			<div
				className="px-5 py-3 border-b flex items-center justify-end"
				style={{
					borderColor: theme.colors.border,
					backgroundColor: theme.colors.bgMain,
				}}
			>
				<button
					onClick={onSkip}
					className="text-xs hover:underline transition-colors"
					style={{ color: theme.colors.textDim }}
				>
					Skip Tour
				</button>
			</div>

			{/* Content */}
			<div className="p-6 flex flex-col items-center">
				<WelcomeContent theme={theme} />

				{/* Start tour button */}
				<button
					onClick={onStartTour}
					className="mt-6 px-6 py-3 rounded-lg text-base font-medium transition-all duration-200 hover:scale-105"
					style={{
						backgroundColor: theme.colors.accent,
						color: theme.colors.accentForeground,
					}}
				>
					Let's Take a Tour
				</button>
			</div>

			{/* Keyboard hint */}
			<div
				className="px-5 py-2 border-t text-center"
				style={{
					borderColor: theme.colors.border,
					backgroundColor: theme.colors.bgMain,
				}}
			>
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					Press{' '}
					<kbd
						className="px-1.5 py-0.5 rounded text-xs"
						style={{ backgroundColor: theme.colors.bgActivity }}
					>
						Enter
					</kbd>{' '}
					to continue
					{' • '}
					<kbd
						className="px-1.5 py-0.5 rounded text-xs"
						style={{ backgroundColor: theme.colors.bgActivity }}
					>
						Esc
					</kbd>{' '}
					to skip
				</span>
			</div>
		</div>
	);
}
