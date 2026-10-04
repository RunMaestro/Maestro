import React from 'react';
import { Box, Text } from 'ink';
import { formatTimestamp, type LogEntryRecord } from '../../shared/maestro-lib';
import {
	TOOL_STATUS_GLYPHS,
	entryBodyBlocks,
	entryIndent,
	isToolEntry,
	sourceStyle,
	summarizeToolEntry,
} from './entries';
import { MarkdownView } from './MarkdownView';

export interface TranscriptEntryViewProps {
	entry: LogEntryRecord;
	/** Columns available to the entry, indent included. */
	width: number;
	/** Show a tool call's input and output under its one-line summary. */
	expandTools: boolean;
}

/**
 * One transcript entry: a header line and its markdown body. A tool call is a
 * single line until expanded. Every other entry, user messages included, goes
 * through the markdown renderer.
 */
function TranscriptEntryViewImpl({
	entry,
	width,
	expandTools,
}: TranscriptEntryViewProps): React.ReactElement {
	const indent = entryIndent(entry);
	const inner = Math.max(1, width - indent);
	const blocks = entryBodyBlocks(entry, expandTools);

	if (isToolEntry(entry)) {
		const { status, line } = summarizeToolEntry(entry);
		return (
			<Box flexDirection="column" paddingLeft={indent} width={width}>
				<Text
					wrap="truncate-end"
					color={status === 'failed' ? 'red' : undefined}
					dimColor={status === 'completed'}
				>
					{expandTools ? '▾' : '▸'} {TOOL_STATUS_GLYPHS[status]} {line}
				</Text>
				{blocks.length > 0 ? (
					<Box paddingLeft={2}>
						<MarkdownView blocks={blocks} width={Math.max(1, inner - 2)} />
					</Box>
				) : null}
			</Box>
		);
	}

	const style = sourceStyle(entry.source);
	return (
		<Box flexDirection="column" marginTop={1} paddingLeft={indent} width={width}>
			<Text>
				<Text bold color={style.color} dimColor={style.dimColor}>
					{style.label}
				</Text>
				<Text dimColor> {formatTimestamp(entry.timestamp, 'time')}</Text>
				{entry.images && entry.images.length > 0 ? (
					<Text dimColor>
						{' '}
						[{entry.images.length} {entry.images.length === 1 ? 'image' : 'images'}]
					</Text>
				) : null}
			</Text>
			<MarkdownView blocks={blocks} width={inner} />
		</Box>
	);
}

export const TranscriptEntryView = React.memo(TranscriptEntryViewImpl);
