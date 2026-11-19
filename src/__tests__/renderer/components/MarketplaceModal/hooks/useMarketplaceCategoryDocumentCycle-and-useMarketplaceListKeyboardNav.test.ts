// Source: src/__tests__/renderer/components/MarketplaceModal/hooks/useMarketplaceCategoryDocumentCycle.test.ts
// Source: src/__tests__/renderer/components/MarketplaceModal/hooks/useMarketplaceListKeyboardNav.test.ts
// Source: src/__tests__/renderer/components/MarketplaceModal/hooks/usePlaybookDetailState.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useMarketplaceCategoryDocumentCycle } from '../../../../../renderer/components/MarketplaceModal/hooks';
import { makePlaybook } from '../_fixtures';
import { afterEach } from 'vitest';
import { useMarketplaceListKeyboardNav } from '../../../../../renderer/components/MarketplaceModal/hooks';
import { act } from '@testing-library/react';
import { usePlaybookDetailState } from '../../../../../renderer/components/MarketplaceModal/hooks';
describeSourceSuite('useMarketplaceCategoryDocumentCycle', () => {
	function fireCycle(key: '[' | ']', options: KeyboardEventInit = {}) {
		const event = new KeyboardEvent('keydown', {
			key,
			metaKey: true,
			shiftKey: true,
			bubbles: true,
			cancelable: true,
			...options,
		});
		window.dispatchEvent(event);
		return event;
	}

	function setup(
		overrides: Partial<Parameters<typeof useMarketplaceCategoryDocumentCycle>[0]> = {}
	) {
		const onCategoryChange = vi.fn();
		const onSelectDocument = vi.fn();
		const params = {
			isOpen: true,
			categories: ['All', 'Development', 'Security'],
			selectedCategory: 'Development',
			showDetailView: false,
			selectedPlaybook: null,
			selectedDocFilename: null,
			onCategoryChange,
			onSelectDocument,
			...overrides,
		};

		const hook = renderHook(() => useMarketplaceCategoryDocumentCycle(params));

		return { ...hook, onCategoryChange, onSelectDocument };
	}

	describe('useMarketplaceCategoryDocumentCycle', () => {
		it('moves category tabs backward and forward with clamp behavior', () => {
			let result = setup({ selectedCategory: 'Development' });
			fireCycle('[');
			expect(result.onCategoryChange).toHaveBeenCalledWith('All');
			result.unmount();

			result = setup({ selectedCategory: 'Development' });
			fireCycle(']');
			expect(result.onCategoryChange).toHaveBeenCalledWith('Security');
			result.unmount();

			result = setup({ selectedCategory: 'All' });
			fireCycle('[');
			expect(result.onCategoryChange).toHaveBeenCalledWith('All');
			result.unmount();

			result = setup({ selectedCategory: 'Security' });
			fireCycle(']');
			expect(result.onCategoryChange).toHaveBeenCalledWith('Security');
		});

		it('cycles detail documents with README wraparound', () => {
			const playbook = makePlaybook();
			let result = setup({
				showDetailView: true,
				selectedPlaybook: playbook,
				selectedDocFilename: null,
			});
			fireCycle(']');
			expect(result.onSelectDocument).toHaveBeenCalledWith('phase-1');
			result.unmount();

			result = setup({
				showDetailView: true,
				selectedPlaybook: playbook,
				selectedDocFilename: 'phase-2',
			});
			fireCycle(']');
			expect(result.onSelectDocument).toHaveBeenCalledWith('');
			result.unmount();

			result = setup({
				showDetailView: true,
				selectedPlaybook: playbook,
				selectedDocFilename: null,
			});
			fireCycle('[');
			expect(result.onSelectDocument).toHaveBeenCalledWith('phase-2');
		});

		it('ignores shortcuts when closed or missing modifiers', () => {
			let result = setup({ isOpen: false });
			fireCycle(']');
			expect(result.onCategoryChange).not.toHaveBeenCalled();
			result.unmount();

			result = setup();
			window.dispatchEvent(new KeyboardEvent('keydown', { key: ']', shiftKey: true }));
			expect(result.onCategoryChange).not.toHaveBeenCalled();
		});

		it('removes its listener on unmount', () => {
			const { unmount, onCategoryChange } = setup();

			unmount();
			fireCycle(']');

			expect(onCategoryChange).not.toHaveBeenCalled();
		});
	});
});
describeSourceSuite('useMarketplaceListKeyboardNav', () => {
	function fireKey(key: string, options: KeyboardEventInit = {}, target?: EventTarget) {
		const event = new KeyboardEvent('keydown', {
			key,
			bubbles: true,
			cancelable: true,
			...options,
		});
		(target ?? window).dispatchEvent(event);
		return event;
	}

	function setup(overrides: Partial<Parameters<typeof useMarketplaceListKeyboardNav>[0]> = {}) {
		const searchInput = document.createElement('input');
		document.body.appendChild(searchInput);
		const playbooks = Array.from({ length: 9 }, (_, index) =>
			makePlaybook({ id: `playbook-${index}`, title: `Playbook ${index}` })
		);
		const setSelectedTileIndex = vi.fn<(updater: (index: number) => number) => void>();
		const onSelectPlaybook = vi.fn();

		const params = {
			isOpen: true,
			showDetailView: false,
			orderedPlaybooks: playbooks,
			selectedTileIndex: 0,
			setSelectedTileIndex,
			onSelectPlaybook,
			searchInputRef: { current: searchInput },
			...overrides,
		};

		const hook = renderHook(() => useMarketplaceListKeyboardNav(params));

		return {
			...hook,
			searchInput,
			playbooks,
			setSelectedTileIndex,
			onSelectPlaybook,
		};
	}

	describe('useMarketplaceListKeyboardNav', () => {
		afterEach(() => {
			document.body.innerHTML = '';
		});

		it('focuses and selects search on Cmd/Ctrl+F outside detail view', () => {
			const { searchInput } = setup();
			const selectSpy = vi.spyOn(searchInput, 'select');

			const event = fireKey('f', { metaKey: true });

			expect(event.defaultPrevented).toBe(true);
			expect(document.activeElement).toBe(searchInput);
			expect(selectSpy).toHaveBeenCalledTimes(1);
		});

		it('does not focus search on Cmd/Ctrl+F inside detail view', () => {
			const { searchInput } = setup({ showDetailView: true });

			fireKey('f', { metaKey: true });

			expect(document.activeElement).not.toBe(searchInput);
		});

		it('moves selection with arrow keys and clamps at grid edges', () => {
			const { setSelectedTileIndex } = setup();

			fireKey('ArrowRight');
			expect(setSelectedTileIndex.mock.calls[0][0](0)).toBe(1);
			expect(setSelectedTileIndex.mock.calls[0][0](8)).toBe(8);

			fireKey('ArrowLeft');
			expect(setSelectedTileIndex.mock.calls[1][0](1)).toBe(0);
			expect(setSelectedTileIndex.mock.calls[1][0](0)).toBe(0);

			fireKey('ArrowDown');
			expect(setSelectedTileIndex.mock.calls[2][0](0)).toBe(3);
			expect(setSelectedTileIndex.mock.calls[2][0](7)).toBe(8);

			fireKey('ArrowUp');
			expect(setSelectedTileIndex.mock.calls[3][0](4)).toBe(1);
			expect(setSelectedTileIndex.mock.calls[3][0](2)).toBe(0);
		});

		it('selects the highlighted playbook on Enter', () => {
			const { onSelectPlaybook } = setup({ selectedTileIndex: 4 });

			fireKey('Enter');

			expect(onSelectPlaybook).toHaveBeenCalledTimes(1);
			expect(onSelectPlaybook.mock.calls[0][0].id).toBe('playbook-4');
		});

		it('leaves Enter to the input method during active IME composition', () => {
			const { onSelectPlaybook } = setup({ selectedTileIndex: 4 });

			for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
				fireKey('Enter', ime);
				expect(onSelectPlaybook).not.toHaveBeenCalled();
			}

			fireKey('Enter');
			expect(onSelectPlaybook).toHaveBeenCalledTimes(1);
		});

		it('lets left and right move the cursor when search input has text', () => {
			const { searchInput, setSelectedTileIndex } = setup();
			searchInput.value = 'query';

			fireKey('ArrowLeft', {}, searchInput);
			fireKey('ArrowRight', {}, searchInput);

			expect(setSelectedTileIndex).not.toHaveBeenCalled();
		});

		it('blurs an empty search input before navigating with arrows', () => {
			const { searchInput, setSelectedTileIndex } = setup();
			searchInput.focus();

			fireKey('ArrowRight', {}, searchInput);

			expect(document.activeElement).not.toBe(searchInput);
			expect(setSelectedTileIndex).toHaveBeenCalledTimes(1);
		});

		it('does nothing when closed, in detail view, or there are no playbooks', () => {
			let result = setup({ isOpen: false });
			fireKey('ArrowRight');
			expect(result.setSelectedTileIndex).not.toHaveBeenCalled();
			result.unmount();

			result = setup({ showDetailView: true });
			fireKey('ArrowRight');
			expect(result.setSelectedTileIndex).not.toHaveBeenCalled();
			result.unmount();

			result = setup({ orderedPlaybooks: [] });
			fireKey('ArrowRight');
			fireKey('Enter');
			expect(result.setSelectedTileIndex).not.toHaveBeenCalled();
			expect(result.onSelectPlaybook).not.toHaveBeenCalled();
		});

		it('removes its listener on unmount', () => {
			const { unmount, setSelectedTileIndex } = setup();

			unmount();
			fireKey('ArrowRight');

			expect(setSelectedTileIndex).not.toHaveBeenCalled();
		});
	});
});
describeSourceSuite('usePlaybookDetailState', () => {
	function createDeferred<T>() {
		let resolve!: (value: T) => void;
		const promise = new Promise<T>((resolver) => {
			resolve = resolver;
		});
		return { promise, resolve };
	}

	describe('usePlaybookDetailState', () => {
		it('opens detail view, generates default folder slug, and loads README', async () => {
			const fetchReadme = vi.fn().mockResolvedValue('# README');
			const fetchDocument = vi.fn();
			const playbook = makePlaybook({ title: 'API Review!!', path: 'playbooks/api-review' });

			const { result } = renderHook(() => usePlaybookDetailState({ fetchReadme, fetchDocument }));

			await act(async () => {
				await result.current.handleSelectPlaybook(playbook);
			});

			expect(result.current.selectedPlaybook).toBe(playbook);
			expect(result.current.showDetailView).toBe(true);
			expect(result.current.targetFolderName).toBe('api-review');
			expect(result.current.readmeContent).toBe('# README');
			expect(fetchReadme).toHaveBeenCalledWith('playbooks/api-review');
		});

		it('loads selected documents and switches back to README without refetching', async () => {
			const fetchReadme = vi.fn().mockResolvedValue('# README');
			const fetchDocument = vi.fn().mockResolvedValue('# Phase 1');
			const playbook = makePlaybook();

			const { result } = renderHook(() => usePlaybookDetailState({ fetchReadme, fetchDocument }));

			await act(async () => {
				await result.current.handleSelectPlaybook(playbook);
			});

			await act(async () => {
				await result.current.handleSelectDocument('phase-1');
			});

			expect(result.current.selectedDocFilename).toBe('phase-1');
			expect(result.current.documentContent).toBe('# Phase 1');
			expect(fetchDocument).toHaveBeenCalledWith(playbook.path, 'phase-1');

			await act(async () => {
				await result.current.handleSelectDocument('');
			});

			expect(result.current.selectedDocFilename).toBeNull();
			expect(result.current.documentContent).toBeNull();
			expect(fetchDocument).toHaveBeenCalledTimes(1);
		});

		it('does nothing when selecting a document without a selected playbook', async () => {
			const fetchReadme = vi.fn();
			const fetchDocument = vi.fn();

			const { result } = renderHook(() => usePlaybookDetailState({ fetchReadme, fetchDocument }));

			await act(async () => {
				await result.current.handleSelectDocument('phase-1');
			});

			expect(fetchDocument).not.toHaveBeenCalled();
			expect(result.current.selectedDocFilename).toBeNull();
		});

		it('ignores stale README responses after selecting another playbook', async () => {
			const firstReadme = createDeferred<string | null>();
			const secondReadme = createDeferred<string | null>();
			const fetchReadme = vi
				.fn()
				.mockReturnValueOnce(firstReadme.promise)
				.mockReturnValueOnce(secondReadme.promise);
			const fetchDocument = vi.fn();
			const firstPlaybook = makePlaybook({ id: 'first', title: 'First', path: 'first' });
			const secondPlaybook = makePlaybook({ id: 'second', title: 'Second', path: 'second' });

			const { result } = renderHook(() => usePlaybookDetailState({ fetchReadme, fetchDocument }));

			let firstSelect = Promise.resolve();
			act(() => {
				firstSelect = result.current.handleSelectPlaybook(firstPlaybook);
			});

			let secondSelect = Promise.resolve();
			act(() => {
				secondSelect = result.current.handleSelectPlaybook(secondPlaybook);
			});

			await act(async () => {
				secondReadme.resolve('# Second README');
				await secondSelect;
			});

			expect(result.current.selectedPlaybook).toBe(secondPlaybook);
			expect(result.current.readmeContent).toBe('# Second README');
			expect(result.current.isLoadingDocument).toBe(false);

			await act(async () => {
				firstReadme.resolve('# First README');
				await firstSelect;
			});

			expect(result.current.selectedPlaybook).toBe(secondPlaybook);
			expect(result.current.readmeContent).toBe('# Second README');
			expect(result.current.isLoadingDocument).toBe(false);
		});

		it('ignores stale document responses after selecting another document', async () => {
			const firstDocument = createDeferred<string | null>();
			const secondDocument = createDeferred<string | null>();
			const fetchReadme = vi.fn().mockResolvedValue('# README');
			const fetchDocument = vi
				.fn()
				.mockReturnValueOnce(firstDocument.promise)
				.mockReturnValueOnce(secondDocument.promise);
			const playbook = makePlaybook();

			const { result } = renderHook(() => usePlaybookDetailState({ fetchReadme, fetchDocument }));

			await act(async () => {
				await result.current.handleSelectPlaybook(playbook);
			});

			let firstSelect = Promise.resolve();
			act(() => {
				firstSelect = result.current.handleSelectDocument('phase-1');
			});

			let secondSelect = Promise.resolve();
			act(() => {
				secondSelect = result.current.handleSelectDocument('phase-2');
			});

			await act(async () => {
				secondDocument.resolve('# Phase 2');
				await secondSelect;
			});

			expect(result.current.selectedDocFilename).toBe('phase-2');
			expect(result.current.documentContent).toBe('# Phase 2');
			expect(result.current.isLoadingDocument).toBe(false);

			await act(async () => {
				firstDocument.resolve('# Phase 1');
				await firstSelect;
			});

			expect(result.current.selectedDocFilename).toBe('phase-2');
			expect(result.current.documentContent).toBe('# Phase 2');
			expect(result.current.isLoadingDocument).toBe(false);
		});

		it('back to list resets detail state', async () => {
			const fetchReadme = vi.fn().mockResolvedValue('# README');
			const fetchDocument = vi.fn().mockResolvedValue('# Phase');
			const { result } = renderHook(() => usePlaybookDetailState({ fetchReadme, fetchDocument }));

			await act(async () => {
				await result.current.handleSelectPlaybook(makePlaybook());
				await result.current.handleSelectDocument('phase-1');
			});

			act(() => {
				result.current.handleBackToList();
			});

			expect(result.current.showDetailView).toBe(false);
			expect(result.current.selectedPlaybook).toBeNull();
			expect(result.current.readmeContent).toBeNull();
			expect(result.current.selectedDocFilename).toBeNull();
			expect(result.current.documentContent).toBeNull();
			expect(result.current.targetFolderName).toBe('');
		});
	});
});
