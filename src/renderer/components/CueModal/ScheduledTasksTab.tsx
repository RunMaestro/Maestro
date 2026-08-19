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

import { useMemo, useState } from 'react';
import { AlarmClock, CalendarClock, Pause, Pencil, Play, Plus, Repeat, Trash2 } from 'lucide-react';
import type { Theme } from '../../types';
import { EmptyStatePlaceholder } from '../ui/EmptyStatePlaceholder';
import { getModalActions } from '../../stores/modalStore';
import { useScheduledTasks } from '../../hooks/cue/useScheduledTasks';
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

/** "in 4m" / "overdue" / "-" for a task whose next fire cannot be projected. */
function formatCountdown(task: ScheduledTask, nowMs: number): string {
	if (task.nextFireAtMs === null) return task.kind === 'interval' ? 'on interval' : '-';
	const delta = task.nextFireAtMs - nowMs;
	if (delta < 0) return 'overdue';
	return `in ${formatDurationCompact(delta)}`;
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

	// One clock read per render pass keeps every countdown in a batch consistent.
	const nowMs = Date.now();

	const grouped = useMemo(() => {
		const byAgent = new Map<string, ScheduledTask[]>();
		for (const task of tasks) {
			const list = byAgent.get(task.agentName);
			if (list) list.push(task);
			else byAgent.set(task.agentName, [task]);
		}
		return [...byAgent.entries()];
	}, [tasks]);

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

	return (
		<div className="flex-1 min-h-0 flex flex-col">
			<div
				className="flex items-center justify-between px-5 py-3 border-b"
				style={{ borderColor: theme.colors.border }}
			>
				<div className="flex flex-col">
					<span
						className="text-xs font-semibold uppercase tracking-wide"
						style={{ color: theme.colors.textDim }}
					>
						Scheduled Tasks
					</span>
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						{tasks.length === 0
							? 'Nothing scheduled'
							: `${tasks.length} task${tasks.length === 1 ? '' : 's'} across ${grouped.length} agent${grouped.length === 1 ? '' : 's'}`}
					</span>
				</div>
				<button
					onClick={() => setEditing({ mode: 'create' })}
					disabled={agents.length === 0}
					className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium disabled:opacity-50"
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
				) : (
					<table className="w-full text-sm">
						<thead>
							<tr
								className="text-left text-xs border-b"
								style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
							>
								<th className="pb-2 font-medium">Task</th>
								<th className="pb-2 font-medium">Agent</th>
								<th className="pb-2 font-medium">Repeats</th>
								<th className="pb-2 font-medium">Schedule</th>
								<th className="pb-2 font-medium text-right">Next</th>
								<th className="pb-2 font-medium text-right"></th>
							</tr>
						</thead>
						<tbody>
							{tasks.map((task) => {
								const Icon = KIND_ICON[task.kind];
								return (
									<tr
										key={`${task.agentId}:${task.name}`}
										className="border-b last:border-b-0"
										style={{ borderColor: theme.colors.border, opacity: task.enabled ? 1 : 0.55 }}
									>
										<td className="py-2 pr-3" style={{ color: theme.colors.textMain }}>
											<div className="flex flex-col">
												<span>{task.label || task.name}</span>
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
