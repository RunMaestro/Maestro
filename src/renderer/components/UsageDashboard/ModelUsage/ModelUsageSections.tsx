/**
 * The blocks of the Usage Dashboard's Models tab, top to bottom:
 *
 *   - `ModelSummaryCards`    - requests, tokens, the share on this machine, decisions;
 *   - `ModelSourcesTable`    - every source and the work it did (sortable);
 *   - `ModelLatencySection`  - p50 and p95 per source, one request and one turn;
 *   - `ModelTasksTable`      - what ran where, by task (sortable);
 *   - `RunOnAgentTiles`      - the agents that launched turns on another model;
 *   - `SystemOneSection`     - how decisions ended, and Auto's tier split;
 *   - `ProxySavingsSection`  - what the token proxy saved, as an estimate, and how well
 *                              the range is covered by what it read.
 *
 * Every block is presentational: it takes a slice of one `ModelUsage` record
 * and draws it. `ModelUsageStats` owns the fetch and the loading, error and
 * empty states. A block with nothing in the range still renders, with one line
 * that says what would fill it, so the tab keeps its shape and a feature that
 * is not set up yet is named rather than missing.
 */

import { Fragment, memo, useMemo, type ReactNode } from 'react';
import {
	Activity,
	Bot,
	Coins,
	Eye,
	HardDrive,
	ListChecks,
	Minimize2,
	RefreshCw,
	Scale,
	Server,
	Settings,
	Timer,
} from 'lucide-react';
import { getAgentDisplayName } from '../../../../shared/agentMetadata';
import {
	formatCalendarDay,
	formatCount,
	formatCountNoun,
	formatNumber,
	formatTimestamp,
	formatTokensCompact,
} from '../../../../shared/formatters';
import {
	MODEL_USAGE_SOURCE_KIND_LABELS,
	describeModelUsageRequestSplit,
	modelUsageSourceLatency,
	type ModelUsage,
	type ModelUsageAgent,
	type ModelUsageProxy,
	type ModelUsageSource,
	type ModelUsageSystemOne,
	type ModelUsageTask,
} from '../../../../shared/local-models/model-usage';
import { SYSTEM_ONE_LEDGER_OUTCOME_LABELS } from '../../../../shared/local-models/system-one-ledger';
import { formatSystemOneCost } from '../../../../shared/local-models/system-one-spend';
import {
	TOKEN_PROXY_ESTIMATE_NOTE,
	TOKEN_PROXY_EVIDENCE_SEPARATION_NOTE,
	TOKEN_PROXY_UNKNOWN_LABELS,
	describeAddedLatency,
	describeTokensSaved,
} from '../../../../shared/local-models/token-proxy';
import {
	TOKEN_PROXY_RESULTS_NOT_EVALUATED_NOTE,
	TOKEN_PROXY_TOTALS_ONLY_NOTE,
	TOKEN_PROXY_TREND_NOTE,
	describeProviderUsage,
	describeProviderUsageNote,
	describeProxyAlgorithmCohort,
	describeProxyHandling,
	describeProxyLatency,
} from '../../../../shared/local-models/token-proxy-report';
import type { DurationPercentiles } from '../../../../shared/percentiles';
import type { ProxyTrendDay } from '../../../../shared/stats-types';
import { COLORBLIND_LINE_COLORS } from '../../../constants/colorblindPalettes';
import { useTableSort } from '../../../hooks/ui/useTableSort';
import type { Theme } from '../../../types';
import { HeaderActionButton } from '../../ui/HeaderActionButton';
import { ProxyReportLines } from '../../shared/ProxyReportLines';
import { MiniBadge } from '../../ui/MiniBadge';
import { SortableTh } from '../../ui/SortableTh';
import { Spinner } from '../../ui/Spinner';
import {
	AgentActivityBars,
	MultiLineChart,
	SectionCard,
	StatCardGrid,
	TypeBreakdown,
	type BarDatum,
	type LineSeries,
	type StatCardDatum,
} from '../../widgets';
import { EntityTile, type EntityTileStat } from '../EntityTile';
import { MetricCard } from '../MetricCard';
import { AGENT_TILE_MIN_WIDTH, tileGridColumns } from '../tileScale';
import { LatencyBars } from './LatencyBars';
import {
	PROXY_MODE_SCOPE_NOTE,
	PROXY_ROUTE_SCOPE_NOTE,
	PROXY_TREND_AXIS_LABELS,
	PROXY_TREND_GAP_NOTE,
	PROXY_TREND_LINES_NOTE,
	defaultSortDirection,
	describeAgentTargets,
	formatLatency,
	formatShare,
	latencyBarRows,
	modelUsageAgentName,
	proxyModeSlices,
	proxyRouteSlices,
	proxyTrendView,
	routedTierSlices,
	routedTurnCount,
	runOnAgents,
	sortModelSources,
	sortModelTasks,
	sourceLocation,
	summarizeModelUsage,
	systemOneOutcomeSlices,
	type SourceLocationTone,
	type SourceSortKey,
	type TaskSortKey,
} from './modelUsageView';

/** Said in a cell that has no value, as opposed to a value of zero. */
const NO_VALUE = '-';

const TH_CLASS = 'text-xs font-medium uppercase tracking-wider px-3 py-2 border-b select-none';
const TD_CLASS = 'px-3 py-2 align-top';
const TD_NUMBER_CLASS = `${TD_CLASS} text-right font-mono tabular-nums whitespace-nowrap`;

interface ModelSetupAction {
	label: string;
	onClick: () => void;
}

function plural(count: number, one: string, many = `${one}s`): string {
	return `${formatNumber(count)} ${count === 1 ? one : many}`;
}

/** The one line a block shows when the range holds nothing for it. */
function SectionEmpty({
	theme,
	children,
	testId,
	actions,
}: {
	theme: Theme;
	children: ReactNode;
	testId?: string;
	actions?: readonly ModelSetupAction[];
}) {
	return (
		<p className="text-sm" style={{ color: theme.colors.textDim }} data-testid={testId}>
			{children}
			{actions?.map((action, index) => (
				<Fragment key={action.label}>
					{index === 0 ? ' ' : ' · '}
					<button
						type="button"
						onClick={action.onClick}
						className="underline underline-offset-2 rounded focus-ring hover:opacity-80"
						style={{ color: theme.colors.accent }}
					>
						{action.label}
					</button>
				</Fragment>
			))}
		</p>
	);
}

/** A dim line under a block: a unit, a caveat, a retention note. */
function SectionNote({
	theme,
	children,
	testId,
}: {
	theme: Theme;
	children: ReactNode;
	testId?: string;
}) {
	return (
		<p
			className="text-xs mt-3 select-text"
			style={{ color: theme.colors.textDim }}
			data-testid={testId}
		>
			{children}
		</p>
	);
}

/** A header cell that does not sort. */
function PlainTh({
	theme,
	children,
	align = 'left',
	title,
}: {
	theme: Theme;
	children: ReactNode;
	align?: 'left' | 'right';
	title?: string;
}) {
	return (
		<th
			className={`${TH_CLASS} ${align === 'right' ? 'text-right' : 'text-left'}`}
			style={{ color: theme.colors.textDim, borderColor: theme.colors.border }}
			title={title}
		>
			{children}
		</th>
	);
}

function zebra(theme: Theme, index: number): string {
	return index % 2 === 0 ? 'transparent' : `${theme.colors.border}10`;
}

/** p50 or p95 of a distribution, or a dash when it holds no sample. */
function latencyCell(distribution: DurationPercentiles, pick: 'p50' | 'p95'): string {
	return distribution.count > 0 ? formatLatency(distribution[pick]) : NO_VALUE;
}

// ---------------------------------------------------------------------------
// Summary cards
// ---------------------------------------------------------------------------

export const ModelSummaryCards = memo(function ModelSummaryCards({
	theme,
	usage,
}: {
	theme: Theme;
	usage: ModelUsage;
}) {
	const summary = useMemo(() => summarizeModelUsage(usage), [usage]);
	return (
		<div
			className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3"
			data-testid="model-usage-summary"
			role="region"
			aria-label="Model usage summary"
		>
			<MetricCard
				testId="model-usage-card-requests"
				icon={<Activity className="w-4 h-4" />}
				label="Requests"
				value={formatNumber(summary.requests)}
				subValue={[
					plural(summary.sourceCount, 'source'),
					summary.errors > 0 ? `${formatNumber(summary.errors)} failed` : null,
				]
					.filter(Boolean)
					.join(' · ')}
				theme={theme}
			/>
			<MetricCard
				testId="model-usage-card-tokens"
				icon={<Coins className="w-4 h-4" />}
				label="Tokens"
				value={formatTokensCompact(summary.tokensIn + summary.tokensOut)}
				subValue={`${formatTokensCompact(summary.tokensIn)} in · ${formatTokensCompact(summary.tokensOut)} out`}
				theme={theme}
			/>
			<MetricCard
				testId="model-usage-card-on-device"
				icon={<HardDrive className="w-4 h-4" />}
				label="On This Machine"
				value={formatShare(summary.onDeviceShare, summary.allRequests)}
				subValue={`${formatNumber(summary.onDeviceRequests)} of ${plural(summary.allRequests, 'request')}, provider clouds included`}
				theme={theme}
			/>
			<MetricCard
				testId="model-usage-card-decisions"
				icon={<Scale className="w-4 h-4" />}
				label="System One Decisions"
				value={formatNumber(summary.decisions)}
				subValue={
					summary.decisions > 0
						? `${formatNumber(summary.answered)} answered · ${formatSystemOneCost(summary.costUsd)}`
						: 'None in this range'
				}
				theme={theme}
			/>
		</div>
	);
});

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const SOURCE_COLUMNS: Array<{ key: SourceSortKey; label: string; title: string }> = [
	{ key: 'requests', label: 'Requests', title: 'Runs, agent turns and routed requests' },
	{ key: 'tokensIn', label: 'Tokens in', title: 'Tokens the model read' },
	{ key: 'tokensOut', label: 'Tokens out', title: 'Tokens the model wrote' },
	{ key: 'errors', label: 'Errors', title: 'Failed runs and failed routed requests' },
	{ key: 'p50', label: 'p50', title: 'Median latency of answered work' },
	{ key: 'p95', label: 'p95', title: '95th percentile latency of answered work' },
];

function locationColor(theme: Theme, tone: SourceLocationTone): string {
	if (tone === 'local') return theme.colors.success;
	if (tone === 'remote') return theme.colors.accent;
	return theme.colors.textDim;
}

export const ModelSourcesTable = memo(function ModelSourcesTable({
	theme,
	sources,
}: {
	theme: Theme;
	sources: ModelUsageSource[];
}) {
	const { sortKey, direction, isDescending, toggleSort } = useTableSort<SourceSortKey>('requests', {
		defaultDirectionFor: defaultSortDirection,
	});
	const sorted = useMemo(
		() => sortModelSources(sources, sortKey, isDescending),
		[sources, sortKey, isDescending]
	);
	const headerStyle = { color: theme.colors.textDim, borderColor: theme.colors.border };
	const hasTurnLatency = sources.some((source) => modelUsageSourceLatency(source)?.unit === 'turn');
	const hasProvider = sources.some((source) => source.kind === 'provider');

	return (
		<SectionCard theme={theme} title="Sources" icon={Server}>
			{sources.length === 0 ? (
				<SectionEmpty theme={theme} testId="model-usage-sources-empty">
					No source did work in this range.
				</SectionEmpty>
			) : (
				<>
					<div className="overflow-x-auto">
						<table
							className="w-full text-sm select-text"
							style={{ borderCollapse: 'separate', borderSpacing: 0 }}
							data-testid="model-usage-sources"
						>
							<thead>
								<tr>
									<SortableTh
										columnKey="source"
										label="Source"
										sortKey={sortKey}
										direction={direction}
										onSort={toggleSort}
										theme={theme}
										className={`${TH_CLASS} text-left`}
										style={headerStyle}
										title="Sort by source name"
									/>
									<PlainTh theme={theme}>Location</PlainTh>
									{SOURCE_COLUMNS.map((column) => (
										<SortableTh
											key={column.key}
											columnKey={column.key}
											label={column.label}
											sortKey={sortKey}
											direction={direction}
											onSort={toggleSort}
											theme={theme}
											align="right"
											className={`${TH_CLASS} text-right`}
											style={headerStyle}
											title={column.title}
										/>
									))}
								</tr>
							</thead>
							<tbody>
								{sorted.map((source, index) => (
									<SourceRow key={source.key} theme={theme} source={source} index={index} />
								))}
							</tbody>
						</table>
					</div>
					{hasTurnLatency && (
						<SectionNote theme={theme} testId="model-usage-turn-note">
							A latency marked &quot;turn&quot; is a whole agent turn, start to exit, not one
							request.
						</SectionNote>
					)}
					{hasProvider && (
						<SectionNote theme={theme} testId="model-usage-provider-note">
							Provider cloud rows are the agents&apos; turns on their provider&apos;s own model,
							shown for comparison. They are not in the Requests and Tokens cards above.
						</SectionNote>
					)}
				</>
			)}
		</SectionCard>
	);
});

function SourceRow({
	theme,
	source,
	index,
}: {
	theme: Theme;
	source: ModelUsageSource;
	index: number;
}) {
	const location = sourceLocation(source);
	const read = modelUsageSourceLatency(source);
	const unitSuffix = read?.unit === 'turn' ? ' turn' : '';
	return (
		<tr
			style={{ backgroundColor: zebra(theme, index) }}
			data-testid="model-usage-source"
			data-source={source.key}
		>
			<td className={TD_CLASS} style={{ color: theme.colors.textMain }}>
				<div className="flex items-center gap-2 min-w-0">
					<span className="truncate" title={source.label}>
						{source.label}
					</span>
					<MiniBadge label={MODEL_USAGE_SOURCE_KIND_LABELS[source.kind]} theme={theme} />
				</div>
				{source.kind !== 'provider' && source.models.length > 0 && (
					<div
						className="text-xs truncate"
						style={{ color: theme.colors.textDim, maxWidth: 360 }}
						title={source.models.map((entry) => `${entry.model} (${entry.requests})`).join(', ')}
					>
						{source.models.map((entry) => entry.model).join(', ')}
					</div>
				)}
			</td>
			<td className={TD_CLASS}>
				<MiniBadge
					label={location.label}
					theme={theme}
					color={locationColor(theme, location.tone)}
					title={location.title}
					className="whitespace-nowrap"
				/>
			</td>
			<td className={TD_NUMBER_CLASS} style={{ color: theme.colors.textMain }}>
				{formatCount(source.requests)}
				<div className="text-xs font-sans" style={{ color: theme.colors.textDim }}>
					{describeModelUsageRequestSplit(source)}
				</div>
			</td>
			<td
				className={TD_NUMBER_CLASS}
				style={{ color: theme.colors.textDim }}
				title={
					source.cachedTokensIn > 0
						? `Plus ${formatCount(source.cachedTokensIn)} read from or written to the prompt cache`
						: undefined
				}
			>
				{formatTokensCompact(source.tokensIn)}
			</td>
			<td className={TD_NUMBER_CLASS} style={{ color: theme.colors.textDim }}>
				{formatTokensCompact(source.tokensOut)}
			</td>
			<td
				className={TD_NUMBER_CLASS}
				style={{ color: source.errors > 0 ? theme.colors.error : theme.colors.textDim }}
			>
				{formatCount(source.errors)}
			</td>
			<td className={TD_NUMBER_CLASS} style={{ color: theme.colors.textDim }}>
				{read ? `${formatLatency(read.distribution.p50)}${unitSuffix}` : NO_VALUE}
			</td>
			<td className={TD_NUMBER_CLASS} style={{ color: theme.colors.textDim }}>
				{read ? `${formatLatency(read.distribution.p95)}${unitSuffix}` : NO_VALUE}
			</td>
		</tr>
	);
}

// ---------------------------------------------------------------------------
// Latency
// ---------------------------------------------------------------------------

function LatencyGroup({
	theme,
	title,
	children,
}: {
	theme: Theme;
	title: string;
	children: ReactNode;
}) {
	return (
		<div className="min-w-0">
			<div
				className="text-2xs uppercase tracking-wide mb-2"
				style={{ color: theme.colors.textDim }}
			>
				{title}
			</div>
			{children}
		</div>
	);
}

export const ModelLatencySection = memo(function ModelLatencySection({
	theme,
	sources,
}: {
	theme: Theme;
	sources: ModelUsageSource[];
}) {
	const requestRows = useMemo(() => latencyBarRows(sources, 'request'), [sources]);
	const turnRows = useMemo(() => latencyBarRows(sources, 'turn'), [sources]);
	return (
		<SectionCard theme={theme} title="Latency by Source" icon={Timer}>
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				<LatencyGroup theme={theme} title="One request">
					<LatencyBars
						theme={theme}
						rows={requestRows}
						unitLabel="requests"
						emptyLabel="No answered request in this range."
						testId="model-usage-latency-requests"
					/>
				</LatencyGroup>
				<LatencyGroup theme={theme} title="One agent turn">
					<LatencyBars
						theme={theme}
						rows={turnRows}
						unitLabel="turns"
						emptyLabel="No agent turn in this range."
						testId="model-usage-latency-turns"
					/>
				</LatencyGroup>
			</div>
			<SectionNote theme={theme}>
				Each row reads p50 / p95. The solid bar ends at the median and the faint bar at p95, on a
				log scale. Answered work only: a failed run&apos;s duration is its timeout.
			</SectionNote>
		</SectionCard>
	);
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const TASK_COLUMNS: Array<{ key: TaskSortKey; label: string; title: string }> = [
	{ key: 'runs', label: 'Runs', title: 'Model calls made for the task' },
	{ key: 'errors', label: 'Errors', title: 'Runs that failed' },
	{ key: 'tokens', label: 'Tokens', title: 'Tokens in and out' },
	{ key: 'p50', label: 'p50', title: 'Median latency of answered runs' },
	{ key: 'p95', label: 'p95', title: '95th percentile latency of answered runs' },
];

export const ModelTasksTable = memo(function ModelTasksTable({
	theme,
	tasks,
	setupActions,
}: {
	theme: Theme;
	tasks: ModelUsageTask[];
	setupActions?: readonly ModelSetupAction[];
}) {
	const { sortKey, direction, isDescending, toggleSort } = useTableSort<TaskSortKey>('runs', {
		defaultDirectionFor: defaultSortDirection,
	});
	const sorted = useMemo(
		() => sortModelTasks(tasks, sortKey, isDescending),
		[tasks, sortKey, isDescending]
	);
	const headerStyle = { color: theme.colors.textDim, borderColor: theme.colors.border };

	return (
		<SectionCard theme={theme} title="Tasks" icon={ListChecks}>
			{tasks.length === 0 ? (
				<SectionEmpty theme={theme} testId="model-usage-tasks-empty" actions={setupActions}>
					No housekeeping or System One task ran in this range. Configure task assignments:
				</SectionEmpty>
			) : (
				<div className="overflow-x-auto">
					<table
						className="w-full text-sm select-text"
						style={{ borderCollapse: 'separate', borderSpacing: 0 }}
						data-testid="model-usage-tasks"
					>
						<thead>
							<tr>
								<SortableTh
									columnKey="task"
									label="Task"
									sortKey={sortKey}
									direction={direction}
									onSort={toggleSort}
									theme={theme}
									className={`${TH_CLASS} text-left`}
									style={headerStyle}
									title="Sort by task name"
								/>
								{TASK_COLUMNS.map((column) => (
									<SortableTh
										key={column.key}
										columnKey={column.key}
										label={column.label}
										sortKey={sortKey}
										direction={direction}
										onSort={toggleSort}
										theme={theme}
										align="right"
										className={`${TH_CLASS} text-right`}
										style={headerStyle}
										title={column.title}
									/>
								))}
								<PlainTh theme={theme}>Where it ran</PlainTh>
							</tr>
						</thead>
						<tbody>
							{sorted.map((task, index) => (
								<tr
									key={task.taskId}
									style={{ backgroundColor: zebra(theme, index) }}
									data-testid="model-usage-task"
									data-task={task.taskId}
								>
									<td className={TD_CLASS} style={{ color: theme.colors.textMain }}>
										{task.label}
									</td>
									<td className={TD_NUMBER_CLASS} style={{ color: theme.colors.textMain }}>
										{formatCount(task.runs)}
									</td>
									<td
										className={TD_NUMBER_CLASS}
										style={{ color: task.errors > 0 ? theme.colors.error : theme.colors.textDim }}
									>
										{formatCount(task.errors)}
									</td>
									<td
										className={TD_NUMBER_CLASS}
										style={{ color: theme.colors.textDim }}
										title={`${formatCount(task.tokensIn)} in, ${formatCount(task.tokensOut)} out`}
									>
										{formatTokensCompact(task.tokensIn + task.tokensOut)}
									</td>
									<td className={TD_NUMBER_CLASS} style={{ color: theme.colors.textDim }}>
										{latencyCell(task.latency, 'p50')}
									</td>
									<td className={TD_NUMBER_CLASS} style={{ color: theme.colors.textDim }}>
										{latencyCell(task.latency, 'p95')}
									</td>
									<td className={`${TD_CLASS} text-xs`} style={{ color: theme.colors.textDim }}>
										{task.sources
											.map((source) => `${source.label} ${formatCount(source.runs)}`)
											.join(', ')}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</SectionCard>
	);
});

// ---------------------------------------------------------------------------
// Run on agents
// ---------------------------------------------------------------------------

function runOnAgentStats(agent: ModelUsageAgent): EntityTileStat[] {
	return [
		{ label: 'Turns', value: formatNumber(agent.turns) },
		{ label: 'Tokens in', value: formatTokensCompact(agent.tokensIn) },
		{ label: 'Tokens out', value: formatTokensCompact(agent.tokensOut) },
		{
			label: 'p50 turn',
			value: agent.turnDuration.count > 0 ? formatLatency(agent.turnDuration.p50) : NO_VALUE,
			muted: agent.turnDuration.count === 0,
			title:
				agent.turnDuration.count > 0
					? `p95 ${formatLatency(agent.turnDuration.p95)}`
					: 'No timed turn',
		},
	];
}

export const RunOnAgentTiles = memo(function RunOnAgentTiles({
	theme,
	agents,
	setupActions,
}: {
	theme: Theme;
	agents: ModelUsageAgent[];
	setupActions?: readonly ModelSetupAction[];
}) {
	const runOn = useMemo(() => runOnAgents(agents), [agents]);
	return (
		<SectionCard theme={theme} title="Run On Agents" icon={Bot}>
			{runOn.length === 0 ? (
				<SectionEmpty theme={theme} testId="model-usage-agents-empty" actions={setupActions}>
					No agent ran a turn on another model in this range. Set a Run on target on the Models tab
					of an agent&apos;s settings.
				</SectionEmpty>
			) : (
				<div
					className="grid gap-3"
					style={{ gridTemplateColumns: tileGridColumns(AGENT_TILE_MIN_WIDTH, 1) }}
					data-testid="model-usage-agents"
				>
					{runOn.map((agent, index) => {
						const name = modelUsageAgentName(agent);
						const targets = describeAgentTargets(agent);
						return (
							<EntityTile
								key={agent.agentId}
								theme={theme}
								title={name}
								subtitle={targets}
								badges={
									agent.agentType
										? [
												{
													label: getAgentDisplayName(agent.agentType),
													title: 'The harness these turns ran behind',
												},
											]
										: undefined
								}
								stats={runOnAgentStats(agent)}
								animationIndex={index}
								ariaLabel={`${name}: ${plural(agent.turns, 'Run on turn')} on ${targets}`}
								testId={`model-usage-agent-${agent.agentId}`}
							/>
						);
					})}
				</div>
			)}
		</SectionCard>
	);
});

// ---------------------------------------------------------------------------
// System One
// ---------------------------------------------------------------------------

function TitledBlock({
	theme,
	title,
	children,
	testId,
}: {
	theme: Theme;
	title: string;
	children: ReactNode;
	testId: string;
}) {
	return (
		<div className="min-w-0" data-testid={testId}>
			<div
				className="text-2xs uppercase tracking-wide mb-2"
				style={{ color: theme.colors.textDim }}
			>
				{title}
			</div>
			{children}
		</div>
	);
}

export const SystemOneSection = memo(function SystemOneSection({
	theme,
	systemOne,
	colorBlindMode = false,
	setupActions,
}: {
	theme: Theme;
	systemOne: ModelUsageSystemOne;
	colorBlindMode?: boolean;
	setupActions?: readonly ModelSetupAction[];
}) {
	const routedTurns = routedTurnCount(systemOne.routedTiers);
	const outcomeSlices = useMemo(
		() => systemOneOutcomeSlices(systemOne, theme, colorBlindMode),
		[systemOne, theme, colorBlindMode]
	);
	const tierSlices = useMemo(
		() => routedTierSlices(systemOne.routedTiers, theme, colorBlindMode),
		[systemOne.routedTiers, theme, colorBlindMode]
	);

	if (systemOne.decisions === 0 && routedTurns === 0) {
		return (
			<SectionCard theme={theme} title="System One" icon={Scale}>
				<SectionEmpty theme={theme} testId="model-usage-system-one-empty" actions={setupActions}>
					No System One decision in this range. Choose an engine and assign it a task:
				</SectionEmpty>
			</SectionCard>
		);
	}

	const facts = [
		systemOne.cached > 0 ? `${formatNumber(systemOne.cached)} answered from the cache` : null,
		systemOne.timeouts > 0
			? `${formatNumber(systemOne.timeouts)} ${SYSTEM_ONE_LEDGER_OUTCOME_LABELS.timeout.toLowerCase()}`
			: null,
		systemOne.decisions > 0 ? `${formatSystemOneCost(systemOne.costUsd)} spent` : null,
	].filter(Boolean);

	return (
		<SectionCard theme={theme} title="System One" icon={Scale}>
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				<TitledBlock theme={theme} title="How decisions ended" testId="model-usage-outcomes">
					{systemOne.decisions > 0 ? (
						<>
							<TypeBreakdown theme={theme} slices={outcomeSlices} />
							{facts.length > 0 && (
								<SectionNote theme={theme} testId="model-usage-outcome-facts">
									{facts.join(' · ')}
								</SectionNote>
							)}
						</>
					) : (
						<SectionEmpty theme={theme}>No decision in this range.</SectionEmpty>
					)}
				</TitledBlock>
				<TitledBlock theme={theme} title="Auto routing, by tier" testId="model-usage-tiers">
					{routedTurns > 0 ? (
						<>
							<TypeBreakdown theme={theme} slices={tierSlices} />
							<SectionNote theme={theme}>
								Turns sent on the Auto model, by the tier the router chose.
							</SectionNote>
						</>
					) : (
						<SectionEmpty theme={theme}>No turn was sent on the Auto model.</SectionEmpty>
					)}
				</TitledBlock>
			</div>

			{systemOne.byTask.length > 0 && (
				<div className="overflow-x-auto mt-4">
					<table
						className="w-full text-sm select-text"
						style={{ borderCollapse: 'separate', borderSpacing: 0 }}
						data-testid="model-usage-decisions"
					>
						<thead>
							<tr>
								<PlainTh theme={theme}>Task</PlainTh>
								<PlainTh theme={theme} align="right">
									Decisions
								</PlainTh>
								<PlainTh theme={theme} align="right">
									{SYSTEM_ONE_LEDGER_OUTCOME_LABELS.ok}
								</PlainTh>
								<PlainTh theme={theme} align="right">
									{SYSTEM_ONE_LEDGER_OUTCOME_LABELS['failed-open']}
								</PlainTh>
								<PlainTh theme={theme} align="right">
									{SYSTEM_ONE_LEDGER_OUTCOME_LABELS['failed-closed']}
								</PlainTh>
								<PlainTh
									theme={theme}
									align="right"
									title="Counted in the failed columns too: a timeout is why the decision had no answer."
								>
									{SYSTEM_ONE_LEDGER_OUTCOME_LABELS.timeout}
								</PlainTh>
								<PlainTh theme={theme} align="right">
									p50
								</PlainTh>
								<PlainTh theme={theme} align="right">
									p95
								</PlainTh>
							</tr>
						</thead>
						<tbody>
							{systemOne.byTask.map((task, index) => (
								<tr
									key={task.taskId}
									style={{ backgroundColor: zebra(theme, index) }}
									data-testid="model-usage-decision-task"
									data-task={task.taskId}
								>
									<td className={TD_CLASS} style={{ color: theme.colors.textMain }}>
										{task.label}
									</td>
									<td className={TD_NUMBER_CLASS} style={{ color: theme.colors.textMain }}>
										{formatCount(task.decisions)}
									</td>
									<td className={TD_NUMBER_CLASS} style={{ color: theme.colors.textDim }}>
										{formatCount(task.outcomes.ok)}
									</td>
									<td className={TD_NUMBER_CLASS} style={{ color: theme.colors.textDim }}>
										{formatCount(task.outcomes['failed-open'])}
									</td>
									<td
										className={TD_NUMBER_CLASS}
										style={{
											color:
												task.outcomes['failed-closed'] > 0
													? theme.colors.error
													: theme.colors.textDim,
										}}
									>
										{formatCount(task.outcomes['failed-closed'])}
									</td>
									<td className={TD_NUMBER_CLASS} style={{ color: theme.colors.textDim }}>
										{formatCount(task.timeouts)}
									</td>
									<td className={TD_NUMBER_CLASS} style={{ color: theme.colors.textDim }}>
										{latencyCell(task.latency, 'p50')}
									</td>
									<td className={TD_NUMBER_CLASS} style={{ color: theme.colors.textDim }}>
										{latencyCell(task.latency, 'p95')}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			{systemOne.byEngine.length > 0 && (
				<SectionNote theme={theme} testId="model-usage-engines">
					{systemOne.byEngine
						.map(
							(engine) =>
								`${engine.label}: ${plural(engine.decisions, 'decision')}, ${formatNumber(engine.answered)} answered`
						)
						.join(' · ')}
				</SectionNote>
			)}

			{systemOne.decisions > 0 && !systemOne.coversRange && (
				<SectionNote theme={theme} testId="model-usage-retention-note">
					Decisions are kept {systemOne.retentionDays} days. This range reaches back further, so the
					decision counts cover only the days still on record. The Auto routing split covers the
					whole range.
				</SectionNote>
			)}
		</SectionCard>
	);
});

// ---------------------------------------------------------------------------
// Token proxy
// ---------------------------------------------------------------------------

/** The y axis and tooltip of the trend: whole tokens, compact (the middle tick is a half). */
function formatTrendTokens(value: number): string {
	return formatTokensCompact(Math.round(value));
}

/**
 * The three figures to read first: the estimated reduction with what it is a share
 * of, how many of the carried requests the proxy read, and what reading them cost.
 * Each is said by the same description the table below uses, and says what it is
 * out of. A figure the proxy did not measure is `-` or `unknown`, never 0.
 */
function proxyHeadlineCards({ totals, effectiveness }: ModelUsageProxy): StatCardDatum[] {
	const read = totals.compressRequests;
	return [
		{
			label: 'Payload reduction (est.)',
			icon: Minimize2,
			value: totals.tokensSaved,
			displayValue: describeTokensSaved(totals),
			caption:
				read > 0
					? `of ${formatTokensCompact(totals.originalTokens)} estimated tokens in ${formatCountNoun(read, 'read request')}`
					: TOKEN_PROXY_UNKNOWN_LABELS['not-read'],
		},
		{
			label: 'Request coverage',
			icon: Eye,
			value: read,
			displayValue: `${formatCount(read)} / ${formatCount(totals.requests)}`,
			caption: 'requests the proxy read, of those it carried',
		},
		{
			label: 'Processing time (mean)',
			icon: Timer,
			value: totals.avgAddedLatencyMs,
			displayValue: describeAddedLatency(totals),
			caption: effectiveness ? describeProxyLatency(effectiveness.latency) : undefined,
		},
	];
}

/**
 * When the record was read, and the two things a reader does about it: read the
 * range again, and open Gateway to change what the proxy does. The time is the
 * fetch owner's own (`useModelUsage`), shown as read and never recomputed on a
 * timer.
 */
function ProxyToolbar({
	theme,
	loadedAt,
	refreshing,
	onRefresh,
	setupActions,
}: {
	theme: Theme;
	loadedAt: number | null;
	refreshing: boolean;
	onRefresh: () => void;
	setupActions?: readonly ModelSetupAction[];
}) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-2 mb-4">
			<p
				className="text-xs select-text"
				style={{ color: theme.colors.textDim }}
				data-testid="model-usage-proxy-loaded"
			>
				{loadedAt === null ? 'Not read yet' : `Loaded ${formatTimestamp(loadedAt)}`}
			</p>
			<div className="flex flex-wrap items-center gap-1">
				<HeaderActionButton
					theme={theme}
					variant="ghost"
					icon={refreshing ? <Spinner size={14} icon={RefreshCw} decorative /> : <RefreshCw />}
					onClick={onRefresh}
					disabled={refreshing}
					title="Read this range again"
					testId="model-usage-proxy-refresh"
				>
					{refreshing ? 'Refreshing' : 'Refresh'}
				</HeaderActionButton>
				{setupActions?.map((action) => (
					<HeaderActionButton
						key={action.label}
						theme={theme}
						variant="ghost"
						icon={<Settings />}
						onClick={action.onClick}
					>
						{action.label}
					</HeaderActionButton>
				))}
			</div>
		</div>
	);
}

/**
 * The estimated tokens of each day, as the requests arrived and as they were sent.
 * The two overlap (sent is the same text after shortening), so they are lines on
 * one axis and never stacked. A day with no request body read is a gap.
 */
function ProxyTrendChart({
	theme,
	trend,
	since,
	loadedAt,
	colorBlindMode,
}: {
	theme: Theme;
	trend: readonly ProxyTrendDay[];
	since: number;
	loadedAt: number | null;
	colorBlindMode: boolean;
}) {
	const view = useMemo(() => proxyTrendView(trend, since, loadedAt), [trend, since, loadedAt]);
	const labels = useMemo(() => view.days.map(formatCalendarDay), [view.days]);
	const series = useMemo<LineSeries[]>(
		() => [
			{
				key: 'original',
				label: 'Original (est.)',
				color: colorBlindMode ? COLORBLIND_LINE_COLORS.secondary : theme.colors.textDim,
				values: view.original,
			},
			{
				key: 'sent',
				label: 'Sent (est.)',
				color: colorBlindMode ? COLORBLIND_LINE_COLORS.primary : theme.colors.accent,
				values: view.sent,
				dashed: true,
			},
		],
		[view, theme, colorBlindMode]
	);

	if (!view.hasData) {
		return (
			<SectionEmpty theme={theme} testId="model-usage-proxy-trend-empty">
				No day in this range has a request the proxy read, so there is nothing to draw by day.
			</SectionEmpty>
		);
	}
	return (
		<>
			<MultiLineChart
				theme={theme}
				xLabels={labels}
				series={series}
				formatValue={formatTrendTokens}
				maxXLabels={PROXY_TREND_AXIS_LABELS}
				ariaLabel="Estimated tokens in the requests the proxy read, by day, as they arrived and as they were sent"
				testId="model-usage-proxy-trend"
			/>
			<SectionNote theme={theme} testId="model-usage-proxy-trend-note">
				{PROXY_TREND_LINES_NOTE} {TOKEN_PROXY_TREND_NOTE} {PROXY_TREND_GAP_NOTE}
			</SectionNote>
		</>
	);
}

/**
 * How the range's requests split by mode and by provider route (each a partition of
 * the requests carried, so a donut), and which algorithms shortened the blocks
 * (counts that overlap, so bars with their own cohort note and never a share). A
 * split an older desktop did not send is left out.
 */
function ProxyBreakdowns({
	theme,
	proxy,
	colorBlindMode,
}: {
	theme: Theme;
	proxy: ModelUsageProxy;
	colorBlindMode: boolean;
}) {
	const { byMode, byRoute, effectiveness } = proxy;
	const modeSlices = useMemo(
		() => (byMode ? proxyModeSlices(byMode, theme, colorBlindMode) : []),
		[byMode, theme, colorBlindMode]
	);
	const routeSlices = useMemo(
		() => (byRoute ? proxyRouteSlices(byRoute, theme, colorBlindMode) : []),
		[byRoute, theme, colorBlindMode]
	);
	const algorithms = effectiveness?.algorithms;
	const algorithmBars = useMemo<BarDatum[]>(
		() =>
			(algorithms?.algorithms ?? []).map(({ algorithm, blocks }) => ({
				label: algorithm,
				value: blocks,
			})),
		[algorithms]
	);

	if (modeSlices.length === 0 && routeSlices.length === 0 && algorithmBars.length === 0) {
		return null;
	}
	return (
		<div
			className="grid gap-6"
			style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}
		>
			{modeSlices.length > 0 && (
				<TitledBlock theme={theme} title="Request mode" testId="model-usage-proxy-modes">
					<TypeBreakdown theme={theme} slices={modeSlices} />
					<SectionNote theme={theme}>{PROXY_MODE_SCOPE_NOTE}</SectionNote>
				</TitledBlock>
			)}
			{routeSlices.length > 0 && (
				<TitledBlock theme={theme} title="Provider route" testId="model-usage-proxy-routes">
					<TypeBreakdown theme={theme} slices={routeSlices} />
					<SectionNote theme={theme}>{PROXY_ROUTE_SCOPE_NOTE}</SectionNote>
				</TitledBlock>
			)}
			{algorithms && effectiveness && algorithmBars.length > 0 && (
				<TitledBlock
					theme={theme}
					title="Algorithm contributions"
					testId="model-usage-proxy-algorithms"
				>
					{/* Every algorithm is a bar: the widget's "+N more" row would add counts that overlap. */}
					<AgentActivityBars
						theme={theme}
						data={algorithmBars}
						topN={algorithmBars.length}
						unitLabel="blocks shortened, per algorithm"
					/>
					<SectionNote theme={theme} testId="model-usage-proxy-algorithm-cohort">
						{describeProxyAlgorithmCohort(algorithms, effectiveness.traffic.blocksShortened)}
					</SectionNote>
				</TitledBlock>
			)}
		</div>
	);
}

/** What the provider counted, class by class, with the requests each class covers. */
function ProxyProviderUsage({ theme, proxy }: { theme: Theme; proxy: ModelUsageProxy }) {
	const lines = useMemo(() => describeProviderUsage(proxy), [proxy]);
	if (lines.length === 0) return null;
	return (
		<TitledBlock theme={theme} title="Provider usage" testId="model-usage-proxy-provider">
			<div style={{ color: theme.colors.textMain }}>
				<ProxyReportLines lines={lines} testId="model-usage-proxy-provider-lines" />
			</div>
			<SectionNote theme={theme} testId="model-usage-proxy-provider-note">
				{describeProviderUsageNote(proxy)}
			</SectionNote>
		</TitledBlock>
	);
}

export const ProxySavingsSection = memo(function ProxySavingsSection({
	theme,
	proxy,
	since,
	loadedAt,
	refreshing,
	onRefresh,
	colorBlindMode = false,
	setupActions,
	inspection,
}: {
	theme: Theme;
	proxy: ModelUsageProxy;
	/** Where the range starts (`ModelUsage.since`; 0 for all time). It bounds the trend's axis. It is not a freshness. */
	since: number;
	/** When the record was last read successfully (`useModelUsage`). Null before a read answers. */
	loadedAt: number | null;
	/** Whether a manual refresh is in flight. */
	refreshing: boolean;
	onRefresh: () => void;
	colorBlindMode?: boolean;
	setupActions?: readonly ModelSetupAction[];
	inspection?: ReactNode;
}) {
	const { effectiveness } = proxy;
	const cards = useMemo(() => proxyHeadlineCards(proxy), [proxy]);
	const handling = useMemo(
		() => (effectiveness ? describeProxyHandling(effectiveness) : []),
		[effectiveness]
	);

	if (proxy.totals.requests === 0) {
		return (
			<SectionCard theme={theme} title="Token Proxy Savings" icon={Minimize2}>
				<SectionEmpty theme={theme} testId="model-usage-proxy-empty" actions={setupActions}>
					No request went through the Maestro token proxy in this range. Turn it on for an agent in
					Gateway settings.
				</SectionEmpty>
				{inspection}
			</SectionCard>
		);
	}

	return (
		<SectionCard
			theme={theme}
			title="Token Proxy Savings"
			icon={Minimize2}
			action={<MiniBadge label="Estimate" theme={theme} title={TOKEN_PROXY_ESTIMATE_NOTE} />}
		>
			<ProxyToolbar
				theme={theme}
				loadedAt={loadedAt}
				refreshing={refreshing}
				onRefresh={onRefresh}
				setupActions={setupActions}
			/>
			<div className="space-y-5">
				<div data-testid="model-usage-proxy-headline">
					<StatCardGrid theme={theme} cards={cards} minColumnWidth={220} />
				</div>
				{effectiveness && (
					<TitledBlock
						theme={theme}
						title="Provider-bound text estimates, by day"
						testId="model-usage-proxy-trend-block"
					>
						<ProxyTrendChart
							theme={theme}
							trend={effectiveness.trend}
							since={since}
							loadedAt={loadedAt}
							colorBlindMode={colorBlindMode}
						/>
					</TitledBlock>
				)}
				<ProxyBreakdowns theme={theme} proxy={proxy} colorBlindMode={colorBlindMode} />
				<ProxyProviderUsage theme={theme} proxy={proxy} />
				<div className="overflow-x-auto">
					<table
						className="w-full text-sm select-text"
						style={{ borderCollapse: 'separate', borderSpacing: 0 }}
						data-testid="model-usage-proxy"
					>
						<thead>
							<tr>
								<PlainTh theme={theme}>Agent</PlainTh>
								<PlainTh theme={theme} align="right">
									Requests
								</PlainTh>
								<PlainTh theme={theme} align="right" title={TOKEN_PROXY_ESTIMATE_NOTE}>
									Tokens saved (est.)
								</PlainTh>
								<PlainTh theme={theme} align="right">
									Average added latency
								</PlainTh>
							</tr>
						</thead>
						<tbody>
							<tr data-testid="model-usage-proxy-total">
								<td className={`${TD_CLASS} font-medium`} style={{ color: theme.colors.textMain }}>
									All agents
								</td>
								<td className={TD_NUMBER_CLASS} style={{ color: theme.colors.textMain }}>
									{formatCount(proxy.totals.requests)}
								</td>
								<td className={TD_NUMBER_CLASS} style={{ color: theme.colors.textMain }}>
									{describeTokensSaved(proxy.totals)}
								</td>
								<td className={TD_NUMBER_CLASS} style={{ color: theme.colors.textDim }}>
									{describeAddedLatency(proxy.totals)}
								</td>
							</tr>
							{proxy.byAgent.map((row, index) => (
								<tr
									key={row.agentId ?? 'no-agent'}
									style={{ backgroundColor: zebra(theme, index + 1) }}
									data-testid="model-usage-proxy-agent"
									data-agent-id={row.agentId ?? ''}
								>
									<td className={TD_CLASS} style={{ color: theme.colors.textMain }}>
										{modelUsageAgentName(row)}
									</td>
									<td className={TD_NUMBER_CLASS} style={{ color: theme.colors.textDim }}>
										{formatCount(row.requests)}
									</td>
									<td className={TD_NUMBER_CLASS} style={{ color: theme.colors.textDim }}>
										{describeTokensSaved(row)}
									</td>
									<td className={TD_NUMBER_CLASS} style={{ color: theme.colors.textDim }}>
										{describeAddedLatency(row)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				{handling.length > 0 && (
					<TitledBlock
						theme={theme}
						title="How the proxy handled these requests"
						testId="model-usage-proxy-handling"
					>
						<div style={{ color: theme.colors.textMain }}>
							<ProxyReportLines lines={handling} testId="model-usage-proxy-handling-lines" />
						</div>
					</TitledBlock>
				)}
			</div>
			{!effectiveness && (
				<SectionNote theme={theme} testId="model-usage-proxy-older">
					{TOKEN_PROXY_TOTALS_ONLY_NOTE}
				</SectionNote>
			)}
			{proxy.routedRequests > 0 && (
				<SectionNote theme={theme} testId="model-usage-proxy-routed">
					{plural(proxy.routedRequests, 'background request')} sent to a Local Models target in
					place of the provider.
				</SectionNote>
			)}
			<SectionNote theme={theme} testId="model-usage-proxy-estimate">
				{TOKEN_PROXY_ESTIMATE_NOTE}
			</SectionNote>
			<SectionNote theme={theme} testId="model-usage-proxy-separation">
				{TOKEN_PROXY_EVIDENCE_SEPARATION_NOTE}
			</SectionNote>
			<SectionNote theme={theme} testId="model-usage-proxy-not-evaluated">
				{TOKEN_PROXY_RESULTS_NOT_EVALUATED_NOTE}
			</SectionNote>
			{inspection}
		</SectionCard>
	);
});
