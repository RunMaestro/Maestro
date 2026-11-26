/**
 * What Maestro's own `/history` and `/skills` commands write to a tab, in one place.
 *
 * The desktop runs them in its renderer (`useWizardHandlers`); a headless host runs them in its
 * runtime (`createRuntimeTurns`). Both write these words and build these prompts from the same
 * functions, so a hosted agent's tab reads exactly as a local agent's does.
 *
 * Renderer-safe: no Node imports.
 */

import { formatRelativeTime } from './formatters';

/** The transcript lines `/history` writes, in the order a run can write them. */
export const HISTORY_COMMAND_TEXT = {
	noSession: 'No active agent session. Start a conversation first before using /history.',
	pending: 'Generating history synopsis...',
	nothingToReport: 'Nothing to report - no history entry created.',
	failed: 'Failed to generate history synopsis. Try again.',
	saved: (summary: string) => `Synopsis saved to history: ${summary}`,
	error: (message: string) => `Error generating synopsis: ${message}`,
} as const;

const HISTORY_SAVED_PREFIX = HISTORY_COMMAND_TEXT.saved('');

/**
 * How a `/history` run that wrote `text` as its last line ended: `saved` with the entry's summary,
 * `ended` for every other last line (nothing to report, failed, error), or null while it is still
 * pending or the line is not one of its own. A window that typed `/history` for a hosted agent reads
 * the host's lines with it, to raise the toast a local `/history` raises.
 */
export function readHistoryCommandOutcome(
	text: string
): { kind: 'saved'; summary: string } | { kind: 'ended' } | null {
	if (text.startsWith(HISTORY_SAVED_PREFIX)) {
		return { kind: 'saved', summary: text.slice(HISTORY_SAVED_PREFIX.length) };
	}
	if (
		text === HISTORY_COMMAND_TEXT.nothingToReport ||
		text === HISTORY_COMMAND_TEXT.failed ||
		text === HISTORY_COMMAND_TEXT.noSession ||
		text.startsWith(HISTORY_COMMAND_TEXT.error(''))
	) {
		return { kind: 'ended' };
	}
	return null;
}

/**
 * The prompt a `/history` synopsis turn is sent: the Auto Run synopsis prompt, told to cover only
 * the work since the tab's last synopsis when it had one.
 */
export function historySynopsisPrompt(basePrompt: string, lastSynopsisTime?: number): string {
	if (!lastSynopsisTime) return basePrompt;
	const timeAgo = formatRelativeTime(lastSynopsisTime);
	return `${basePrompt}\n\nIMPORTANT: Only synopsize work done since the last synopsis (${timeAgo}). Do not repeat previous work.`;
}

/** How long the work a `/history` entry covers took: since the last synopsis, else since the tab opened. */
export function historySynopsisElapsedMs(
	tab: { lastSynopsisTime?: number; createdAt?: number },
	synopsisTime: number
): number {
	return synopsisTime - (tab.lastSynopsisTime || tab.createdAt || synopsisTime);
}

/** One Claude Code skill, as `/skills` lists it. */
export interface ClaudeSkillSummary {
	name: string;
	description: string;
	/** About four characters per token. */
	tokenCount: number;
	source: 'project' | 'user';
}

/** The text of `/skills`'s answer: a table of the project's skills, then the user's. */
export function formatClaudeSkillsMessage(skills: readonly ClaudeSkillSummary[]): string {
	if (skills.length === 0) {
		return '## Skills\n\nNo Claude Code skills were found in this project.\n\nTo add skills, create `.claude/skills/<skill-name>/SKILL.md` files in your project.';
	}
	const formatTokenCount = (tokens: number): string =>
		tokens >= 1000 ? `~${(tokens / 1000).toFixed(1)}k` : `~${tokens}`;
	const table = (title: string, list: readonly ClaudeSkillSummary[]): string[] => [
		`### ${title}`,
		'',
		'| Skill | Tokens | Description |',
		'|-------|--------|-------------|',
		...list.map((skill) => {
			const desc =
				skill.description && skill.description !== 'No description' ? skill.description : '-';
			return `| **${skill.name}** | ${formatTokenCount(skill.tokenCount)} | ${desc} |`;
		}),
	];
	const projectSkills = skills.filter((skill) => skill.source === 'project');
	const userSkills = skills.filter((skill) => skill.source === 'user');
	const lines: string[] = [
		'## Skills',
		'',
		`${skills.length} skill${skills.length !== 1 ? 's' : ''} available`,
		'',
	];
	if (projectSkills.length > 0) lines.push(...table('Project Skills', projectSkills), '');
	if (userSkills.length > 0) lines.push(...table('User Skills', userSkills));
	return lines.join('\n');
}

/** The transcript line `/skills` writes when listing fails. */
export function skillsCommandErrorText(message: string): string {
	return `Error listing skills: ${message}`;
}
