import type { GeneratedDocument, WizardMessage } from '../../../WizardContext';

export function countTasks(content: string): number {
	const matches = content.match(/^- \[([ x])\]/gm);
	return matches ? matches.length : 0;
}

export function buildPhaseReviewStatsText(
	documents: GeneratedDocument[],
	currentContent: string
): string {
	const taskCount = countTasks(currentContent);
	const totalTasks = documents.reduce((sum, doc) => sum + doc.taskCount, 0);

	if (documents.length > 1) {
		return `${totalTasks} total tasks - ${documents.length} documents - ${taskCount} tasks in this document`;
	}

	return `${taskCount} tasks ready to run`;
}

export function buildWizardCompletionMetrics({
	wizardStartTime,
	conversationHistory,
	generatedDocuments,
}: {
	wizardStartTime?: number;
	conversationHistory: WizardMessage[];
	generatedDocuments: GeneratedDocument[];
}) {
	return {
		durationMs: wizardStartTime ? Date.now() - wizardStartTime : 0,
		conversationExchanges: conversationHistory.filter((msg) => msg.role === 'user').length,
		phasesGenerated: generatedDocuments.length,
		tasksGenerated: generatedDocuments.reduce((total, doc) => total + countTasks(doc.content), 0),
	};
}
