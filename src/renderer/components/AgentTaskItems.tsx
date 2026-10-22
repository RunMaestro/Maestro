import type { Theme } from '../types';
import type { AgentTask } from '../utils/agentTaskList';

/**
 * The task rows of an agent checklist: status glyph, label, completed styling.
 *
 * Shared by the two surfaces that render a checklist - the inline
 * `AgentTaskListCard` in the transcript and the docked `AgentTaskListBar` above
 * the composer - so "what a completed task looks like" is decided once. The
 * surfaces differ in chrome and placement, not in how a task reads.
 */

/** Status glyph + color for a single task row. */
export function taskGlyph(task: AgentTask, theme: Theme): { glyph: string; color: string } {
	if (task.status === 'completed') return { glyph: '✓', color: theme.colors.success };
	if (task.status === 'in_progress') return { glyph: '▸', color: theme.colors.warning };
	return { glyph: '○', color: theme.colors.textDim };
}

interface AgentTaskItemsProps {
	theme: Theme;
	tasks: AgentTask[];
	className?: string;
}

export function AgentTaskItems({ theme, tasks, className }: AgentTaskItemsProps) {
	return (
		<ul className={className ?? 'space-y-0.5'}>
			{tasks.map((task, index) => {
				const { glyph, color } = taskGlyph(task, theme);
				return (
					<li
						key={`${index}-${task.content}`}
						className="flex items-start gap-2 break-words"
						style={{
							color: theme.colors.textMain,
							opacity: task.status === 'completed' ? 0.45 : 0.8,
						}}
					>
						<span className="shrink-0" style={{ color }} aria-hidden="true">
							{glyph}
						</span>
						<span
							style={{
								textDecoration: task.status === 'completed' ? 'line-through' : undefined,
							}}
						>
							{task.status === 'in_progress' && task.activeForm ? task.activeForm : task.content}
						</span>
					</li>
				);
			})}
		</ul>
	);
}
