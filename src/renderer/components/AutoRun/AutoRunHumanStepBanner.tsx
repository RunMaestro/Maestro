import { memo } from 'react';
import type { Theme } from '../../types';
import type { HumanOnlyTask } from '../../hooks/batch/batchUtils';
import { AutoRunNoticeBanner } from './AutoRunNoticeBanner';

/** Cap the inline list so a badly-authored document can't flood the panel. */
const MAX_LISTED = 3;

/**
 * Remembered collapse state. The warning is advisory and recurs on every
 * document that has human-only steps, so an author who has already read it
 * should not have to re-collapse it each time the panel re-renders.
 */
const COLLAPSE_KEY = 'autoRun.humanStepBanner.collapsed';

export interface AutoRunHumanStepBannerProps {
	theme: Theme;
	tasks: HumanOnlyTask[];
	/** Jump the editor to a task's line. Omit to render the list read-only. */
	onSelectLine?: (line: number) => void;
}

/**
 * Warns that unchecked tasks in the selected document read as human-only
 * steps. The Auto Run engine will dispatch them to an agent that cannot
 * finish them, so the run stalls (or the agent ticks a box it never did).
 *
 * Non-blocking by design: the detection is heuristic, so this informs the
 * author rather than gating the run.
 */
export const AutoRunHumanStepBanner = memo(function AutoRunHumanStepBanner({
	theme,
	tasks,
	onSelectLine,
}: AutoRunHumanStepBannerProps) {
	if (tasks.length === 0) return null;

	const listed = tasks.slice(0, MAX_LISTED);
	const overflow = tasks.length - listed.length;

	return (
		<AutoRunNoticeBanner
			theme={theme}
			severity="warning"
			collapseKey={COLLAPSE_KEY}
			title={
				tasks.length === 1
					? '1 task looks like a human step'
					: `${tasks.length} tasks look like human steps`
			}
		>
			<div className="mb-1.5">
				Auto Run will hand these to an agent that cannot complete them. Use a{' '}
				<code style={{ color: theme.colors.warning }}>{'<!-- MAESTRO:HITL reason="..." -->'}</code>{' '}
				marker to pause for review, or move the step to plain <code>-</code> bullets at the end of
				the document.
			</div>
			<ul className="space-y-1">
				{listed.map((task) => {
					const label = `Line ${task.line + 1}: ${task.text}`;
					return (
						<li key={task.line} className="flex items-baseline gap-1.5 min-w-0">
							{onSelectLine ? (
								<button
									onClick={() => onSelectLine(task.line)}
									className="text-left truncate hover:underline"
									style={{ color: theme.colors.textMain }}
									title={`${label} (${task.reason})`}
								>
									{label}
								</button>
							) : (
								<span className="truncate" title={`${label} (${task.reason})`}>
									{label}
								</span>
							)}
							<span className="flex-shrink-0 text-[10px]" style={{ color: theme.colors.textDim }}>
								{task.reason}
							</span>
						</li>
					);
				})}
				{overflow > 0 && (
					<li style={{ color: theme.colors.textDim }}>
						and {overflow} more {overflow === 1 ? 'task' : 'tasks'}
					</li>
				)}
			</ul>
		</AutoRunNoticeBanner>
	);
});
