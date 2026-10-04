import React from 'react';
import { Box, Text } from 'ink';
import { keysFor } from '../keymap';

export interface OverlayFrameProps {
	title: string;
	width: number;
	height: number;
	children: React.ReactNode;
}

/**
 * The box every overlay draws inside. It owns the `Esc` hint, read from the
 * keymap, so no overlay can forget to show how to leave it.
 */
export function OverlayFrame({
	title,
	width,
	height,
	children,
}: OverlayFrameProps): React.ReactElement {
	return (
		<Box
			flexDirection="column"
			width={width}
			height={height}
			borderStyle="single"
			borderColor="#9146FF"
		>
			<Box justifyContent="space-between">
				<Text bold wrap="truncate-end">
					{title}
				</Text>
				<Text dimColor>{keysFor('closeOverlay')} close</Text>
			</Box>
			<Box flexDirection="column" flexGrow={1}>
				{children}
			</Box>
		</Box>
	);
}
