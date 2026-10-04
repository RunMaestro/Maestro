import { fuzzyMatchWithIndices, fuzzyMatchWithScore } from '../../shared/maestro-lib';
import type { PaletteEntry } from './entries';

export interface RankedEntry {
	entry: PaletteEntry;
	/** Positions in `entry.label` the query matched, for highlighting. Empty without a query. */
	indices: number[];
}

/**
 * The entries a query matches, best first. With no query every entry stays, in
 * the order given (actions, agents, tabs). Equal scores keep that order, so the
 * list does not shuffle between keystrokes.
 */
export function rankPaletteEntries(entries: readonly PaletteEntry[], query: string): RankedEntry[] {
	const text = query.trim();
	if (!text) return entries.map((entry) => ({ entry, indices: [] }));
	const scored: { entry: PaletteEntry; score: number; order: number }[] = [];
	entries.forEach((entry, order) => {
		const { matches, score } = fuzzyMatchWithScore(entry.label, text);
		if (matches) scored.push({ entry, score, order });
	});
	scored.sort((a, b) => b.score - a.score || a.order - b.order);
	return scored.map(({ entry }) => ({
		entry,
		indices: fuzzyMatchWithIndices(entry.label, text),
	}));
}

export interface LabelSegment {
	text: string;
	match: boolean;
}

/** Splits a label into runs of matched and unmatched characters, so a row draws few spans. */
export function highlightSegments(label: string, indices: readonly number[]): LabelSegment[] {
	if (indices.length === 0) return [{ text: label, match: false }];
	const hit = new Set(indices);
	const segments: LabelSegment[] = [];
	for (let at = 0; at < label.length; at++) {
		const match = hit.has(at);
		const last = segments[segments.length - 1];
		if (last && last.match === match) last.text += label[at];
		else segments.push({ text: label[at], match });
	}
	return segments;
}
