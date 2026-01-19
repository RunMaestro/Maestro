import { useEffect } from 'react';

/**
 * Theme colors required for CSS variable management.
 */
export interface ThemeColors {
	/** Accent color used for highlights and scrollbar styling */
	accent: string;
}

/**
 * Dependencies for the useThemeStyles hook.
 */
export interface UseThemeStylesDeps {
	/** Theme colors to apply as CSS variables */
	themeColors: ThemeColors;
}

/**
 * Return type for useThemeStyles hook.
 * Currently empty as all functionality is side effects.
 */
export interface UseThemeStylesReturn {
	// No return values - all functionality is via side effects
}

/**
 * Hook for managing theme-related CSS variables and scrollbar animations.
 *
 * This hook handles:
 * 1. Setting CSS variables for theme colors (used by scrollbar styling)
 * 2. Scrollbar fade animation - highlights scrollbars during active scrolling
 *    and fades them out after inactivity
 *
 * The scrollbar animation works by:
 * - Adding 'scrolling' class during scroll events
 * - Adding 'fading' class when scroll stops (triggers CSS transition)
 * - Removing classes after fade transition completes
 *
 * @param deps - Hook dependencies containing theme colors
 * @returns Empty object (all functionality via side effects)
 */
export function useThemeStyles(deps: UseThemeStylesDeps): UseThemeStylesReturn {
	const { themeColors } = deps;

	// Set CSS variables for theme colors (for scrollbar styling)
	useEffect(() => {
		document.documentElement.style.setProperty('--accent-color', themeColors.accent);
		document.documentElement.style.setProperty('--highlight-color', themeColors.accent);
	}, [themeColors.accent]);

	// Add scroll listeners to highlight scrollbars during active scrolling
	// Uses passive listener and batched RAF updates to avoid blocking scroll
	useEffect(() => {
		const scrollTimeouts = new Map<Element, NodeJS.Timeout>();
		const fadeTimeouts = new Map<Element, NodeJS.Timeout>();
		const pendingUpdates = new Set<Element>();
		let rafId: number | null = null;

		const processUpdates = () => {
			pendingUpdates.forEach((target) => {
				// Cancel any pending fade completion
				const existingFadeTimeout = fadeTimeouts.get(target);
				if (existingFadeTimeout) {
					clearTimeout(existingFadeTimeout);
					fadeTimeouts.delete(target);
				}

				// Add scrolling class, remove fading if present
				target.classList.remove('fading');
				target.classList.add('scrolling');

				// Clear existing timeout for this element
				const existingTimeout = scrollTimeouts.get(target);
				if (existingTimeout) {
					clearTimeout(existingTimeout);
				}

				// Start fade-out after 1 second of no scrolling
				const timeout = setTimeout(() => {
					// Add fading class to trigger CSS transition
					target.classList.add('fading');
					target.classList.remove('scrolling');
					scrollTimeouts.delete(target);

					// Remove fading class after transition completes (500ms)
					const fadeTimeout = setTimeout(() => {
						target.classList.remove('fading');
						fadeTimeouts.delete(target);
					}, 500);
					fadeTimeouts.set(target, fadeTimeout);
				}, 1000);

				scrollTimeouts.set(target, timeout);
			});
			pendingUpdates.clear();
			rafId = null;
		};

		const handleScroll = (e: Event) => {
			const target = e.target as Element;
			if (!target.classList.contains('scrollbar-thin')) return;

			// Batch updates via requestAnimationFrame to avoid blocking scroll
			pendingUpdates.add(target);
			if (!rafId) {
				rafId = requestAnimationFrame(processUpdates);
			}
		};

		// Add listener to capture scroll events (passive for better scroll performance)
		document.addEventListener('scroll', handleScroll, { capture: true, passive: true });

		return () => {
			document.removeEventListener('scroll', handleScroll, true);
			if (rafId) cancelAnimationFrame(rafId);
			scrollTimeouts.forEach((timeout) => clearTimeout(timeout));
			scrollTimeouts.clear();
			fadeTimeouts.forEach((timeout) => clearTimeout(timeout));
			fadeTimeouts.clear();
		};
	}, []);

	return {};
}
