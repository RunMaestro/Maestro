import React from 'react';
import { Box, Text } from 'ink';
import { cellWidth, sliceToWidth } from './cellWidth';
import { parseMarkdown, spansText, type Block, type StyledSpan, type TableAlign } from './markdown';

const ACCENT = '#9146FF';

/** Spans as nested Ink text. The parent `<Text>` is the caller's, so wrapping stays Ink's. */
export function Spans({ spans }: { spans: readonly StyledSpan[] }): React.ReactElement {
	return (
		<>
			{spans.map(({ text, ...style }, index) => (
				<Text key={index} {...style}>
					{text}
				</Text>
			))}
		</>
	);
}

/** Cut a span run to `columns`, ending in an ellipsis when something was removed. */
function truncateSpans(spans: readonly StyledSpan[], columns: number): StyledSpan[] {
	if (cellWidth(spansText(spans)) <= columns) return [...spans];
	const out: StyledSpan[] = [];
	let left = Math.max(0, columns - 1);
	for (const span of spans) {
		if (left <= 0) break;
		const text = sliceToWidth(span.text, left);
		if (text) out.push({ ...span, text });
		left -= cellWidth(text);
	}
	out.push({ text: '…' });
	return out;
}

function padSpans(spans: readonly StyledSpan[], columns: number, align: TableAlign): StyledSpan[] {
	const gap = Math.max(0, columns - cellWidth(spansText(spans)));
	if (gap === 0) return [...spans];
	if (align === 'right') return [{ text: ' '.repeat(gap) }, ...spans];
	if (align === 'center') {
		const left = Math.floor(gap / 2);
		return [{ text: ' '.repeat(left) }, ...spans, { text: ' '.repeat(gap - left) }];
	}
	return [...spans, { text: ' '.repeat(gap) }];
}

/**
 * Column widths for a table that must fit `available` columns. Each column
 * gets its widest cell; when the total is too wide the widest columns give
 * way first, never below 3.
 */
export function fitColumnWidths(natural: readonly number[], available: number): number[] {
	// Every column costs its cells plus 3 columns of frame: "│ " before, and a closing "│".
	const frame = natural.length * 3 + 1;
	const widths = [...natural];
	let excess = widths.reduce((sum, width) => sum + width, 0) + frame - available;
	while (excess > 0) {
		const widest = Math.max(...widths);
		if (widest <= 3) break;
		widths[widths.indexOf(widest)] = widest - 1;
		excess -= 1;
	}
	return widths;
}

function Table({
	header,
	rows,
	align,
	width,
}: {
	header: StyledSpan[][];
	rows: StyledSpan[][][];
	align: TableAlign[];
	width: number;
}): React.ReactElement {
	const columns = header.length;
	const natural = Array.from({ length: columns }, (_, column) =>
		Math.max(
			cellWidth(spansText(header[column] ?? [])),
			...rows.map((row) => cellWidth(spansText(row[column] ?? [])))
		)
	);
	const widths = fitColumnWidths(natural, width);
	const rule = (left: string, mid: string, right: string) =>
		left + widths.map((columnWidth) => '─'.repeat(columnWidth + 2)).join(mid) + right;
	const line = (cells: StyledSpan[][]) => (
		<Text>
			<Text dimColor>│</Text>
			{widths.map((columnWidth, column) => (
				<React.Fragment key={column}>
					<Text> </Text>
					<Spans
						spans={padSpans(
							truncateSpans(cells[column] ?? [], columnWidth),
							columnWidth,
							align[column] ?? 'left'
						)}
					/>
					<Text> </Text>
					<Text dimColor>│</Text>
				</React.Fragment>
			))}
		</Text>
	);
	return (
		<Box flexDirection="column">
			<Text dimColor>{rule('┌', '┬', '┐')}</Text>
			{line(header)}
			<Text dimColor>{rule('├', '┼', '┤')}</Text>
			{rows.map((row, index) => (
				<React.Fragment key={index}>{line(row)}</React.Fragment>
			))}
			<Text dimColor>{rule('└', '┴', '┘')}</Text>
		</Box>
	);
}

function headingColor(depth: number): string | undefined {
	if (depth === 1) return ACCENT;
	if (depth === 2) return 'cyan';
	return undefined;
}

/** Visible columns taken by a list marker, so nested content can be given the rest. */
function markerFor(
	block: Extract<Block, { kind: 'list' }>,
	index: number,
	checked: boolean | undefined
): string {
	if (checked !== undefined) return checked ? '[x] ' : '[ ] ';
	return block.ordered ? `${block.start + index}. ` : '• ';
}

function BlockView({ block, width }: { block: Block; width: number }): React.ReactElement | null {
	switch (block.kind) {
		case 'heading':
			return (
				<Text bold color={headingColor(block.depth)}>
					{'#'.repeat(block.depth)} <Spans spans={block.spans} />
				</Text>
			);
		case 'paragraph':
			return (
				<Text>
					<Spans spans={block.spans} />
				</Text>
			);
		case 'code':
			return (
				<Box
					flexDirection="column"
					borderStyle="single"
					borderColor="gray"
					borderTop={false}
					borderBottom={false}
					borderRight={false}
					paddingLeft={1}
				>
					{block.language ? <Text dimColor>{block.language}</Text> : null}
					{block.lines.map((line, index) => (
						<Text key={index} wrap="wrap">
							{line.length > 0 ? <Spans spans={line} /> : ' '}
						</Text>
					))}
				</Box>
			);
		case 'list': {
			const markers = block.items.map((item, index) => markerFor(block, index, item.checked));
			const markerWidth = Math.max(...markers.map((marker) => marker.length));
			return (
				<Box flexDirection="column">
					{block.items.map((item, index) => (
						<Box key={index}>
							<Box width={markerWidth} flexShrink={0}>
								<Text dimColor={item.checked === undefined}>{markers[index]}</Text>
							</Box>
							<Blocks blocks={item.blocks} width={Math.max(1, width - markerWidth)} gap={0} />
						</Box>
					))}
				</Box>
			);
		}
		case 'quote':
			return (
				<Box
					borderStyle="single"
					borderColor="gray"
					borderTop={false}
					borderBottom={false}
					borderRight={false}
					paddingLeft={1}
				>
					<Blocks blocks={block.blocks} width={Math.max(1, width - 2)} />
				</Box>
			);
		case 'table':
			return <Table header={block.header} rows={block.rows} align={block.align} width={width} />;
		case 'rule':
			return <Text dimColor>{'─'.repeat(Math.max(1, Math.min(width, 40)))}</Text>;
	}
}

function Blocks({
	blocks,
	width,
	gap = 1,
}: {
	blocks: readonly Block[];
	width: number;
	gap?: number;
}): React.ReactElement {
	return (
		<Box flexDirection="column" flexGrow={1} flexShrink={1} gap={gap}>
			{blocks.map((block, index) => (
				<BlockView key={index} block={block} width={width} />
			))}
		</Box>
	);
}

export interface MarkdownViewProps {
	/** Markdown source. Ignored when `blocks` is given. */
	text?: string;
	/** Already-parsed blocks, so a caller that caches parses does not parse twice. */
	blocks?: readonly Block[];
	/** Columns available; tables and rules fit themselves to it. */
	width: number;
}

/** Markdown drawn as terminal text. */
export function MarkdownView({ text, blocks, width }: MarkdownViewProps): React.ReactElement {
	return (
		<Box width={width}>
			<Blocks blocks={blocks ?? parseMarkdown(text ?? '')} width={width} />
		</Box>
	);
}
