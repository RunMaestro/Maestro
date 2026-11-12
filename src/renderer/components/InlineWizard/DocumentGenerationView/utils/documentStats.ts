import type { GeneratedDocument } from '../../../Wizard/WizardContext';

export function countTasks(content: string): number {
	const matches = content.match(/^- \[([ x])\]/gm);
	return matches ? matches.length : 0;
}

export function countTotalTasks(documents: GeneratedDocument[]): number {
	return documents.reduce((sum, doc) => sum + countTasks(doc.content), 0);
}

export function extractDocumentDescription(content: string): string | null {
	const lines = content.split('\n');
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
		return trimmed.length > 150 ? trimmed.slice(0, 147) + '...' : trimmed;
	}
	return null;
}
