/**
 * Tab-strip reorder by drag, across every chip kind.
 *
 * The gesture is older than tiling, and tiling bolted a second payload onto the
 * same drag: every non-group chip now also writes `application/x-maestro-tab`
 * so a drop onto the tiled panel can identify it. These tests pin the part that
 * must not change because of that - dropping a chip on a sibling chip reorders
 * the strip - and the part that regressed: a drop on the bar's own background.
 *
 * The background case is the one worth explaining. Before tiling, the bar had no
 * `dragover` handler, so releasing over strip padding or past the last chip was
 * rejected by the browser and the drag snapped back: nothing happened, and it
 * LOOKED like nothing would. After tiling the bar accepts any drag carrying a
 * tile payload - which is now every tab drag - so the cursor promises a move and
 * then the handler, which only knows how to promote a tiled pane, declines and
 * returns. Same non-result, but advertised as a drop. That is the bug.
 */

import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TabBar } from '../../../../renderer/components/TabBar';
import { mockTheme } from '../../../helpers/mockTheme';
import { TAB_TILE_MIME } from '../../../../renderer/utils/tabDragPayload';
import type { AITab, FilePreviewTab, UnifiedTab } from '../../../../renderer/types';

vi.mock('lucide-react', async (importOriginal) => ({
	...(await importOriginal<typeof import('lucide-react')>()),
}));

const aiTab = { id: 'ai-1', name: 'Alpha', logs: [], messages: [] } as unknown as AITab;
const aiTab2 = { id: 'ai-2', name: 'Bravo', logs: [], messages: [] } as unknown as AITab;
const fileTab = {
	id: 'file-1',
	name: 'document',
	extension: '.md',
	path: '/tmp/document.md',
} as unknown as FilePreviewTab;

const unifiedTabs: UnifiedTab[] = [
	{ type: 'ai', id: 'ai-1', data: aiTab },
	{ type: 'ai', id: 'ai-2', data: aiTab2 },
	{ type: 'file', id: 'file-1', data: fileTab },
];

/**
 * A dataTransfer stand-in that behaves like the real one for our purposes:
 * `types` reflects what has been written (that is what `dragover` can see), and
 * `getData` returns it (that is what `drop` can see).
 */
function makeDataTransfer(initial: Record<string, string> = {}) {
	const store: Record<string, string> = { ...initial };
	return {
		effectAllowed: '',
		dropEffect: '',
		get types() {
			return Object.keys(store);
		},
		setData: (type: string, value: string) => {
			store[type] = value;
		},
		getData: (type: string) => store[type] ?? '',
	};
}

function renderBar(onUnifiedTabReorder: (from: number, to: number) => void) {
	return render(
		<TabBar
			tabs={[aiTab, aiTab2]}
			activeTabId="ai-1"
			theme={mockTheme}
			onTabSelect={vi.fn()}
			onTabClose={vi.fn()}
			onNewTab={vi.fn()}
			unifiedTabs={unifiedTabs}
			activeFileTabId={null}
			onFileTabSelect={vi.fn()}
			onFileTabClose={vi.fn()}
			onUnifiedTabReorder={onUnifiedTabReorder}
		/>
	);
}

function chip(tabId: string): HTMLElement {
	const el = document.querySelector(`[data-tab-id="${tabId}"]`);
	if (!el) throw new Error(`no chip for ${tabId}`);
	return el as HTMLElement;
}

/** Run a full drag: dragstart on `from`, dragover then drop on `to`. */
function drag(from: HTMLElement, to: HTMLElement) {
	const dataTransfer = makeDataTransfer();
	fireEvent.dragStart(from, { dataTransfer });
	fireEvent.dragOver(to, { dataTransfer });
	fireEvent.drop(to, { dataTransfer });
	return dataTransfer;
}

describe('tab strip reorder', () => {
	it('reorders when a chip is dropped on a sibling chip', () => {
		const reorder = vi.fn();
		renderBar(reorder);

		drag(chip('ai-1'), chip('ai-2'));

		expect(reorder).toHaveBeenCalledWith(0, 1);
	});

	it('reorders across kinds - an AI chip onto a file chip', () => {
		const reorder = vi.fn();
		renderBar(reorder);

		drag(chip('ai-1'), chip('file-1'));

		expect(reorder).toHaveBeenCalledWith(0, 2);
	});

	it('reorders backwards - a later chip onto an earlier one', () => {
		const reorder = vi.fn();
		renderBar(reorder);

		drag(chip('file-1'), chip('ai-1'));

		expect(reorder).toHaveBeenCalledWith(2, 0);
	});

	it('still carries the tile payload, so dropping onto the panel keeps working', () => {
		const reorder = vi.fn();
		renderBar(reorder);

		const dataTransfer = makeDataTransfer();
		fireEvent.dragStart(chip('ai-1'), { dataTransfer });

		expect(dataTransfer.getData('text/plain')).toBe('ai-1');
		const payload = JSON.parse(dataTransfer.getData(TAB_TILE_MIME));
		expect(payload).toMatchObject({ ref: { type: 'ai', id: 'ai-1' }, source: 'tab-bar' });
	});

	it('does not reorder a chip onto itself', () => {
		const reorder = vi.fn();
		renderBar(reorder);

		drag(chip('ai-1'), chip('ai-1'));

		expect(reorder).not.toHaveBeenCalled();
	});

	it('moves the chip to the end when dropped on the bar background', () => {
		// The regression: the bar accepts the drop (the cursor says "move") because
		// every tab drag now carries a tile payload, then does nothing because the
		// only thing it knows how to handle is a tiled pane being promoted out.
		const reorder = vi.fn();
		const { container } = renderBar(reorder);

		const bar = container.querySelector('[data-tour="tab-bar"]') as HTMLElement;
		expect(bar).toBeTruthy();

		const dataTransfer = makeDataTransfer();
		fireEvent.dragStart(chip('ai-1'), { dataTransfer });
		fireEvent.dragOver(bar, { dataTransfer });
		fireEvent.drop(bar, { dataTransfer });

		expect(reorder).toHaveBeenCalledWith(0, unifiedTabs.length - 1);
	});
});
