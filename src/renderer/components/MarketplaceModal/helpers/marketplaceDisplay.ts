import type { MarketplacePlaybook } from '../../../../shared/marketplace-types';
import { isCompatible } from '../../../../shared/marketplace-compatibility';
import type { PlaybookInteraction, PlaybookScope } from '../../../../shared/types';

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

/** Badge text and tooltip for how a playbook collects its parameters. */
export interface PlaybookTraitBadge {
	label: string;
	title: string;
}

/**
 * The interaction badge for a playbook. Absent `interaction` means `form`, so
 * every playbook gets one.
 */
export function getInteractionBadge(
	interaction: PlaybookInteraction | undefined
): PlaybookTraitBadge {
	return interaction === 'guided'
		? {
				label: 'Guided',
				title: 'An agent interviews you to fill in the configuration before the run.',
			}
		: { label: 'Form', title: 'You fill in the configuration in a form before the run.' };
}

/** The scope badge for a playbook, or null when the manifest does not declare one. */
export function getScopeBadge(scope: PlaybookScope | undefined): PlaybookTraitBadge | null {
	if (scope === 'machine') {
		return {
			label: 'Machine',
			title: 'This playbook configures your machine, not just this project.',
		};
	}
	if (scope === 'repo') {
		return { label: 'Repo', title: 'This playbook works inside one project.' };
	}
	return null;
}

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

export { generateDefaultFolderName } from '../../../../shared/marketplaceFolderName';

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
