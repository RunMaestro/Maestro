import React from 'react';
import { Box } from 'ink';
import type { LogEntryRecord } from '../../shared/maestro-lib';
import { entryBodyBlocks } from './entries';
import { TranscriptEntryView } from './TranscriptEntryView';

export interface TranscriptViewportProps {
	entries: readonly LogEntryRecord[];
	width: number;
	height: number;
	expandTools: boolean;
}

/** A cheap line count for one entry: enough to know when the window is full, not exact. */
function estimateEntryLines(entry: LogEntryRecord, width: number, expandTools: boolean): number {
	const body = entryBodyBlocks(entry, expandTools).length > 0 ? entry.text : '';
	const wrapped = body
		.split('\n')
		.reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / Math.max(1, width))), 0);
	// Header plus the blank line above it; code, tables and lists add some lines beyond the text.
	return wrapped + 2;
}

/**
 * The newest part of a transcript, sized to a pane. The box is as tall as the
 * pane, anchors its content to the bottom, and clips what overflows at the top,
 * so the newest line is always on screen. Only as many trailing entries as can
 * fill the pane are mounted (a transcript can run to thousands), and each
 * entry's parse is cached, so a redraw costs the window and not the history.
 */
export function TranscriptViewport({
	entries,
	width,
	height,
	expandTools,
}: TranscriptViewportProps): React.ReactElement {
	let budget = height;
	let start = entries.length;
	while (start > 0 && budget > 0) {
		start -= 1;
		budget -= estimateEntryLines(entries[start]!, width, expandTools);
	}
	const shown = entries.slice(start);
	return (
		<Box
			flexDirection="column"
			justifyContent="flex-end"
			width={width}
			height={height}
			overflow="hidden"
		>
			{shown.map((entry) => (
				<Box key={entry.id} flexShrink={0} flexDirection="column">
					<TranscriptEntryView entry={entry} width={width} expandTools={expandTools} />
				</Box>
			))}
		</Box>
	);
}
