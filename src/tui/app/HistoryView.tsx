import React from 'react';
import { Box, Text } from 'ink';
import { formatTimestamp, type AgentRecord, type HistoryEntryType } from '../../shared/maestro-lib';
import { summaryLine, type HistoryViewState } from './history';
import { OverlayFrame } from './OverlayFrame';

export interface HistoryViewProps {
	agent: AgentRecord;
	state: HistoryViewState;
	width: number;
	height: number;
}

const TYPE_COLORS: Record<HistoryEntryType, string> = {
	USER: 'cyan',
	AUTO: 'yellow',
	CUE: 'magenta',
	AGENT: 'green',
};

/** `USER`, `AUTO`, `CUE`, `AGENT`: the longest is five, plus a gap. */
const TYPE_COLUMN = 6;
/** `Oct 3 2:30 PM` is the longest `smart` stamp, plus a gap. */
const TIME_COLUMN = 15;

/** One agent's history, newest first: type, time, and a one-line summary per entry. */
export function HistoryView({ agent, state, width, height }: HistoryViewProps): React.ReactElement {
	const { entries, cursor } = state;
	// Title takes one line, the border two, and the count line one.
	const room = Math.max(1, height - 4);
	const start = Math.min(Math.max(0, cursor - room + 1), Math.max(0, entries.length - room));
	return (
		<OverlayFrame title={`History: ${agent.name}`} width={width} height={height}>
			{state.problem ? (
				<Text color="yellow" wrap="truncate-end">
					{state.problem}
				</Text>
			) : (
				<>
					{entries.slice(start, start + room).map((entry, offset) => {
						const index = start + offset;
						return (
							<Box key={entry.id}>
								<Text color="#9146FF">{index === cursor ? '›' : ' '}</Text>
								<Box width={TYPE_COLUMN} flexShrink={0}>
									<Text color={TYPE_COLORS[entry.type]}>{entry.type}</Text>
								</Box>
								<Box width={TIME_COLUMN} flexShrink={0}>
									<Text dimColor>{formatTimestamp(entry.timestamp)}</Text>
								</Box>
								<Text wrap="truncate-end" bold={index === cursor}>
									{summaryLine(entry.summary)}
								</Text>
							</Box>
						);
					})}
					<Text dimColor>
						{entries.length === 0
							? 'No entries.'
							: `${cursor + 1} of ${state.total}${state.nextBefore === undefined ? '' : ' (older load as you scroll)'}`}
					</Text>
				</>
			)}
		</OverlayFrame>
	);
}
