/**
 * PipelineListTab - the reading view of Maestro Cue's pipelines.
 *
 * The Pipeline Graph tab answers "how is this wired?" by drawing it. This tab
 * answers the two questions the canvas is bad at: what does each pipeline
 * actually do, and is it working? One row per pipeline, with a prose flow line
 * and a health verdict derived from config validation plus the recent run
 * history.
 *
 * Read-only by design. Editing stays on the graph tab - the "Graph" action on
 * each row jumps there with that pipeline pre-selected.
 */

import { useMemo, useState } from 'react';
import { AlertTriangle, GitFork, Play, Search, X } from 'lucide-react';
import type { Theme } from '../../types';
import type { CuePipeline, CueGraphSession } from '../../../shared/cue-pipeline-types';
import type { CueRunResult } from '../../../shared/cue/contracts';
import {
	describePipeline,
	derivePipelineHealth,
	stripPipelinePrefix,
	type CuePipelineHealth,
	type CuePipelineHealthStatus,
} from '../../../shared/cue-pipeline-summary';
import { validatePipelines } from '../CuePipelineEditor/utils/pipelineValidation';
import { compareNamesIgnoringEmojis } from '../../../shared/emojiUtils';
import { SegmentedControl } from '../ui/SegmentedControl';
import { PipelineDot } from './StatusDot';
import { formatDuration, formatRelativeTime } from './cueModalUtils';

export interface PipelineListTabProps {
	theme: Theme;
	pipelines: CuePipeline[];
	/** Raw graph data - supplies each subscription's on-disk enabled flag. */
	graphSessions: CueGraphSession[];
	activeRuns: CueRunResult[];
	activityLog: CueRunResult[];
	loading: boolean;
	error: string | null;
	onRetry: () => void;
	/** Jump to the Pipeline Graph tab with this pipeline selected. */
	onViewInGraph: (pipelineId: string) => void;
	onTriggerSubscription: (subscriptionName: string) => void;
}

type StatusFilter = 'all' | 'attention' | 'running' | 'quiet';
type SortMode = 'health' | 'name' | 'recent';

/** Sort weight - lower sorts first, so the rows that need a human come first. */
const HEALTH_RANK: Record<CuePipelineHealthStatus, number> = {
	invalid: 0,
	failing: 1,
	running: 2,
	idle: 3,
	disabled: 4,
	healthy: 5,
};

function healthColor(status: CuePipelineHealthStatus, theme: Theme): string {
	switch (status) {
		case 'running':
			return theme.colors.accent;
		case 'invalid':
			return theme.colors.warning;
		case 'failing':
			return theme.colors.error;
		case 'healthy':
			return theme.colors.success;
		default:
			return theme.colors.textDim;
	}
}

interface PipelineRow {
	pipeline: CuePipeline;
	health: CuePipelineHealth;
	description: ReturnType<typeof describePipeline>;
	/** Distinct subscription names the Run Now button fires. */
	triggerSubs: string[];
	/** Lowercased haystack for the search box. */
	haystack: string;
}

export function PipelineListTab({
	theme,
	pipelines,
	graphSessions,
	activeRuns,
	activityLog,
	loading,
	error,
	onRetry,
	onViewInGraph,
	onTriggerSubscription,
}: PipelineListTabProps) {
	const [query, setQuery] = useState('');
	const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
	const [sortMode, setSortMode] = useState<SortMode>('health');

	// On-disk enabled flag per subscription. A pipeline whose every trigger is
	// switched off in cue.yaml is reported as disabled rather than idle - "it
	// never runs" and "it is turned off" are different problems.
	const subscriptionEnabled = useMemo(() => {
		const map = new Map<string, boolean>();
		for (const gs of graphSessions) {
			for (const sub of gs.subscriptions) {
				map.set(sub.name, sub.enabled);
			}
		}
		return map;
	}, [graphSessions]);

	const rows = useMemo<PipelineRow[]>(() => {
		return pipelines.map((pipeline) => {
			// Validate one pipeline at a time so each row owns exactly its own
			// errors - validatePipelines returns a flat list across all inputs.
			const configErrors = validatePipelines([pipeline]).map((e) =>
				stripPipelinePrefix(e, pipeline.name)
			);
			const description = describePipeline(pipeline);
			const triggerSubs = Array.from(
				new Set(
					description.triggers
						.map((t) => t.subscriptionName)
						.filter((name): name is string => !!name)
				)
			);
			const known = triggerSubs.filter((name) => subscriptionEnabled.has(name));
			const disabled = known.length > 0 && known.every((name) => !subscriptionEnabled.get(name));
			const health = derivePipelineHealth(pipeline, {
				activeRuns,
				activityLog,
				configErrors,
				disabled,
			});
			const haystack = [
				pipeline.name,
				description.flow,
				health.label,
				...description.triggers.map((t) => `${t.label} ${t.summary}`),
				...description.steps.map((s) => `${s.label} ${s.detail}`),
			]
				.join(' ')
				.toLowerCase();
			return { pipeline, health, description, triggerSubs, haystack };
		});
	}, [pipelines, subscriptionEnabled, activeRuns, activityLog]);

	const visibleRows = useMemo(() => {
		const needle = query.trim().toLowerCase();
		const filtered = rows.filter((row) => {
			if (needle && !row.haystack.includes(needle)) return false;
			switch (statusFilter) {
				case 'attention':
					return row.health.status === 'invalid' || row.health.status === 'failing';
				case 'running':
					return row.health.status === 'running';
				case 'quiet':
					return row.health.status === 'idle' || row.health.status === 'disabled';
				default:
					return true;
			}
		});
		const byName = (a: PipelineRow, b: PipelineRow) =>
			compareNamesIgnoringEmojis(a.pipeline.name, b.pipeline.name);
		return [...filtered].sort((a, b) => {
			if (sortMode === 'name') return byName(a, b);
			if (sortMode === 'recent') {
				// Never-run pipelines sink to the bottom rather than sorting as
				// "epoch", which would put them above everything that has run.
				const at = a.health.lastRun ? new Date(a.health.lastRun.endedAt).getTime() : -Infinity;
				const bt = b.health.lastRun ? new Date(b.health.lastRun.endedAt).getTime() : -Infinity;
				return bt - at || byName(a, b);
			}
			return HEALTH_RANK[a.health.status] - HEALTH_RANK[b.health.status] || byName(a, b);
		});
	}, [rows, query, statusFilter, sortMode]);

	if (loading && pipelines.length === 0) {
		return (
			<div className="flex-1 text-center py-12 text-sm" style={{ color: theme.colors.textDim }}>
				Loading pipelines...
			</div>
		);
	}

	return (
		<div className="flex-1 min-h-0 flex flex-col px-5 py-4">
			{error && (
				<div
					className="flex items-center gap-2 px-3 py-2 rounded-md text-xs mb-3"
					style={{
						backgroundColor: `${theme.colors.error}15`,
						border: `1px solid ${theme.colors.error}40`,
						color: theme.colors.error,
					}}
				>
					<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
					<span className="flex-1">{error}</span>
					<button
						onClick={onRetry}
						className="px-2 py-0.5 rounded text-xs hover:opacity-80"
						style={{ color: theme.colors.textMain }}
					>
						Retry
					</button>
				</div>
			)}

			{/* Toolbar */}
			<div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
				<h3
					className="text-xs font-bold uppercase tracking-wider"
					style={{ color: theme.colors.textDim }}
				>
					Pipelines
					{pipelines.length > 0 && (
						<span
							className="ml-2 font-normal normal-case tracking-normal"
							style={{ color: theme.colors.textDim, opacity: 0.7 }}
						>
							{visibleRows.length === pipelines.length
								? `${pipelines.length}`
								: `${visibleRows.length} of ${pipelines.length}`}
						</span>
					)}
				</h3>
				<div className="flex items-center gap-2 flex-wrap">
					<div
						className="flex items-center gap-1.5 px-2 py-1 rounded"
						style={{ backgroundColor: theme.colors.bgActivity, minWidth: 200 }}
					>
						<Search className="w-3 h-3 flex-shrink-0" style={{ color: theme.colors.textDim }} />
						<input
							type="text"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Search pipelines..."
							className="flex-1 bg-transparent outline-none text-xs"
							style={{ color: theme.colors.textMain }}
							disabled={pipelines.length === 0}
						/>
						{query && (
							<button
								onClick={() => setQuery('')}
								className="flex-shrink-0 opacity-60 hover:opacity-100"
								style={{ color: theme.colors.textDim }}
								aria-label="Clear search"
							>
								<X className="w-3 h-3" />
							</button>
						)}
					</div>
					<SegmentedControl
						value={statusFilter}
						onChange={setStatusFilter}
						options={[
							{ value: 'all', label: 'All' },
							{
								value: 'attention',
								label: 'Attention',
								title: 'Broken config or a failing last run',
							},
							{ value: 'running', label: 'Running' },
							{
								value: 'quiet',
								label: 'Quiet',
								title: 'Disabled, or nothing in the recent window',
							},
						]}
						theme={theme}
						ariaLabel="Filter pipelines by health"
						testId="pipeline-list-filter"
					/>
					<SegmentedControl
						value={sortMode}
						onChange={setSortMode}
						options={[
							{ value: 'health', label: 'Health' },
							{ value: 'name', label: 'Name' },
							{ value: 'recent', label: 'Last run' },
						]}
						theme={theme}
						ariaLabel="Sort pipelines"
						testId="pipeline-list-sort"
					/>
				</div>
			</div>

			{/* Body */}
			<div className="flex-1 min-h-0 overflow-y-auto space-y-2 select-text">
				{pipelines.length === 0 ? (
					<div className="text-sm py-8 text-center" style={{ color: theme.colors.textDim }}>
						No pipelines yet. Build one on the Pipeline Graph tab.
					</div>
				) : visibleRows.length === 0 ? (
					<div className="text-xs py-8 text-center" style={{ color: theme.colors.textDim }}>
						No pipelines match the current search and filter.
					</div>
				) : (
					visibleRows.map((row) => (
						<PipelineListRow
							key={row.pipeline.id}
							row={row}
							theme={theme}
							onViewInGraph={onViewInGraph}
							onTriggerSubscription={onTriggerSubscription}
						/>
					))
				)}
			</div>
		</div>
	);
}

function PipelineListRow({
	row,
	theme,
	onViewInGraph,
	onTriggerSubscription,
}: {
	row: PipelineRow;
	theme: Theme;
	onViewInGraph: (pipelineId: string) => void;
	onTriggerSubscription: (subscriptionName: string) => void;
}) {
	const { pipeline, health, description, triggerSubs } = row;
	const badgeColor = healthColor(health.status, theme);

	return (
		<div
			className="rounded-md px-3 py-2.5"
			style={{
				backgroundColor: theme.colors.bgActivity,
				border: `1px solid ${health.status === 'invalid' || health.status === 'failing' ? `${badgeColor}55` : theme.colors.border}`,
			}}
			data-testid={`pipeline-list-row-${pipeline.id}`}
		>
			{/* Heading: name, health badge, actions */}
			<div className="flex items-center gap-2">
				<PipelineDot color={pipeline.color} name={pipeline.name} />
				<span
					className="text-sm font-semibold truncate"
					style={{ color: theme.colors.textMain }}
					title={pipeline.name}
				>
					{pipeline.name}
				</span>
				<span
					className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide flex-shrink-0"
					style={{ backgroundColor: `${badgeColor}20`, color: badgeColor }}
				>
					{health.label}
				</span>
				<span className="flex-1" />
				{triggerSubs.length > 0 && (
					<button
						onClick={() => triggerSubs.forEach((name) => onTriggerSubscription(name))}
						className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:opacity-80 transition-opacity"
						style={{ color: theme.colors.textDim }}
						title={
							triggerSubs.length === 1
								? `Run "${triggerSubs[0]}" now`
								: `Run all ${triggerSubs.length} triggers now: ${triggerSubs.join(', ')}`
						}
					>
						<Play className="w-3 h-3" />
						Run now
					</button>
				)}
				<button
					onClick={() => onViewInGraph(pipeline.id)}
					className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:opacity-80 transition-opacity"
					style={{ color: theme.colors.textDim }}
					title="Open this pipeline on the Pipeline Graph tab"
				>
					<GitFork className="w-3 h-3" />
					Graph
				</button>
			</div>

			{/* What it does */}
			<div
				className="text-xs mt-1.5 break-words"
				style={{ color: theme.colors.textMain, opacity: 0.85 }}
			>
				{description.flow}
			</div>

			{/* How it is doing */}
			<div
				className="text-[11px] mt-1 flex items-center gap-1.5 flex-wrap"
				style={{ color: theme.colors.textDim }}
			>
				<span style={{ color: badgeColor }}>{health.detail}</span>
				{health.lastRun && (
					<>
						<span>·</span>
						<span title={new Date(health.lastRun.endedAt).toLocaleString()}>
							Last run {formatRelativeTime(health.lastRun.endedAt)} in{' '}
							{formatDuration(health.lastRun.durationMs)}
						</span>
					</>
				)}
				{health.recentRunCount > 0 && (
					<>
						<span>·</span>
						<span>
							{health.recentRunCount} recent run{health.recentRunCount === 1 ? '' : 's'}
							{health.recentFailureCount > 0 ? `, ${health.recentFailureCount} failed` : ''}
						</span>
					</>
				)}
				<span>·</span>
				<span>
					{description.steps.length} step{description.steps.length === 1 ? '' : 's'}
				</span>
			</div>

			{/* Config problems, verbatim */}
			{health.issues.length > 0 && (
				<ul className="mt-1.5 space-y-0.5">
					{health.issues.map((issue, i) => (
						<li
							key={i}
							className="text-[11px] flex items-start gap-1.5"
							style={{ color: theme.colors.warning }}
						>
							<AlertTriangle className="w-3 h-3 flex-shrink-0 mt-[1px]" />
							<span className="break-words">{issue}</span>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
