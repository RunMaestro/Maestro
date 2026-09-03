import { useEffect } from 'react';
import { hexToRgb } from '../../../shared/colorContrast';
import type { ThemeMode } from '../../../shared/theme-types';
import type { GlossLevel } from '../../../shared/themeGloss';

/**
 * The light source the gloss rules mix, as an `R G B` triple for `rgb(... / a%)`.
 *
 * Derived from the theme's own `textMain` so a theme declares what colour its
 * light is, rather than the sheen picking up whatever `color` happens to be
 * inherited at each chrome root. That was the earlier approach and it makes the
 * gloss non-deterministic: a container that sets a dim text colour glosses
 * differently from one that does not, so the same level renders at two
 * strengths in the same window for reasons no one chose.
 *
 * Falls back to white when the palette carries a non-hex colour (a custom theme
 * may use any CSS colour). White is the right failure: gloss is dark-theme only,
 * and a white light source is what every dark theme's `textMain` approximates.
 */
function sheenRgbTriple(textMain: string): string {
	const rgb = hexToRgb(textMain);
	return rgb ? `${rgb.r} ${rgb.g} ${rgb.b}` : '255 255 255';
}

/**
 * The accent as a bare `R, G, B` triple for `rgba(var(--accent-rgb), a)`.
 *
 * Comma separated on purpose, unlike `--sheen-rgb`: the sheen is consumed by
 * the modern `rgb(... / a%)` form, while this one is for rules that still take
 * the legacy `rgba(r, g, b, a)` form. One separator cannot serve both, so the
 * two vars stay separate rather than one being reformatted at each call site.
 *
 * Returns null when the palette carries a non-hex accent (a custom theme may
 * use any CSS colour). The caller then clears the property so every
 * `var(--accent-rgb, ...)` falls back to its own literal, which is a colour
 * someone chose - unlike a guessed triple, and unlike a stale value left over
 * from the previously active theme.
 */
function accentRgbTriple(accent: string): string | null {
	const rgb = hexToRgb(accent);
	return rgb ? `${rgb.r}, ${rgb.g}, ${rgb.b}` : null;
}

/**
 * The accent thinned to `percent` opacity, for the themed glow effects.
 *
 * `color-mix` rather than an rgba() built from `hexToRgb`, so a custom theme
 * whose accent is any valid CSS colour (`oklch(...)`, a named colour, a
 * gradient stop function) still tints its glows instead of dropping to the
 * hard-coded indigo fallback. It is the same technique the max-gloss active
 * ring already uses in index.css.
 *
 * The percentages are chosen to match the alphas each effect's CSS fallback
 * carried, so wiring the theme in changes the hue and not the intensity.
 */
function accentMix(accent: string, percent: number): string {
	return `color-mix(in srgb, ${accent} ${percent}%, transparent)`;
}

/**
 * Theme colors required for CSS variable management.
 *
 * This is a structural subset of `ThemeColors` from `src/shared/theme-types.ts`
 * - only the tokens consumed by global CSS rules are listed here. Keep these
 * field names in sync with the shared type. The hook is happy to receive the
 * full theme palette; it just reads what it needs.
 */
export interface ThemeColors {
	/** Accent color used for highlights and active-scrolling scrollbar thumbs */
	accent: string;
	/** Border color - used as the idle scrollbar thumb color (theme-aware,
	 *  works on both light and dark themes unlike the previous hardcoded
	 *  rgba(255,255,255,0.15) which was invisible on light themes). */
	border: string;
	/** Dimmed text color - used as the hover scrollbar thumb color. Slightly
	 *  more visible than `border`, still subtle. */
	textDim: string;
	/** Activity background - used as the very subtle scrollbar track tint.
	 *  Track is mostly transparent so this only matters for tall narrow
	 *  containers where the track is visible. */
	bgActivity: string;
	/** Main text color - the light source the surface-gloss rules mix. */
	textMain: string;
	/** Main background color, published as `--bg-main`. */
	bgMain: string;
	/** Sidebar background color, published as `--bg-sidebar`. */
	bgSidebar: string;
	/** Text color for accent contexts, published as `--accent-text`. */
	accentText: string;
	/** Text color for use ON accent backgrounds, published as `--accent-fg`. */
	accentForeground: string;
	/** Success state color, published as `--success`. */
	success: string;
	/** Warning state color, published as `--warning`. */
	warning: string;
	/** Error state color, published as `--error`. */
	error: string;
}

/**
 * Dependencies for the useThemeStyles hook.
 */
export interface UseThemeStylesDeps {
	/** Theme colors to apply as CSS variables */
	themeColors: ThemeColors;
	/** Active theme's mode, published as `<html data-theme-mode>` so CSS can opt out on light themes. */
	themeMode: ThemeMode;
	/** Surface gloss level, published as `<html data-gloss>`. */
	glossLevel: GlossLevel;
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
 *   --fx-quiet               = themeColors.textDim
 *   --sheen-rgb              = themeColors.textMain as "R G B"
 *   --bg-main                = themeColors.bgMain
 *   --bg-sidebar             = themeColors.bgSidebar
 *   --bg-activity            = themeColors.bgActivity
 *   --border                 = themeColors.border
 *   --text-main              = themeColors.textMain
 *   --text-dim               = themeColors.textDim
 *   --accent-text            = themeColors.accentText
 *   --accent-fg              = themeColors.accentForeground
 *   --success                = themeColors.success
 *   --warning                = themeColors.warning
 *   --error                  = themeColors.error
 *   --accent-rgb             = themeColors.accent as "R, G, B"
 *   --pulse-color            = accent at 40% (highlight-pulse ring)
 *   --glow-color             = accent at 15% (card-glow hover halo)
 *   --token-highlight        = themeColors.accent (token-update flash)
 *
 * The palette block below `--sheen-rgb` publishes the whole theme rather than
 * only the tokens a rule happens to need today. A CSS rule that wants a theme
 * colour should be able to reach for it without a matching TypeScript change,
 * which is what forced every earlier themed effect to be hard-coded to one
 * theme's hex.
 *
 * Scrollbar styling lives in `src/renderer/index.css` and consumes these
 * variables. To add a new themed CSS rule app-wide, set the property here and
 * reference it in index.css with a sensible fallback.
 *
 * It is also the single place that publishes theme-driven ATTRIBUTES on the
 * same element:
 *
 *   data-theme-mode = 'light' | 'dark' | 'vibe'
 *   data-gloss      = the `themeGloss` setting
 *
 * Both are written together on purpose. The gloss rules in index.css opt out
 * entirely on light themes, so a build that sets one attribute from here and
 * the other from a stray effect elsewhere can render a light theme with a dark
 * theme's highlights for a frame, and nothing in a diff shows it. If you need a
 * new theme-driven attribute, add it here rather than starting a second writer.
 *
 * This hook also handles the scrollbar fade-on-idle animation by toggling
 * `.scrolling` / `.fading` classes on elements with `.scrollbar-thin`. Those
 * classes drive the bright-on-scroll → fade-to-transparent transition in CSS.
 *
 * @param deps - Hook dependencies containing theme colors
 * @returns Empty object (all functionality via side effects)
 */
export function useThemeStyles(deps: UseThemeStylesDeps): UseThemeStylesReturn {
	const { themeColors, themeMode, glossLevel } = deps;

	// Set CSS variables for theme colors. App-wide scrollbar styling in
	// index.css references these via var(--scrollbar-*) so every scrollable
	// container picks up the active theme automatically - no per-component
	// changes required.
	useEffect(() => {
		const root = document.documentElement.style;
		root.setProperty('--accent-color', themeColors.accent);
		root.setProperty('--highlight-color', themeColors.accent);
		root.setProperty('--scrollbar-thumb', themeColors.border);
		root.setProperty('--scrollbar-thumb-hover', themeColors.textDim);
		root.setProperty('--scrollbar-thumb-active', themeColors.accent);
		root.setProperty('--scrollbar-track', themeColors.bgActivity);
		// Quiet/secondary control colour, consumed by the Files toolbar hierarchy.
		root.setProperty('--fx-quiet', themeColors.textDim);
		// Light source for the surface-gloss rules. A triple rather than a finished
		// colour, so the alpha stays in index.css where the levels are defined and
		// only the hue crosses the bridge.
		root.setProperty('--sheen-rgb', sheenRgbTriple(themeColors.textMain));

		// The rest of the palette, one var per token. Purely additive: a rule
		// that wants a theme colour reads it from here instead of restating a
		// hex that only matches whichever theme its author had open.
		root.setProperty('--bg-main', themeColors.bgMain);
		root.setProperty('--bg-sidebar', themeColors.bgSidebar);
		root.setProperty('--bg-activity', themeColors.bgActivity);
		root.setProperty('--border', themeColors.border);
		root.setProperty('--text-main', themeColors.textMain);
		root.setProperty('--text-dim', themeColors.textDim);
		root.setProperty('--accent-text', themeColors.accentText);
		root.setProperty('--accent-fg', themeColors.accentForeground);
		root.setProperty('--success', themeColors.success);
		root.setProperty('--warning', themeColors.warning);
		root.setProperty('--error', themeColors.error);

		// Themed glow effects. Their keyframes in index.css used to fall back to a
		// hard-coded indigo or Dracula purple on every theme, because nothing ever
		// wrote these vars. The fallbacks stay in place for any stylesheet loaded
		// before this effect runs.
		root.setProperty('--pulse-color', accentMix(themeColors.accent, 40));
		root.setProperty('--glow-color', accentMix(themeColors.accent, 15));
		// Full strength, so it is the accent itself rather than a 100% mix that
		// only restates it. The token flash is text colour, not a halo.
		root.setProperty('--token-highlight', themeColors.accent);

		const accentRgb = accentRgbTriple(themeColors.accent);
		if (accentRgb) {
			root.setProperty('--accent-rgb', accentRgb);
		} else {
			root.removeProperty('--accent-rgb');
		}
	}, [
		themeColors.accent,
		themeColors.border,
		themeColors.textDim,
		themeColors.bgActivity,
		themeColors.textMain,
		themeColors.bgMain,
		themeColors.bgSidebar,
		themeColors.accentText,
		themeColors.accentForeground,
		themeColors.success,
		themeColors.warning,
		themeColors.error,
	]);

	// Publish the theme mode and the gloss level as attributes. Kept in one
	// effect so the pair is always written in the same commit: the gloss rules
	// key off both, and updating them out of step paints a light theme with dark
	// highlights until the second effect catches up.
	useEffect(() => {
		const root = document.documentElement;
		root.dataset.themeMode = themeMode;
		root.dataset.gloss = glossLevel;
	}, [themeMode, glossLevel]);

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
