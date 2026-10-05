import React from 'react';
import { Box, Text } from 'ink';
import type { SettingsSnapshot } from '../../shared/maestro-lib';
import { windowRows } from '../app/agentRows';
import { OverlayFrame } from '../app/OverlayFrame';
import { keysFor } from '../keymap';
import { settingsLines } from './lines';

const ACCENT = '#9146FF';
const LABEL_WIDTH = 24;
/** Title and border take three lines; the scroll hint takes one more. */
const CHROME_LINES = 4;

export interface SettingsViewProps {
	snapshot: SettingsSnapshot;
	/** The line at the cursor; the window follows it. */
	cursor: number;
	width: number;
	height: number;
}

/** What the desktop holds, read-only, on the same move keys every list uses. */
export function SettingsView({
	snapshot,
	cursor,
	width,
	height,
}: SettingsViewProps): React.ReactElement {
	const lines = settingsLines(snapshot);
	const capacity = Math.max(1, height - CHROME_LINES);
	const { start, rows } = windowRows(lines, lines[cursor]?.key, capacity);
	return (
		<OverlayFrame title="Settings (read-only)" width={width} height={height}>
			{rows.map((line) =>
				line.kind === 'heading' ? (
					<Text key={line.key} bold color={ACCENT} wrap="truncate-end">
						{line.text}
					</Text>
				) : line.kind === 'warn' ? (
					<Text key={line.key} color="yellow" wrap="truncate-end">
						{line.text}
					</Text>
				) : line.kind === 'dim' ? (
					<Text key={line.key} dimColor wrap="truncate-end">
						{line.text}
					</Text>
				) : (
					<Box key={line.key}>
						<Box width={LABEL_WIDTH} flexShrink={0}>
							<Text wrap="truncate-end">{line.label}</Text>
						</Box>
						<Text wrap="truncate-end">{line.text}</Text>
					</Box>
				)
			)}
			<Box flexGrow={1} />
			<Text dimColor wrap="truncate-end">
				{lines.length > capacity
					? `${start + 1}-${start + rows.length} of ${lines.length}  j/k scroll  `
					: ''}
				{keysFor('reloadSettings')} reload
			</Text>
		</OverlayFrame>
	);
}
