/**
 * TourOverlay.tsx
 *
 * Full-screen tour overlay with spotlight cutout that guides users
 * through the Maestro interface. Renders a semi-transparent dark
 * backdrop with a highlighted "spotlight" area showing the current
 * element of interest.
 *
 * Uses CSS clip-path to create the spotlight cutout effect.
 */

import { useEffect, useCallback, useRef, useState } from 'react';
import type { Theme, Shortcut } from '../../../types';
import { useLayerStack } from '../../../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../../../constants/modalPriorities';
import { TourStep } from './TourStep';
import { TourWelcome } from './TourWelcome';
import { useTour, type TourStepConfig } from './useTour';

interface TourOverlayProps {
	theme: Theme;
	/** Whether the tour overlay is visible */
	isOpen: boolean;
	/** Callback when tour ends (completed or skipped) */
	onClose: () => void;
	/** Optional starting step index */
	startStep?: number;
	/** Whether tour was launched from the wizard (affects step descriptions) */
	fromWizard?: boolean;
	/** User's keyboard shortcuts for dynamic placeholder replacement */
	shortcuts?: Record<string, Shortcut>;
	/** Analytics callback: Called when tour starts */
	onTourStart?: () => void;
	/** Analytics callback: Called when tour completes all steps */
	onTourComplete?: (stepsViewed: number) => void;
	/** Analytics callback: Called when tour is skipped before completion */
	onTourSkip?: (stepsViewed: number) => void;
}

/**
 * Calculate the clip-path for the spotlight effect
 * Creates a "cutout" in the dark overlay where the spotlight element is
 */
function getSpotlightClipPath(spotlight: TourStepConfig['spotlight'] | null): string {
	if (!spotlight || !spotlight.rect) {
		// No spotlight - full dark overlay
		return 'none';
	}

	const { x, y, width, height } = spotlight.rect;
	const padding = spotlight.padding || 8;

	// Calculate spotlight bounds with padding
	const spotX = x - padding;
	const spotY = y - padding;
	const spotW = width + padding * 2;
	const spotH = height + padding * 2;
	const borderRadius = spotlight.borderRadius || 8;

	// Use an inset path that covers everything except the spotlight area
	// We use a polygon with a "hole" created by going around the viewport,
	// then around the spotlight area in reverse
	return `polygon(
    0% 0%,
    0% 100%,
    ${spotX}px 100%,
    ${spotX}px ${spotY + borderRadius}px,
    ${spotX + borderRadius}px ${spotY}px,
    ${spotX + spotW - borderRadius}px ${spotY}px,
    ${spotX + spotW}px ${spotY + borderRadius}px,
    ${spotX + spotW}px ${spotY + spotH - borderRadius}px,
    ${spotX + spotW - borderRadius}px ${spotY + spotH}px,
    ${spotX + borderRadius}px ${spotY + spotH}px,
    ${spotX}px ${spotY + spotH - borderRadius}px,
    ${spotX}px 100%,
    100% 100%,
    100% 0%
  )`;
}

/**
 * TourOverlay - Main tour overlay component
 *
 * Renders a full-screen dark overlay with a spotlight cutout that
 * highlights different UI elements as the user progresses through
 * the tour. Handles keyboard navigation and step transitions.
 */
export function TourOverlay({
	theme,
	isOpen,
	onClose,
	startStep = 0,
	fromWizard = false,
	shortcuts,
	onTourStart,
	onTourComplete,
	onTourSkip,
}: TourOverlayProps): JSX.Element | null {
	const { registerLayer, unregisterLayer } = useLayerStack();

	// Track whether we're showing the welcome screen (before tour steps)
	const [showWelcome, setShowWelcome] = useState(true);

	// Track if tour start has been recorded for this open session
	const tourStartedRef = useRef(false);
	// Track maximum step viewed (1-indexed for reporting)
	const maxStepViewedRef = useRef(1);

	// Use refs for callbacks to avoid recreating handlers on every render
	// This prevents infinite loops caused by unstable callback references
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const onTourCompleteRef = useRef(onTourComplete);
	onTourCompleteRef.current = onTourComplete;
	const onTourSkipRef = useRef(onTourSkip);
	onTourSkipRef.current = onTourSkip;
	const onTourStartRef = useRef(onTourStart);
	onTourStartRef.current = onTourStart;

	// Stable onComplete callback that uses refs
	const handleComplete = useCallback(() => {
		// Tour completed - user viewed all steps
		if (onTourCompleteRef.current) {
			onTourCompleteRef.current(maxStepViewedRef.current);
		}
		onCloseRef.current();
	}, []);

	const {
		currentStep,
		currentStepIndex,
		totalSteps,
		spotlight,
		isTransitioning,
		isPositionReady,
		nextStep,
		previousStep,
		goToStep,
		skipTour: internalSkipTour,
		isLastStep,
	} = useTour({
		isOpen,
		onComplete: handleComplete,
		startStep,
	});

	// Wrapper for skipTour that calls analytics callback
	// Uses ref for onTourSkip to keep skipTour stable
	const skipTour = useCallback(() => {
		// Tour skipped before completion
		if (onTourSkipRef.current) {
			onTourSkipRef.current(maxStepViewedRef.current);
		}
		internalSkipTour();
	}, [internalSkipTour]);

	// Track tour start when it opens
	// Uses ref for onTourStart to avoid effect re-running on callback changes
	useEffect(() => {
		if (isOpen && !tourStartedRef.current) {
			tourStartedRef.current = true;
			maxStepViewedRef.current = 1; // Reset to 1 (first step)
			setShowWelcome(true); // Reset to welcome screen when tour opens
			if (onTourStartRef.current) {
				onTourStartRef.current();
			}
		} else if (!isOpen) {
			// Reset when tour closes
			tourStartedRef.current = false;
		}
	}, [isOpen]);

	// Track the maximum step viewed
	useEffect(() => {
		if (isOpen) {
			// currentStepIndex is 0-based, we track 1-based for human-readable reporting
			const stepNumber = currentStepIndex + 1;
			if (stepNumber > maxStepViewedRef.current) {
				maxStepViewedRef.current = stepNumber;
			}
		}
	}, [isOpen, currentStepIndex]);

	// Handle starting tour from welcome screen
	const handleStartTour = useCallback(() => {
		setShowWelcome(false);
	}, []);

	// Handle keyboard navigation
	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if (!isOpen) return;

			switch (e.key) {
				case 'Enter':
				case ' ':
					e.preventDefault();
					if (showWelcome) {
						handleStartTour();
					} else if (isLastStep) {
						skipTour(); // Finish tour
					} else {
						nextStep();
					}
					break;
				case 'Escape':
					e.preventDefault();
					skipTour();
					break;
				case 'ArrowRight':
				case 'ArrowDown':
					e.preventDefault();
					if (!showWelcome) {
						nextStep();
					}
					break;
				case 'ArrowLeft':
				case 'ArrowUp':
					e.preventDefault();
					if (!showWelcome) {
						previousStep();
					}
					break;
				default:
					break;
			}
		},
		[isOpen, showWelcome, isLastStep, nextStep, previousStep, skipTour, handleStartTour]
	);

	// Register keyboard handler
	useEffect(() => {
		if (isOpen) {
			window.addEventListener('keydown', handleKeyDown);
			return () => window.removeEventListener('keydown', handleKeyDown);
		}
	}, [isOpen, handleKeyDown]);

	// Register with layer stack for proper focus management
	useEffect(() => {
		if (isOpen) {
			const id = registerLayer({
				type: 'modal',
				priority: MODAL_PRIORITIES.TOUR,
				blocksLowerLayers: true,
				capturesFocus: true,
				focusTrap: 'lenient',
				onEscape: skipTour,
			});
			return () => unregisterLayer(id);
		}
	}, [isOpen, registerLayer, unregisterLayer, skipTour]);

	// Don't render if not open
	if (!isOpen) {
		return null;
	}

	// Don't render tour steps if currentStep is null (but welcome can still show)
	if (!showWelcome && !currentStep) {
		return null;
	}

	const clipPath = showWelcome ? 'none' : getSpotlightClipPath(spotlight);

	return (
		<div
			className="fixed inset-0 z-[9999] tour-overlay"
			role="dialog"
			aria-modal="true"
			aria-label="Interface tour"
		>
			{/* Dark overlay with spotlight cutout */}
			<div
				className="absolute inset-0 transition-all duration-300 ease-out"
				style={{
					backgroundColor: 'rgba(0, 0, 0, 0.75)',
					clipPath: clipPath,
					// If no spotlight or welcome screen, ensure full coverage
					...(clipPath === 'none' && { backgroundColor: 'rgba(0, 0, 0, 0.85)' }),
				}}
			/>

			{/* Welcome screen or tour steps */}
			{showWelcome ? (
				<TourWelcome theme={theme} onStartTour={handleStartTour} onSkip={skipTour} />
			) : (
				<>
					{/* Spotlight border ring (visible highlight around the cutout area) */}
					{spotlight?.rect && (
						<div
							className="absolute pointer-events-none transition-all duration-300 ease-out"
							style={{
								left: spotlight.rect.x - (spotlight.padding || 8) - 2,
								top: spotlight.rect.y - (spotlight.padding || 8) - 2,
								width: spotlight.rect.width + (spotlight.padding || 8) * 2 + 4,
								height: spotlight.rect.height + (spotlight.padding || 8) * 2 + 4,
								borderRadius: (spotlight.borderRadius || 8) + 2,
								border: `2px solid ${theme.colors.accent}`,
								boxShadow: `0 0 20px ${theme.colors.accent}40, inset 0 0 20px ${theme.colors.accent}20`,
								// Only show when position is ready and not transitioning
								opacity: isPositionReady && !isTransitioning ? 1 : 0,
							}}
						/>
					)}

					{/* Tour step tooltip */}
					{currentStep && (
						<TourStep
							theme={theme}
							step={currentStep}
							stepNumber={currentStepIndex + 1}
							totalSteps={totalSteps}
							spotlight={spotlight}
							onNext={nextStep}
							onGoToStep={goToStep}
							onSkip={skipTour}
							isLastStep={isLastStep}
							isTransitioning={isTransitioning}
							isPositionReady={isPositionReady}
							fromWizard={fromWizard}
							shortcuts={shortcuts}
						/>
					)}
				</>
			)}

			{/* Animation styles */}
			<style>{`
        .tour-overlay {
          animation: tour-fade-in 0.3s ease-out;
        }

        @keyframes tour-fade-in {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }

        .tour-step-enter {
          animation: tour-step-enter 0.25s ease-out;
        }

        @keyframes tour-step-enter {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .tour-welcome-enter {
          animation: tour-welcome-enter 0.3s ease-out;
        }

        @keyframes tour-welcome-enter {
          from {
            opacity: 0;
            transform: translate(-50%, -50%) scale(0.95);
          }
          to {
            opacity: 1;
            transform: translate(-50%, -50%) scale(1);
          }
        }
      `}</style>
		</div>
	);
}
