/**
 * Resolve one surface's font family and size from settings.
 *
 * Most of the app gets its typography from the CSS custom properties
 * `applyTypographyVars` publishes, and should NOT use this hook - inheritance
 * is cheaper and reaches portals. This exists for the surfaces that cannot read
 * CSS at all:
 *
 *   - xterm.js measures glyphs and paints to a canvas, so it needs a real
 *     family string and a real number, not `var(--maestro-font-terminal)`.
 *   - CodeMirror 6 compiles its theme into a StyleModule at configure time and
 *     owns `.cm-scroller`'s font, so the value has to be threaded in as a prop.
 *
 * Both call it, so the canvas surfaces and the CSS surfaces can never disagree
 * about what a setting resolved to: the same `resolveSurfaceFont` and
 * `resolveSurfaceFontSize` run on both paths.
 */

import { useSettingsStore } from '../../stores/settingsStore';
import {
	TYPOGRAPHY_SURFACE_SPECS,
	canInherit,
	resolveInheritedFont,
	resolveSurfaceFontSize,
	type TypographySurface,
} from '../../../shared/typography';
import { resolveSurfaceFont, withMonoFallback } from '../../../shared/fontStack';

export interface SurfaceTypography {
	/** CSS font-family value, inheritance and fallback chain applied. */
	fontFamily: string;
	/** Rendered size in px, zoom applied. */
	fontSize: number;
}

/** Read a surface's resolved family. Subscribes to only what it needs. */
export function useSurfaceFontFamily(surface: TypographySurface): string {
	return useSettingsStore((s) => {
		const spec = TYPOGRAPHY_SURFACE_SPECS[surface];
		const interfaceFont = s.fontFamily;
		if (!canInherit(spec)) return withMonoFallback(interfaceFont);
		const stored = (s as unknown as Record<string, string | undefined>)[spec.fontKey];
		// One hop of inheritance first (a surface may follow the terminal), then
		// the fallback chain.
		return resolveSurfaceFont(
			resolveInheritedFont(stored, { interface: interfaceFont, terminal: s.terminalFontFamily }),
			interfaceFont
		);
	});
}

/** Read a surface's rendered size, zoom applied. */
export function useSurfaceFontSize(surface: TypographySurface): number {
	return useSettingsStore((s) => {
		const spec = TYPOGRAPHY_SURFACE_SPECS[surface];
		const own = canInherit(spec)
			? Number((s as unknown as Record<string, number | undefined>)[spec.sizeKey] ?? 0)
			: s.fontSize;
		return resolveSurfaceFontSize(own, s.fontSize, s.fontZoom);
	});
}

/**
 * Both at once.
 *
 * Deliberately NOT one selector returning an object: zustand compares selector
 * results by reference, so a fresh object every render would re-render the
 * subscriber on every unrelated store write. Two primitive selectors compare by
 * value and only fire when their own value actually moves.
 */
export function useSurfaceTypography(surface: TypographySurface): SurfaceTypography {
	const fontFamily = useSurfaceFontFamily(surface);
	const fontSize = useSurfaceFontSize(surface);
	return { fontFamily, fontSize };
}
