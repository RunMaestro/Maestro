import React, { useMemo, useState } from 'react';
import { ListChecks, X } from 'lucide-react';
import type { LogEntry, Theme } from '../types';
import { findLatestAgentTaskList, summarizeAgentTaskList } from '../utils/agentTaskList';
import { AgentTaskItems } from './AgentTaskItems';
import { usePersistedToggle } from '../hooks/ui/usePersistedToggle';
import { useSettingsStore } from '../stores/settingsStore';

/**
 * The agent's current checklist, docked directly above the composer.
 *
 * `AgentTaskListCard` already renders every checklist update inline, but those
 * cards scroll away as the conversation grows, so "what is the agent working on
 * and how much is left" stops being answerable without scrolling back. This bar
 * pins the NEWEST checklist in the active tab in place instead: collapsed to a
 * one-line summary by default, expandable to the full list, and rewritten in
 * place as the agent updates its plan.
 *
 * Nothing new is captured for it - the list is derived from the tab's own logs,
 * so it survives tab switches and app restarts for free and there is no second
 * copy of the state to fall out of sync with the transcript.
 *
 * Two Display settings drive it, both off by default: `showAgentTaskListBar`
 * renders it at all, and `autoExpandAgentTaskListBar` opens each NEW checklist
 * to its full list rather than the one-line summary.
 */

interface AgentTaskListBarProps {
	theme: Theme;
	/** Conversation log of the active AI tab. */
	logs: LogEntry[] | undefined;
}

export const AgentTaskListBar = React.memo(function AgentTaskListBar({
	theme,
	logs,
}: AgentTaskListBarProps) {
	const enabled = useSettingsStore((s) => s.showAgentTaskListBar);
	const autoExpand = useSettingsStore((s) => s.autoExpandAgentTaskListBar);
	const { value: stickyExpanded, toggle: toggleStickyExpanded } = usePersistedToggle(
		'agentTaskList.bar.expanded',
		false
	);
	// Keyed by the source log entry, so dismissing hides THIS list and the next
	// checklist the agent writes brings the bar back on its own.
	const [dismissedEntryId, setDismissedEntryId] = useState<string | null>(null);
	// Under auto-expand the sticky preference is not the answer: the bar opens
	// for every new checklist, and a click only overrides THAT list. Keying the
	// override off the entry id is what re-expands on the next update without an
	// effect to re-sync a second copy of the state.
	const [expandOverride, setExpandOverride] = useState<{
		entryId: string;
		value: boolean;
	} | null>(null);

	// PERF: the composer re-renders on every keystroke but `logs` only changes
	// when the agent writes, so memoizing on it keeps the reverse scan off the
	// typing path entirely.
	const latest = useMemo(() => (enabled ? findLatestAgentTaskList(logs) : null), [enabled, logs]);
	if (!latest || latest.entryId === dismissedEntryId) return null;

	const isExpanded = autoExpand
		? expandOverride?.entryId === latest.entryId
			? expandOverride.value
			: true
		: stickyExpanded;
	const toggleExpanded = () => {
		if (autoExpand) setExpandOverride({ entryId: latest.entryId, value: !isExpanded });
		else toggleStickyExpanded();
	};

	const { tasks, completed } = latest.list;
	const percent = tasks.length > 0 ? Math.round((completed / tasks.length) * 100) : 0;
	const isComplete = completed === tasks.length;

	return (
		<div
			className="w-full mb-2 px-3 py-2 rounded-lg border text-sm"
			style={{
				backgroundColor: theme.colors.bgActivity,
				borderColor: theme.colors.border,
				color: theme.colors.textMain,
			}}
			data-testid="agent-task-list-bar"
		>
			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={toggleExpanded}
					className="flex min-w-0 flex-1 items-center gap-2 text-left transition-all hover:opacity-90"
					aria-expanded={isExpanded}
					aria-label={isExpanded ? 'Collapse agent task list' : 'Expand agent task list'}
				>
					<ListChecks
						className="w-4 h-4 flex-shrink-0"
						style={{ color: isComplete ? theme.colors.success : theme.colors.warning }}
					/>
					<span className="truncate opacity-80">{summarizeAgentTaskList(latest.list)}</span>
					<span
						className="ml-auto flex-shrink-0 h-1 w-16 rounded overflow-hidden"
						style={{ backgroundColor: `${theme.colors.textDim}40` }}
					>
						<span
							className="block h-full rounded"
							style={{ width: `${percent}%`, backgroundColor: theme.colors.success }}
						/>
					</span>
					<span className="flex-shrink-0 text-xs opacity-50">{isExpanded ? '▾' : '▸'}</span>
				</button>
				<button
					type="button"
					onClick={() => setDismissedEntryId(latest.entryId)}
					className="flex-shrink-0 rounded p-0.5 opacity-50 transition-opacity hover:opacity-100"
					aria-label="Hide this task list"
					title="Hide this task list until the agent updates it"
				>
					<X className="w-3.5 h-3.5" />
				</button>
			</div>
			{isExpanded && (
				<AgentTaskItems
					theme={theme}
					tasks={tasks}
					className="mt-2 max-h-40 space-y-0.5 overflow-y-auto"
				/>
			)}
		</div>
	);
});

AgentTaskListBar.displayName = 'AgentTaskListBar';
