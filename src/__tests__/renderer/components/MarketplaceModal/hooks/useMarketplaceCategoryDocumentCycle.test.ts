import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useMarketplaceCategoryDocumentCycle } from '../../../../../renderer/components/MarketplaceModal/hooks';
import { makePlaybook } from '../_fixtures';

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

function setup(overrides: Partial<Parameters<typeof useMarketplaceCategoryDocumentCycle>[0]> = {}) {
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
