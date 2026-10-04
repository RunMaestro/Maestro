import React from 'react';
import { Box, Text, useApp, useInput } from 'ink';

export interface AppProps {
	/** The resolved Maestro data directory, shown on the status line. */
	userDataDir: string;
}

export function App({ userDataDir }: AppProps): React.ReactElement {
	const { exit } = useApp();

	// Ink exits on Ctrl-C by itself (`exitOnCtrlC`), so only `q` is ours.
	useInput((input) => {
		if (input === 'q') exit();
	});

	return (
		<Box flexDirection="column">
			<Text bold>Maestro TUI</Text>
			<Text>Data directory: {userDataDir}</Text>
			<Text dimColor>Press q to quit</Text>
		</Box>
	);
}
