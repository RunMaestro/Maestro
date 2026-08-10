import { useState } from 'react';
import type { Theme } from '../types';
import type { AgentTask, AgentTaskList } from '../utils/agentTaskList';
import { summarizeAgentTaskList } from '../utils/agentTaskList';

/**
 * Inline task list card for the chat history.
 *
 * Agents that keep a working checklist (Claude Code / OpenCode `TodoWrite`,
 * Codex `update_plan`) emit it as a tool call on every update. Rendering the
 * full list for each of those updates would flood the transcript, so the card
 * stays collapsed by default: a progress bar plus the same one-line summary the
 * tool log has always shown. Clicking it expands the individual task items with
 * their states - the GUI equivalent of Claude Code's Ctrl+T overlay, kept inline
 * with the agent rather than in a separate panel.
 */

interface AgentTaskListCardProps {
	theme: Theme;
	taskList: AgentTaskList;
}

/** Status glyph + color for a single task row. */
function taskGlyph(task: AgentTask, theme: Theme): { glyph: string; color: string } {
	if (task.status === 'completed') return { glyph: '✓', color: theme.colors.success };
	if (task.status === 'in_progress') return { glyph: '▸', color: theme.colors.warning };
	return { glyph: '○', color: theme.colors.textDim };
}

export function AgentTaskListCard({ theme, taskList }: AgentTaskListCardProps) {
	const [isExpanded, setIsExpanded] = useState(false);
	const { tasks, completed } = taskList;
	const percent = tasks.length > 0 ? Math.round((completed / tasks.length) * 100) : 0;

	return (
		<div className="mt-1 ml-1 pl-2 border-l" style={{ borderColor: `${theme.colors.accent}40` }}>
			<button
				type="button"
				onClick={() => setIsExpanded((prev) => !prev)}
				className="flex items-center gap-2 w-full text-left"
				aria-expanded={isExpanded}
				aria-label={isExpanded ? 'Collapse task list' : 'Expand task list'}
				style={{ color: theme.colors.textMain }}
			>
				<span className="opacity-50 shrink-0">{isExpanded ? '▾' : '▸'}</span>
				<span className="opacity-70 break-words">{summarizeAgentTaskList(taskList)}</span>
				<span
					className="ml-auto shrink-0 h-1 w-16 rounded overflow-hidden"
					style={{ backgroundColor: `${theme.colors.textDim}40` }}
				>
					<span
						className="block h-full rounded"
						style={{ width: `${percent}%`, backgroundColor: theme.colors.success }}
					/>
				</span>
			</button>
			{isExpanded && (
				<ul className="mt-1 space-y-0.5">
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
									{task.status === 'in_progress' && task.activeForm
										? task.activeForm
										: task.content}
								</span>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
