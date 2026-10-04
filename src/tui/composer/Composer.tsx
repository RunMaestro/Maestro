import React from 'react';
import { Box, Text } from 'ink';
import { formatBindingKeys, bindingFor, keysFor } from '../keymap';
import type { ComposerLayout, ComposerRow } from './draft';

/** The composer grows with its draft up to this many text rows, then scrolls with the caret. */
export const COMPOSER_MAX_ROWS = 6;

/** Columns the row prefix (`› `) takes; the text wraps to what is left. */
export const COMPOSER_PREFIX_WIDTH = 2;

export interface ComposerHeaderInput {
	focused: boolean;
	running: boolean;
	queued: number;
	empty: boolean;
}

/**
 * The line above the input: what Enter does right now, the queued count, and
 * the keys worth knowing. Pure, so the wording is tested without Ink.
 */
export function composerHeader({ focused, running, queued, empty }: ComposerHeaderInput): string {
	const parts: string[] = [];
	parts.push(running ? 'Agent is working: Enter queues your message' : 'Message');
	if (queued > 0) parts.push(`${queued} queued`);
	if (focused) {
		parts.push(
			`${keysFor('send')} send`,
			`${formatBindingKeys(bindingFor('newline'))} newline`,
			running ? `${keysFor('interrupt')} interrupt` : `${keysFor('palette')} palette`
		);
		if (!empty) parts.push(`${keysFor('blurComposer')} agents`);
	} else {
		parts.push(`${keysFor('nextPane')} to type`);
	}
	return parts.join(' · ');
}

function RowView({ row, focused }: { row: ComposerRow; focused: boolean }): React.ReactElement {
	if (!focused || row.caret === undefined) return <Text wrap="truncate-end">{row.text}</Text>;
	const chars = Array.from(row.text);
	const before = chars.slice(0, row.caret).join('');
	const at = chars[row.caret] ?? ' ';
	const after = chars.slice(row.caret + 1).join('');
	return (
		// Keyed by its content: a row with a nested caret span kept the width Ink measured for its
		// previous text, so a longer draft drew as "…" until the next key. A fresh node measures anew.
		<Text key={`${row.caret}:${row.text}`} wrap="truncate-end">
			{before}
			<Text inverse>{at}</Text>
			{after}
		</Text>
	);
}

export interface ComposerProps {
	layout: ComposerLayout;
	/** True while the draft has no text at all. */
	empty: boolean;
	width: number;
	focused: boolean;
	running: boolean;
	queued: number;
}

/** Lines the composer takes: its header plus its text rows. */
export function composerHeight(layout: ComposerLayout): number {
	return 1 + layout.rows.length;
}

/**
 * The input box under the transcript: a header line, then the draft with a
 * block caret when the pane has focus. A hidden-above count replaces the
 * prefix of a draft scrolled past its first rows.
 */
export function Composer({
	layout,
	empty,
	width,
	focused,
	running,
	queued,
}: ComposerProps): React.ReactElement {
	return (
		<Box flexDirection="column" width={width} flexShrink={0}>
			<Text dimColor wrap="truncate-end">
				{composerHeader({ focused, running, queued, empty })}
			</Text>
			{layout.rows.map((row, index) => (
				<Box key={index} width={width}>
					<Box width={COMPOSER_PREFIX_WIDTH} flexShrink={0}>
						<Text color={focused ? '#9146FF' : undefined} dimColor={!focused}>
							{index === 0 && layout.hiddenAbove > 0 ? '↑ ' : '› '}
						</Text>
					</Box>
					<Box flexGrow={1} flexShrink={1}>
						{empty && index === 0 ? (
							<Text wrap="truncate-end">
								{focused ? <Text inverse> </Text> : null}
								<Text dimColor>{focused ? 'Type a message' : ''}</Text>
							</Text>
						) : (
							<RowView row={row} focused={focused} />
						)}
					</Box>
				</Box>
			))}
		</Box>
	);
}
