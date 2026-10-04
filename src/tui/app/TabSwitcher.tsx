import React from 'react';
import { Box, Text } from 'ink';
import { getTabDisplayName, type AITabRecord, type AgentRecord } from '../../shared/maestro-lib';
import { OverlayFrame } from './OverlayFrame';

export interface TabSwitcherProps {
	agent: AgentRecord;
	tabs: readonly AITabRecord[];
	/** The row the cursor is on. */
	cursor: number;
	/** The tab the Conversation pane shows now. */
	activeTabId: string | undefined;
	width: number;
	height: number;
}

/** The tabs of one agent, with the cursor row and the open tab marked. */
export function TabSwitcher({
	agent,
	tabs,
	cursor,
	activeTabId,
	width,
	height,
}: TabSwitcherProps): React.ReactElement {
	// Title takes one line and the border two.
	const room = Math.max(1, height - 3);
	const start = Math.min(Math.max(0, cursor - room + 1), Math.max(0, tabs.length - room));
	return (
		<OverlayFrame title={`Tabs: ${agent.name}`} width={width} height={height}>
			{tabs.slice(start, start + room).map((tab, offset) => {
				const index = start + offset;
				return (
					<Box key={tab.id}>
						<Text color="#9146FF">{index === cursor ? '›' : ' '}</Text>
						<Text wrap="truncate-end" bold={index === cursor}>
							{tab.id === activeTabId ? '● ' : '  '}
							{getTabDisplayName(tab)}
							{tab.hasUnread ? ' ◆' : ''}
						</Text>
					</Box>
				);
			})}
		</OverlayFrame>
	);
}
