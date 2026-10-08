import type { LogEntry } from '../../../types';

/**
 * Map every raw log id to the id of the transcript row that actually renders it.
 *
 * The AI transcript is not a 1:1 render of `tab.logs`. Three stages collapse or
 * drop entries before anything reaches the DOM:
 *   1. `collapseAiResponseLogs` folds a turn's streamed response entries into one,
 *   2. the per-tab Thinking / `showToolCalls` toggles filter tool entries out,
 *   3. `groupSubagentToolLogs` nests subagent tool badges under their parent.
 *
 * So anything holding a RAW log id (cross-tab message search hands out
 * `log.id` straight off `tab.logs`) has to resolve it to the row that exists,
 * or the scroll silently finds nothing.
 *
 * Rather than have each stage thread its own mapping through, this derives the
 * answer from the two lists that bracket the pipeline. Every stage keeps the
 * FIRST entry's id as its group's id and preserves relative order, so the row
 * for a given entry is the last rendered row at or before it in the original
 * order. Entries filtered out entirely (tools with Thinking off) resolve to the
 * preceding visible row, which lands the user next to the hit instead of nowhere.
 */
export function buildRenderedIdMap(
	renderedLogs: LogEntry[],
	originalLogs: LogEntry[]
): Map<string, string> {
	const renderedIds = new Set(renderedLogs.map((l) => l.id));
	const map = new Map<string, string>();

	let currentRowId: string | null = null;
	for (const log of originalLogs) {
		// A rendered row opens a new span; everything after it (until the next
		// rendered row) was folded into or hidden behind it.
		if (renderedIds.has(log.id)) currentRowId = log.id;
		if (currentRowId !== null) map.set(log.id, currentRowId);
	}

	return map;
}
