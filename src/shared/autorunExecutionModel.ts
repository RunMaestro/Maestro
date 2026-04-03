import type { HistoryUsageBreakdown, PlaybookAgentStrategy, ToolType, UsageStats } from './types';

export type AutoRunStage = 'single' | 'planner' | 'executor' | 'verifier';

export function calculateUsageContextTokens(stats: UsageStats, toolType: ToolType): number {
	if (toolType === 'codex' || toolType === 'zai') {
		return (
			(stats.inputTokens || 0) + (stats.outputTokens || 0) + (stats.cacheCreationInputTokens || 0)
		);
	}

	return (
		(stats.inputTokens || 0) +
		(stats.cacheReadInputTokens || 0) +
		(stats.cacheCreationInputTokens || 0)
	);
}

export function pickContextDisplayUsageStats(
	toolType: ToolType,
	usageBreakdown: HistoryUsageBreakdown | undefined,
	fallback: UsageStats | undefined
): UsageStats | undefined {
	const candidates = [
		usageBreakdown?.planner,
		usageBreakdown?.executor,
		usageBreakdown?.verifier,
		usageBreakdown?.synopsis,
	].filter((stats): stats is UsageStats => Boolean(stats));

	if (candidates.length === 0) {
		return fallback;
	}

	return candidates.reduce((peak, current) =>
		calculateUsageContextTokens(current, toolType) > calculateUsageContextTokens(peak, toolType)
			? current
			: peak
	);
}

export function mergeUsageStats(
	current: UsageStats | undefined,
	next: UsageStats | undefined
): UsageStats | undefined {
	if (!next) return current;
	if (!current) return next;

	const merged: UsageStats = {
		...next,
		inputTokens: current.inputTokens + next.inputTokens,
		outputTokens: current.outputTokens + next.outputTokens,
		cacheReadInputTokens: current.cacheReadInputTokens + next.cacheReadInputTokens,
		cacheCreationInputTokens: current.cacheCreationInputTokens + next.cacheCreationInputTokens,
		totalCostUsd: current.totalCostUsd + next.totalCostUsd,
		contextWindow: Math.max(current.contextWindow, next.contextWindow),
		reasoningTokens:
			current.reasoningTokens || next.reasoningTokens
				? (current.reasoningTokens || 0) + (next.reasoningTokens || 0)
				: undefined,
	};

	if (!merged.reasoningTokens) {
		delete merged.reasoningTokens;
	}

	return merged;
}

export function buildDefinitionOfDoneSection(definitionOfDone: string[] = []): string {
	if (definitionOfDone.length === 0) {
		return '';
	}

	return `## Definition of Done\n${definitionOfDone.map((item) => `- ${item}`).join('\n')}`;
}

export function buildVerificationStepsSection(verificationSteps: string[] = []): string {
	if (verificationSteps.length === 0) {
		return '';
	}

	return `## Verification Steps\n${verificationSteps.map((item) => `- ${item}`).join('\n')}`;
}

export function getVerifierVerdict(response?: string): 'PASS' | 'WARN' | 'FAIL' | null {
	const firstNonEmptyLine = response
		?.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean)
		?.toUpperCase();

	if (
		firstNonEmptyLine === 'PASS' ||
		firstNonEmptyLine === 'WARN' ||
		firstNonEmptyLine === 'FAIL'
	) {
		return firstNonEmptyLine;
	}

	return null;
}

export function applyVerifierVerdictToSummary(
	summary: string,
	verdict: 'PASS' | 'WARN' | 'FAIL' | null
): string {
	if (!summary || !verdict || verdict === 'PASS') {
		return summary;
	}

	return `[${verdict}] ${summary}`;
}

export function shouldIncludeSharedSkillGuidance(
	stage: AutoRunStage,
	agentStrategy: PlaybookAgentStrategy
): boolean {
	return agentStrategy === 'single' || stage === 'planner';
}
