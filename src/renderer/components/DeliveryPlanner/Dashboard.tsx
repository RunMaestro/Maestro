import { memo, useMemo } from 'react';
import type React from 'react';
import {
	AlertTriangle,
	CheckCircle2,
	GitPullRequest,
	Inbox,
	Loader2,
	Network,
	ServerCrash,
	ShieldCheck,
	Tag,
} from 'lucide-react';
import type { Theme, WorkItem } from '../../types';
import { WORK_GRAPH_READY_TAG } from '../../types';
import { useDeliveryPlanner } from '../../hooks/useDeliveryPlanner';
import { EmptyState } from '../ui';
import { DependencyGraph } from './DependencyGraph';
import { LineageChip } from '../CrossMajor/LineageChip';

interface DashboardProps {
	theme: Theme;
	compact?: boolean;
}

interface PlannerSummary {
	epicsInProgress: WorkItem[];
	unblockedTasks: WorkItem[];
	blockedTasks: WorkItem[];
	recentlyCompleted: WorkItem[];
	agentReadyTasks: WorkItem[];
	graphItems: WorkItem[];
}

const ACTIVE_EPIC_STATUSES: WorkItem['status'][] = ['claimed', 'in_progress', 'review'];
const OPEN_STATUSES: WorkItem['status'][] = [
	'discovered',
	'planned',
	'ready',
	'claimed',
	'in_progress',
	'blocked',
	'review',
];

function isTaskLike(item: WorkItem): boolean {
	return item.type === 'task' || item.type === 'bug' || item.type === 'chore';
}

function blocksItem(item: WorkItem, itemById: Map<string, WorkItem>): boolean {
	return (item.dependencies ?? []).some((dependency) => {
		if (dependency.type !== 'blocks' || dependency.status !== 'active') return false;
		if (dependency.fromWorkItemId !== item.id) return false;
		const blocker = itemById.get(dependency.toWorkItemId);
		return !blocker || !['done', 'canceled'].includes(blocker.status);
	});
}

function summarize(items: WorkItem[]): PlannerSummary {
	const itemById = new Map(items.map((item) => [item.id, item]));
	const openTaskItems = items.filter(
		(item) => isTaskLike(item) && OPEN_STATUSES.includes(item.status)
	);
	const blockedTasks = openTaskItems.filter(
		(item) => item.status === 'blocked' || blocksItem(item, itemById)
	);

	return {
		epicsInProgress: items.filter(
			(item) => item.type === 'milestone' && ACTIVE_EPIC_STATUSES.includes(item.status)
		),
		unblockedTasks: openTaskItems.filter(
			(item) => item.status !== 'blocked' && !blocksItem(item, itemById)
		),
		blockedTasks,
		recentlyCompleted: items
			.filter((item) => item.status === 'done')
			.sort(
				(a, b) =>
					new Date(b.completedAt ?? b.updatedAt).getTime() -
					new Date(a.completedAt ?? a.updatedAt).getTime()
			)
			.slice(0, 6),
		agentReadyTasks: openTaskItems.filter((item) => item.tags.includes(WORK_GRAPH_READY_TAG)),
		graphItems: items.filter(
			(item) => OPEN_STATUSES.includes(item.status) || item.status === 'done'
		),
	};
}

function formatTime(value?: string): string {
	if (!value) return 'Never';
	return new Intl.DateTimeFormat(undefined, {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	}).format(new Date(value));
}

function Metric({
	icon,
	label,
	value,
	theme,
}: {
	icon: React.ReactNode;
	label: string;
	value: number;
	theme: Theme;
}) {
	return (
		<div
			className="rounded border p-3"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
		>
			<div className="flex items-center justify-between gap-2">
				<span className="text-[11px] uppercase font-bold" style={{ color: theme.colors.textDim }}>
					{label}
				</span>
				<span style={{ color: theme.colors.accent }}>{icon}</span>
			</div>
			<div className="mt-2 text-2xl font-bold" style={{ color: theme.colors.textMain }}>
				{value}
			</div>
		</div>
	);
}

function WorkList({
	title,
	items,
	theme,
	emptyTitle,
	emptyDescription,
}: {
	title: string;
	items: WorkItem[];
	theme: Theme;
	emptyTitle: string;
	emptyDescription?: string;
}) {
	return (
		<section>
			<div className="mb-2 text-xs uppercase font-bold" style={{ color: theme.colors.textDim }}>
				{title}
			</div>
			<div className="space-y-2">
				{items.slice(0, 6).map((item) => (
					<div
						key={item.id}
						className="rounded border p-3"
						style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
					>
						<div className="flex items-start justify-between gap-3">
							<div className="min-w-0">
								<div
									className="text-sm font-medium truncate"
									style={{ color: theme.colors.textMain }}
								>
									{item.title}
								</div>
								<div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
									<span style={{ color: theme.colors.textDim }}>{item.status}</span>
									{item.github?.issueNumber && (
										<span style={{ color: theme.colors.textDim }}>#{item.github.issueNumber}</span>
									)}
									{item.tags.includes(WORK_GRAPH_READY_TAG) && (
										<span
											className="rounded px-1.5 py-0.5 font-bold"
											style={{
												backgroundColor: `${theme.colors.success}18`,
												color: theme.colors.success,
											}}
										>
											{WORK_GRAPH_READY_TAG}
										</span>
									)}
								</div>
								<div className="mt-1">
									<LineageChip workItem={item} theme={theme} />
								</div>
							</div>
							<span className="text-[11px] shrink-0" style={{ color: theme.colors.textDim }}>
								{formatTime(item.completedAt ?? item.updatedAt)}
							</span>
						</div>
					</div>
				))}
				{items.length === 0 && (
					<div
						className="rounded border"
						style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
					>
						<EmptyState
							theme={theme}
							icon={<Inbox className="w-6 h-6" />}
							title={emptyTitle}
							description={emptyDescription}
							className="py-5"
						/>
					</div>
				)}
			</div>
		</section>
	);
}

export const DeliveryPlannerDashboard = memo(function DeliveryPlannerDashboard({
	theme,
	compact = false,
}: DashboardProps) {
	const filters = useMemo(() => ({ source: 'delivery-planner' as const, limit: 500 }), []);
	const { items, progress, loading, error, refresh } = useDeliveryPlanner(filters);
	const summary = useMemo(() => summarize(items), [items]);
	const activeOperations = Object.values(progress).filter((operation) =>
		['queued', 'running'].includes(operation.status)
	);
	const lastProgressAt = Object.values(progress)
		.map((operation) => operation.updatedAt)
		.sort()
		.at(-1);

	return (
		<div className={compact ? 'py-4 space-y-5' : 'p-6 space-y-6'}>
			<div className="flex items-start justify-between gap-3">
				<div>
					<h2 className="text-lg font-bold" style={{ color: theme.colors.textMain }}>
						Delivery Planner
					</h2>
					<div className="mt-1 text-xs" style={{ color: theme.colors.textDim }}>
						Work Graph refreshes arrive from desktop broadcasts.
					</div>
				</div>
				<button
					onClick={() => void refresh()}
					className="rounded px-2.5 py-1.5 text-xs font-bold border transition-colors hover:opacity-80"
					style={{
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
						backgroundColor: theme.colors.bgMain,
					}}
				>
					Refresh
				</button>
			</div>

			{error && (
				<EmptyState
					theme={theme}
					icon={<ServerCrash className="w-10 h-10" />}
					title="Failed to load planner data"
					description={error}
					primaryAction={{ label: 'Retry', onClick: () => void refresh() }}
					helpHref="https://docs.runmaestro.ai/delivery-planner"
					helpLabel="Delivery Planner docs"
				/>
			)}

			{!error && !loading && items.length === 0 && (
				<EmptyState
					theme={theme}
					icon={<Inbox className="w-10 h-10" />}
					title="No work items yet"
					description="Create a PRD and convert it to an epic to populate the planner."
					helpHref="https://docs.runmaestro.ai/delivery-planner"
					helpLabel="Learn about Delivery Planner"
				/>
			)}

			{!error && (items.length > 0 || loading) && (
				<>
					<div className="grid grid-cols-2 gap-2">
						<Metric
							icon={<GitPullRequest className="w-4 h-4" />}
							label="Epics"
							value={summary.epicsInProgress.length}
							theme={theme}
						/>
						<Metric
							icon={<ShieldCheck className="w-4 h-4" />}
							label="Unblocked"
							value={summary.unblockedTasks.length}
							theme={theme}
						/>
						<Metric
							icon={<AlertTriangle className="w-4 h-4" />}
							label="Blocked"
							value={summary.blockedTasks.length}
							theme={theme}
						/>
						<Metric
							icon={<Tag className="w-4 h-4" />}
							label="Agent Ready"
							value={summary.agentReadyTasks.length}
							theme={theme}
						/>
					</div>

					<div
						className="rounded border p-3 text-xs flex items-center justify-between gap-3"
						style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
					>
						<div className="flex items-center gap-2 min-w-0">
							{loading || activeOperations.length > 0 ? (
								<Loader2 className="w-4 h-4 animate-spin" style={{ color: theme.colors.warning }} />
							) : (
								<CheckCircle2 className="w-4 h-4" style={{ color: theme.colors.success }} />
							)}
							<span className="truncate" style={{ color: theme.colors.textMain }}>
								{activeOperations.length > 0
									? `${activeOperations.length} planner operation${activeOperations.length === 1 ? '' : 's'} active`
									: 'Planner sync idle'}
							</span>
						</div>
						<span className="shrink-0" style={{ color: theme.colors.textDim }}>
							{formatTime(lastProgressAt)}
						</span>
					</div>

					<WorkList
						title="Epics In Progress"
						items={summary.epicsInProgress}
						theme={theme}
						emptyTitle="No active epics"
						emptyDescription="Epics appear here once a PRD is converted."
					/>
					<WorkList
						title="Agent-Ready Tasks"
						items={summary.agentReadyTasks}
						theme={theme}
						emptyTitle="No agent-ready tasks"
						emptyDescription={`Tag a task "${WORK_GRAPH_READY_TAG}" to surface it here.`}
					/>
					<WorkList
						title="Unblocked Tasks"
						items={summary.unblockedTasks}
						theme={theme}
						emptyTitle="No unblocked tasks"
						emptyDescription="All open tasks are either blocked or complete."
					/>
					<WorkList
						title="Blocked Tasks"
						items={summary.blockedTasks}
						theme={theme}
						emptyTitle="No blocked tasks"
						emptyDescription="Nothing is currently blocking progress."
					/>
					<WorkList
						title="Recently Completed"
						items={summary.recentlyCompleted}
						theme={theme}
						emptyTitle="No completed tasks yet"
						emptyDescription="Completed tasks will appear here."
					/>

					<section>
						<div
							className="mb-2 flex items-center gap-2 text-xs uppercase font-bold"
							style={{ color: theme.colors.textDim }}
						>
							<Network className="w-3.5 h-3.5" />
							Dependency Graph
						</div>
						<DependencyGraph items={summary.graphItems} theme={theme} />
					</section>
				</>
			)}
		</div>
	);
});
