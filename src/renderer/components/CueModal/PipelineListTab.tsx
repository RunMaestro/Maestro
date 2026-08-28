/**
 * PipelineListTab - the reading view of Maestro Cue's pipelines.
 *
 * The Pipeline Graph tab answers "how is this wired?" by drawing it. This tab
 * answers the two questions the canvas is bad at: what does each pipeline
 * actually do, and is it working? One row per pipeline, collapsed to a
 * one-line overview plus a health verdict derived from config validation and
 * the recent run history; click a row to expand its triggers and steps in full.
 *
 * The collapse is load-bearing, not decoration. A pipeline like "Pedsidian"
 * groups 39 independent chains under one name, and listing all 39 node names
 * inline drowns the 16 other pipelines on the screen.
 *
 * Read-only by design. Editing stays on the graph tab - the "Graph" action on
 * each row jumps there with that pipeline pre-selected.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
	AlertTriangle,
	Bot,
	ChevronDown,
	ChevronRight,
	GitFork,
	Pencil,
	Play,
	Search,
	Terminal,
	X,
	Zap,
} from 'lucide-react';
import type { Theme } from '../../types';
import type { CuePipeline, CueGraphSession } from '../../../shared/cue-pipeline-types';
import type { CueRunResult } from '../../../shared/cue/contracts';
import {
	describePipeline,
	derivePipelineHealth,
	stripPipelinePrefix,
	type CueNodePrompts,
	type CuePipelineHealth,
	type CuePipelineHealthStatus,
} from '../../../shared/cue-pipeline-summary';
import { validatePipelines } from '../CuePipelineEditor/utils/pipelineValidation';
import { compareNamesIgnoringEmojis } from '../../../shared/emojiUtils';
import { SegmentedControl } from '../ui/SegmentedControl';
import { HoverTooltip } from '../ui/HoverTooltip';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { cueService } from '../../services/cue';
import { notifyToast } from '../../stores/notificationStore';
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
	/** Refetch graph data after a rename lands on disk. */
	onRenamed: () => void;
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

/** Stable empty set, so a row without an index entry doesn't get a new identity
 *  on every render. */
const EMPTY_NAMES: ReadonlySet<string> = new Set();

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
	onRenamed,
}: PipelineListTabProps) {
	const [query, setQuery] = useState('');
	const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
	const [sortMode, setSortMode] = useState<SortMode>('health');
	// Which rows are expanded. A Set of ids (not a single id) because comparing
	// two pipelines side by side is the common reason to expand at all.
	const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());

	// At most one row is being renamed at a time - a rename is a short,
	// committed interaction, unlike expansion which is a comparison aid.
	const [renamingId, setRenamingId] = useState<string | null>(null);

	const toggleExpanded = useCallback((pipelineId: string) => {
		setExpandedIds((prev) => {
			const next = new Set(prev);
			if (!next.delete(pipelineId)) next.add(pipelineId);
			return next;
		});
	}, []);

	const cancelRename = useCallback(() => setRenamingId(null), []);

	// While a rename is open it owns Escape: the key cancels the rename rather
	// than closing the whole Cue modal. The layer stack handles Escape on a
	// capture-phase window listener, so a keydown handler on the input could
	// never win - this has to be a real layer that outranks CUE_MODAL. Same
	// mechanism the Scheduled Tasks filter box uses.
	useModalLayer(MODAL_PRIORITIES.CUE_PIPELINE_RENAME, undefined, cancelRename, {
		enabled: renamingId !== null,
		// An inline field, not an overlay: it must not dim the modal, trap focus,
		// or block the rest of the list from being clicked.
		focusTrap: 'none',
		blocksLowerLayers: false,
		capturesFocus: false,
	});

	const commitRename = useCallback(
		async (oldName: string, newName: string) => {
			// Close the editor first: the rename round-trips to disk and then to a
			// graph-data refetch, and leaving a live input over a row that is about
			// to be replaced makes the field appear to hang.
			setRenamingId(null);
			try {
				const result = await cueService.renamePipeline(oldName, newName);
				if (!result.renamed) {
					notifyToast({
						type: 'error',
						title: `Could not rename "${oldName}"`,
						message: result.reason ?? 'The pipeline was not changed.',
					});
					return;
				}
				// Warnings mean the YAML rename DID land but something adjacent did
				// not (a root that could not be read, lost node positions). Report
				// them without calling the rename a failure.
				if (result.warnings.length > 0) {
					notifyToast({
						type: 'warning',
						title: `Renamed to "${newName}" with warnings`,
						message: result.warnings.join('; '),
					});
				} else {
					notifyToast({
						type: 'success',
						title: `Renamed to "${newName}"`,
						message: `Updated ${result.subscriptionsUpdated} subscription${
							result.subscriptionsUpdated === 1 ? '' : 's'
						} across ${result.filesWritten.length} file${
							result.filesWritten.length === 1 ? '' : 's'
						}.`,
					});
				}
				onRenamed();
			} catch (err) {
				notifyToast({
					type: 'error',
					title: `Could not rename "${oldName}"`,
					message: err instanceof Error ? err.message : 'The pipeline was not changed.',
				});
			}
		},
		[onRenamed]
	);

	// Per-pipeline set of every OTHER pipeline's name, lowercased, so the rename
	// editor can reject a duplicate before it reaches disk. Built once for the
	// whole list rather than per keystroke - the set only changes when the
	// pipelines do. Excluding the row's own name is what lets a user re-type the
	// name they already have (or change only its casing) without a false clash.
	const nameIndex = useMemo(() => {
		const map = new Map<string, ReadonlySet<string>>();
		for (const pipeline of pipelines) {
			map.set(
				pipeline.id,
				new Set(
					pipelines.filter((p) => p.id !== pipeline.id).map((p) => p.name.trim().toLowerCase())
				)
			);
		}
		return map;
	}, [pipelines]);

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
			// Prompt text is part of the haystack: in a fan-out pipeline the agent
			// names are all identical, so the prompt is the only searchable thing
			// that tells one step from another. Only the STEP prompts are added -
			// every trigger prompt rides an edge into some step, so including both
			// would just index the same text twice.
			const haystack = [
				pipeline.name,
				description.flow,
				health.label,
				...description.triggers.map((t) => `${t.label} ${t.summary}`),
				...description.steps.map((s) => `${s.label} ${s.detail} ${s.prompts.prompts.join(' ')}`),
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
							expanded={expandedIds.has(row.pipeline.id)}
							renaming={renamingId === row.pipeline.id}
							takenNames={nameIndex.get(row.pipeline.id) ?? EMPTY_NAMES}
							onToggleExpanded={toggleExpanded}
							onStartRename={setRenamingId}
							onCancelRename={cancelRename}
							onCommitRename={commitRename}
							onViewInGraph={onViewInGraph}
							onTriggerSubscription={onTriggerSubscription}
						/>
					))
				)}
			</div>
		</div>
	);
}

/**
 * Inline rename field. Its own component so the draft text lives here and dies
 * with the editor - keeping it in the parent means every keystroke re-renders
 * (and re-derives the health of) every pipeline in the list.
 *
 * Enter commits, Escape cancels, blur commits. Duplicate and empty names are
 * rejected before the IPC call rather than after: the backend would refuse
 * anyway, and catching it here keeps the field open with the bad text still in
 * it instead of bouncing the user back to a row that silently did not change.
 */
function PipelineNameEditor({
	theme,
	initialName,
	takenNames,
	onCommit,
	onCancel,
}: {
	theme: Theme;
	initialName: string;
	/** Every OTHER pipeline's name, lowercased. */
	takenNames: ReadonlySet<string>;
	onCommit: (name: string) => void;
	onCancel: () => void;
}) {
	const [draft, setDraft] = useState(initialName);
	const trimmed = draft.trim();
	const error =
		trimmed.length === 0
			? 'A pipeline needs a name'
			: takenNames.has(trimmed.toLowerCase()) && trimmed !== initialName
				? 'Another pipeline already has that name'
				: null;

	// Set the instant this editor is being torn down, so a blur fired on the way
	// out cannot commit. Escape cancels from the LAYER STACK, which unmounts this
	// component while its input still holds focus, and a blur-commit racing that
	// teardown would save the very rename Escape was pressed to abandon.
	//
	// Defensive: React does not fire `onBlur` for an element removed while
	// focused, so no test drives this branch (one that tried passed with the
	// guard deleted, which is worse than no test). Kept because it is one
	// comparison and the failure it prevents is silent and destructive.
	const closingRef = useRef(false);

	const cancel = () => {
		closingRef.current = true;
		onCancel();
	};

	const commit = () => {
		if (closingRef.current) return;
		// An unchanged name is a no-op, not an error - it is what pressing Enter
		// without typing should do.
		if (trimmed === initialName) return cancel();
		if (error) return;
		closingRef.current = true;
		onCommit(trimmed);
	};

	return (
		<span className="flex items-center gap-1.5 min-w-0 flex-1" onClick={(e) => e.stopPropagation()}>
			<input
				autoFocus
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
					// Stop every key here: the row is a button, so Space and Enter
					// would otherwise toggle it while the user is typing.
					//
					// Escape is NOT handled here on purpose. The layer stack claims it
					// on a capture-phase window listener, so this handler never sees
					// it; the cancel comes from the CUE_PIPELINE_RENAME layer that
					// PipelineListTab registers while a rename is open. A local
					// Escape branch here would be dead code that reads as the source
					// of the behavior.
					e.stopPropagation();
					if (e.key === 'Enter') {
						e.preventDefault();
						commit();
					}
				}}
				// Blur-commits rather than blur-cancels: clicking away from a field
				// you have just typed into reads as "keep it", and Escape is right
				// there for the other intent.
				onBlur={commit}
				className="text-sm font-semibold bg-transparent outline-none rounded px-1 py-0.5 min-w-0 flex-1"
				style={{
					color: theme.colors.textMain,
					border: `1px solid ${error ? theme.colors.error : theme.colors.accent}`,
				}}
				aria-label="Pipeline name"
				aria-invalid={error ? true : undefined}
				data-testid="pipeline-rename-input"
			/>
			{error && (
				<span className="text-[10px] flex-shrink-0" style={{ color: theme.colors.error }}>
					{error}
				</span>
			)}
		</span>
	);
}

function PipelineListRow({
	row,
	theme,
	expanded,
	renaming,
	takenNames,
	onToggleExpanded,
	onStartRename,
	onCancelRename,
	onCommitRename,
	onViewInGraph,
	onTriggerSubscription,
}: {
	row: PipelineRow;
	theme: Theme;
	expanded: boolean;
	renaming: boolean;
	takenNames: ReadonlySet<string>;
	onToggleExpanded: (pipelineId: string) => void;
	onStartRename: (pipelineId: string) => void;
	onCancelRename: () => void;
	onCommitRename: (oldName: string, newName: string) => void;
	onViewInGraph: (pipelineId: string) => void;
	onTriggerSubscription: (subscriptionName: string) => void;
}) {
	const { pipeline, health, description, triggerSubs } = row;
	const badgeColor = healthColor(health.status, theme);
	// "Run now" at the row level only when there is exactly ONE subscription to
	// fire. With several triggers the button is ambiguous (which event is being
	// simulated? they can carry entirely different prompts) and dangerous - a
	// 39-trigger pipeline would dispatch 39 agent runs on one click. Multi-
	// trigger pipelines get a per-trigger Run in the expanded panel instead.
	const singleRunSub = triggerSubs.length === 1 ? triggerSubs[0] : null;

	return (
		<div
			className="rounded-md"
			style={{
				backgroundColor: theme.colors.bgActivity,
				border: `1px solid ${health.status === 'invalid' || health.status === 'failing' ? `${badgeColor}55` : theme.colors.border}`,
			}}
			data-testid={`pipeline-list-row-${pipeline.id}`}
		>
			{/* Summary. The whole block is the expand target, so the click area
			    matches what the user reads rather than a 12px chevron. */}
			<div
				role="button"
				tabIndex={0}
				aria-expanded={expanded}
				aria-label={`${pipeline.name} details`}
				onClick={() => onToggleExpanded(pipeline.id)}
				onKeyDown={(e) => {
					if (e.key !== 'Enter' && e.key !== ' ') return;
					e.preventDefault();
					onToggleExpanded(pipeline.id);
				}}
				className="px-3 py-2.5 cursor-pointer outline-none focus-visible:ring-1"
				style={{ ...({ '--tw-ring-color': theme.colors.accent } as React.CSSProperties) }}
			>
				{/* Heading: name, health badge, actions */}
				<div className="flex items-center gap-2">
					{expanded ? (
						<ChevronDown
							className="w-3.5 h-3.5 flex-shrink-0"
							style={{ color: theme.colors.textDim }}
						/>
					) : (
						<ChevronRight
							className="w-3.5 h-3.5 flex-shrink-0"
							style={{ color: theme.colors.textDim }}
						/>
					)}
					<PipelineDot color={pipeline.color} name={pipeline.name} />
					{renaming ? (
						<PipelineNameEditor
							theme={theme}
							initialName={pipeline.name}
							takenNames={takenNames}
							onCancel={onCancelRename}
							onCommit={(name) => onCommitRename(pipeline.name, name)}
						/>
					) : (
						<>
							<span
								className="text-sm font-semibold truncate"
								style={{ color: theme.colors.textMain }}
								title={pipeline.name}
							>
								{pipeline.name}
							</span>
							<button
								onClick={(e) => {
									e.stopPropagation();
									onStartRename(pipeline.id);
								}}
								className="p-0.5 rounded hover:opacity-100 opacity-50 transition-opacity flex-shrink-0"
								style={{ color: theme.colors.textDim }}
								title={`Rename "${pipeline.name}"`}
								aria-label={`Rename ${pipeline.name}`}
							>
								<Pencil className="w-3 h-3" />
							</button>
						</>
					)}
					<span
						className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide flex-shrink-0"
						style={{ backgroundColor: `${badgeColor}20`, color: badgeColor }}
					>
						{health.label}
					</span>
					<span className="flex-1" />
					{singleRunSub && (
						<button
							onClick={(e) => {
								e.stopPropagation();
								onTriggerSubscription(singleRunSub);
							}}
							className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:opacity-80 transition-opacity"
							style={{ color: theme.colors.textDim }}
							title={`Run "${singleRunSub}" now`}
						>
							<Play className="w-3 h-3" />
							Run now
						</button>
					)}
					<button
						onClick={(e) => {
							e.stopPropagation();
							onViewInGraph(pipeline.id);
						}}
						className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:opacity-80 transition-opacity"
						style={{ color: theme.colors.textDim }}
						title="Open this pipeline on the Pipeline Graph tab"
					>
						<GitFork className="w-3 h-3" />
						Graph
					</button>
				</div>

				{/* What it does, at a glance */}
				<div
					className="text-xs mt-1.5 break-words"
					style={{ color: theme.colors.textMain, opacity: 0.85 }}
				>
					{description.headline}
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

				{/* Config problems, verbatim. Shown collapsed too - a broken
				    pipeline should not need a click to admit it. */}
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

			{expanded && (
				<div
					className="px-3 pb-3 pt-1 grid gap-4 sm:grid-cols-2"
					style={{ borderTop: `1px solid ${theme.colors.border}` }}
					data-testid={`pipeline-list-detail-${pipeline.id}`}
				>
					<DetailColumn
						title={`Triggers (${description.triggers.length})`}
						theme={theme}
						empty="No triggers configured"
					>
						{description.triggers.map((t, i) => (
							<li key={i} className="flex items-baseline gap-1.5">
								<Zap
									className="w-3 h-3 flex-shrink-0 translate-y-[1px]"
									style={{ color: theme.colors.accent }}
								/>
								{/* min-w-0 is load-bearing: without it this flex child
								    refuses to shrink below its content and the clipped
								    prompt line stretches the row instead of ellipsising. */}
								<span
									className="flex-1 min-w-0 break-words"
									style={{ color: theme.colors.textMain }}
								>
									{t.label}
									{t.summary && <span style={{ color: theme.colors.textDim }}> · {t.summary}</span>}
									{t.subscriptionName && (
										<span
											className="block text-[10px] font-mono break-all"
											style={{ color: theme.colors.textDim, opacity: 0.7 }}
										>
											{t.subscriptionName}
										</span>
									)}
									{/* No prompt line here on purpose. A trigger's outgoing edge
									    and its target's incoming edge are the SAME edge, so
									    rendering it in both columns prints every prompt twice.
									    It belongs on the step - that is the row it disambiguates,
									    and a fan-out trigger has one prompt per target rather
									    than one of its own. `t.prompts` stays on the summary for
									    callers that describe a trigger on its own. */}
								</span>
								{/* Per-trigger Run replaces the row-level button on
								    multi-trigger pipelines - each trigger is its own
								    subscription with its own prompt. */}
								{!singleRunSub && t.subscriptionName && (
									<button
										onClick={() => onTriggerSubscription(t.subscriptionName!)}
										className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] hover:opacity-80 transition-opacity flex-shrink-0"
										style={{ color: theme.colors.textDim }}
										title={`Run "${t.subscriptionName}" now`}
									>
										<Play className="w-2.5 h-2.5" />
										Run
									</button>
								)}
							</li>
						))}
					</DetailColumn>

					<DetailColumn
						title={`Steps (${description.steps.length})`}
						theme={theme}
						empty="No agents or commands"
					>
						{description.steps.map((s, i) => {
							const Icon =
								s.kind === 'agent' ? Bot : s.kind === 'command' ? Terminal : AlertTriangle;
							const color = s.kind === 'error' ? theme.colors.error : theme.colors.textDim;
							return (
								<li key={i} className="flex items-baseline gap-1.5">
									<Icon className="w-3 h-3 flex-shrink-0 translate-y-[1px]" style={{ color }} />
									{/* min-w-0: see the trigger column above. */}
									<span
										className="flex-1 min-w-0 break-words"
										style={{ color: theme.colors.textMain }}
									>
										{s.label}
										{s.detail && (
											<span
												className="block text-[10px] font-mono break-all"
												style={{ color, opacity: 0.7 }}
											>
												{s.detail}
											</span>
										)}
										<PromptLine prompts={s.prompts} theme={theme} />
									</span>
								</li>
							);
						})}
					</DetailColumn>
				</div>
			)}
		</div>
	);
}

/**
 * How much of a prompt the hover card will show. Prompts routinely run to
 * hundreds of lines; past this the card stops being a peek and becomes a
 * document viewer, which is what the graph's config panel is for.
 */
const PROMPT_TOOLTIP_MAX_CHARS = 1200;

/**
 * The prompt attached to a trigger or step: one clipped line inline, the full
 * text on hover.
 *
 * This is often the only thing distinguishing two rows - a fan-out pipeline
 * renders the same agent name six times, and only the prompt says which job is
 * which. The inline line is clipped by CSS rather than cut to a word count, so
 * it fits exactly as many words as the column is actually wide.
 */
function PromptLine({ prompts, theme }: { prompts: CueNodePrompts; theme: Theme }) {
	if (prompts.count === 0) return null;

	const full = prompts.prompts[0];
	const truncated =
		full.length > PROMPT_TOOLTIP_MAX_CHARS ? `${full.slice(0, PROMPT_TOOLTIP_MAX_CHARS)}…` : full;
	// A prompt that is already one short line needs no hover card repeating it;
	// one that wraps or has newlines does, because the inline view loses both.
	const isSingleLine = !full.includes('\n');

	return (
		<span className="flex items-baseline gap-1 min-w-0">
			<HoverTooltip
				theme={theme}
				maxWidth={520}
				onlyWhenTruncated={isSingleLine}
				triggerClassName="truncate min-w-0 flex-1"
				label={
					<span className="whitespace-pre-wrap break-words">
						{truncated}
						{prompts.count > 1 && (
							<span className="block mt-1.5 opacity-70">
								+{prompts.count - 1} more prompt{prompts.count - 1 === 1 ? '' : 's'} feed this
							</span>
						)}
					</span>
				}
			>
				<span
					className="block truncate text-[10px] italic"
					style={{ color: theme.colors.textDim, opacity: 0.85 }}
				>
					{prompts.preview}
				</span>
			</HoverTooltip>
			{prompts.count > 1 && (
				<span
					className="text-[9px] font-bold flex-shrink-0 px-1 rounded"
					style={{ backgroundColor: `${theme.colors.textDim}25`, color: theme.colors.textDim }}
					title={`${prompts.count} different prompts feed this`}
				>
					×{prompts.count}
				</span>
			)}
		</span>
	);
}

/** One labeled column inside an expanded row. */
function DetailColumn({
	title,
	theme,
	empty,
	children,
}: {
	title: string;
	theme: Theme;
	empty: string;
	children: React.ReactNode[];
}) {
	return (
		<div>
			<div
				className="text-[10px] font-bold uppercase tracking-wider mb-1"
				style={{ color: theme.colors.textDim }}
			>
				{title}
			</div>
			{children.length === 0 ? (
				<div className="text-[11px]" style={{ color: theme.colors.textDim, opacity: 0.7 }}>
					{empty}
				</div>
			) : (
				<ul className="space-y-1 text-[11px]">{children}</ul>
			)}
		</div>
	);
}
