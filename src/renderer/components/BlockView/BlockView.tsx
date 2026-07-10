/**
 * BlockView - the surface-agnostic engine that renders an agent-authored block
 * tree (see ./types) into theme-styled UI. Recursive: layout blocks nest
 * children; content blocks render one widget/primitive. Renders into a plain
 * <div>, so it drops into any surface (a cadenza, a panel, a tab).
 *
 * Robust by construction: a malformed or unknown block renders nothing rather
 * than crashing the whole view, because specs are agent-authored JSON.
 */

import { memo } from 'react';
import type { Theme } from '../../types';
import {
	StatCard,
	StatCardGrid,
	SectionCard,
	AgentActivityBars,
	TypeBreakdown,
	SuccessFailureWidget,
	Sparkline,
	ChartErrorBoundary,
	type StatCardDatum,
	type BarDatum,
	type DonutSlice,
} from '../widgets';
import { Markdown } from '../Markdown';
import type { Block, BlockSpec } from './types';
import { ORANGE_HEX, resolveAlign, resolveBlockColor, resolveGap, TYPE } from './tokens';

interface BlockViewProps {
	spec: BlockSpec;
	theme: Theme;
}

/** Normalize the two accepted spec shapes to a flat block array. */
function toBlocks(spec: BlockSpec): Block[] {
	if (Array.isArray(spec)) return spec;
	return Array.isArray(spec?.blocks) ? spec.blocks : [];
}

/**
 * Coerce an agent-authored leaf value to a safe React child. Specs are untrusted
 * JSON, so a field typed `string` may arrive as an object/array/number; rendering
 * that raw throws "Objects are not valid as a React child" and (bare-mounted)
 * blanks the whole app. Everything funnels through here at the render leaves.
 */
function toText(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

// ===========================================================================
// Layout containers
// ===========================================================================

function Row({ block, theme }: { block: Extract<Block, { kind: 'row' }>; theme: Theme }) {
	return (
		<div
			style={{
				display: 'flex',
				flexDirection: 'row',
				flexWrap: block.wrap ? 'wrap' : 'nowrap',
				gap: resolveGap(block.gap),
				alignItems: resolveAlign(block.align),
				width: '100%',
			}}
		>
			{(block.children ?? []).map((child, i) => (
				<div key={i} style={{ minWidth: 0, flex: '1 1 0' }}>
					<OneBlock block={child} theme={theme} />
				</div>
			))}
		</div>
	);
}

function Column({ block, theme }: { block: Extract<Block, { kind: 'column' }>; theme: Theme }) {
	return (
		<div
			style={{
				display: 'flex',
				flexDirection: 'column',
				gap: resolveGap(block.gap),
				alignItems: resolveAlign(block.align),
				width: '100%',
			}}
		>
			{(block.children ?? []).map((child, i) => (
				<OneBlock key={i} block={child} theme={theme} />
			))}
		</div>
	);
}

function Grid({ block, theme }: { block: Extract<Block, { kind: 'grid' }>; theme: Theme }) {
	// Explicit column count wins; otherwise auto-fit to a minimum column width.
	const template =
		typeof block.columns === 'number' && block.columns > 0
			? `repeat(${Math.min(block.columns, 12)}, minmax(0, 1fr))`
			: `repeat(auto-fit, minmax(${block.minColumnWidth ?? 160}px, 1fr))`;
	return (
		<div
			style={{
				display: 'grid',
				gridTemplateColumns: template,
				gap: resolveGap(block.gap),
				width: '100%',
			}}
		>
			{(block.children ?? []).map((child, i) => (
				<div key={i} style={{ minWidth: 0 }}>
					<OneBlock block={child} theme={theme} />
				</div>
			))}
		</div>
	);
}

function Group({ block, theme }: { block: Extract<Block, { kind: 'group' }>; theme: Theme }) {
	const accent = resolveBlockColor(block.color, theme);
	return (
		<div
			style={{
				border: `1px solid ${theme.colors.border}`,
				borderRadius: 12,
				backgroundColor: theme.colors.bgSidebar,
				overflow: 'hidden',
				width: '100%',
			}}
		>
			{block.title && (
				<div
					style={{
						padding: '12px 16px',
						...TYPE.subheading,
						color: theme.colors.textMain,
						borderBottom: `1px solid ${theme.colors.border}`,
						borderLeft: `3px solid ${accent}`,
					}}
				>
					{toText(block.title)}
				</div>
			)}
			<div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: resolveGap('md') }}>
				{(block.children ?? []).map((child, i) => (
					<OneBlock key={i} block={child} theme={theme} />
				))}
			</div>
		</div>
	);
}

// ===========================================================================
// Content leaves (primitives added by the engine)
// ===========================================================================

function Heading({ block, theme }: { block: Extract<Block, { kind: 'heading' }>; theme: Theme }) {
	if (!block.text) return null;
	const role = block.level === 1 ? TYPE.title : block.level === 3 ? TYPE.subheading : TYPE.heading;
	return (
		<div
			style={{
				...role,
				color: theme.colors.textMain,
			}}
		>
			{toText(block.text)}
		</div>
	);
}

function Badge({ block, theme }: { block: Extract<Block, { kind: 'badge' }>; theme: Theme }) {
	if (!block.text) return null;
	const accent = resolveBlockColor(block.color, theme);
	return (
		<span
			style={{
				display: 'inline-block',
				padding: '3px 10px',
				borderRadius: 9999,
				...TYPE.caption,
				fontWeight: 600,
				color: accent,
				backgroundColor: `${accent}1f`,
				border: `1px solid ${accent}55`,
			}}
		>
			{toText(block.text)}
		</span>
	);
}

function Callout({ block, theme }: { block: Extract<Block, { kind: 'callout' }>; theme: Theme }) {
	if (!block.text && !block.title) return null;
	const accent = resolveBlockColor(block.color, theme);
	return (
		<div
			style={{
				borderLeft: `3px solid ${accent}`,
				backgroundColor: `${accent}14`,
				borderRadius: 8,
				padding: '12px 16px',
				width: '100%',
			}}
		>
			{block.title && (
				<div style={{ ...TYPE.subheading, color: accent, marginBottom: 4 }}>
					{toText(block.title)}
				</div>
			)}
			{block.text && (
				<div style={{ ...TYPE.body, color: theme.colors.textMain, whiteSpace: 'pre-wrap' }}>
					{toText(block.text)}
				</div>
			)}
		</div>
	);
}

function Progress({ block, theme }: { block: Extract<Block, { kind: 'progress' }>; theme: Theme }) {
	const max = typeof block.max === 'number' && block.max > 0 ? block.max : 100;
	const value = typeof block.value === 'number' ? block.value : 0;
	const pct = Math.max(0, Math.min(100, (value / max) * 100));
	const accent = resolveBlockColor(block.color, theme);
	return (
		<div style={{ width: '100%' }}>
			{(block.label || typeof block.value === 'number') && (
				<div
					style={{
						display: 'flex',
						justifyContent: 'space-between',
						...TYPE.caption,
						color: theme.colors.textDim,
						marginBottom: 6,
					}}
				>
					<span>{block.label ?? ''}</span>
					<span>{Math.round(pct)}%</span>
				</div>
			)}
			<div
				style={{
					height: 8,
					borderRadius: 9999,
					backgroundColor: `${theme.colors.textDim}33`,
					overflow: 'hidden',
				}}
			>
				<div style={{ height: '100%', width: `${pct}%`, backgroundColor: accent }} />
			</div>
		</div>
	);
}

function KeyValue({ block, theme }: { block: Extract<Block, { kind: 'keyValue' }>; theme: Theme }) {
	const items = (block.items ?? []).filter(
		(it) => it && typeof it.label === 'string' && typeof it.value === 'string'
	);
	if (items.length === 0) return null;
	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
			{items.map((it, i) => (
				<div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
					<span style={{ ...TYPE.label, color: theme.colors.textDim, minWidth: 0 }}>
						{it.label}
					</span>
					<span
						style={{
							...TYPE.value,
							color: it.color ? resolveBlockColor(it.color, theme) : theme.colors.textMain,
							textAlign: 'right',
						}}
					>
						{it.value}
					</span>
				</div>
			))}
		</div>
	);
}

function CodeBlock({ block, theme }: { block: Extract<Block, { kind: 'code' }>; theme: Theme }) {
	if (!block.code) return null;
	// The language tag is spliced into the fence line; strip anything that could
	// break out of it (backticks, whitespace/newlines).
	const lang = (block.language ?? '').replace(/[^0-9A-Za-z#+.-]/g, '');
	// Fence longer than any backtick run inside the code, so agent snippets that
	// themselves contain ``` cannot close the fence early and leak the rest of
	// the snippet into normal markdown.
	const longestRun = block.code.match(/`+/g)?.reduce((m, r) => Math.max(m, r.length), 0) ?? 0;
	const fence = '`'.repeat(Math.max(3, longestRun + 1));
	// Reuse the Markdown code-fence path so snippets get Shiki syntax highlighting
	// and the copy affordance, consistent with the rest of the app.
	return (
		<div
			style={{
				border: `1px solid ${theme.colors.border}`,
				borderRadius: 8,
				overflow: 'hidden',
				width: '100%',
			}}
		>
			{block.filename && (
				<div
					style={{
						padding: '6px 12px',
						...TYPE.caption,
						fontFamily: 'monospace',
						color: theme.colors.textDim,
						backgroundColor: theme.colors.bgSidebar,
						borderBottom: `1px solid ${theme.colors.border}`,
					}}
				>
					{block.filename}
				</div>
			)}
			<Markdown content={`${fence}${lang}\n${block.code}\n${fence}`} theme={theme} preset="chat" />
		</div>
	);
}

function Table({ block, theme }: { block: Extract<Block, { kind: 'table' }>; theme: Theme }) {
	const columns = Array.isArray(block.columns) ? block.columns : [];
	const rows = Array.isArray(block.rows) ? block.rows : [];
	if (columns.length === 0 && rows.length === 0) return null;
	return (
		<div style={{ width: '100%', overflowX: 'auto' }}>
			<table style={{ width: '100%', borderCollapse: 'collapse' }}>
				{columns.length > 0 && (
					<thead>
						<tr>
							{columns.map((c, i) => (
								<th
									key={i}
									style={{
										...TYPE.label,
										textAlign: 'left',
										padding: '8px 12px',
										color: theme.colors.textDim,
										fontWeight: 600,
										borderBottom: `1px solid ${theme.colors.border}`,
										whiteSpace: 'nowrap',
									}}
								>
									{toText(c)}
								</th>
							))}
						</tr>
					</thead>
				)}
				<tbody>
					{rows.map((row, ri) => (
						<tr key={ri}>
							{(Array.isArray(row) ? row : []).map((cell, ci) => (
								<td
									key={ci}
									style={{
										...TYPE.body,
										padding: '8px 12px',
										color: theme.colors.textMain,
										borderBottom: `1px solid ${theme.colors.border}66`,
									}}
								>
									{toText(cell)}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

// ===========================================================================
// Block dispatch
// ===========================================================================

const OneBlock = memo(function OneBlock({ block, theme }: { block: Block; theme: Theme }) {
	if (!block || typeof block !== 'object' || typeof block.kind !== 'string') return null;

	switch (block.kind) {
		// ---- layout ----
		case 'row':
			return <Row block={block} theme={theme} />;
		case 'column':
			return <Column block={block} theme={theme} />;
		case 'grid':
			return <Grid block={block} theme={theme} />;
		case 'group':
			return <Group block={block} theme={theme} />;

		// ---- primitives ----
		case 'heading':
			return <Heading block={block} theme={theme} />;
		case 'divider':
			return <div style={{ height: 1, width: '100%', backgroundColor: theme.colors.border }} />;
		case 'badge':
			return <Badge block={block} theme={theme} />;
		case 'callout':
			return <Callout block={block} theme={theme} />;
		case 'progress':
			return <Progress block={block} theme={theme} />;
		case 'keyValue':
			return <KeyValue block={block} theme={theme} />;
		case 'table':
			return <Table block={block} theme={theme} />;
		case 'text':
			return block.content ? (
				<div style={{ fontSize: TYPE.body.fontSize, lineHeight: TYPE.body.lineHeight }}>
					<Markdown content={toText(block.content)} theme={theme} preset="chat" />
				</div>
			) : null;
		case 'code':
			return <CodeBlock block={block} theme={theme} />;

		// ---- widget-backed content ----
		case 'stat':
			if (typeof block.label !== 'string' || typeof block.value !== 'number') return null;
			return (
				<StatCard
					theme={theme}
					label={block.label}
					value={block.value}
					displayValue={block.displayValue}
					caption={block.caption}
					color={block.color ? resolveBlockColor(block.color, theme) : undefined}
					trend={block.trend}
				/>
			);
		case 'stats': {
			const cards: StatCardDatum[] = (block.cards ?? [])
				.filter((c) => c && typeof c.label === 'string' && typeof c.value === 'number')
				.map((c) => ({
					label: c.label,
					value: c.value,
					displayValue: c.displayValue,
					caption: c.caption,
					trend: c.trend,
					color: c.color ? resolveBlockColor(c.color, theme) : undefined,
				}));
			if (cards.length === 0) return null;
			return <StatCardGrid theme={theme} cards={cards} minColumnWidth={block.minColumnWidth} />;
		}
		case 'section':
			if (!block.title && !block.text) return null;
			return (
				<SectionCard theme={theme} title={toText(block.title)}>
					<Markdown content={toText(block.text)} theme={theme} preset="chat" />
				</SectionCard>
			);
		case 'bars': {
			const data: BarDatum[] = (block.data ?? [])
				.filter((d) => d && typeof d.label === 'string' && typeof d.value === 'number')
				.map((d) => ({
					label: d.label,
					value: d.value,
					color: d.color ? resolveBlockColor(d.color, theme) : undefined,
				}));
			if (data.length === 0) return null;
			return (
				<ChartErrorBoundary theme={theme}>
					<AgentActivityBars
						theme={theme}
						data={data}
						topN={block.topN}
						emptyLabel={block.emptyLabel}
					/>
				</ChartErrorBoundary>
			);
		}
		case 'donut': {
			const palette = [
				theme.colors.accent,
				theme.colors.success,
				theme.colors.warning,
				theme.colors.error,
				ORANGE_HEX,
				theme.colors.textDim,
			];
			const slices: DonutSlice[] = (block.slices ?? [])
				.filter((s) => s && typeof s.label === 'string' && typeof s.value === 'number')
				.map((s, i) => ({
					label: s.label,
					value: s.value,
					color: s.color ? resolveBlockColor(s.color, theme) : palette[i % palette.length],
				}));
			if (slices.length === 0) return null;
			return (
				<ChartErrorBoundary theme={theme}>
					<TypeBreakdown theme={theme} slices={slices} size={block.size} />
				</ChartErrorBoundary>
			);
		}
		case 'successFailure':
			return (
				<SuccessFailureWidget
					theme={theme}
					successCount={block.successCount ?? 0}
					failureCount={block.failureCount ?? 0}
				/>
			);
		case 'sparkline':
			if (!Array.isArray(block.data) || block.data.length === 0) return null;
			return (
				<Sparkline
					data={block.data}
					color={resolveBlockColor(block.color, theme)}
					height={block.height}
				/>
			);

		default:
			return null;
	}
});

/** Render an agent-authored block tree. Surface-agnostic (plain flex column).
 *  Wrapped in an error boundary so a still-uncaught throw in an agent-authored
 *  block degrades to an inline error card instead of blanking the whole app
 *  (Movement/Cadenza mount this bare, above the app-level ErrorBoundary). */
export const BlockView = memo(function BlockView({ spec, theme }: BlockViewProps) {
	const blocks = toBlocks(spec);
	if (blocks.length === 0) return null;
	return (
		<ChartErrorBoundary theme={theme} chartName="view">
			<div
				style={{ display: 'flex', flexDirection: 'column', gap: resolveGap('md'), width: '100%' }}
			>
				{blocks.map((block, i) => (
					<OneBlock key={i} block={block} theme={theme} />
				))}
			</div>
		</ChartErrorBoundary>
	);
});
