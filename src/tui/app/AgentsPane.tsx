import React from 'react';
import { Box, Text } from 'ink';
import { agentHasUnread } from '../../shared/maestro-lib';
import { providerBadge, stateColor, type PaneRow } from './agentRows';

export interface AgentsPaneProps {
	/** The rows to draw, already cut to what fits (`windowRows`). */
	rows: readonly PaneRow[];
	cursorKey: string | undefined;
	width: number;
	height: number;
	focused: boolean;
	/** Store files that could not be read, one line each. */
	problems?: readonly string[];
}

function SectionLine({ row }: { row: Extract<PaneRow, { kind: 'section' }> }): React.ReactElement {
	const { section } = row;
	const title =
		section.emoji && !section.title.startsWith(section.emoji)
			? `${section.emoji} ${section.title}`
			: section.title;
	// A folded group shows how many agents it hides; an open one does not repeat what is listed.
	const count = row.collapsed ? ` (${row.agentCount})` : '';
	return (
		<Text bold wrap="truncate-end">
			{row.collapsed ? '▸' : '▾'} {title}
			{count}
		</Text>
	);
}

function AgentLine({ row }: { row: Extract<PaneRow, { kind: 'agent' }> }): React.ReactElement {
	const { agent } = row;
	const unread = agentHasUnread(agent);
	return (
		<Box justifyContent="space-between">
			<Box flexShrink={1}>
				<Text wrap="truncate-end">
					{row.depth === 1 ? '  └ ' : '  '}
					<Text color={stateColor(agent.state)}>●</Text> {agent.name}
				</Text>
			</Box>
			<Box flexShrink={0}>
				<Text dimColor> {providerBadge(agent.toolType)}</Text>
				<Text color="cyan">{unread ? ' ◆' : '  '}</Text>
			</Box>
		</Box>
	);
}

export function AgentsPane({
	rows,
	cursorKey,
	width,
	height,
	focused,
	problems = [],
}: AgentsPaneProps): React.ReactElement {
	return (
		<Box
			flexDirection="column"
			width={width}
			height={height}
			borderStyle="single"
			borderColor={focused ? '#9146FF' : undefined}
		>
			<Text bold dimColor={!focused}>
				Agents
			</Text>
			{problems.map((problem) => (
				<Text key={problem} color="red" wrap="truncate-end">
					{problem}
				</Text>
			))}
			{rows.length === 0 && problems.length === 0 ? <Text dimColor>No agents found</Text> : null}
			{rows.map((row) => (
				<Box key={row.key}>
					<Text color="#9146FF">{row.key === cursorKey ? '›' : ' '}</Text>
					<Box flexGrow={1} flexDirection="column">
						{row.kind === 'section' ? <SectionLine row={row} /> : <AgentLine row={row} />}
					</Box>
				</Box>
			))}
		</Box>
	);
}
