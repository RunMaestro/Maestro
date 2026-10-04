import React from 'react';
import { Box, Text } from 'ink';
import { KEYMAP, formatBindingKeys } from '../keymap';
import { OverlayFrame } from './OverlayFrame';

export interface HelpOverlayProps {
	width: number;
	height: number;
}

/** Width of the key column; the longest binding (`Ctrl-B`, `j / ↓`) fits with room to spare. */
const KEYS_COLUMN = 14;

/** Key help. Every row comes from `KEYMAP`, the table the input handler reads. */
export function HelpOverlay({ width, height }: HelpOverlayProps): React.ReactElement {
	return (
		<OverlayFrame title="Key help" width={width} height={height}>
			{KEYMAP.map((binding) => (
				<Box key={binding.action}>
					<Box width={KEYS_COLUMN} flexShrink={0}>
						<Text color="#9146FF">{formatBindingKeys(binding)}</Text>
					</Box>
					<Text wrap="truncate-end">{binding.description}</Text>
				</Box>
			))}
		</OverlayFrame>
	);
}
