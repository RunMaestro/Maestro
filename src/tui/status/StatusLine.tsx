import React from 'react';
import { Box, Text } from 'ink';
import type { AITabRecord, AgentRecord } from '../../shared/maestro-lib';
import {
	STATUS_SEPARATOR,
	buildStatusSegments,
	fitStatusSegments,
	type StatusTone,
} from './statusSegments';

/** Lines the status line takes. */
export const STATUS_LINE_HEIGHT = 1;

const TONE_COLOR: Record<StatusTone, string | undefined> = {
	normal: undefined,
	warn: 'yellow',
	danger: 'red',
};

export interface StatusLineProps {
	agent: AgentRecord;
	tab: AITabRecord;
	width: number;
}

/** One dim line: provider, model, effort, context use, cost. Context turns yellow, then red. */
export function StatusLine({ agent, tab, width }: StatusLineProps): React.ReactElement {
	const segments = fitStatusSegments(buildStatusSegments(agent, tab), width);
	return (
		<Box width={width} height={STATUS_LINE_HEIGHT} flexShrink={0}>
			<Text wrap="truncate-end" dimColor>
				{segments.map((segment, index) => (
					<Text key={segment.key}>
						{index > 0 ? STATUS_SEPARATOR : ''}
						<Text color={TONE_COLOR[segment.tone]} dimColor={segment.tone === 'normal'}>
							{segment.text}
						</Text>
					</Text>
				))}
			</Text>
		</Box>
	);
}
