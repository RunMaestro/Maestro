import React from 'react';
import { Box, Text } from 'ink';
import {
	visibleAiTabsOf,
	getAgentDisplayName,
	getTabDisplayName,
	transcriptOf,
	type AITabRecord,
	type AgentRecord,
	type LogEntryRecord,
} from '../../shared/maestro-lib';
import { TranscriptViewport } from '../transcript';

/** The tab the pane shows: the TUI's pick, else the desktop's active tab, else the first. */
export function resolveActiveTab(
	tabs: readonly AITabRecord[],
	picked: string | undefined,
	agent: AgentRecord | undefined
): AITabRecord | undefined {
	return (
		tabs.find((tab) => tab.id === picked) ??
		tabs.find((tab) => tab.id === agent?.activeTabId) ??
		tabs[0]
	);
}

export interface ConversationPaneProps {
	agent: AgentRecord | undefined;
	/** The tab picked in the TUI's tab switcher; unset or unknown falls back to the agent's own. */
	activeTabId?: string;
	/**
	 * The active tab's entries. A tab record from the desktop carries none, so the
	 * caller reads them; unset falls back to the entries on the record.
	 */
	entries?: readonly LogEntryRecord[];
	width: number;
	height: number;
	focused: boolean;
	/** Show tool calls with their input and output instead of one line each. */
	expandTools?: boolean;
}

/** Lines the pane spends on its border (2), its title (1), and its subtitle (1). */
const CONVERSATION_CHROME_LINES = 4;

/** The center pane: a title, then the active tab's transcript as terminal markdown. */
export function ConversationPane({
	agent,
	activeTabId,
	entries,
	width,
	height,
	focused,
	expandTools = false,
}: ConversationPaneProps): React.ReactElement {
	const tabs = agent ? visibleAiTabsOf(agent) : [];
	const activeTab = resolveActiveTab(tabs, activeTabId, agent);
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
				<>
					<Text dimColor wrap="truncate-end">
						{tabs.length} {tabs.length === 1 ? 'tab' : 'tabs'}
						{agent.cwd ? ` · ${agent.cwd}` : ''}
					</Text>
					{activeTab ? (
						<TranscriptViewport
							// A new tab starts with a fresh window, not the previous tab's mounted entries.
							key={activeTab.id}
							entries={entries ?? transcriptOf(activeTab)}
							width={Math.max(1, width - 2)}
							height={Math.max(1, height - CONVERSATION_CHROME_LINES)}
							expandTools={expandTools}
						/>
					) : (
						<Text dimColor>This agent has no tabs.</Text>
					)}
				</>
			) : (
				<Text dimColor>Select an agent to see its conversation.</Text>
			)}
		</Box>
	);
}
