import { StateField, StateEffect, type Extension } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';

/**
 * CodeMirror extension that paints search matches driven by the host app's
 * shared search bar - NOT CM6's built-in search panel.
 *
 * The host dispatches `setSearchMatchesEffect` with the full match list and
 * the index of the "current" match. We render every match with class
 * `cm-app-search-match`; the active one is overlaid with
 * `cm-app-search-current` so it stands out without losing the count tint.
 *
 * Decorations are theme-styled via the editor theme (see themeAdapter), so
 * the colors stay consistent with the rest of the search UI.
 */
export interface SearchMatch {
	from: number;
	to: number;
}

export const setSearchMatchesEffect = StateEffect.define<{
	matches: SearchMatch[];
	currentIndex: number;
}>();

const matchDeco = Decoration.mark({ class: 'cm-app-search-match' });
const currentDeco = Decoration.mark({ class: 'cm-app-search-current' });

function buildDecorations(
	matches: SearchMatch[],
	currentIndex: number,
	docLength: number
): DecorationSet {
	if (matches.length === 0) return Decoration.none;
	const ranges: { from: number; to: number; deco: ReturnType<typeof Decoration.mark> }[] = [];
	for (let i = 0; i < matches.length; i++) {
		const m = matches[i];
		// Defensive clamp: matches came from the host's view of the source
		// (which may include or exclude a trailing newline); ignore any range
		// that doesn't fit the live doc to avoid CM6 throwing.
		if (m.from < 0 || m.to > docLength || m.from >= m.to) continue;
		ranges.push({ from: m.from, to: m.to, deco: matchDeco });
		if (i === currentIndex) {
			ranges.push({ from: m.from, to: m.to, deco: currentDeco });
		}
	}
	// CM6's `Decoration.set` requires sorted-by-start ranges; for ties (the
	// match + current overlay sharing a span) the second-arg `sort=true` lets
	// CM6 stable-sort. We pre-sort anyway so the input is already ordered.
	ranges.sort((a, b) => a.from - b.from || a.to - b.to);
	return Decoration.set(
		ranges.map((r) => r.deco.range(r.from, r.to)),
		true
	);
}

export function searchHighlightExtension(): Extension {
	const field = StateField.define<DecorationSet>({
		create() {
			return Decoration.none;
		},
		update(value, tr) {
			let next = value.map(tr.changes);
			for (const e of tr.effects) {
				if (e.is(setSearchMatchesEffect)) {
					next = buildDecorations(e.value.matches, e.value.currentIndex, tr.state.doc.length);
				}
			}
			return next;
		},
		provide: (f) => EditorView.decorations.from(f),
	});
	return [field];
}
