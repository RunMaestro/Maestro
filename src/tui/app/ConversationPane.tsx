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
import {
	Composer,
	COMPOSER_MAX_ROWS,
	COMPOSER_PREFIX_WIDTH,
	composerHeight,
} from '../composer/Composer';
import { layoutComposer, type ComposerState } from '../composer/draft';
import { MentionPickerView } from '../composer/MentionPickerView';
import { consultStyle } from '../composer/consults';
import { mentionPickerHeight, type MentionPicker } from '../composer/mentions';
import { StatusLine, STATUS_LINE_HEIGHT } from '../status/StatusLine';

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

/** What the pane needs to draw the composer under the transcript. */
export interface ConversationComposer {
	state: ComposerState;
	running: boolean;
	/** Messages waiting in the host's execution queue for this tab. */
	queued: number;
	/** The `@` agent picker, while the caret is in an `@name` that matches someone. */
	mentions?: MentionPicker;
	/** Replaces the header line, for a message that needs a warning before Enter (a delegation). */
	header?: string;
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
	/** The composer, when messages can be sent: a desktop is attached and the agent has a tab. */
	composer?: ConversationComposer;
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
	composer,
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

	const innerWidth = Math.max(1, width - 2);
	const composerLayout =
		composer && activeTab
			? layoutComposer(composer.state, innerWidth - COMPOSER_PREFIX_WIDTH, COMPOSER_MAX_ROWS)
			: undefined;
	// The status line shows for any tab on screen, with or without a desktop to send through.
	const pickerRows = composer?.mentions ? mentionPickerHeight(composer.mentions) : 0;
	const reserved =
		(composerLayout ? composerHeight(composerLayout) : 0) +
		pickerRows +
		(activeTab ? STATUS_LINE_HEIGHT : 0);

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
							width={innerWidth}
							height={Math.max(1, height - CONVERSATION_CHROME_LINES - reserved)}
							expandTools={expandTools}
							styleFor={consultStyle}
						/>
					) : (
						<Text dimColor>This agent has no tabs.</Text>
					)}
					{activeTab ? <StatusLine agent={agent} tab={activeTab} width={innerWidth} /> : null}
					{composer?.mentions ? (
						<MentionPickerView picker={composer.mentions} width={innerWidth} />
					) : null}
					{composer && composerLayout ? (
						<Composer
							layout={composerLayout}
							empty={composer.state.text === ''}
							width={innerWidth}
							focused={focused}
							running={composer.running}
							queued={composer.queued}
							header={composer.header}
						/>
					) : null}
				</>
			) : (
				<Text dimColor>Select an agent to see its conversation.</Text>
			)}
		</Box>
	);
}
