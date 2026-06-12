import type { MarketplacePlaybook } from '../../../../shared/marketplace-types';
import { useEventListener } from '../../../hooks/utils/useEventListener';
import { getCycledDocumentFilename } from '../helpers';

export interface UseMarketplaceCategoryDocumentCycleParams {
	isOpen: boolean;
	categories: string[];
	selectedCategory: string;
	showDetailView: boolean;
	selectedPlaybook: MarketplacePlaybook | null;
	selectedDocFilename: string | null;
	onCategoryChange: (category: string) => void;
	onSelectDocument: (filename: string) => void;
}

export function useMarketplaceCategoryDocumentCycle({
	isOpen,
	categories,
	selectedCategory,
	showDetailView,
	selectedPlaybook,
	selectedDocFilename,
	onCategoryChange,
	onSelectDocument,
}: UseMarketplaceCategoryDocumentCycleParams): void {
	useEventListener(
		'keydown',
		(event) => {
			const e = event as KeyboardEvent;
			if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || (e.key !== '[' && e.key !== ']')) {
				return;
			}

			e.preventDefault();

			if (showDetailView && selectedPlaybook) {
				const newDoc = getCycledDocumentFilename(
					selectedPlaybook,
					selectedDocFilename,
					e.key === '[' ? 'previous' : 'next'
				);
				onSelectDocument(newDoc);
				return;
			}

			const currentIndex = categories.indexOf(selectedCategory);
			if (e.key === '[') {
				const newIndex = Math.max(0, currentIndex - 1);
				onCategoryChange(categories[newIndex]);
			} else {
				const newIndex = Math.min(categories.length - 1, currentIndex + 1);
				onCategoryChange(categories[newIndex]);
			}
		},
		{ enabled: isOpen }
	);
}
