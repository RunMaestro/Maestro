import React from 'react';
import { Box, Text } from 'ink';
import {
	aiTabsOf,
	getAgentDisplayName,
	getTabDisplayName,
	type AgentRecord,
} from '../../shared/maestro-lib';

export interface ConversationPaneProps {
	agent: AgentRecord | undefined;
	width: number;
	height: number;
	focused: boolean;
}

/**
 * The center pane. This task lays the pane out and titles it; the transcript
 * itself is drawn by the transcript renderer (`src/tui/transcript/`).
 */
export function ConversationPane({
	agent,
	width,
	height,
	focused,
}: ConversationPaneProps): React.ReactElement {
	const tabs = agent ? aiTabsOf(agent) : [];
	const activeTab = tabs.find((tab) => tab.id === agent?.activeTabId) ?? tabs[0];
	const title = agent
		? [
				agent.name,
				getAgentDisplayName(agent.toolType),
				agent.customModel,
				activeTab ? `tab: ${getTabDisplayName(activeTab)}` : undefined,
			]
				.filter(Boolean)
				.join(' · ')
		: 'Conversation';

	return (
		<Box
			flexDirection="column"
			width={width}
			height={height}
			borderStyle="single"
			borderColor={focused ? '#9146FF' : undefined}
		>
			<Text bold wrap="truncate-end" dimColor={!focused}>
				{title}
			</Text>
			{agent ? (
				<Text dimColor>
					{tabs.length} {tabs.length === 1 ? 'tab' : 'tabs'}
					{agent.cwd ? ` · ${agent.cwd}` : ''}
				</Text>
			) : (
				<Text dimColor>Select an agent to see its conversation.</Text>
			)}
		</Box>
	);
}
