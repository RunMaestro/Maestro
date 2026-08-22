/**
 * ScheduledTasksTab - the Cue modal's list of clock-driven tasks.
 *
 * Shows every `time.once` / `time.scheduled` / `time.heartbeat` subscription
 * across all agents in one place, with the four things a user actually wants
 * from a scheduler: see what is queued, change when it runs, pause it, cancel
 * it - plus a form to add new ones without hand-editing YAML.
 *
 * The list is the same data `maestro-cli cue schedule --list` prints, read
 * through the same module, so the two surfaces can never disagree.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
	AlarmClock,
	CalendarClock,
	Pause,
	Pencil,
	Play,
	Plus,
	Repeat,
	Search,
	Trash2,
} from 'lucide-react';
import type { Theme } from '../../types';
import { EmptyStatePlaceholder } from '../ui/EmptyStatePlaceholder';
import { EscCloseButton } from '../ui/EscCloseButton';
import { SortableTh } from '../ui/SortableTh';
import { getModalActions } from '../../stores/modalStore';
import { useScheduledTasks } from '../../hooks/cue/useScheduledTasks';
import { useTableSort } from '../../hooks/ui/useTableSort';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { fuzzyMatchWithScore } from '../../utils/search';
import { compareNamesIgnoringEmojis } from '../../../shared/emojiUtils';
import { formatDurationCompact } from '../../../shared/formatters';
import {
	describeSchedule,
	type ScheduledTask,
	type ScheduledTaskKind,
} from '../../../shared/cue/scheduled-tasks';
import { ScheduledTaskForm, type ScheduledTaskFormAgent } from './ScheduledTaskForm';

export interface ScheduledTasksTabProps {
	theme: Theme;
	/** Whether this tab is the visible one - gates fetching and polling. */
	active: boolean;
	agents: ScheduledTaskFormAgent[];
	/** Agent pre-selected when creating a task (usually the active agent). */
	defaultAgentId?: string;
}

const KIND_ICON: Record<ScheduledTaskKind, typeof AlarmClock> = {
	once: AlarmClock,
	daily: CalendarClock,
	interval: Repeat,
};

const KIND_LABEL: Record<ScheduledTaskKind, string> = {
	once: 'Once',
	daily: 'At set times',
	interval: 'Interval',
};

/** Sort order for the Repeats column: soonest-lived kind first. Alphabetical
 *  on the labels would read as arbitrary ("At set times" before "Once"). */
const KIND_RANK: Record<ScheduledTaskKind, number> = { once: 0, daily: 1, interval: 2 };

type TaskSortKey = 'task' | 'agent' | 'repeats' | 'schedule' | 'next';

/** Text columns read best A-Z; the countdown reads best soonest-first, which is
 *  also ascending, so every column starts ascending. */
const SORT_TITLES: Record<TaskSortKey, string> = {
	task: 'Sort by task label',
	agent: 'Sort by owning agent',
	repeats: 'Sort by how the task repeats',
	schedule: 'Sort by schedule',
	next: 'Sort by time until the next fire',
};

/** What the Task column sorts and filters on. */
function taskTitle(task: ScheduledTask): string {
	return task.label || task.name;
}

/** "in 4m" / "overdue" / "-" for a task whose next fire cannot be projected. */
function formatCountdown(task: ScheduledTask, nowMs: number): string {
	if (task.nextFireAtMs === null) return task.kind === 'interval' ? 'on interval' : '-';
	const delta = task.nextFireAtMs - nowMs;
	if (delta < 0) return 'overdue';
	return `in ${formatDurationCompact(delta)}`;
}

/**
 * True when the task matches the filter query.
 *
 * Two classes of field, matched two different ways on purpose:
 *
 *   - **Identity** (label, subscription name, agent) gets FUZZY subsequence
 *     matching, because that is what people abbreviate: "wspr" should find
 *     "Wispr Sync". The cost is the usual fuzzy noise - "sans" legitimately
 *     matches "Pedsidian-Wispr-Sync" - which is the same bargain VS Code's
 *     file switcher and the Usage Dashboard's agent filter already make.
 *   - **Descriptive** (pipeline, schedule text, action) gets plain SUBSTRING
 *     matching. Nobody abbreviates "18:00" or "command"; the value here is
 *     exact recall. Fuzzy on a schedule string like "09:00 (every day)" would
 *     match almost any query built from those characters and drown the list.
 */
function taskMatchesFilter(task: ScheduledTask, query: string): boolean {
	const fuzzyFields = [taskTitle(task), task.name, task.agentName];
	if (fuzzyFields.some((text) => text && fuzzyMatchWithScore(text, query).matches)) return true;

	const needle = query.toLowerCase();
	const substringFields = [task.pipelineName, describeSchedule(task), task.action];
	return substringFields.some((text) => text && text.toLowerCase().includes(needle));
}

export function ScheduledTasksTab({
	theme,
	active,
	agents,
	defaultAgentId,
}: ScheduledTasksTabProps) {
	const { tasks, warnings, loading, createTask, updateTask, cancelTask, setTaskEnabled } =
		useScheduledTasks(active);
	const [editing, setEditing] = useState<
		{ mode: 'create' } | { mode: 'edit'; task: ScheduledTask } | null
	>(null);

	const [filterQuery, setFilterQuery] = useState('');
	const filterInputRef = useRef<HTMLInputElement>(null);
	const { sortKey, direction, isDescending, toggleSort } = useTableSort<TaskSortKey>('next');

	const clearFilter = useCallback(() => {
		setFilterQuery('');
		filterInputRef.current?.focus();
	}, []);

	// While the filter holds text, it owns Escape: the key clears the box rather
	// than closing the whole Cue modal. The layer stack handles Escape on a
	// capture-phase window listener, so an input-local key handler could never
	// win - this has to be a real layer that outranks CUE_MODAL.
	useModalLayer(MODAL_PRIORITIES.CUE_SCHEDULED_TASK_FILTER, undefined, clearFilter, {
		enabled: filterQuery.length > 0,
		focusTrap: 'none',
		blocksLowerLayers: false,
		capturesFocus: false,
	});

	// One clock read per render pass keeps every countdown in a batch consistent.
	const nowMs = Date.now();

	const agentCount = useMemo(() => new Set(tasks.map((task) => task.agentId)).size, [tasks]);

	// Filter first, then sort: the chosen column is the user's stated order and
	// survives filtering untouched. There is no "relevance" column to sort by,
	// and re-ranking by fuzzy score would silently scramble the countdown order
	// people rely on to see what fires next.
	const visibleTasks = useMemo(() => {
		const query = filterQuery.trim();
		const filtered = query ? tasks.filter((task) => taskMatchesFilter(task, query)) : tasks;

		const sorted = filtered.slice().sort((a, b) => {
			let diff = 0;
			switch (sortKey) {
				case 'task':
					diff = compareNamesIgnoringEmojis(taskTitle(a), taskTitle(b));
					break;
				case 'agent':
					diff =
						compareNamesIgnoringEmojis(a.agentName, b.agentName) ||
						compareNamesIgnoringEmojis(taskTitle(a), taskTitle(b));
					break;
				case 'repeats':
					diff =
						KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
						compareNamesIgnoringEmojis(taskTitle(a), taskTitle(b));
					break;
				case 'schedule':
					diff = describeSchedule(a).localeCompare(describeSchedule(b));
					break;
				case 'next': {
					// Tasks with no projection (an interval's phase lives in engine
					// run state, not YAML) sink to the bottom in BOTH directions.
					// Flipping the sort must not promote rows that have no value to
					// compare - "unknown" is not the largest countdown.
					if (a.nextFireAtMs === null && b.nextFireAtMs === null) diff = 0;
					else if (a.nextFireAtMs === null) return 1;
					else if (b.nextFireAtMs === null) return -1;
					else diff = a.nextFireAtMs - b.nextFireAtMs;
					break;
				}
			}
			return isDescending ? -diff : diff;
		});
		return sorted;
	}, [tasks, filterQuery, sortKey, isDescending]);

	function confirmCancel(task: ScheduledTask) {
		getModalActions().showConfirmation(
			`Cancel scheduled task "${task.name}"?\n\nIt will be removed from ${task.agentName}'s cue.yaml. This cannot be undone.`,
			() => void cancelTask(task)
		);
	}

	if (editing) {
		return (
			<div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
				<ScheduledTaskForm
					theme={theme}
					agents={agents}
					defaultAgentId={defaultAgentId}
					task={editing.mode === 'edit' ? editing.task : undefined}
					onCancel={() => setEditing(null)}
					onCreate={createTask}
					onUpdate={updateTask}
				/>
			</div>
		);
	}

	const headerClass = 'pb-2 font-medium whitespace-nowrap';

	return (
		<div className="flex-1 min-h-0 flex flex-col">
			<div
				className="flex items-center justify-between gap-3 px-5 py-3 border-b"
				style={{ borderColor: theme.colors.border }}
			>
				<div className="flex flex-col shrink-0">
					<span
						className="text-xs font-semibold uppercase tracking-wide"
						style={{ color: theme.colors.textDim }}
					>
						Scheduled Tasks
					</span>
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						{tasks.length === 0
							? 'Nothing scheduled'
							: `${tasks.length} task${tasks.length === 1 ? '' : 's'} across ${agentCount} agent${agentCount === 1 ? '' : 's'}`}
					</span>
				</div>

				<div className="flex items-center gap-2 min-w-0 flex-1 justify-center">
					<div className="relative flex items-center" style={{ width: 320, maxWidth: '100%' }}>
						<Search
							className="absolute left-2 w-3.5 h-3.5 pointer-events-none"
							style={{ color: filterQuery ? theme.colors.accent : theme.colors.textDim }}
							aria-hidden="true"
						/>
						<input
							ref={filterInputRef}
							type="text"
							value={filterQuery}
							onChange={(e) => setFilterQuery(e.target.value)}
							placeholder="Filter tasks, agents, pipelines, schedules..."
							className="w-full rounded border bg-transparent outline-none text-xs py-1 pl-7"
							style={{
								borderColor: filterQuery ? theme.colors.accent : theme.colors.border,
								color: theme.colors.textMain,
								paddingRight: filterQuery ? 52 : 8,
							}}
							aria-label="Filter scheduled tasks"
							data-testid="scheduled-tasks-filter-input"
						/>
						{filterQuery && (
							<EscCloseButton
								theme={theme}
								variant="adornment"
								label="Clear filter (Esc)"
								onClose={clearFilter}
								testId="scheduled-tasks-filter-clear"
							/>
						)}
					</div>
					{filterQuery && (
						<span
							className="text-xs tabular-nums whitespace-nowrap"
							style={{ color: theme.colors.textDim }}
							data-testid="scheduled-tasks-filter-count"
						>
							{visibleTasks.length} of {tasks.length}
						</span>
					)}
				</div>

				<button
					onClick={() => setEditing({ mode: 'create' })}
					disabled={agents.length === 0}
					className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium disabled:opacity-50 shrink-0"
					style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
				>
					<Plus className="w-3.5 h-3.5" />
					New Task
				</button>
			</div>

			<div className="flex-1 min-h-0 overflow-y-auto px-5 py-3">
				{warnings.length > 0 && (
					<div className="mb-3 text-xs" style={{ color: theme.colors.warning }}>
						{warnings.map((warning) => (
							<div key={warning}>{warning}</div>
						))}
					</div>
				)}

				{loading && tasks.length === 0 ? (
					<div className="text-center py-8 text-sm" style={{ color: theme.colors.textDim }}>
						Loading scheduled tasks...
					</div>
				) : tasks.length === 0 ? (
					<EmptyStatePlaceholder
						theme={theme}
						icon={<AlarmClock className="w-8 h-8" />}
						title="No scheduled tasks"
						description="Schedule a one-shot reminder, a daily job, or a repeating check. Agents can create the same tasks with: maestro-cli cue schedule --in 20m --agent <name> --prompt '...'"
					/>
				) : visibleTasks.length === 0 ? (
					<div
						className="py-8 text-center text-sm"
						style={{ color: theme.colors.textDim }}
						data-testid="scheduled-tasks-no-matches"
						role="status"
					>
						No scheduled tasks match &ldquo;{filterQuery.trim()}&rdquo;
					</div>
				) : (
					<table className="w-full text-sm">
						<thead>
							<tr
								className="text-left text-xs border-b"
								style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
							>
								{(
									[
										['task', 'Task', 'left'],
										['agent', 'Agent', 'left'],
										['repeats', 'Repeats', 'left'],
										['schedule', 'Schedule', 'left'],
										['next', 'Next', 'right'],
									] as [TaskSortKey, string, 'left' | 'right'][]
								).map(([key, label, align]) => (
									<SortableTh
										key={key}
										columnKey={key}
										label={label}
										sortKey={sortKey}
										direction={direction}
										onSort={toggleSort}
										theme={theme}
										align={align}
										title={SORT_TITLES[key]}
										className={`${headerClass}${align === 'right' ? ' text-right' : ''}`}
										testId={`scheduled-tasks-sort-${key}`}
									/>
								))}
								<th className={`${headerClass} text-right`} />
							</tr>
						</thead>
						<tbody>
							{visibleTasks.map((task) => {
								const Icon = KIND_ICON[task.kind];
								return (
									<tr
										key={`${task.agentId}:${task.name}`}
										className="border-b last:border-b-0"
										style={{ borderColor: theme.colors.border, opacity: task.enabled ? 1 : 0.55 }}
									>
										<td className="py-2 pr-3" style={{ color: theme.colors.textMain }}>
											<div className="flex flex-col">
												<span>{taskTitle(task)}</span>
												{/* The pipeline matters here: this list mixes standalone reminders
												    with the schedule triggers that drive a whole pipeline, and
												    cancelling one of those breaks the pipeline. */}
												<span className="text-xs font-mono" style={{ color: theme.colors.textDim }}>
													{task.name}
													{` · ${task.pipelineName}`}
													{task.action !== 'prompt' ? ` · ${task.action}` : ''}
													{task.enabled ? '' : ' · paused'}
												</span>
											</div>
										</td>
										<td className="py-2 pr-3" style={{ color: theme.colors.textDim }}>
											{task.agentName}
										</td>
										<td className="py-2 pr-3" style={{ color: theme.colors.textDim }}>
											<span className="inline-flex items-center gap-1.5">
												<Icon className="w-3.5 h-3.5" />
												{KIND_LABEL[task.kind]}
											</span>
										</td>
										<td
											className="py-2 pr-3 font-mono text-xs"
											style={{ color: theme.colors.textDim }}
										>
											{describeSchedule(task)}
										</td>
										<td className="py-2 pr-3 text-right" style={{ color: theme.colors.textDim }}>
											{formatCountdown(task, nowMs)}
										</td>
										<td className="py-2">
											<div className="flex items-center justify-end gap-1">
												<button
													onClick={() => void setTaskEnabled(task, !task.enabled)}
													title={task.enabled ? 'Pause this task' : 'Resume this task'}
													aria-label={task.enabled ? 'Pause this task' : 'Resume this task'}
													className="p-1 rounded hover:bg-white/10"
													style={{ color: theme.colors.textDim }}
												>
													{task.enabled ? (
														<Pause className="w-3.5 h-3.5" />
													) : (
														<Play className="w-3.5 h-3.5" />
													)}
												</button>
												<button
													onClick={() => setEditing({ mode: 'edit', task })}
													title="Edit this task"
													aria-label="Edit this task"
													className="p-1 rounded hover:bg-white/10"
													style={{ color: theme.colors.textDim }}
												>
													<Pencil className="w-3.5 h-3.5" />
												</button>
												<button
													onClick={() => confirmCancel(task)}
													title="Cancel this task"
													aria-label="Cancel this task"
													className="p-1 rounded hover:bg-white/10"
													style={{ color: theme.colors.error }}
												>
													<Trash2 className="w-3.5 h-3.5" />
												</button>
											</div>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				)}
			</div>
		</div>
	);
}
