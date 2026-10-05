import React from 'react';
import { Box, Text } from 'ink';
import type { GroupChatRecord } from '../../shared/maestro-lib';
import { getAgentDisplayName } from '../../shared/maestro-lib';
import { OverlayFrame } from '../app/OverlayFrame';
import {
	Composer,
	COMPOSER_MAX_ROWS,
	COMPOSER_PREFIX_WIDTH,
	composerHeight,
} from '../composer/Composer';
import { layoutComposer, type ComposerState } from '../composer/draft';
import { MentionPickerView } from '../composer/MentionPickerView';
import { mentionPickerHeight, type MentionPicker } from '../composer/mentions';
import { keysFor } from '../keymap';
import { TranscriptViewport } from '../transcript';
import { groupChatEntries, groupChatStyle, participantColor } from './entries';
import { CHAT_MENTION_HINT } from './mentions';
import { chatActivityLine, participantRows } from './state';

export interface GroupChatViewProps {
	chat: GroupChatRecord;
	draft: ComposerState;
	/** The `@` picker, open while the caret is in an `@name` (GC-5). */
	picker?: MentionPicker;
	/** A call in flight, for one line. */
	busy?: string;
	message?: string;
	error?: string;
	width: number;
	height: number;
}

/** Overlay border (2), title row (1), roster (1), activity (1), notice (1). */
const CHROME_LINES = 6;

/**
 * One open chat (GC-2, GC-3): the log as it grows, who is working, and a box to
 * message the moderator. The roster shows each participant's status; a reply
 * lands in the log as one line when its turn ends.
 */
export function GroupChatView({
	chat,
	draft,
	picker,
	busy,
	message,
	error,
	width,
	height,
}: GroupChatViewProps): React.ReactElement {
	const inner = Math.max(1, width - 2);
	const layout = layoutComposer(draft, inner - COMPOSER_PREFIX_WIDTH, COMPOSER_MAX_ROWS);
	const entries = React.useMemo(() => groupChatEntries(chat.lines), [chat.lines]);
	const working = chat.state !== 'idle';
	const header = working
		? `${keysFor('stopGroupChat')} stop the round · ${keysFor('closeOverlay')} back`
		: `${keysFor('sendGroupChat')} send · ${keysFor('newline')} newline · ${keysFor('closeOverlay')} back`;
	const roster = participantRows(chat);
	return (
		<OverlayFrame title={`Group chat: ${chat.name}`} width={width} height={height}>
			<Text wrap="truncate-end">
				<Text dimColor>
					{chat.moderatorProvider
						? `${getAgentDisplayName(chat.moderatorProvider)} moderates · `
						: ''}
				</Text>
				{roster.length === 0 ? <Text dimColor>no participants yet</Text> : null}
				{roster.map((row) => (
					<Text key={row.name} color={participantColor(row.name)}>
						{row.working ? '● ' : '○ '}
						{row.name}
						<Text dimColor>{row.working ? ' working  ' : '  '}</Text>
					</Text>
				))}
			</Text>
			<TranscriptViewport
				// A new chat starts with a fresh window, not the previous chat's mounted entries.
				key={chat.id}
				entries={entries}
				width={inner}
				height={Math.max(
					1,
					height -
						CHROME_LINES -
						composerHeight(layout) -
						(picker ? mentionPickerHeight(picker) : 0)
				)}
				expandTools={false}
				styleFor={groupChatStyle}
			/>
			<Text wrap="truncate-end" color={working ? 'green' : undefined} dimColor={!working}>
				{chatActivityLine(chat)}
			</Text>
			<Text wrap="truncate-end" color={error ? 'red' : undefined} dimColor={!error}>
				{error ?? busy ?? message ?? ' '}
			</Text>
			<Box flexDirection="column" flexShrink={0}>
				{picker ? (
					<MentionPickerView picker={picker} width={inner} hint={CHAT_MENTION_HINT} />
				) : null}
				<Composer
					layout={layout}
					empty={draft.text === ''}
					width={inner}
					focused
					running={working}
					queued={0}
					header={header}
				/>
			</Box>
		</OverlayFrame>
	);
}
