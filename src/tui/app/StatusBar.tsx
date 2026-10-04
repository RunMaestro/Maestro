import React from 'react';
import { Box, Text } from 'ink';
import { keysFor } from '../keymap';

export interface StatusBarProps {
	userDataDir: string;
	/** Who owns the data directory right now. `read-only` until the TUI can write. */
	hostLabel: string;
	width: number;
}

/** Replaces the user's home directory with `~`, so a long path leaves room for the label. */
export function abbreviateHome(dir: string, home: string | undefined): string {
	if (home && (dir === home || dir.startsWith(`${home}/`))) return `~${dir.slice(home.length)}`;
	return dir;
}

export function StatusBar({ userDataDir, hostLabel, width }: StatusBarProps): React.ReactElement {
	return (
		<Box width={width} height={1} paddingX={1}>
			{/* The path gives way first: the host label is the part that must stay readable. */}
			<Box flexShrink={1} flexGrow={1}>
				<Text wrap="truncate-start" dimColor>
					data: {abbreviateHome(userDataDir, process.env.HOME)}
				</Text>
			</Box>
			<Box flexShrink={0} marginLeft={2}>
				<Text dimColor>
					{keysFor('palette')} palette {keysFor('help')} help{' '}
				</Text>
				<Text color="#9146FF">host: {hostLabel}</Text>
			</Box>
		</Box>
	);
}
