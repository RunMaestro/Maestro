/**
 * Tests for SymphonyModal/hooks/useProjectsKeyboardNav - repository tile-grid
 * keyboard nav (Arrows / Enter / "/" / Esc-blur).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useProjectsKeyboardNav } from '../../../../../renderer/components/SymphonyModal/hooks/useProjectsKeyboardNav';
import { makeRepo } from '../_fixtures';

function fire(key: string, target?: EventTarget) {
	const ev = new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true });
	if (target) {
		Object.defineProperty(ev, 'target', { value: target });
		(target as EventTarget).dispatchEvent(ev);
	} else {
		window.dispatchEvent(ev);
	}
	return ev;
}

function setup(params: {
	isOpen?: boolean;
	activeTab?: 'projects' | 'active' | 'history' | 'stats';
	showDetailView?: boolean;
	repoCount?: number;
	selectedTileIndex?: number;
}) {
	const setSelectedTileIndex = vi.fn<(updater: (i: number) => number) => void>();
	const onSelectRepo = vi.fn();
	const filteredRepositories = Array.from({ length: params.repoCount ?? 9 }, (_, i) =>
		makeRepo({ slug: `r-${i}`, name: `r-${i}` })
	);
	// Create real DOM elements so the .focus()/.blur() shims behave.
	const searchInput = document.createElement('input');
	searchInput.id = 'search';
	document.body.appendChild(searchInput);
	const grid = document.createElement('div');
	grid.tabIndex = 0;
	document.body.appendChild(grid);
	const searchInputRef = { current: searchInput };
	const tileGridRef = { current: grid };

	renderHook(() =>
		useProjectsKeyboardNav({
			isOpen: params.isOpen ?? true,
			activeTab: params.activeTab ?? 'projects',
			showDetailView: params.showDetailView ?? false,
			filteredRepositories,
			selectedTileIndex: params.selectedTileIndex ?? 0,
			setSelectedTileIndex,
			onSelectRepo,
			searchInputRef,
			tileGridRef,
		})
	);

	return { setSelectedTileIndex, onSelectRepo, searchInput, grid };
}

describe('useProjectsKeyboardNav', () => {
	afterEach(() => {
		document.getElementById('search')?.remove();
		document.querySelectorAll('div[tabindex="0"]').forEach((node) => node.remove());
	});

	it('ArrowRight increments and clamps at total-1', () => {
		const { setSelectedTileIndex } = setup({ selectedTileIndex: 0, repoCount: 9 });
		fire('ArrowRight');
		expect(setSelectedTileIndex).toHaveBeenCalledTimes(1);
		const updater = setSelectedTileIndex.mock.calls[0][0];
		expect(updater(0)).toBe(1);
		expect(updater(8)).toBe(8); // clamp at end
	});

	it('ArrowLeft decrements and clamps at 0', () => {
		const { setSelectedTileIndex } = setup({ selectedTileIndex: 1 });
		fire('ArrowLeft');
		const updater = setSelectedTileIndex.mock.calls[0][0];
		expect(updater(2)).toBe(1);
		expect(updater(0)).toBe(0);
	});

	it('ArrowDown advances by grid width (3) and clamps', () => {
		const { setSelectedTileIndex } = setup({ repoCount: 9 });
		fire('ArrowDown');
		const updater = setSelectedTileIndex.mock.calls[0][0];
		expect(updater(0)).toBe(3);
		expect(updater(7)).toBe(8);
		expect(updater(8)).toBe(8);
	});

	it('ArrowUp moves back by grid width (3) and clamps', () => {
		const { setSelectedTileIndex } = setup({ repoCount: 9 });
		fire('ArrowUp');
		const updater = setSelectedTileIndex.mock.calls[0][0];
		expect(updater(7)).toBe(4);
		expect(updater(1)).toBe(0);
	});

	it('Enter calls onSelectRepo with the currently selected tile', () => {
		const { onSelectRepo } = setup({ selectedTileIndex: 4, repoCount: 9 });
		fire('Enter');
		expect(onSelectRepo).toHaveBeenCalledTimes(1);
		expect(onSelectRepo.mock.calls[0][0].slug).toBe('r-4');
	});

	it('"/" focuses the search input and prevents default', () => {
		const { searchInput } = setup({});
		const ev = fire('/');
		expect(document.activeElement).toBe(searchInput);
		expect(ev.defaultPrevented).toBe(true);
	});

	it('Escape inside the search input blurs + refocuses grid + stops propagation', () => {
		const { searchInput, grid } = setup({});
		searchInput.focus();
		expect(document.activeElement).toBe(searchInput);
		const ev = new KeyboardEvent('keydown', {
			key: 'Escape',
			cancelable: true,
			bubbles: true,
		});
		searchInput.dispatchEvent(ev);
		expect(document.activeElement).toBe(grid);
	});

	it('does nothing when activeTab !== "projects"', () => {
		const { setSelectedTileIndex } = setup({ activeTab: 'active' });
		fire('ArrowRight');
		expect(setSelectedTileIndex).not.toHaveBeenCalled();
	});

	it('does nothing when showDetailView is true', () => {
		const { setSelectedTileIndex } = setup({ showDetailView: true });
		fire('ArrowRight');
		expect(setSelectedTileIndex).not.toHaveBeenCalled();
	});

	it('does nothing when filteredRepositories is empty', () => {
		const { setSelectedTileIndex, onSelectRepo } = setup({ repoCount: 0 });
		fire('ArrowRight');
		fire('Enter');
		expect(setSelectedTileIndex).not.toHaveBeenCalled();
		expect(onSelectRepo).not.toHaveBeenCalled();
	});

	it('inside the search input, only ArrowDown/ArrowUp affect tile selection', () => {
		const { setSelectedTileIndex, searchInput, grid } = setup({});
		fire('ArrowLeft', searchInput);
		fire('ArrowRight', searchInput);
		fire('Enter', searchInput);
		expect(setSelectedTileIndex).not.toHaveBeenCalled();
		fire('ArrowDown', searchInput);
		expect(setSelectedTileIndex).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(grid);
		searchInput.focus();
		fire('ArrowUp', searchInput);
		expect(setSelectedTileIndex).toHaveBeenCalledTimes(2);
		expect(document.activeElement).toBe(grid);
	});

	it('is a no-op when isOpen is false', () => {
		const { setSelectedTileIndex } = setup({ isOpen: false });
		fire('ArrowRight');
		fire('Enter');
		expect(setSelectedTileIndex).not.toHaveBeenCalled();
	});

	it('removes the listener on unmount', () => {
		const setSelectedTileIndex = vi.fn();
		const onSelectRepo = vi.fn();
		const filteredRepositories = [makeRepo()];
		const searchInputRef = { current: document.createElement('input') };
		const tileGridRef = { current: document.createElement('div') };
		const { unmount } = renderHook(() =>
			useProjectsKeyboardNav({
				isOpen: true,
				activeTab: 'projects',
				showDetailView: false,
				filteredRepositories,
				selectedTileIndex: 0,
				setSelectedTileIndex,
				onSelectRepo,
				searchInputRef,
				tileGridRef,
			})
		);
		unmount();
		fire('ArrowRight');
		expect(setSelectedTileIndex).not.toHaveBeenCalled();
	});
});
