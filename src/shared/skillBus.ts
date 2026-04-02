import type { HistoryEntry } from './types';

export type SkillBusRunResult = 'success' | 'partial' | 'fail';

export interface SkillBusRecordRunPayload {
	skillName: string;
	result: SkillBusRunResult;
	score: number;
	task: string;
}

export interface SkillBusRecordRunResponse {
	success: boolean;
	error?: string;
}

export interface SkillBusStatusResponse {
	available: boolean;
	scriptPath: string;
	error?: string;
}

export const AUTORUN_SKILL_BUS_SKILL_NAME = 'maestro-autorun';

function isAutoRunSummaryEntry(summary: string): boolean {
	return /^Loop \d+/.test(summary) || summary.startsWith('Auto Run completed:');
}

function getScoreForResult(result: SkillBusRunResult): number {
	if (result === 'success') return 1;
	if (result === 'partial') return 0.7;
	return 0.2;
}

export function buildAutoRunSkillBusPayload(
	entry: Pick<HistoryEntry, 'type' | 'summary' | 'success' | 'verifierVerdict' | 'sessionName'>,
	source: 'desktop' | 'cli'
): SkillBusRecordRunPayload | null {
	if (entry.type !== 'AUTO' || !entry.summary || isAutoRunSummaryEntry(entry.summary)) {
		return null;
	}

	const result: SkillBusRunResult =
		entry.success === false || entry.verifierVerdict === 'FAIL'
			? 'fail'
			: entry.verifierVerdict === 'WARN'
				? 'partial'
				: 'success';
	const sessionPrefix = entry.sessionName ? `[${entry.sessionName}] ` : '';
	const verdictSuffix = entry.verifierVerdict ? ` (${entry.verifierVerdict})` : '';

	return {
		skillName: AUTORUN_SKILL_BUS_SKILL_NAME,
		result,
		score: getScoreForResult(result),
		task: `${source === 'desktop' ? 'Desktop' : 'CLI'} Auto Run: ${sessionPrefix}${entry.summary}${verdictSuffix}`,
	};
}
