import React from 'react';
import { Box, Static } from 'ink';
import type { LogEntryRecord } from '../../shared/maestro-lib';
import { splitFinished } from './entries';
import { TranscriptEntryView } from './TranscriptEntryView';

export interface TranscriptProps {
	entries: readonly LogEntryRecord[];
	width: number;
	expandTools: boolean;
}

/**
 * A transcript written to the terminal as a log (risk R4): finished entries go
 * through Ink's `<Static>`, which prints each once and never redraws it, and
 * only the live tail (from the first tool call still running) is re-rendered
 * on every update.
 *
 * `<Static>` writes above the live frame, into the terminal's scrollback, so
 * it cannot sit inside a bordered pane that has to be redrawn in place, and a
 * printed entry cannot change afterwards (an expand toggle does not reach it).
 * The Conversation pane therefore draws `TranscriptViewport`; this component
 * is for output that is meant to scroll, such as a transcript dump.
 */
export function Transcript({ entries, width, expandTools }: TranscriptProps): React.ReactElement {
	const { finished, live } = splitFinished(entries);
	return (
		<>
			<Static items={finished}>
				{(entry) => (
					<TranscriptEntryView
						key={entry.id}
						entry={entry}
						width={width}
						expandTools={expandTools}
					/>
				)}
			</Static>
			<Box flexDirection="column" width={width}>
				{live.map((entry) => (
					<TranscriptEntryView
						key={entry.id}
						entry={entry}
						width={width}
						expandTools={expandTools}
					/>
				))}
			</Box>
		</>
	);
}
