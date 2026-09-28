/**
 * TourStep.tsx
 *
 * Individual tour step tooltip component that displays tour content
 * next to the spotlighted element. Includes title, description,
 * navigation buttons, and step indicator.
 */

import React from 'react';
import type { Theme, Shortcut } from '../../../types';
import type { TourStepConfig, SpotlightInfo } from './useTour';
import { formatShortcutKeys } from '../../../utils/shortcutFormatter';
import { measureTextWidth } from '../../../utils/measureTextWidth';
import { useSettingsStore } from '../../../stores/settingsStore';
import { resolveSurfaceFontSize } from '../../../../shared/typography';
import { withMonoFallback } from '../../../../shared/fontStack';

/**
 * Render description text with shortcut placeholders replaced by styled kbd badges.
 * Splits on {{shortcutId}} patterns and returns React nodes.
 */
function renderDescriptionWithBadges(
	text: string,
	shortcuts: Record<string, Shortcut> | undefined,
	theme: Theme
): React.ReactNode[] {
	if (!shortcuts) return [text];

	const parts: React.ReactNode[] = [];
	const pattern = /\{\{(\w+)\}\}/g;
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = pattern.exec(text)) !== null) {
		// Add text before the match
		if (match.index > lastIndex) {
			parts.push(text.slice(lastIndex, match.index));
		}

		const shortcutId = match[1];
		const shortcut = shortcuts[shortcutId];
		if (shortcut?.keys) {
			const formatted = formatShortcutKeys(shortcut.keys);
			parts.push(
				<kbd
					key={`kbd-${match.index}`}
					className="inline-block px-1.5 py-0.5 mx-0.5 rounded text-xs font-mono font-semibold"
					style={{
						backgroundColor: theme.colors.accent + '25',
						color: theme.colors.accent,
						border: `1px solid ${theme.colors.accent}40`,
					}}
				>
					{formatted}
				</kbd>
			);
		} else {
			// Shortcut not found, keep placeholder as-is
			parts.push(match[0]);
		}

		lastIndex = match.index + match[0].length;
	}

	// Add remaining text after last match
	if (lastIndex < text.length) {
		parts.push(text.slice(lastIndex));
	}

	return parts;
}

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
/**
 * Navigation-row metrics, in root font units (rem). Kept as constants rather
 * than inlined so the width reserve and the markup cannot drift: each one
 * names the Tailwind class it is measuring.
 */
const DOT_WIDTH_REM = 0.5; // w-2
const DOT_GAP_REM = 0.375; // gap-1.5
const CONTAINER_PADDING_X_REM = 1.25; // p-5
const BUTTON_PADDING_X_REM = 1; // px-4
const BUTTON_FONT_SIZE_REM = 0.875; // text-sm
const NAV_ROW_GAP_REM = 1; // gap-4 between the dot row and the button
const MIN_TOOLTIP_WIDTH_REM = 360 / 16;
const WIDE_TOOLTIP_WIDTH_REM = 520 / 16;
/** The root size the original pixel figures were tuned against. */
const BASE_ROOT_FONT_PX = 16;
/**
 * The longest label the button can hold. Reserving for the widest possible
 * text means the layout does not change on the final step, when "Continue"
 * becomes "Finish Tour".
 */
const WIDEST_BUTTON_LABEL = 'Finish Tour';

function calculateTooltipPosition(
	spotlight: SpotlightInfo | null,
	preferredPosition: TourStepConfig['position'],
	hasExtraContent?: boolean,
	totalSteps: number = 0,
	/** Rendered root font size in px, zoom included. Scales every reserve below. */
	rootFontPx: number = BASE_ROOT_FONT_PX,
	/** Interface font, so the button label is measured in the face it renders in. */
	buttonFontFamily: string = 'sans-serif'
): {
	position: 'top' | 'bottom' | 'left' | 'right' | 'center' | 'center-overlay';
	style: React.CSSProperties;
} {
	// Base tooltip width; widen if extra content OR if there are enough progress
	// dots that the row would crowd the Continue button.
	//
	// Every figure below is expressed in ROOT FONT UNITS and multiplied out at
	// the end, because everything it is measuring is rem-based and therefore
	// scales with the interface font size and the Cmd+= zoom: the dots are
	// `w-2`, their gap is `gap-1.5`, the container padding is `p-5`, and the
	// button is `text-sm px-4`. The reserve used to be raw pixels
	// (`totalSteps * 14 + 170`), tuned at a 14px root - so at a larger root the
	// contents outgrew the width they were given and the `justify-between` row
	// collapsed, putting the Continue button on top of the last few dots.
	const rootPx = rootFontPx > 0 ? rootFontPx : BASE_ROOT_FONT_PX;
	const dotsWidth =
		totalSteps > 0 ? totalSteps * DOT_WIDTH_REM + Math.max(0, totalSteps - 1) * DOT_GAP_REM : 0;
	// The widest label the button can hold. Measured rather than guessed at,
	// since its width depends on the interface font: the old fixed ~110px
	// estimate was taken against monospace.
	const buttonWidth =
		measureTextWidth(
			WIDEST_BUTTON_LABEL,
			`500 ${BUTTON_FONT_SIZE_REM * rootPx}px ${buttonFontFamily}`
		) /
			rootPx +
		BUTTON_PADDING_X_REM * 2;
	const minWidthForDots =
		totalSteps > 0
			? Math.ceil(
					(dotsWidth + buttonWidth + CONTAINER_PADDING_X_REM * 2 + NAV_ROW_GAP_REM) * rootPx
				)
			: 0;
	const baseWidth = Math.max(MIN_TOOLTIP_WIDTH_REM * rootPx, minWidthForDots);
	const tooltipWidth = hasExtraContent
		? Math.max(WIDE_TOOLTIP_WIDTH_REM * rootPx, minWidthForDots)
		: baseWidth;
	const tooltipHeight = hasExtraContent ? 360 : 240; // Estimated max height
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
	// Use wizard-specific description if fromWizard, otherwise use generic (or fall back to description)
	const rawDescription = fromWizard
		? step.description
		: step.descriptionGeneric || step.description;

	// Get optional JSX content based on context
	const descriptionContent = fromWizard
		? step.descriptionContent
		: step.descriptionContentGeneric || step.descriptionContent;

	// Determine if we have extra content or explicit wide flag (for wider tooltip)
	const hasExtraContent = !!descriptionContent || !!step.wide;

	// The rendered root size and interface font, so the width reserve is
	// computed against the type the tooltip will actually be drawn in.
	const rootFontPx = useSettingsStore((state) =>
		resolveSurfaceFontSize(state.fontSize, state.fontSize, state.fontZoom)
	);
	const interfaceFontFamily = useSettingsStore((state) => withMonoFallback(state.fontFamily));

	const { position, style } = calculateTooltipPosition(
		spotlight,
		step.position,
		hasExtraContent,
		totalSteps,
		rootFontPx,
		interfaceFontFamily
	);

	// Description stays as raw text; shortcut badges are rendered inline as JSX

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

				{/* Description - render double newlines as paragraphs, single newlines as line breaks, shortcuts as kbd badges */}
				<div className="text-sm leading-relaxed mb-5" style={{ color: theme.colors.textDim }}>
					{rawDescription.split('\n\n').map((paragraph, pi) => (
						<p key={pi} className={pi > 0 ? 'mt-3' : ''}>
							{paragraph.split('\n').map((line, i, arr) => (
								<span key={i}>
									{renderDescriptionWithBadges(line, shortcuts, theme)}
									{i < arr.length - 1 && <br />}
								</span>
							))}
						</p>
					))}
					{/* Optional JSX content (e.g., inline icons) */}
					{descriptionContent && <div className="mt-3">{descriptionContent}</div>}
				</div>

				{/* Navigation buttons.
				    `gap-4` and the button's `shrink-0` are the structural half of
				    the width reserve above: even if the estimate is wrong for some
				    font, the two can no longer occupy the same pixels. The dot row
				    wraps rather than overflowing, so a very long tour grows the
				    modal downward instead of pushing the button off the edge. */}
				<div className="flex items-center justify-between gap-4">
					{/* Progress dots - past steps are clickable */}
					<div className="flex items-center flex-wrap gap-1.5 min-w-0">
						{Array.from({ length: totalSteps }, (_, i) => {
							const isPast = i < stepNumber - 1;
							const isCurrent = i === stepNumber - 1;
							return (
								<button
									key={i}
									onClick={() => isPast && onGoToStep(i)}
									disabled={!isPast}
									// shrink-0 keeps a dot round: a flex item with a width but no
									// shrink guard is squashed into an ellipse under pressure.
									className={`w-2 h-2 shrink-0 rounded-full transition-all duration-200 ${
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
						className="px-4 py-2 rounded-lg text-sm font-medium shrink-0 whitespace-nowrap transition-all duration-200 hover:scale-105"
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
