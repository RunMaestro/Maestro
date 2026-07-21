import type { AutoRunSession } from '../../../shared/stats-types';
import { formatTimestamp } from '../../../shared/formatters';
import { isGoalRunDocument } from '../../../shared/goalDriven/goalRunLabel';

export const MAX_LONGEST_AUTORUN_ROWS = 25;
const EMPTY_TABLE_CELL = String.fromCharCode(8212);

export function formatAgentName(agentType: string): string {
	const names: Record<string, string> = {
		'claude-code': 'Claude Code',
		opencode: 'OpenCode',
		'openai-codex': 'OpenAI Codex',
		codex: 'Codex',
		'gemini-cli': 'Gemini CLI',
		'qwen3-coder': 'Qwen3 Coder',
		'factory-droid': 'Factory Droid',
		copilot: 'GitHub Copilot',
		grok: 'Grok CLI',
		terminal: 'Terminal',
	};
	return names[agentType] || agentType;
}

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

export function getTopAutoRunSessions(
	sessions: AutoRunSession[],
	maxRows = MAX_LONGEST_AUTORUN_ROWS
): AutoRunSession[] {
	return [...sessions].sort((a, b) => b.duration - a.duration).slice(0, maxRows);
}

export function formatAutoRunTasksLabel(session: AutoRunSession): string {
	if (isGoalRunDocument(session.documentPath)) {
		return `${session.tasksCompleted ?? 0}%`;
	}
	if (session.tasksTotal != null) {
		return `${session.tasksCompleted ?? 0} / ${session.tasksTotal}`;
	}
	return EMPTY_TABLE_CELL;
}
