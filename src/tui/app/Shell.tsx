import React, { useRef } from 'react';
import { Box, Text } from 'ink';
import type { AgentRecord, LogEntryRecord } from '../../shared/maestro-lib';
import { AgentsPane } from './AgentsPane';
import { ConversationPane, type ConversationComposer } from './ConversationPane';
import { StatusBar } from './StatusBar';
import { windowRows, type PaneRow } from './agentRows';
import {
	MIN_COLUMNS,
	MIN_ROWS,
	effectiveAgentsPaneWidth,
	isAgentsPaneVisible,
	isTerminalTooSmall,
	type PaneId,
	type TerminalSize,
} from './layout';

export interface ShellProps {
	size: TerminalSize;
	userDataDir: string;
	hostLabel: string;
	/** Every row of the Agents pane; the shell cuts them to what fits. */
	rows: readonly PaneRow[];
	cursorKey: string | undefined;
	/** The agent shown in the Conversation pane. */
	agent: AgentRecord | undefined;
	/** The tab the Conversation pane shows for `agent`; see `resolveActiveTab`. */
	activeTabId?: string;
	/** The tab's transcript, when the caller read it from somewhere other than the record. */
	entries?: readonly LogEntryRecord[];
	/** Show tool calls expanded in the Conversation pane. */
	expandTools?: boolean;
	/** The composer under the transcript; unset while the TUI cannot send (no desktop attached). */
	composer?: ConversationComposer;
	/** The pane that has keyboard focus. Ignored for a pane that is hidden. */
	focusedPane: PaneId;
	/**
	 * An overlay, drawn in place of the Conversation pane. Called with the room
	 * that pane would have had, so the overlay fills it exactly.
	 */
	overlay?: (room: { width: number; height: number }) => React.ReactNode;
	/** The user's toggle for the Agents pane; unset means "by terminal width". */
	agentsPaneOverride: boolean | undefined;
	agentsPaneWidth: number;
	/** Store files that could not be read, one line each. */
	problems: readonly string[];
	/** One line of news for the status bar; it replaces the key hints until the next key. */
	notice?: string;
}

/** Lines the Agents pane spends on its border (2) and its title (1). */
const AGENTS_PANE_CHROME_LINES = 3;

/**
 * The three-part layout from spec section 5.1: Agents on the left,
 * Conversation in the center, a status bar underneath. Pure of state, so a test
 * can draw it at any size.
 */
export function Shell({
	size,
	userDataDir,
	hostLabel,
	rows,
	cursorKey,
	agent,
	activeTabId,
	entries,
	focusedPane,
	expandTools,
	composer,
	overlay,
	agentsPaneOverride,
	agentsPaneWidth,
	problems,
	notice,
}: ShellProps): React.ReactElement {
	const scrollStart = useRef(0);

	if (isTerminalTooSmall(size)) {
		return (
			<Box flexDirection="column">
				<Text color="yellow">
					Terminal too small: {size.columns}x{size.rows}. Maestro TUI needs at least {MIN_COLUMNS}x
					{MIN_ROWS}.
				</Text>
			</Box>
		);
	}

	const showAgents = isAgentsPaneVisible(size.columns, agentsPaneOverride);
	const agentsWidth = showAgents ? effectiveAgentsPaneWidth(size.columns, agentsPaneWidth) : 0;
	const paneHeight = size.rows - 1;
	// Problems take lines from the list, so reserve them before windowing.
	const listHeight = Math.max(0, paneHeight - AGENTS_PANE_CHROME_LINES - problems.length);
	const visible = windowRows(rows, cursorKey, listHeight, scrollStart.current);
	scrollStart.current = visible.start;

	return (
		<Box flexDirection="column" width={size.columns} height={size.rows}>
			<Box height={paneHeight}>
				{showAgents ? (
					<AgentsPane
						rows={visible.rows}
						cursorKey={cursorKey}
						width={agentsWidth}
						height={paneHeight}
						focused={focusedPane === 'agents'}
						problems={problems}
					/>
				) : null}
				{overlay ? (
					overlay({ width: size.columns - agentsWidth, height: paneHeight })
				) : (
					<ConversationPane
						agent={agent}
						activeTabId={activeTabId}
						entries={entries}
						width={size.columns - agentsWidth}
						height={paneHeight}
						focused={focusedPane === 'conversation' || !showAgents}
						expandTools={expandTools}
						composer={composer}
					/>
				)}
			</Box>
			<StatusBar
				userDataDir={userDataDir}
				hostLabel={hostLabel}
				width={size.columns}
				notice={notice}
			/>
		</Box>
	);
}
