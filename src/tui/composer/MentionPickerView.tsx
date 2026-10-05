import React from 'react';
import { Box, Text } from 'ink';
import { getAgentDisplayName } from '../../shared/maestro-lib';
import { keysFor } from '../keymap';
import { visibleMentionRows, type MentionPicker } from './mentions';

export interface MentionPickerViewProps {
	picker: MentionPicker;
	width: number;
}

/** What a row says about itself: a group's size, an agent's provider and whether it runs on a remote. */
function describeRow(row: MentionPicker['rows'][number]): string {
	if (row.kind === 'group') {
		const count = row.memberSessionIds?.length ?? 0;
		return `group of ${count} ${count === 1 ? 'agent' : 'agents'}`;
	}
	const provider = row.toolType ? getAgentDisplayName(row.toolType) : '';
	return row.isSshRemote ? `${provider} · SSH` : provider;
}

/**
 * The `@` picker, drawn between the transcript and the message box: a hint line
 * and up to five rows. Pure of state; the App derives `picker` from the draft.
 */
export function MentionPickerView({ picker, width }: MentionPickerViewProps): React.ReactElement {
	const { start, rows } = visibleMentionRows(picker);
	return (
		<Box flexDirection="column" width={width} flexShrink={0}>
			<Text dimColor wrap="truncate-end">
				{`Mention an agent (consult, read-only) · ↑↓ pick · ${keysFor('acceptMention')} insert · ${keysFor('dismissMention')} close`}
			</Text>
			{rows.map((row, index) => {
				const selected = start + index === picker.cursor;
				return (
					<Box key={`${row.kind}:${row.value}`} width={width}>
						<Text color={selected ? '#9146FF' : undefined} bold={selected} wrap="truncate-end">
							{selected ? '› ' : '  '}
							{row.displayText}
							<Text dimColor> {describeRow(row)}</Text>
						</Text>
					</Box>
				);
			})}
		</Box>
	);
}
