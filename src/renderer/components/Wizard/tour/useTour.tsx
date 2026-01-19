/**
 * useTour.tsx
 *
 * Hook for managing tour state, step progression, and spotlight positioning.
 * Handles element lookup, position calculation, and UI state changes
 * required for each tour step.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { tourSteps } from './tourSteps';

/**
 * UI action to perform before showing a tour step
 */
export interface TourUIAction {
	type:
		| 'setRightTab'
		| 'openRightPanel'
		| 'closeRightPanel'
		| 'openHamburgerMenu'
		| 'closeHamburgerMenu'
		| 'setInputMode';
	value?: string;
}

/**
 * Tour step configuration
 */
export interface TourStepConfig {
	/** Unique identifier for the step */
	id: string;
	/** Title displayed in the tooltip */
	title: string;
	/** Description/explanation text (wizard context - Auto Run active) */
	description: string;
	/** Generic description (hamburger menu context - general overview) */
	descriptionGeneric?: string;
	/** CSS selector for the element to spotlight, or null for no spotlight */
	selector: string | null;
	/** Preferred tooltip position relative to spotlight
	 * - 'center-overlay': Centers tooltip over the spotlight element itself
	 * - 'center': Centers tooltip on screen (no spotlight)
	 */
	position?: 'top' | 'bottom' | 'left' | 'right' | 'center' | 'center-overlay';
	/** UI actions to perform before showing this step */
	uiActions?: TourUIAction[];
	/** Computed spotlight info (set at runtime) */
	spotlight?: SpotlightInfo;
}

/**
 * Information about the current spotlight position/size
 */
export interface SpotlightInfo {
	/** Element bounding rectangle */
	rect: {
		x: number;
		y: number;
		width: number;
		height: number;
	};
	/** Padding around the spotlight */
	padding: number;
	/** Border radius for the spotlight */
	borderRadius: number;
}

/**
 * Tour hook options
 */
interface UseTourOptions {
	/** Whether the tour is currently active */
	isOpen: boolean;
	/** Callback when tour completes (finished or skipped) */
	onComplete: () => void;
	/** Starting step index */
	startStep?: number;
	/** Callback to execute UI actions */
	onUIAction?: (action: TourUIAction) => void;
}

/**
 * Tour hook return value
 */
interface UseTourReturn {
	/** Current step configuration */
	currentStep: TourStepConfig | null;
	/** Current step index (0-based) */
	currentStepIndex: number;
	/** Total number of steps */
	totalSteps: number;
	/** Current spotlight position/size info */
	spotlight: SpotlightInfo | null;
	/** Whether currently transitioning between steps */
	isTransitioning: boolean;
	/** Whether position has been calculated and tooltip is ready to show */
	isPositionReady: boolean;
	/** Advance to next step */
	nextStep: () => void;
	/** Go back to previous step */
	previousStep: () => void;
	/** Go to a specific step by index */
	goToStep: (stepIndex: number) => void;
	/** Skip/end the tour */
	skipTour: () => void;
	/** Whether on the last step */
	isLastStep: boolean;
}

/**
 * Calculate element position for spotlight
 * Supports multiple selectors separated by commas - combines their bounding boxes
 */
function getElementRect(selector: string | null): DOMRect | null {
	if (!selector) return null;

	// Support multiple selectors separated by commas
	const selectors = selector.split(',').map((s) => s.trim());
	const rects: DOMRect[] = [];

	for (const sel of selectors) {
		const element = document.querySelector(sel);
		if (element) {
			rects.push(element.getBoundingClientRect());
		}
	}

	if (rects.length === 0) {
		console.warn(`[Tour] No elements found for selector(s): ${selector}`);
		return null;
	}

	// If single element, return its rect directly
	if (rects.length === 1) {
		return rects[0];
	}

	// Combine multiple rects into one bounding box
	const minX = Math.min(...rects.map((r) => r.x));
	const minY = Math.min(...rects.map((r) => r.y));
	const maxX = Math.max(...rects.map((r) => r.x + r.width));
	const maxY = Math.max(...rects.map((r) => r.y + r.height));

	// Create a synthetic DOMRect-like object
	return {
		x: minX,
		y: minY,
		width: maxX - minX,
		height: maxY - minY,
		top: minY,
		left: minX,
		bottom: maxY,
		right: maxX,
		toJSON: () => ({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }),
	} as DOMRect;
}

/**
 * Dispatch a custom tour event for UI components to respond to
 */
function dispatchTourEvent(action: TourUIAction) {
	const event = new CustomEvent('tour:action', {
		detail: action,
	});
	window.dispatchEvent(event);
}

/**
 * useTour - Hook for managing the tour overlay
 *
 * Handles step progression, spotlight positioning, and UI state
 * management for the onboarding tour.
 */
export function useTour({
	isOpen,
	onComplete,
	startStep = 0,
	onUIAction,
}: UseTourOptions): UseTourReturn {
	const [currentStepIndex, setCurrentStepIndex] = useState(startStep);
	const [spotlight, setSpotlight] = useState<SpotlightInfo | null>(null);
	const [isTransitioning, setIsTransitioning] = useState(false);
	// Track whether position has been calculated for current step
	const [isPositionReady, setIsPositionReady] = useState(false);
	const transitionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
	const repositionTimeoutRef = useRef<NodeJS.Timeout | null>(null);

	const totalSteps = tourSteps.length;
	const currentStep = tourSteps[currentStepIndex] || null;
	const isLastStep = currentStepIndex === totalSteps - 1;

	/**
	 * Update spotlight position for current step
	 */
	const updateSpotlight = useCallback(() => {
		if (!currentStep) {
			setSpotlight(null);
			setIsPositionReady(true);
			return;
		}

		const rect = getElementRect(currentStep.selector);

		if (rect) {
			setSpotlight({
				rect: {
					x: rect.x,
					y: rect.y,
					width: rect.width,
					height: rect.height,
				},
				padding: 8,
				borderRadius: 8,
			});
		} else {
			// No element found or no selector - no spotlight
			setSpotlight(null);
		}

		// Mark position as ready after spotlight is set
		setIsPositionReady(true);
	}, [currentStep]);

	/**
	 * Execute UI actions for a step
	 */
	const executeUIActions = useCallback(
		(step: TourStepConfig) => {
			if (!step.uiActions || step.uiActions.length === 0) return;

			for (const action of step.uiActions) {
				if (onUIAction) {
					onUIAction(action);
				} else {
					// Dispatch event for components to handle
					dispatchTourEvent(action);
				}
			}
		},
		[onUIAction]
	);

	/**
	 * Go to a specific step with transition animation
	 */
	const goToStep = useCallback(
		(stepIndex: number) => {
			if (stepIndex < 0 || stepIndex >= totalSteps) return;

			// Clear any pending timeouts
			if (transitionTimeoutRef.current) {
				clearTimeout(transitionTimeoutRef.current);
			}
			if (repositionTimeoutRef.current) {
				clearTimeout(repositionTimeoutRef.current);
			}

			// Start transition - hide tooltip and mark position as not ready
			setIsTransitioning(true);
			setIsPositionReady(false);

			// After short delay, update step and execute UI actions
			transitionTimeoutRef.current = setTimeout(() => {
				setCurrentStepIndex(stepIndex);

				const nextStep = tourSteps[stepIndex];
				if (nextStep) {
					executeUIActions(nextStep);
				}

				// After UI actions settle, end transition phase
				// Position will be calculated in updateSpotlight effect
				repositionTimeoutRef.current = setTimeout(() => {
					setIsTransitioning(false);
				}, 200);
			}, 150);
		},
		[totalSteps, executeUIActions]
	);

	/**
	 * Advance to next step
	 */
	const nextStep = useCallback(() => {
		if (isLastStep) {
			// Complete the tour
			onComplete();
		} else {
			goToStep(currentStepIndex + 1);
		}
	}, [currentStepIndex, isLastStep, goToStep, onComplete]);

	/**
	 * Go back to previous step
	 */
	const previousStep = useCallback(() => {
		if (currentStepIndex > 0) {
			goToStep(currentStepIndex - 1);
		}
	}, [currentStepIndex, goToStep]);

	/**
	 * Skip/end the tour
	 */
	const skipTour = useCallback(() => {
		onComplete();
	}, [onComplete]);

	// Initialize tour when opened
	useEffect(() => {
		if (isOpen) {
			// Reset position ready state - will be set true after spotlight position is calculated
			setIsPositionReady(false);
			setCurrentStepIndex(startStep);
			const initialStep = tourSteps[startStep];
			if (initialStep) {
				executeUIActions(initialStep);
			}
		}
	}, [isOpen, startStep, executeUIActions]);

	// Update spotlight when step changes
	useEffect(() => {
		if (isOpen && !isTransitioning) {
			// Small delay to let UI actions settle
			const timer = setTimeout(updateSpotlight, 100);
			return () => clearTimeout(timer);
		}
	}, [isOpen, currentStepIndex, isTransitioning, updateSpotlight]);

	// Handle window resize - reposition spotlight
	useEffect(() => {
		if (!isOpen) return;

		const handleResize = () => {
			updateSpotlight();
		};

		window.addEventListener('resize', handleResize);
		return () => window.removeEventListener('resize', handleResize);
	}, [isOpen, updateSpotlight]);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			if (transitionTimeoutRef.current) {
				clearTimeout(transitionTimeoutRef.current);
			}
			if (repositionTimeoutRef.current) {
				clearTimeout(repositionTimeoutRef.current);
			}
		};
	}, []);

	return {
		currentStep,
		currentStepIndex,
		totalSteps,
		spotlight,
		isTransitioning,
		isPositionReady,
		nextStep,
		previousStep,
		goToStep,
		skipTour,
		isLastStep,
	};
}
