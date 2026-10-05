import React from 'react';
import { Box, Text } from 'ink';
import { formatBindingKeys, type Binding } from '../keymap';
import { windowRows } from './agentRows';
import { OverlayFrame } from './OverlayFrame';

export interface HelpOverlayProps {
	/** The bindings that exist right now: the keymap less anything an Encore flag has switched off. */
	keymap: readonly Binding[];
	/** The row at the top of the list the person has scrolled to. */
	cursor: number;
	width: number;
	height: number;
}

/** Width of the key column; the longest binding (`Ctrl-J / Alt-Enter`) fits with room to spare. */
const KEYS_COLUMN = 20;

/** Lines the frame spends on its border (2) and title (1), plus the scroll hint below the list (1). */
const CHROME_LINES = 4;

/**
 * Key help. Every row comes from the keymap, the table the input handler reads.
 * The table outgrew the smallest terminal, so the list scrolls on the same
 * move keys every other list uses, and the hint line says where the window is.
 */
export function HelpOverlay({
	keymap,
	cursor,
	width,
	height,
}: HelpOverlayProps): React.ReactElement {
	const rows = keymap.map((binding) => ({ ...binding, key: binding.action }));
	const capacity = Math.max(1, height - CHROME_LINES);
	const { start, rows: visible } = windowRows(rows, rows[cursor]?.key, capacity);
	return (
		<OverlayFrame title="Key help" width={width} height={height}>
			{visible.map((binding) => (
				<Box key={binding.action}>
					<Box width={KEYS_COLUMN} flexShrink={0}>
						<Text color="#9146FF">{formatBindingKeys(binding)}</Text>
					</Box>
					<Text wrap="truncate-end">{binding.description}</Text>
				</Box>
			))}
			<Box flexGrow={1} />
			<Text dimColor wrap="truncate-end">
				{rows.length > capacity
					? `${start + 1}-${start + visible.length} of ${rows.length}  j/k scroll`
					: ' '}
			</Text>
		</OverlayFrame>
	);
}
