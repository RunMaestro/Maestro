import type { RefObject } from 'react';
import type { MarketplacePlaybook } from '../../../../shared/marketplace-types';
import { useEventListener } from '../../../hooks/utils/useEventListener';

export interface UseMarketplaceListKeyboardNavParams {
	isOpen: boolean;
	showDetailView: boolean;
	orderedPlaybooks: MarketplacePlaybook[];
	selectedTileIndex: number;
	setSelectedTileIndex: (updater: (index: number) => number) => void;
	onSelectPlaybook: (playbook: MarketplacePlaybook) => void;
	searchInputRef: RefObject<HTMLInputElement>;
	gridColumns?: number;
}

export function useMarketplaceListKeyboardNav({
	isOpen,
	showDetailView,
	orderedPlaybooks,
	selectedTileIndex,
	setSelectedTileIndex,
	onSelectPlaybook,
	searchInputRef,
	gridColumns = 3,
}: UseMarketplaceListKeyboardNavParams): void {
	useEventListener(
		'keydown',
		(event) => {
			const e = event as KeyboardEvent;

			if ((e.metaKey || e.ctrlKey) && e.key === 'f' && !showDetailView) {
				e.preventDefault();
				searchInputRef.current?.focus();
				searchInputRef.current?.select();
			}

			if (showDetailView) return;

			const total = orderedPlaybooks.length;
			if (total === 0) return;

			if (e.target instanceof HTMLInputElement) {
				const input = e.target;
				if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
					if (input.value.length > 0) {
						return;
					}
					input.blur();
				}
				if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
					input.blur();
				}
			}

			switch (e.key) {
				case 'ArrowRight':
					e.preventDefault();
					setSelectedTileIndex((index) => Math.min(total - 1, index + 1));
					break;
				case 'ArrowLeft':
					e.preventDefault();
					setSelectedTileIndex((index) => Math.max(0, index - 1));
					break;
				case 'ArrowDown':
					e.preventDefault();
					setSelectedTileIndex((index) => Math.min(total - 1, index + gridColumns));
					break;
				case 'ArrowUp':
					e.preventDefault();
					setSelectedTileIndex((index) => Math.max(0, index - gridColumns));
					break;
				case 'Enter':
					e.preventDefault();
					if (orderedPlaybooks[selectedTileIndex]) {
						onSelectPlaybook(orderedPlaybooks[selectedTileIndex]);
					}
					break;
			}
		},
		{ enabled: isOpen }
	);
}
