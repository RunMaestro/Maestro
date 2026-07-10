/**
 * Concerto chat "point" links.
 *
 * An agent can drop a normal-looking markdown link with a `concerto:` scheme in
 * its chat message to point the user at a view it composed, instead of
 * re-typing the view's contents:
 *
 *   [watch the deploy](maestro://concerto/movement/deploy-status)
 *   [the failing suite](maestro://concerto/cadenza/tests)
 *
 * The chat Markdown renderer turns these into an inline chip; clicking it
 * un-stashes + pulses the referenced Movement panel, or pulses the referenced
 * Cadenza card. This module is the pure parse + dispatch seam so both the link
 * detector and the click handler share one source of truth.
 */

import { useMovementStore } from '../stores/movementStore';

export interface ConcertoTarget {
	surface: 'movement' | 'cadenza';
	id: string;
}

/** Matches `maestro://concerto/<surface>/<id>` (canonical, survives sanitize) and
 *  the bare `concerto:<surface>/<id>` fallback. The id may be URL-encoded. */
const CONCERTO_HREF = /^(?:maestro:\/\/concerto\/|concerto:)(movement|cadenza)\/(.+)$/i;

/** Parse a `concerto:` href into its surface + id, or null if it isn't one. */
export function parseConcertoHref(href: string | undefined | null): ConcertoTarget | null {
	if (!href) return null;
	const match = CONCERTO_HREF.exec(href.trim());
	if (!match) return null;
	let id = match[2];
	try {
		id = decodeURIComponent(id);
	} catch {
		// Keep the raw id if it wasn't percent-encoded.
	}
	if (!id) return null;
	return { surface: match[1].toLowerCase() as ConcertoTarget['surface'], id };
}

/** Flash/focus the Movement or Cadenza a `concerto:` link points at. No-op for a
 *  non-concerto href. Movements live in this (main) window, so flash the store
 *  directly; cadenzas live in the separate HUD renderer, so route the flash
 *  through main, which forwards it to whichever renderer holds the card. */
export function flashConcertoTarget(href: string | undefined | null): boolean {
	const target = parseConcertoHref(href);
	if (!target) return false;
	if (target.surface === 'movement') {
		useMovementStore.getState().flashItem(target.id);
	} else {
		window.maestro?.process?.flashCadenza?.(target.id);
	}
	return true;
}
