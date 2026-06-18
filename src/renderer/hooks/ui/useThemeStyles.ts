import { useEffect } from 'react';

/**
 * Theme colors required for CSS variable management.
 *
 * This is a structural subset of `ThemeColors` from `src/shared/theme-types.ts`
 * — only the tokens consumed by global CSS rules are listed here. Keep these
 * field names in sync with the shared type. The hook is happy to receive the
 * full theme palette; it just reads what it needs.
 */
export interface ThemeColors {
	/** Accent color used for highlights and active-scrolling scrollbar thumbs */
	accent: string;
	/** Border color — used as the idle scrollbar thumb color (theme-aware,
	 *  works on both light and dark themes unlike the previous hardcoded
	 *  rgba(255,255,255,0.15) which was invisible on light themes). */
	border: string;
	/** Dimmed text color — used as the hover scrollbar thumb color. Slightly
	 *  more visible than `border`, still subtle. */
	textDim: string;
	/** Activity background — used as the very subtle scrollbar track tint.
	 *  Track is mostly transparent so this only matters for tall narrow
	 *  containers where the track is visible. */
	bgActivity: string;
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
 * This hook is the **single bridge** between the React theme system and any
 * CSS that needs theme colors (notably the app-wide scrollbar styling in
 * index.css). It exposes theme tokens as CSS custom properties on
 * `document.documentElement` so global stylesheets can reference them.
 *
 * Currently injected CSS variables:
 *
 *   --accent-color           = themeColors.accent
 *   --highlight-color        = themeColors.accent (alias for legacy refs)
 *   --scrollbar-thumb        = themeColors.border
 *   --scrollbar-thumb-hover  = themeColors.textDim
 *   --scrollbar-thumb-active = themeColors.accent
 *   --scrollbar-track        = themeColors.bgActivity
 *
 * Scrollbar styling lives in `src/renderer/index.css` and consumes these
 * variables. To add a new themed CSS rule app-wide, set the property here and
 * reference it in index.css with a sensible fallback.
 *
 * This hook also handles the scrollbar fade-on-idle animation by toggling
 * `.scrolling` / `.fading` classes on elements with `.scrollbar-thin`. Those
 * classes drive the bright-on-scroll → fade-to-transparent transition in CSS.
 *
 * @param deps - Hook dependencies containing theme colors
 * @returns Empty object (all functionality via side effects)
 */
export function useThemeStyles(deps: UseThemeStylesDeps): UseThemeStylesReturn {
	const { themeColors } = deps;

	// Set CSS variables for theme colors. App-wide scrollbar styling in
	// index.css references these via var(--scrollbar-*) so every scrollable
	// container picks up the active theme automatically — no per-component
	// changes required.
	useEffect(() => {
		const root = document.documentElement.style;
		root.setProperty('--accent-color', themeColors.accent);
		root.setProperty('--highlight-color', themeColors.accent);
		root.setProperty('--scrollbar-thumb', themeColors.border);
		root.setProperty('--scrollbar-thumb-hover', themeColors.textDim);
		root.setProperty('--scrollbar-thumb-active', themeColors.accent);
		root.setProperty('--scrollbar-track', themeColors.bgActivity);
	}, [themeColors.accent, themeColors.border, themeColors.textDim, themeColors.bgActivity]);

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
			// Scroll events can fire on Document and Window in addition to
			// Elements (e.g. body scrolling), neither of which has classList.
			// Guard with instanceof so non-Element targets are safely ignored
			// instead of crashing the listener with `Cannot read properties of
			// undefined (reading 'contains')`.
			const target = e.target;
			if (!(target instanceof Element)) return;
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
