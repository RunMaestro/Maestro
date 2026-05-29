import {
	act,
	cleanup,
	createEvent,
	fireEvent,
	render,
	screen,
	waitFor,
} from '@testing-library/react';
import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DocumentsPanel, type DocTreeNode } from '../../renderer/components/DocumentsPanel';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import type { BatchDocumentEntry, Theme } from '../../renderer/types';

const theme: Theme = {
	id: 'integration-dark',
	name: 'Integration Dark',
	mode: 'dark',
	colors: {
		bgMain: '#101114',
		bgSidebar: '#20242b',
		bgActivity: '#181b20',
		border: '#3f3f46',
		textMain: '#f4f4f5',
		textDim: '#a1a1aa',
		accent: '#4f8cff',
		accentDim: '#1d4ed8',
		accentText: '#4f8cff',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

function doc(
	id: string,
	filename: string,
	overrides: Partial<BatchDocumentEntry> = {}
): BatchDocumentEntry {
	return {
		id,
		filename,
		resetOnCompletion: false,
		isDuplicate: false,
		...overrides,
	};
}

interface HarnessProps {
	initialDocuments?: BatchDocumentEntry[];
	initialAllDocuments?: string[];
	documentTree?: DocTreeNode[];
	taskCounts?: Record<string, number>;
	loadingTaskCounts?: boolean;
	initialLoopEnabled?: boolean;
	initialMaxLoops?: number | null;
	refreshDocuments?: string[];
	onRefreshDocuments?: ReturnType<typeof vi.fn>;
}

function DocumentsHarness({
	initialDocuments = [],
	initialAllDocuments = ['alpha', 'beta', 'gamma'],
	documentTree,
	taskCounts = { alpha: 2, beta: 1, gamma: 0, 'folder/plan': 3, 'folder/check': 0 },
	loadingTaskCounts = false,
	initialLoopEnabled = false,
	initialMaxLoops = null,
	refreshDocuments,
	onRefreshDocuments = vi.fn(),
}: HarnessProps) {
	const [documents, setDocuments] = useState(initialDocuments);
	const [allDocuments, setAllDocuments] = useState(initialAllDocuments);
	const [loopEnabled, setLoopEnabled] = useState(initialLoopEnabled);
	const [maxLoops, setMaxLoops] = useState<number | null>(initialMaxLoops);

	return (
		<LayerStackProvider>
			<DocumentsPanel
				theme={theme}
				documents={documents}
				setDocuments={setDocuments}
				taskCounts={taskCounts}
				loadingTaskCounts={loadingTaskCounts}
				loopEnabled={loopEnabled}
				setLoopEnabled={setLoopEnabled}
				maxLoops={maxLoops}
				setMaxLoops={setMaxLoops}
				allDocuments={allDocuments}
				documentTree={documentTree}
				onRefreshDocuments={async () => {
					await onRefreshDocuments();
					if (refreshDocuments) {
						setAllDocuments(refreshDocuments);
					}
				}}
			/>
		</LayerStackProvider>
	);
}

function renderDocumentsPanel(props: HarnessProps = {}) {
	return render(<DocumentsHarness {...props} />);
}

function rowFor(filename: string): HTMLElement {
	const label = screen.getAllByText(`${filename}.md`)[0];
	const row = label.closest('[draggable]');
	if (!row) {
		throw new Error(`Could not find draggable row for ${filename}`);
	}
	return row as HTMLElement;
}

function dataTransfer() {
	return {
		effectAllowed: 'move',
		dropEffect: 'move',
		setData: vi.fn(),
		getData: vi.fn(),
	};
}

function withDragProperties<T extends Event>(
	event: T,
	properties: { ctrlKey?: boolean; clientX?: number; clientY?: number }
): T {
	for (const [key, value] of Object.entries(properties)) {
		Object.defineProperty(event, key, { value });
	}
	return event;
}

describe('DocumentsPanel integration', () => {
	const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;

	beforeEach(() => {
		HTMLElement.prototype.getBoundingClientRect = vi.fn(() => ({
			x: 0,
			y: 0,
			width: 240,
			height: 40,
			top: 0,
			left: 0,
			right: 240,
			bottom: 40,
			toJSON: () => ({}),
		}));
	});

	afterEach(() => {
		HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
		vi.useRealTimers();
		cleanup();
	});

	it('opens and closes the selector modal through buttons, backdrop, and Escape', async () => {
		renderDocumentsPanel();

		expect(screen.getByText('No documents selected')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /add docs/i }));

		expect(screen.getByText('Select Documents')).toBeInTheDocument();
		fireEvent.click(screen.getByLabelText('Close document selector'));
		expect(screen.queryByText('Select Documents')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /add docs/i }));
		fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByText('Select Documents')).not.toBeInTheDocument());

		fireEvent.click(screen.getByRole('button', { name: /add docs/i }));
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(screen.queryByText('Select Documents')).not.toBeInTheDocument();
	});

	it('adds, removes, and preserves selected documents from the flat selector', () => {
		renderDocumentsPanel({
			initialDocuments: [doc('existing-alpha', 'alpha')],
			initialAllDocuments: ['alpha', 'beta', 'gamma'],
		});

		fireEvent.click(screen.getByRole('button', { name: /add docs/i }));
		expect(screen.getByText('3 tasks')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /add 1 file/i })).toHaveTextContent('2 tasks');

		fireEvent.click(screen.getByText('beta.md'));
		expect(screen.getByRole('button', { name: /add 2 files/i })).toHaveTextContent('3 tasks');

		fireEvent.click(screen.getAllByText('alpha.md').at(-1)!);
		expect(screen.getByRole('button', { name: /add 1 file/i })).toHaveTextContent('1 task');

		fireEvent.click(screen.getByRole('button', { name: /select all/i }));
		expect(screen.getByRole('button', { name: /deselect all/i })).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /deselect all/i }));
		expect(screen.getByRole('button', { name: /add 0 files/i })).toHaveTextContent('0 tasks');

		fireEvent.click(screen.getByText('gamma.md'));
		fireEvent.click(screen.getByRole('button', { name: /add 1 file/i }));

		expect(screen.queryByText('alpha.md')).not.toBeInTheDocument();
		expect(screen.getByText('gamma.md')).toBeInTheDocument();
		expect(screen.getByText('0 tasks')).toBeInTheDocument();
	});

	it('handles tree selection, folder totals, loading labels, and refresh count messages', async () => {
		vi.useFakeTimers();
		const onRefreshDocuments = vi.fn();
		const documentTree: DocTreeNode[] = [
			{
				name: 'folder',
				type: 'folder',
				path: 'folder',
				children: [
					{ name: 'plan', type: 'file', path: 'folder/plan' },
					{ name: 'check', type: 'file', path: 'folder/check' },
				],
			},
		];

		renderDocumentsPanel({
			initialAllDocuments: ['folder/plan', 'folder/check'],
			documentTree,
			loadingTaskCounts: true,
			refreshDocuments: ['folder/plan', 'folder/check', 'folder/new'],
			onRefreshDocuments,
		});

		fireEvent.click(screen.getByRole('button', { name: /add docs/i }));
		expect(screen.getAllByText('...').length).toBeGreaterThan(0);
		await act(async () => {
			fireEvent.click(screen.getByTitle('Refresh document list'));
			await Promise.resolve();
		});

		expect(onRefreshDocuments).toHaveBeenCalledTimes(1);
		await act(async () => {
			await Promise.resolve();
			vi.advanceTimersByTime(500);
		});
		expect(screen.getByText('Found 1 new document')).toBeInTheDocument();

		fireEvent.click(screen.getByTestId('chevronright-icon').closest('button')!);
		expect(screen.getByText('plan.md')).toBeInTheDocument();
		expect(screen.getByText('check.md')).toBeInTheDocument();

		fireEvent.click(screen.getByText('check.md'));
		expect(screen.getByRole('button', { name: /add 1 file/i })).toHaveTextContent('...');

		fireEvent.click(screen.getByText('folder'));
		expect(screen.getByRole('button', { name: /add 2 files/i })).toHaveTextContent('...');

		fireEvent.click(screen.getByRole('button', { name: /add 2 files/i }));
		expect(screen.getByText('folder/plan.md')).toBeInTheDocument();
		expect(screen.getByText('folder/check.md')).toBeInTheDocument();
	});

	it('deselects selected folders, handles empty tree nodes, and reports removed documents', async () => {
		vi.useFakeTimers();
		const onRefreshDocuments = vi.fn();
		const documentTree: DocTreeNode[] = [
			{
				name: 'folder',
				type: 'folder',
				path: 'folder',
				children: [
					{ name: 'plan', type: 'file', path: 'folder/plan' },
					{ name: 'check', type: 'file', path: 'folder/check' },
				],
			},
			{ name: 'empty', type: 'folder', path: 'empty' },
			{
				name: 'untallied',
				type: 'folder',
				path: 'untallied',
				children: [{ name: 'missing-count', type: 'file', path: 'untallied/missing-count' }],
			},
		];

		renderDocumentsPanel({
			initialDocuments: [doc('plan-1', 'folder/plan'), doc('check-1', 'folder/check')],
			initialAllDocuments: ['folder/plan', 'folder/check', 'untallied/missing-count'],
			documentTree,
			taskCounts: { 'folder/plan': 1, 'folder/check': 0 },
			refreshDocuments: ['folder/plan'],
			onRefreshDocuments,
		});

		fireEvent.click(screen.getByRole('button', { name: /add docs/i }));
		expect(screen.getByText('empty')).toBeInTheDocument();
		expect(screen.getByText('0 files')).toBeInTheDocument();
		expect(screen.getAllByText('0 tasks').length).toBeGreaterThan(0);

		const folderChevron = screen.getAllByTestId('chevronright-icon')[0].closest('button')!;
		fireEvent.click(folderChevron);
		expect(screen.getByText('plan.md')).toBeInTheDocument();
		fireEvent.click(screen.getByTestId('chevrondown-icon').closest('button')!);
		expect(screen.queryByText('plan.md')).not.toBeInTheDocument();

		fireEvent.click(screen.getByText('folder'));
		expect(screen.getByRole('button', { name: /add 0 files/i })).toHaveTextContent('0 tasks');

		await act(async () => {
			fireEvent.click(screen.getByTitle('Refresh document list'));
			await Promise.resolve();
		});
		await act(async () => {
			await Promise.resolve();
			vi.advanceTimersByTime(500);
		});
		expect(onRefreshDocuments).toHaveBeenCalledTimes(1);
		expect(screen.getByText('2 documents removed')).toBeInTheDocument();

		await act(async () => {
			vi.advanceTimersByTime(3000);
		});
		expect(screen.queryByText('2 documents removed')).not.toBeInTheDocument();
	});

	it('renders empty and loading selector fallbacks', () => {
		renderDocumentsPanel({
			initialAllDocuments: [],
			loadingTaskCounts: true,
		});

		fireEvent.click(screen.getByRole('button', { name: /add docs/i }));
		expect(screen.getByText('No documents found in folder')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /add 0 files/i })).toHaveTextContent('...');

		cleanup();

		renderDocumentsPanel({
			initialAllDocuments: ['alpha'],
			loadingTaskCounts: true,
		});

		fireEvent.click(screen.getByRole('button', { name: /add docs/i }));
		expect(screen.getAllByText('...').length).toBeGreaterThan(0);

		cleanup();

		renderDocumentsPanel({
			initialAllDocuments: ['delta'],
			taskCounts: {},
		});

		fireEvent.click(screen.getByRole('button', { name: /add docs/i }));
		expect(screen.getByText('delta.md')).toBeInTheDocument();
		expect(screen.getAllByText('0 tasks').length).toBeGreaterThan(0);
	});

	it('covers selector task fallback counts and refresh pluralization', async () => {
		vi.useFakeTimers();
		const onRefreshDocuments = vi.fn();
		const documentTree: DocTreeNode[] = [
			{
				name: 'untallied',
				type: 'folder',
				path: 'untallied',
				children: [{ name: 'missing-count', type: 'file', path: 'untallied/missing-count' }],
			},
		];

		renderDocumentsPanel({
			initialDocuments: [doc('alpha-1', 'alpha')],
			initialAllDocuments: ['alpha', 'untallied/missing-count'],
			documentTree,
			taskCounts: {},
			refreshDocuments: ['alpha', 'untallied/missing-count', 'new-one', 'new-two'],
			onRefreshDocuments,
		});

		fireEvent.click(screen.getByRole('button', { name: /add docs/i }));
		expect(screen.getAllByText('0 tasks').length).toBeGreaterThan(0);
		fireEvent.click(screen.getByTestId('chevronright-icon').closest('button')!);
		expect(screen.getByText('missing-count.md')).toBeInTheDocument();
		fireEvent.click(screen.getByText('missing-count.md'));
		expect(screen.getByRole('button', { name: /add 2 files/i })).toHaveTextContent('0 tasks');
		fireEvent.click(screen.getByRole('button', { name: /add 2 files/i }));
		expect(screen.getByText('untallied/missing-count.md')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /add docs/i }));
		fireEvent.click(screen.getByRole('button', { name: /add 2 files/i }));
		expect(screen.getByText('alpha.md')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /add docs/i }));
		await act(async () => {
			fireEvent.click(screen.getByTitle('Refresh document list'));
			await Promise.resolve();
		});
		await act(async () => {
			await Promise.resolve();
			vi.advanceTimersByTime(500);
		});
		expect(onRefreshDocuments).toHaveBeenCalledTimes(1);
		expect(screen.getByText('Found 2 new documents')).toBeInTheDocument();

		cleanup();

		renderDocumentsPanel({
			initialAllDocuments: ['alpha', 'beta'],
			refreshDocuments: ['alpha'],
		});

		fireEvent.click(screen.getByRole('button', { name: /add docs/i }));
		await act(async () => {
			fireEvent.click(screen.getByTitle('Refresh document list'));
			await Promise.resolve();
		});
		await act(async () => {
			await Promise.resolve();
			vi.advanceTimersByTime(500);
		});
		expect(screen.getByText('1 document removed')).toBeInTheDocument();
	});

	it('updates document rows, duplicate reset behavior, missing warnings, and loop controls', () => {
		renderDocumentsPanel({
			initialDocuments: [
				doc('alpha-1', 'alpha'),
				doc('beta-1', 'beta', { resetOnCompletion: true }),
				doc('missing-1', 'missing', { isMissing: true }),
			],
			taskCounts: { alpha: 2, beta: 1, missing: 4 },
		});

		expect(
			screen.getByText('1 document no longer exists in the folder and will be skipped')
		).toBeInTheDocument();
		expect(
			screen.getByText('Total: 3 tasks across 2 available documents (1 missing)')
		).toBeInTheDocument();

		fireEvent.click(screen.getByTitle(/^Enable reset/));
		expect(screen.getAllByTitle('Duplicate document')).toHaveLength(2);

		fireEvent.click(screen.getAllByTitle('Duplicate document')[0]);
		expect(screen.getAllByText('alpha.md')).toHaveLength(2);

		fireEvent.click(screen.getAllByTitle(/Remove duplicates to disable/)[0]);
		expect(screen.getAllByText('alpha.md')).toHaveLength(2);

		fireEvent.click(screen.getByTitle('Remove missing document'));
		expect(screen.queryByText(/no longer exist/)).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /loop/i }));
		expect(screen.getByTitle('Loop forever until all tasks complete')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Set maximum loop iterations'));
		const slider = screen.getByRole('slider');
		expect(slider).toHaveValue('5');

		fireEvent.change(slider, { target: { value: '8' } });
		expect(slider).toHaveValue('8');

		fireEvent.click(screen.getByTitle('Loop forever until all tasks complete'));
		expect(screen.queryByRole('slider')).not.toBeInTheDocument();

		cleanup();

		renderDocumentsPanel({
			initialDocuments: [doc('alpha-1', 'alpha'), doc('beta-1', 'beta')],
			initialLoopEnabled: true,
			initialMaxLoops: 5,
		});

		const maxButton = screen.getByTitle('Set maximum loop iterations');
		fireEvent.click(maxButton);
		expect(screen.getByRole('slider')).toHaveValue('5');

		cleanup();

		renderDocumentsPanel({
			initialDocuments: [
				doc('alpha-1', 'alpha'),
				doc('missing-1', 'missing', { isMissing: true }),
				doc('gone-1', 'gone', { isMissing: true }),
			],
		});

		expect(
			screen.getByText('2 documents no longer exist in the folder and will be skipped')
		).toBeInTheDocument();
		expect(
			screen.getByText('Total: 2 tasks across 1 available document (2 missing)')
		).toBeInTheDocument();
	});

	it('moves and copies documents with drag and drop operations', async () => {
		renderDocumentsPanel({
			initialDocuments: [doc('alpha-1', 'alpha'), doc('beta-1', 'beta'), doc('gamma-1', 'gamma')],
		});

		const alphaRow = rowFor('alpha');
		const gammaRow = rowFor('gamma');
		const moveTransfer = dataTransfer();

		fireEvent.dragStart(alphaRow, { dataTransfer: moveTransfer, clientX: 10, clientY: 10 });
		fireEvent.dragOver(gammaRow, { dataTransfer: moveTransfer, clientY: 35 });
		fireEvent.drop(gammaRow, { dataTransfer: moveTransfer });

		await waitFor(() => {
			const names = screen.getAllByText(/^(alpha|beta|gamma)\.md$/).map((el) => el.textContent);
			expect(names).toEqual(['beta.md', 'gamma.md', 'alpha.md']);
		});

		const betaRow = rowFor('beta');
		const copyTransfer = dataTransfer();
		fireEvent(
			betaRow,
			withDragProperties(
				createEvent.dragStart(betaRow, {
					dataTransfer: copyTransfer,
				}),
				{ ctrlKey: true, clientX: 10, clientY: 10 }
			)
		);

		fireEvent(
			rowFor('alpha'),
			withDragProperties(
				createEvent.dragOver(rowFor('alpha'), {
					dataTransfer: copyTransfer,
				}),
				{ ctrlKey: true, clientX: 20, clientY: 5 }
			)
		);
		fireEvent.drop(rowFor('alpha'), {
			dataTransfer: copyTransfer,
		});

		await waitFor(() => {
			expect(screen.getAllByText('beta.md')).toHaveLength(2);
		});
		expect(screen.getAllByTitle(/Remove duplicates to disable/)).toHaveLength(2);
	});

	it('updates drag affordances and falls back to drag-end drop handling', async () => {
		renderDocumentsPanel({
			initialDocuments: [doc('alpha-1', 'alpha'), doc('beta-1', 'beta'), doc('gamma-1', 'gamma')],
		});

		const alphaRow = rowFor('alpha');
		const betaRow = rowFor('beta');
		const gammaRow = rowFor('gamma');
		const transfer = dataTransfer();

		fireEvent.dragOver(betaRow, { dataTransfer: transfer, clientY: 5 });
		fireEvent.dragLeave(betaRow);

		fireEvent.dragStart(alphaRow, { dataTransfer: transfer, clientX: 10, clientY: 10 });
		fireEvent(
			alphaRow,
			withDragProperties(createEvent.drag(alphaRow, { dataTransfer: transfer }), {
				metaKey: true,
				clientX: 25,
				clientY: 30,
			})
		);
		expect(document.querySelector('.fixed.pointer-events-none.z-\\[10001\\]')).not.toBeNull();
		fireEvent(
			alphaRow,
			withDragProperties(createEvent.drag(alphaRow, { dataTransfer: transfer }), {
				clientX: 0,
				clientY: 0,
			})
		);

		fireEvent.dragOver(alphaRow, { dataTransfer: transfer, clientY: 5 });

		fireEvent.dragOver(gammaRow, { dataTransfer: transfer, clientY: 35 });
		fireEvent.dragEnd(alphaRow);

		await waitFor(() => {
			const names = screen.getAllByText(/^(alpha|beta|gamma)\.md$/).map((el) => el.textContent);
			expect(names).toEqual(['beta.md', 'gamma.md', 'alpha.md']);
		});
		expect(document.querySelector('.fixed.pointer-events-none.z-\\[10001\\]')).toBeNull();

		const noTargetTransfer = dataTransfer();
		fireEvent.dragStart(rowFor('beta'), {
			dataTransfer: noTargetTransfer,
			clientX: 5,
			clientY: 5,
		});
		fireEvent.dragEnd(rowFor('beta'));
		await waitFor(() => {
			const names = screen.getAllByText(/^(alpha|beta|gamma)\.md$/).map((el) => el.textContent);
			expect(names).toEqual(['beta.md', 'gamma.md', 'alpha.md']);
		});

		const reverseTransfer = dataTransfer();
		fireEvent.dragStart(rowFor('alpha'), {
			dataTransfer: reverseTransfer,
			clientX: 10,
			clientY: 10,
		});
		const betaTarget = rowFor('beta');
		fireEvent(
			betaTarget,
			withDragProperties(createEvent.dragOver(betaTarget, { dataTransfer: reverseTransfer }), {
				clientY: 5,
			})
		);
		fireEvent.dragEnd(rowFor('alpha'));
		await waitFor(() => {
			const names = screen.getAllByText(/^(alpha|beta|gamma)\.md$/).map((el) => el.textContent);
			expect(names).toEqual(['alpha.md', 'beta.md', 'gamma.md']);
		});
	});
});
