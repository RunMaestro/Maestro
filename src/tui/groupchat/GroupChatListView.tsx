import React from 'react';
import { Box, Text } from 'ink';
import { getAgentDisplayName, type GroupChatRecord } from '../../shared/maestro-lib';
import { OverlayFrame } from '../app/OverlayFrame';
import { keysFor } from '../keymap';
import { chatStatusLabel, type GroupChatListState } from './state';

const ACCENT = '#9146FF';
/** `moderating` and `3 working` fit; the rest of the row is the name and the roster. */
const STATUS_COLUMN = 12;

export interface GroupChatListViewProps {
	state: GroupChatListState;
	/** Each chat as events last left it, so a status moves while the list is open. */
	liveOf: (chat: GroupChatRecord) => GroupChatRecord;
	width: number;
	height: number;
}

function rosterOf(chat: GroupChatRecord): string {
	const names = chat.participants.map((participant) => participant.name);
	if (names.length === 0) return 'no participants yet';
	return names.join(', ');
}

/** Every group chat on the desktop: its name, who is in it, and whether a round is running. */
export function GroupChatListView({
	state,
	liveOf,
	width,
	height,
}: GroupChatListViewProps): React.ReactElement {
	const { chats, cursor } = state;
	// Title and border take three lines; the message and footer two more.
	const room = Math.max(1, height - 3 - 2);
	const start = Math.min(Math.max(0, cursor - room + 1), Math.max(0, chats.length - room));
	return (
		<OverlayFrame title="Group chats" width={width} height={height}>
			{chats.length === 0 ? (
				<Text dimColor>No group chats yet. {keysFor('newGroupChat')} creates one.</Text>
			) : null}
			{chats.slice(start, start + room).map((listed, offset) => {
				const index = start + offset;
				const chat = liveOf(listed);
				const busy = chat.state !== 'idle';
				return (
					<Box key={chat.id}>
						<Text color={ACCENT}>{index === cursor ? '›' : ' '}</Text>
						<Box flexShrink={1} flexGrow={1}>
							<Text wrap="truncate-end" bold={index === cursor} dimColor={chat.archived}>
								{chat.name}
								<Text dimColor>
									{'  '}
									{chat.moderatorProvider ? `${getAgentDisplayName(chat.moderatorProvider)}: ` : ''}
									{rosterOf(chat)}
								</Text>
							</Text>
						</Box>
						<Box width={STATUS_COLUMN} flexShrink={0} justifyContent="flex-end">
							<Text color={busy ? 'green' : undefined} dimColor={!busy}>
								{chat.archived ? 'archived' : chatStatusLabel(chat)}
							</Text>
						</Box>
					</Box>
				);
			})}
			<Box flexGrow={1} />
			<Text wrap="truncate-end" dimColor>
				{state.message ?? ' '}
			</Text>
			<Text wrap="truncate-end" dimColor>
				{keysFor('open')} open {keysFor('newGroupChat')} new {keysFor('renameGroupChat')} rename{' '}
				{keysFor('deleteGroupChat')} delete {keysFor('reloadGroupChats')} reload
			</Text>
		</OverlayFrame>
	);
}
