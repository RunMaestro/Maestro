/**
 * Publish the resolved typography onto `document.documentElement` as CSS
 * custom properties.
 *
 * This is what makes a font setting reach the whole app rather than only the
 * components that happen to thread a `fontFamily` prop down. Two classes of
 * surface could not be reached any other way:
 *
 *   - Anything that portals to `document.body`. Forty-seven components do, and
 *     `body` was pinned to a literal JetBrains Mono stack, so every context
 *     menu, tooltip, popover, and portalled modal ignored the interface font.
 *     The toast fix that preceded this was one instance of that bug; this is
 *     the general form.
 *   - Tailwind's `font-mono` utility, used in ~200 places for chips, hashes,
 *     paths, and inline code. It compiled to a hard-coded stack, so none of
 *     them followed the user's chosen monospace font. It now compiles to
 *     `var(--maestro-font-mono)`.
 *
 * Custom properties inherit through the document, so a portal at `body` level
 * resolves them exactly like an in-tree node. Every variable also carries a CSS
 * fallback, which is what renders during the first paint before this runs.
 */

import {
	MONO_ACCENT_VAR,
	TYPOGRAPHY_SURFACE_LIST,
	canInherit,
	resolveInheritedFont,
	resolveSurfaceFontSize,
	type TypographySurface,
} from '../../shared/typography';
import { resolveSurfaceFont, withMonoFallback } from '../../shared/fontStack';

/** The five font families and five sizes, plus the base size and zoom. */
export interface TypographyVarInput {
	fonts: Record<TypographySurface, string | undefined>;
	sizes: Record<TypographySurface, number | undefined>;
	/** Interface size in px, before zoom. The base every surface inherits. */
	baseSize: number;
	/** Cmd+= / Cmd+- multiplier applied to every surface equally. */
	zoom: number;
}

/**
 * The values written, returned so tests can assert on them without a DOM and
 * so the web client can ship the same map over its own transport.
 */
export function computeTypographyVars(input: TypographyVarInput): Record<string, string> {
	const vars: Record<string, string> = {};
	const interfaceFont = input.fonts.interface;

	// The two roots every other surface may follow, resolved once.
	const roots = { interface: interfaceFont, terminal: input.fonts.terminal };

	for (const spec of TYPOGRAPHY_SURFACE_LIST) {
		// `resolveInheritedFont` walks at most one hop of inheritance (a surface
		// may follow the terminal, which may itself follow the interface), and
		// `resolveSurfaceFont` then appends the fallback chain so a bare family
		// name degrades to monospace rather than the browser's serif default.
		vars[spec.fontVar] = canInherit(spec)
			? resolveSurfaceFont(resolveInheritedFont(input.fonts[spec.id], roots), interfaceFont)
			: withMonoFallback(interfaceFont);

		vars[spec.sizeVar] = `${resolveSurfaceFontSize(
			canInherit(spec) ? input.sizes[spec.id] : input.baseSize,
			input.baseSize,
			input.zoom
		)}px`;
	}

	// The code face. Follows the TERMINAL font rather than the interface font:
	// `font-mono` marks the places that want a code face specifically, and the
	// terminal font is the user's explicit answer to "what should code look
	// like". Falls through to the interface font when the terminal inherits.
	vars[MONO_ACCENT_VAR] = resolveSurfaceFont(
		resolveInheritedFont(input.fonts.terminal, roots),
		interfaceFont
	);

	// Drives the .modal-w-* utilities so fixed-width modals grow with the zoom.
	// 14px is the design baseline the widths were drawn against.
	const effectiveBase = resolveSurfaceFontSize(input.baseSize, input.baseSize, input.zoom);
	vars['--font-scale'] = String(effectiveBase / 14);

	return vars;
}

/**
 * Write the variables and the root font size.
 *
 * The root `font-size` stays a real declaration rather than a variable because
 * Tailwind's rem-based spacing scale resolves against it; a custom property
 * cannot serve that role.
 */
export function applyTypographyVars(input: TypographyVarInput, root?: HTMLElement): void {
	const target = root ?? document.documentElement;
	const vars = computeTypographyVars(input);

	for (const [name, value] of Object.entries(vars)) {
		target.style.setProperty(name, value);
	}

	const effectiveBase = resolveSurfaceFontSize(input.baseSize, input.baseSize, input.zoom);
	target.style.fontSize = `${effectiveBase}px`;
}
