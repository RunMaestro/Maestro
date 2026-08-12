import { useEffect, type RefObject } from 'react';
import type { RegisteredRepository } from '../../../../shared/symphony-types';
import type { ModalTab } from '../types';

export interface UseProjectsKeyboardNavParams {
	isOpen: boolean;
	activeTab: ModalTab;
	showDetailView: boolean;
	filteredRepositories: RegisteredRepository[];
	selectedTileIndex: number;
	setSelectedTileIndex: (updater: (i: number) => number) => void;
	onSelectRepo: (repo: RegisteredRepository) => void;
	searchInputRef: RefObject<HTMLInputElement>;
	tileGridRef: RefObject<HTMLDivElement>;
	gridColumns?: number;
}

/**
 * Keyboard navigation for the Projects tab repository grid:
 *  - "/" focuses the search input
 *  - Escape inside the search input blurs + returns focus to the grid
 *  - Arrow keys move the selected tile (clamped at edges, no wrap)
 *  - Enter activates the highlighted tile
 *
 * All listeners attach to `window` (not the modal root) - matches today's
 * behavior. The hook is a no-op when the modal is closed, when we're on a
 * different tab, or when the detail view is open.
 */
export function useProjectsKeyboardNav({
	isOpen,
	activeTab,
	showDetailView,
	filteredRepositories,
	selectedTileIndex,
	setSelectedTileIndex,
	onSelectRepo,
	searchInputRef,
	tileGridRef,
	gridColumns = 3,
}: UseProjectsKeyboardNavParams): void {
	useEffect(() => {
		if (!isOpen) return;
		const handleKeyDown = (e: KeyboardEvent) => {
			if (activeTab !== 'projects' || showDetailView) return;

			// "/" focuses search (vim-style); ignore if user is already typing in an input.
			if (e.key === '/' && !(e.target instanceof HTMLInputElement)) {
				e.preventDefault();
				searchInputRef.current?.focus();
				return;
			}

			// Escape in the search input blurs + restores grid focus; stopPropagation
			// keeps the modal from closing.
			if (e.key === 'Escape' && e.target instanceof HTMLInputElement) {
				e.preventDefault();
				e.stopPropagation();
				(e.target as HTMLInputElement).blur();
				tileGridRef.current?.focus();
				return;
			}

			const total = filteredRepositories.length;
			if (total === 0) return;
			// When typing in an input, only ArrowDown/ArrowUp escape out of the field.
			if (e.target instanceof HTMLInputElement && !['ArrowDown', 'ArrowUp'].includes(e.key)) {
				return;
			}

			switch (e.key) {
				case 'ArrowRight':
					e.preventDefault();
					setSelectedTileIndex((i) => Math.min(total - 1, i + 1));
					break;
				case 'ArrowLeft':
					e.preventDefault();
					setSelectedTileIndex((i) => Math.max(0, i - 1));
					break;
				case 'ArrowDown':
					e.preventDefault();
					setSelectedTileIndex((i) => Math.min(total - 1, i + gridColumns));
					if (e.target instanceof HTMLInputElement) {
						tileGridRef.current?.focus();
					}
					break;
				case 'ArrowUp':
					e.preventDefault();
					setSelectedTileIndex((i) => Math.max(0, i - gridColumns));
					if (e.target instanceof HTMLInputElement) {
						tileGridRef.current?.focus();
					}
					break;
				case 'Enter': {
					e.preventDefault();
					const repo = filteredRepositories[selectedTileIndex];
					if (repo) onSelectRepo(repo);
					break;
				}
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [
		isOpen,
		activeTab,
		showDetailView,
		filteredRepositories,
		selectedTileIndex,
		setSelectedTileIndex,
		onSelectRepo,
		searchInputRef,
		tileGridRef,
		gridColumns,
	]);
}
