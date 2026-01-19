/**
 * TourStep.tsx
 *
 * Individual tour step tooltip component that displays tour content
 * next to the spotlighted element. Includes title, description,
 * navigation buttons, and step indicator.
 */

import type { Theme, Shortcut } from '../../../types';
import type { TourStepConfig, SpotlightInfo } from './useTour';
import { replaceShortcutPlaceholders } from './tourSteps';

interface TourStepProps {
	theme: Theme;
	/** The tour step configuration */
	step: TourStepConfig;
	/** Current step number (1-based) */
	stepNumber: number;
	/** Total number of steps */
	totalSteps: number;
	/** Current spotlight position/size info */
	spotlight: SpotlightInfo | null;
	/** Callback to advance to next step */
	onNext: () => void;
	/** Callback to go to a specific step (0-based index) */
	onGoToStep: (stepIndex: number) => void;
	/** Callback to skip/end the tour */
	onSkip: () => void;
	/** Whether this is the last step */
	isLastStep: boolean;
	/** Whether currently transitioning between steps */
	isTransitioning: boolean;
	/** Whether position has been calculated and tooltip is ready to show */
	isPositionReady: boolean;
	/** Whether tour was launched from wizard (uses wizard-specific descriptions) */
	fromWizard?: boolean;
	/** User's keyboard shortcuts for dynamic placeholder replacement */
	shortcuts?: Record<string, Shortcut>;
}

/**
 * Calculate the optimal tooltip position based on spotlight location
 * and available viewport space
 */
function calculateTooltipPosition(
	spotlight: SpotlightInfo | null,
	preferredPosition: TourStepConfig['position']
): {
	position: 'top' | 'bottom' | 'left' | 'right' | 'center' | 'center-overlay';
	style: React.CSSProperties;
} {
	const tooltipWidth = 360;
	const tooltipHeight = 240; // Estimated max height
	const margin = 16;

	// If no spotlight, center the tooltip on screen
	if (!spotlight?.rect) {
		return {
			position: 'center',
			style: {
				position: 'fixed',
				top: '50%',
				left: '50%',
				transform: 'translate(-50%, -50%)',
				width: tooltipWidth,
			},
		};
	}

	const { x, y, width, height } = spotlight.rect;
	const padding = spotlight.padding || 8;
	const viewportWidth = window.innerWidth;
	const viewportHeight = window.innerHeight;

	// If center-overlay is requested, center the tooltip over the spotlight element
	if (preferredPosition === 'center-overlay') {
		const centerX = x + width / 2;
		const centerY = y + height / 2;
		return {
			position: 'center-overlay',
			style: {
				position: 'fixed',
				top: centerY,
				left: centerX,
				transform: 'translate(-50%, -50%)',
				width: tooltipWidth,
			},
		};
	}

	// Calculate available space in each direction
	const spaceTop = y - padding;
	const spaceBottom = viewportHeight - (y + height + padding);
	const spaceLeft = x - padding;
	const spaceRight = viewportWidth - (x + width + padding);

	// Determine best position based on preference and available space
	let position: 'top' | 'bottom' | 'left' | 'right' | 'center' =
		(preferredPosition as any) || 'bottom';

	// Check if preferred position has enough space, otherwise find best
	const minSpace = tooltipHeight + margin * 2;
	const minHorizontalSpace = tooltipWidth + margin * 2;

	if (position === 'top' && spaceTop < minSpace) {
		position =
			spaceBottom >= minSpace ? 'bottom' : spaceRight >= minHorizontalSpace ? 'right' : 'left';
	} else if (position === 'bottom' && spaceBottom < minSpace) {
		position = spaceTop >= minSpace ? 'top' : spaceRight >= minHorizontalSpace ? 'right' : 'left';
	} else if (position === 'left' && spaceLeft < minHorizontalSpace) {
		position =
			spaceRight >= minHorizontalSpace ? 'right' : spaceBottom >= minSpace ? 'bottom' : 'top';
	} else if (position === 'right' && spaceRight < minHorizontalSpace) {
		position =
			spaceLeft >= minHorizontalSpace ? 'left' : spaceBottom >= minSpace ? 'bottom' : 'top';
	}

	// Calculate position style
	let style: React.CSSProperties = {
		position: 'fixed',
		width: tooltipWidth,
	};

	const centerX = x + width / 2;
	const centerY = y + height / 2;

	switch (position) {
		case 'top':
			style = {
				...style,
				bottom: viewportHeight - y + padding + margin,
				left: Math.max(
					margin,
					Math.min(centerX - tooltipWidth / 2, viewportWidth - tooltipWidth - margin)
				),
			};
			break;
		case 'bottom':
			style = {
				...style,
				top: y + height + padding + margin,
				left: Math.max(
					margin,
					Math.min(centerX - tooltipWidth / 2, viewportWidth - tooltipWidth - margin)
				),
			};
			break;
		case 'left':
			style = {
				...style,
				right: viewportWidth - x + padding + margin,
				top: Math.max(
					margin,
					Math.min(centerY - tooltipHeight / 2, viewportHeight - tooltipHeight - margin)
				),
			};
			break;
		case 'right':
			style = {
				...style,
				left: x + width + padding + margin,
				top: Math.max(
					margin,
					Math.min(centerY - tooltipHeight / 2, viewportHeight - tooltipHeight - margin)
				),
			};
			break;
	}

	return { position, style };
}

/**
 * Arrow pointer component that points from tooltip to spotlight
 */
function TooltipArrow({
	theme,
	position,
}: {
	theme: Theme;
	position: 'top' | 'bottom' | 'left' | 'right' | 'center' | 'center-overlay';
}) {
	if (position === 'center' || position === 'center-overlay') return null;

	const arrowStyles: Record<string, React.CSSProperties> = {
		top: {
			position: 'absolute',
			bottom: -8,
			left: '50%',
			transform: 'translateX(-50%)',
			width: 0,
			height: 0,
			borderLeft: '8px solid transparent',
			borderRight: '8px solid transparent',
			borderTop: `8px solid ${theme.colors.bgSidebar}`,
		},
		bottom: {
			position: 'absolute',
			top: -8,
			left: '50%',
			transform: 'translateX(-50%)',
			width: 0,
			height: 0,
			borderLeft: '8px solid transparent',
			borderRight: '8px solid transparent',
			borderBottom: `8px solid ${theme.colors.bgSidebar}`,
		},
		left: {
			position: 'absolute',
			right: -8,
			top: '50%',
			transform: 'translateY(-50%)',
			width: 0,
			height: 0,
			borderTop: '8px solid transparent',
			borderBottom: '8px solid transparent',
			borderLeft: `8px solid ${theme.colors.bgSidebar}`,
		},
		right: {
			position: 'absolute',
			left: -8,
			top: '50%',
			transform: 'translateY(-50%)',
			width: 0,
			height: 0,
			borderTop: '8px solid transparent',
			borderBottom: '8px solid transparent',
			borderRight: `8px solid ${theme.colors.bgSidebar}`,
		},
	};

	return <div style={arrowStyles[position]} />;
}

/**
 * TourStep - Tour step tooltip component
 *
 * Displays the tour step content positioned near the spotlight area.
 * Includes title, description, step indicator, and navigation buttons.
 */
export function TourStep({
	theme,
	step,
	stepNumber,
	totalSteps,
	spotlight,
	onNext,
	onGoToStep,
	onSkip,
	isLastStep,
	isTransitioning,
	isPositionReady,
	fromWizard = false,
	shortcuts,
}: TourStepProps): JSX.Element {
	const { position, style } = calculateTooltipPosition(spotlight, step.position);

	// Use wizard-specific description if fromWizard, otherwise use generic (or fall back to description)
	const rawDescription = fromWizard
		? step.description
		: step.descriptionGeneric || step.description;

	// Replace shortcut placeholders with formatted shortcuts
	const description = shortcuts
		? replaceShortcutPlaceholders(rawDescription, shortcuts)
		: rawDescription;

	// Only show tooltip when position is ready and not transitioning
	// This prevents flickering by ensuring position is calculated before becoming visible
	const shouldShow = isPositionReady && !isTransitioning;

	return (
		<div
			className={`tour-step-tooltip rounded-xl shadow-2xl overflow-hidden ${
				shouldShow ? 'tour-step-enter' : ''
			}`}
			style={{
				...style,
				backgroundColor: theme.colors.bgSidebar,
				border: `1px solid ${theme.colors.border}`,
				transition: 'opacity 0.2s ease-out',
				opacity: shouldShow ? 1 : 0,
				// Use visibility to ensure element is positioned but not visible during calculation
				visibility: isPositionReady ? 'visible' : 'hidden',
			}}
		>
			{/* Arrow pointer */}
			<TooltipArrow theme={theme} position={position} />

			{/* Header with step indicator */}
			<div
				className="px-5 py-3 border-b flex items-center justify-between"
				style={{
					borderColor: theme.colors.border,
					backgroundColor: theme.colors.bgMain,
				}}
			>
				<div className="flex items-center gap-3">
					{/* Step icon */}
					<div
						className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
					>
						{stepNumber}
					</div>
					<span className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
						Step {stepNumber} of {totalSteps}
					</span>
				</div>

				{/* Skip button */}
				<button
					onClick={onSkip}
					className="text-xs hover:underline transition-colors"
					style={{ color: theme.colors.textDim }}
				>
					Skip Tour
				</button>
			</div>

			{/* Content */}
			<div className="p-5">
				{/* Title */}
				<h3 className="text-lg font-semibold mb-2" style={{ color: theme.colors.textMain }}>
					{step.title}
				</h3>

				{/* Description */}
				<p className="text-sm leading-relaxed mb-5" style={{ color: theme.colors.textDim }}>
					{description}
				</p>

				{/* Navigation buttons */}
				<div className="flex items-center justify-between">
					{/* Progress dots - past steps are clickable */}
					<div className="flex items-center gap-1.5">
						{Array.from({ length: totalSteps }, (_, i) => {
							const isPast = i < stepNumber - 1;
							const isCurrent = i === stepNumber - 1;
							return (
								<button
									key={i}
									onClick={() => isPast && onGoToStep(i)}
									disabled={!isPast}
									className={`w-2 h-2 rounded-full transition-all duration-200 ${
										isPast ? 'cursor-pointer hover:scale-150' : ''
									}`}
									style={{
										backgroundColor: i < stepNumber ? theme.colors.accent : theme.colors.border,
										transform: isCurrent ? 'scale(1.2)' : 'scale(1)',
										opacity: isPast ? 0.7 : 1,
									}}
									title={isPast ? `Go back to step ${i + 1}` : undefined}
								/>
							);
						})}
					</div>

					{/* Continue button */}
					<button
						onClick={onNext}
						className="px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 hover:scale-105"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
					>
						{isLastStep ? 'Finish Tour' : 'Continue'}
					</button>
				</div>
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
