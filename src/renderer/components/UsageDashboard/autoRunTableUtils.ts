import type { AutoRunSession } from '../../../shared/stats-types';
import { formatTimestamp } from '../../../shared/formatters';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import { isGoalRunDocument, goalRunLabel } from '../../../shared/goalDriven/goalRunLabel';

/** Rows the Longest Auto Runs table shows before "Show more". */
export const LONGEST_AUTORUN_PAGE_SIZE = 25;
export const EMPTY_TABLE_CELL = '-';

export type AutoRunSortKey = 'duration' | 'start' | 'provider' | 'document' | 'tasks' | 'project';

export function extractFileName(path?: string): string {
	if (!path) return EMPTY_TABLE_CELL;
	const segments = path.replace(/\\/g, '/').split('/');
	return segments[segments.length - 1] || EMPTY_TABLE_CELL;
}

export function extractProjectName(path?: string): string {
	if (!path) return EMPTY_TABLE_CELL;
	const segments = path.replace(/\\/g, '/').split('/').filter(Boolean);
	return segments[segments.length - 1] || EMPTY_TABLE_CELL;
}

export function formatAutoRunDate(timestamp: number): string {
	return new Date(timestamp).toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
	});
}

export const formatAutoRunTime = (timestamp: number) => formatTimestamp(timestamp, 'time');

/** Provider display name for a run's agent type. */
export const formatAutoRunProvider = (agentType: string) => getAgentDisplayName(agentType);

/** The document column's text: the goal for a goal run, else the file name. */
export function autoRunDocumentLabel(session: AutoRunSession): string {
	return isGoalRunDocument(session.documentPath)
		? goalRunLabel(session.documentPath)
		: extractFileName(session.documentPath);
}

/** Ticked share of a run's checkboxes (a goal run's progress), for sorting. */
function taskSortValue(session: AutoRunSession): number {
	if (isGoalRunDocument(session.documentPath)) return (session.tasksCompleted ?? 0) / 100;
	if (!session.tasksTotal) return -1;
	return (session.tasksCompleted ?? 0) / session.tasksTotal;
}

/** Runs ordered by the chosen column; ties fall back to longest first. */
export function sortAutoRunSessions(
	sessions: AutoRunSession[],
	key: AutoRunSortKey,
	descending: boolean
): AutoRunSession[] {
	const compare = (a: AutoRunSession, b: AutoRunSession): number => {
		switch (key) {
			case 'duration':
				return a.duration - b.duration;
			case 'start':
				return a.startTime - b.startTime;
			case 'provider':
				return formatAutoRunProvider(a.agentType).localeCompare(formatAutoRunProvider(b.agentType));
			case 'document':
				return autoRunDocumentLabel(a).localeCompare(autoRunDocumentLabel(b));
			case 'tasks':
				return taskSortValue(a) - taskSortValue(b);
			case 'project':
				return extractProjectName(a.projectPath).localeCompare(extractProjectName(b.projectPath));
		}
	};
	return [...sessions].sort((a, b) => {
		const diff = compare(a, b);
		if (diff !== 0) return descending ? -diff : diff;
		return b.duration - a.duration;
	});
}

export function formatAutoRunTasksLabel(session: AutoRunSession): string {
	if (isGoalRunDocument(session.documentPath)) {
		return `${session.tasksCompleted ?? 0}%`;
	}
	if (session.duration <= 0) {
		return session.tasksTotal != null ? `- / ${session.tasksTotal}` : EMPTY_TABLE_CELL;
	}
	if (session.tasksTotal != null) {
		return `${session.tasksCompleted ?? 0} / ${session.tasksTotal}`;
	}
	return EMPTY_TABLE_CELL;
}
