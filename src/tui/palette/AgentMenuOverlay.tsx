import React from 'react';
import { Box, Text } from 'ink';
import type { AgentRecord } from '../../shared/maestro-lib';
import { OverlayFrame } from '../app/OverlayFrame';
import type { AgentMenuEntry } from './agentMenu';

export interface AgentMenuOverlayProps {
	agent: AgentRecord;
	entries: readonly AgentMenuEntry[];
	cursor: number;
	width: number;
	height: number;
}

/** The actions that apply to one agent, with the keys that reach each one directly. */
export function AgentMenuOverlay({
	agent,
	entries,
	cursor,
	width,
	height,
}: AgentMenuOverlayProps): React.ReactElement {
	return (
		<OverlayFrame title={`Agent: ${agent.name}`} width={width} height={height}>
			{entries.map((entry, index) => (
				<Box key={entry.action}>
					<Text color="#9146FF">{index === cursor ? '›' : ' '}</Text>
					<Box flexGrow={1} flexShrink={1}>
						<Text wrap="truncate-end" bold={index === cursor}>
							{entry.label}
						</Text>
					</Box>
					<Box flexShrink={0} marginLeft={1}>
						<Text dimColor>{entry.keys}</Text>
					</Box>
				</Box>
			))}
		</OverlayFrame>
	);
}
