import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useMarketplaceListKeyboardNav } from '../../../../../renderer/components/MarketplaceModal/hooks';
import { makePlaybook } from '../_fixtures';

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
