import React from 'react';
import { Box, Text } from 'ink';
import { OverlayFrame } from '../app/OverlayFrame';
import { windowRows } from '../app/agentRows';
import { highlightSegments, type RankedEntry } from './rank';

export interface PaletteOverlayProps {
	query: string;
	results: readonly RankedEntry[];
	cursor: number;
	width: number;
	height: number;
}

/** Lines the frame spends on its border (2) and title (1), and the query line (1). */
const CHROME_LINES = 4;

/** `Ctrl-K`: a search box over actions, agents, and tabs. */
export function PaletteOverlay({
	query,
	results,
	cursor,
	width,
	height,
}: PaletteOverlayProps): React.ReactElement {
	const keyed = results.map((result) => ({ ...result, key: result.entry.id }));
	const { rows } = windowRows(keyed, keyed[cursor]?.key, Math.max(1, height - CHROME_LINES));
	return (
		<OverlayFrame title="Command palette" width={width} height={height}>
			<Box>
				<Text color="#9146FF">› </Text>
				<Text>{query}</Text>
				<Text inverse> </Text>
			</Box>
			{rows.length === 0 ? (
				<Text dimColor>No match</Text>
			) : (
				rows.map(({ entry, indices, key }) => {
					const selected = key === keyed[cursor]?.key;
					return (
						<Box key={key}>
							<Text color="#9146FF">{selected ? '›' : ' '}</Text>
							<Box flexGrow={1} flexShrink={1}>
								<Text wrap="truncate-end" bold={selected}>
									{highlightSegments(entry.label, indices).map((segment, at) => (
										<Text
											key={at}
											color={segment.match ? '#9146FF' : undefined}
											underline={segment.match}
										>
											{segment.text}
										</Text>
									))}
								</Text>
							</Box>
							<Box flexShrink={0} marginLeft={1}>
								<Text dimColor>{entry.detail}</Text>
							</Box>
						</Box>
					);
				})
			)}
		</OverlayFrame>
	);
}
