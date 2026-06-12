import type { MarketplacePlaybook } from '../../../../shared/marketplace-types';
import { isCompatible } from '../../../../shared/marketplace-compatibility';

export const LOADING_TILE_IDS = [
	'tile-1',
	'tile-2',
	'tile-3',
	'tile-4',
	'tile-5',
	'tile-6',
] as const;

// Badge colors are fixed independent of theme so they remain recognizable.
export const BETA_BADGE_BG = '#F59E0B';
export const INCOMPAT_BADGE_BG = '#EF4444';
export const LOCAL_BADGE_BG = '#3b82f620';
export const LOCAL_BADGE_FG = '#3b82f6';
export const BADGE_FG = '#ffffff';

export interface PartitionedPlaybooks {
	compatiblePlaybooks: MarketplacePlaybook[];
	incompatiblePlaybooks: MarketplacePlaybook[];
	orderedPlaybooks: MarketplacePlaybook[];
}

export function partitionPlaybooksByCompatibility(
	playbooks: MarketplacePlaybook[],
	runningVersion: string
): PartitionedPlaybooks {
	const compatiblePlaybooks: MarketplacePlaybook[] = [];
	const incompatiblePlaybooks: MarketplacePlaybook[] = [];

	for (const playbook of playbooks) {
		if (isCompatible(playbook, runningVersion)) {
			compatiblePlaybooks.push(playbook);
		} else {
			incompatiblePlaybooks.push(playbook);
		}
	}

	return {
		compatiblePlaybooks,
		incompatiblePlaybooks,
		orderedPlaybooks: [...compatiblePlaybooks, ...incompatiblePlaybooks],
	};
}

export function getCategoryCount(category: string, playbooks: MarketplacePlaybook[]): number {
	if (category === 'All') return playbooks.length;
	return playbooks.filter((playbook) => playbook.category === category).length;
}

export function generateDefaultFolderName(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

export function buildDocumentList(playbook: MarketplacePlaybook): Array<string | null> {
	return [null, ...playbook.documents.map((doc) => doc.filename)];
}

export function getCycledDocumentFilename(
	playbook: MarketplacePlaybook,
	selectedDocFilename: string | null,
	direction: 'previous' | 'next'
): string {
	const docList = buildDocumentList(playbook);
	const currentIndex =
		selectedDocFilename === null || selectedDocFilename === ''
			? 0
			: docList.indexOf(selectedDocFilename);

	const newIndex =
		direction === 'previous'
			? currentIndex <= 0
				? docList.length - 1
				: currentIndex - 1
			: currentIndex >= docList.length - 1
				? 0
				: currentIndex + 1;

	return docList[newIndex] ?? '';
}
