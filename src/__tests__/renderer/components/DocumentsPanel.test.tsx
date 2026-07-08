import React, { useEffect, useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { DocumentsPanel, type DocTreeNode } from '../../../renderer/components/DocumentsPanel';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { BatchDocumentEntry, Theme } from '../../../renderer/types';

const theme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#181818',
		bgActivity: '#222222',
		textMain: '#ffffff',
		textDim: '#999999',
		accent: '#4f8cff',
		accentForeground: '#ffffff',
		border: '#333333',
		success: '#33cc88',
		warning: '#ffcc66',
		error: '#ff6666',
	},
};

const createDocument = (
	id: string,
	filename: string,
	overrides: Partial<BatchDocumentEntry> = {}
): BatchDocumentEntry => ({
	id,
	filename,
	resetOnCompletion: false,
	isDuplicate: false,
	...overrides,
});

interface HarnessProps {
	initialDocuments?: BatchDocumentEntry[];
	allDocuments?: string[];
	documentTree?: DocTreeNode[];
	taskCounts?: Record<string, number>;
	loadingTaskCounts?: boolean;
	initialLoopEnabled?: boolean;
	initialMaxLoops?: number | null;
	onDocumentsChange?: (documents: BatchDocumentEntry[]) => void;
	onRefreshDocuments?: () => Promise<void>;
}

function DocumentsPanelHarness({
	initialDocuments = [],
	allDocuments = ['alpha', 'beta', 'gamma'],
	documentTree,
	taskCounts = { alpha: 2, beta: 3, gamma: 0 },
	loadingTaskCounts = false,
	initialLoopEnabled = false,
	initialMaxLoops = null,
	onDocumentsChange,
	onRefreshDocuments = vi.fn().mockResolvedValue(undefined),
}: HarnessProps) {
	const [documents, setDocuments] = useState(initialDocuments);
	const [loopEnabled, setLoopEnabled] = useState(initialLoopEnabled);
	const [maxLoops, setMaxLoops] = useState<number | null>(initialMaxLoops);

	useEffect(() => {
		onDocumentsChange?.(documents);
	}, [documents, onDocumentsChange]);

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
				onRefreshDocuments={onRefreshDocuments}
			/>
		</LayerStackProvider>
	);
}

function getDraggableRow(title: string): HTMLElement {
	const row = screen.getByTitle(title).closest('[draggable="true"]');
	expect(row).toBeTruthy();
	return row as HTMLElement;
}

function setDropRect(element: HTMLElement, top: number, height: number) {
	element.getBoundingClientRect = () =>
		({
			top,
			bottom: top + height,
			left: 0,
			right: 200,
			width: 200,
			height,
			x: 0,
			y: top,
			toJSON: () => ({}),
		}) as DOMRect;
}

function dispatchDragEvent(
	element: HTMLElement,
	type: string,
	init: {
		clientX?: number;
		clientY?: number;
		ctrlKey?: boolean;
		metaKey?: boolean;
		dataTransfer?: { effectAllowed?: string; dropEffect?: string };
	} = {}
) {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, 'clientX', { value: init.clientX ?? 0 });
	Object.defineProperty(event, 'clientY', { value: init.clientY ?? 0 });
	Object.defineProperty(event, 'ctrlKey', { value: init.ctrlKey ?? false });
	Object.defineProperty(event, 'metaKey', { value: init.metaKey ?? false });
	Object.defineProperty(event, 'dataTransfer', {
		value: init.dataTransfer ?? { effectAllowed: '', dropEffect: '' },
	});
	fireEvent(element, event);
}

function getDropIndicators(): HTMLElement[] {
	return Array.from(document.querySelectorAll<HTMLElement>('div')).filter(
		(el) => el.className.includes('h-0.5') && el.className.includes('pointer-events-none')
	);
}

describe('DocumentsPanel', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('selects documents from the flat selector and removes deselected existing entries', async () => {
		const onDocumentsChange = vi.fn();
		render(
			<DocumentsPanelHarness
				initialDocuments={[createDocument('doc-alpha', 'alpha')]}
				onDocumentsChange={onDocumentsChange}
			/>
		);

		fireEvent.click(screen.getByText('Add Docs'));
		expect(screen.getByText('Select Documents')).toBeInTheDocument();
		expect(screen.getByText('5 tasks')).toBeInTheDocument();

		fireEvent.click(screen.getByText('Select All'));
		expect(screen.getByText('Deselect All')).toBeInTheDocument();

		fireEvent.click(screen.getByText('Deselect All'));
		fireEvent.click(screen.getByText('beta.md'));
		fireEvent.click(screen.getByRole('button', { name: /Add 1 file .* 3 tasks/ }));

		await waitFor(() => {
			expect(screen.queryByText('Select Documents')).not.toBeInTheDocument();
		});
		expect(screen.getByTitle('beta.md')).toBeInTheDocument();
		expect(screen.queryByTitle('alpha.md')).not.toBeInTheDocument();
		expect(onDocumentsChange).toHaveBeenLastCalledWith([
			expect.objectContaining({ filename: 'beta', resetOnCompletion: false }),
		]);
	});

	it('keeps existing selected docs and falls back to zero counts when task counts are missing', async () => {
		const onDocumentsChange = vi.fn();
		render(
			<DocumentsPanelHarness
				initialDocuments={[createDocument('doc-alpha', 'alpha')]}
				allDocuments={['alpha', 'delta']}
				taskCounts={{}}
				onDocumentsChange={onDocumentsChange}
			/>
		);

		fireEvent.click(screen.getByText('Add Docs'));

		expect(screen.getAllByText('0 tasks').length).toBeGreaterThan(0);
		expect(screen.getByRole('button', { name: /Add 1 file .* 0 tasks/ })).toBeInTheDocument();
		expect(screen.getByText('delta.md')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Add 1 file .* 0 tasks/ }));

		await waitFor(() => {
			expect(onDocumentsChange).toHaveBeenLastCalledWith([
				expect.objectContaining({ filename: 'alpha' }),
			]);
		});
	});

	it('selects nested documents through the tree selector folder controls', async () => {
		const onDocumentsChange = vi.fn();
		const documentTree: DocTreeNode[] = [
			{
				name: 'Specs',
				type: 'folder',
				path: 'Specs',
				children: [
					{ name: 'Plan', type: 'file', path: 'Specs/Plan' },
					{ name: 'Review', type: 'file', path: 'Specs/Review' },
				],
			},
			{
				name: 'Empty',
				type: 'folder',
				path: 'Empty',
			},
		];

		render(
			<DocumentsPanelHarness
				initialDocuments={[]}
				allDocuments={['Specs/Plan', 'Specs/Review']}
				documentTree={documentTree}
				taskCounts={{ 'Specs/Plan': 1, 'Specs/Review': 2 }}
				onDocumentsChange={onDocumentsChange}
			/>
		);

		fireEvent.click(screen.getByText('Add Docs'));

		const folderButton = screen.getByText('Specs').closest('button')!;
		const expandButton = folderButton.previousElementSibling as HTMLElement;
		fireEvent.click(expandButton);
		expect(screen.getByText('Plan.md')).toBeInTheDocument();

		fireEvent.click(screen.getByText('Plan.md'));
		expect(screen.getByRole('button', { name: /Add 1 file .* 1 task/ })).toBeInTheDocument();
		fireEvent.click(screen.getByText('Plan.md'));
		expect(screen.getByRole('button', { name: /Add 0 files .* 0 tasks/ })).toBeInTheDocument();
		fireEvent.click(screen.getByText('Plan.md'));

		fireEvent.click(expandButton);
		expect(screen.queryByText('Plan.md')).not.toBeInTheDocument();
		fireEvent.click(expandButton);

		fireEvent.click(folderButton);
		fireEvent.click(folderButton);
		expect(screen.getByRole('button', { name: /Add 0 files .* 0 tasks/ })).toBeInTheDocument();
		fireEvent.click(folderButton);
		fireEvent.click(screen.getByRole('button', { name: /Add 2 files .* 3 tasks/ }));

		await waitFor(() => {
			expect(onDocumentsChange).toHaveBeenLastCalledWith([
				expect.objectContaining({ filename: 'Specs/Plan' }),
				expect.objectContaining({ filename: 'Specs/Review' }),
			]);
		});
	});

	it('renders tree selector count fallbacks, singular labels, and loading badges', async () => {
		const documentTree: DocTreeNode[] = [
			{
				name: 'Solo',
				type: 'folder',
				path: 'Solo',
				children: [{ name: 'Only', type: 'file', path: 'Solo/Only' }],
			},
			{
				name: 'Mixed',
				type: 'folder',
				path: 'Mixed',
				children: [
					{ name: 'Known', type: 'file', path: 'Mixed/Known' },
					{ name: 'MissingCount', type: 'file', path: 'Mixed/MissingCount' },
				],
			},
		];

		const firstRender = render(
			<DocumentsPanelHarness
				initialDocuments={[]}
				allDocuments={['Solo/Only', 'Mixed/Known', 'Mixed/MissingCount']}
				documentTree={documentTree}
				taskCounts={{ 'Solo/Only': 1, 'Mixed/Known': 1 }}
			/>
		);

		fireEvent.click(screen.getByText('Add Docs'));
		fireEvent.click(
			screen.getByText('Solo').closest('button')!.previousElementSibling as HTMLElement
		);
		fireEvent.click(
			screen.getByText('Mixed').closest('button')!.previousElementSibling as HTMLElement
		);

		expect(screen.getByText('1 file')).toBeInTheDocument();
		expect(screen.getAllByText('1 task').length).toBeGreaterThan(0);
		expect(screen.getByText('MissingCount.md')).toBeInTheDocument();
		expect(screen.getAllByText('0 tasks').length).toBeGreaterThan(0);

		firstRender.unmount();

		render(
			<DocumentsPanelHarness
				initialDocuments={[]}
				allDocuments={['Solo/Only']}
				documentTree={documentTree.slice(0, 1)}
				taskCounts={{}}
				loadingTaskCounts
			/>
		);
		fireEvent.click(screen.getByText('Add Docs'));
		fireEvent.click(
			screen.getByText('Solo').closest('button')!.previousElementSibling as HTMLElement
		);
		expect(screen.getAllByText('...').length).toBeGreaterThan(0);
	});

	it('handles reset, duplicate, missing document, and loop controls', async () => {
		render(
			<DocumentsPanelHarness
				initialDocuments={[
					createDocument('doc-alpha', 'alpha', { resetOnCompletion: true }),
					createDocument('doc-beta', 'beta'),
					createDocument('doc-missing', 'missing', { isMissing: true }),
				]}
				taskCounts={{ alpha: 2, beta: 0, missing: 9 }}
			/>
		);

		expect(screen.getByText(/1 document no longer exists in the folder/)).toBeInTheDocument();
		expect(
			screen.getByText(/Total: 2 tasks across 2 available documents \(1 missing\)/)
		).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Duplicate document'));
		expect(screen.getAllByTitle('alpha.md')).toHaveLength(2);
		expect(screen.getAllByTitle(/Remove duplicates to disable/)).toHaveLength(2);

		fireEvent.click(screen.getByTitle('Loop back to first document when finished'));
		expect(screen.getByTitle('Loop forever until all tasks complete')).toBeInTheDocument();
		fireEvent.click(screen.getByTitle('Set maximum loop iterations'));

		const slider = screen.getByRole('slider');
		fireEvent.change(slider, { target: { value: '9' } });
		expect(screen.getByText('9')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Loop forever until all tasks complete'));
		expect(screen.queryByRole('slider')).not.toBeInTheDocument();
	});

	it('shows loading totals and plural missing warnings with one available document', () => {
		render(
			<DocumentsPanelHarness
				initialDocuments={[
					createDocument('doc-alpha', 'alpha'),
					createDocument('doc-missing-1', 'missing-one', { isMissing: true }),
					createDocument('doc-missing-2', 'missing-two', { isMissing: true }),
				]}
				taskCounts={{}}
				loadingTaskCounts
			/>
		);

		expect(screen.getByText(/2 documents no longer exist in the folder/)).toBeInTheDocument();
		expect(
			screen.getByText(/Total: \.\.\. tasks across 1 available document \(2 missing\)/)
		).toBeInTheDocument();
		expect(screen.getAllByText('...').length).toBeGreaterThan(0);
		expect(screen.getAllByTitle('Remove missing document')).toHaveLength(2);
	});

	it('does not reset max loop count when max mode is already active', () => {
		render(
			<DocumentsPanelHarness
				initialDocuments={[
					createDocument('doc-alpha', 'alpha'),
					createDocument('doc-beta', 'beta'),
				]}
				initialLoopEnabled
				initialMaxLoops={7}
			/>
		);

		const slider = screen.getByRole('slider');
		expect(slider).toHaveValue('7');

		fireEvent.click(screen.getByTitle('Set maximum loop iterations'));

		expect(screen.getByRole('slider')).toHaveValue('7');
	});

	it('shows document refresh count changes after the selector refresh delay', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });

		function RefreshHarness() {
			const [allDocuments, setAllDocuments] = useState(['alpha']);
			return (
				<DocumentsPanelHarness
					initialDocuments={[]}
					allDocuments={allDocuments}
					taskCounts={{ alpha: 1, beta: 2 }}
					onRefreshDocuments={vi.fn().mockImplementation(async () => {
						setAllDocuments(['alpha', 'beta']);
					})}
				/>
			);
		}

		render(<RefreshHarness />);
		fireEvent.click(screen.getByText('Add Docs'));
		fireEvent.click(screen.getByTitle('Refresh document list'));

		await act(async () => {
			await Promise.resolve();
			vi.advanceTimersByTime(500);
		});

		expect(screen.getByText('Found 1 new document')).toBeInTheDocument();

		await act(async () => {
			vi.runOnlyPendingTimers();
			await Promise.resolve();
		});

		await waitFor(() => {
			expect(screen.queryByText('Found 1 new document')).not.toBeInTheDocument();
		});
	});

	it('shows plural refresh messages for added and removed documents', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });

		function AddedHarness() {
			const [allDocuments, setAllDocuments] = useState(['alpha']);
			return (
				<DocumentsPanelHarness
					initialDocuments={[]}
					allDocuments={allDocuments}
					onRefreshDocuments={vi.fn().mockImplementation(async () => {
						setAllDocuments(['alpha', 'beta', 'gamma']);
					})}
				/>
			);
		}

		const added = render(<AddedHarness />);
		fireEvent.click(screen.getByText('Add Docs'));
		fireEvent.click(screen.getByTitle('Refresh document list'));
		await act(async () => {
			await Promise.resolve();
			vi.advanceTimersByTime(500);
		});
		expect(screen.getByText('Found 2 new documents')).toBeInTheDocument();
		added.unmount();

		function RemovedHarness() {
			const [allDocuments, setAllDocuments] = useState(['alpha', 'beta', 'gamma']);
			return (
				<DocumentsPanelHarness
					initialDocuments={[]}
					allDocuments={allDocuments}
					onRefreshDocuments={vi.fn().mockImplementation(async () => {
						setAllDocuments(['alpha']);
					})}
				/>
			);
		}

		render(<RemovedHarness />);
		fireEvent.click(screen.getByText('Add Docs'));
		fireEvent.click(screen.getByTitle('Refresh document list'));
		await act(async () => {
			await Promise.resolve();
			vi.advanceTimersByTime(500);
		});
		expect(screen.getByText('2 documents removed')).toBeInTheDocument();
	});

	it('closes the selector from cancel, overlay, close button, and escape paths', async () => {
		render(<DocumentsPanelHarness initialDocuments={[]} />);

		fireEvent.click(screen.getByText('Add Docs'));
		fireEvent.click(screen.getByText('Cancel'));
		await waitFor(() => {
			expect(screen.queryByText('Select Documents')).not.toBeInTheDocument();
		});

		fireEvent.click(screen.getByText('Add Docs'));
		fireEvent.click(screen.getByLabelText('Close document selector'));
		await waitFor(() => {
			expect(screen.queryByText('Select Documents')).not.toBeInTheDocument();
		});

		fireEvent.click(screen.getByText('Add Docs'));
		const headerActions = screen.getByText('Select Documents').parentElement!.nextElementSibling!;
		fireEvent.click(headerActions.querySelectorAll('button')[2]);
		await waitFor(() => {
			expect(screen.queryByText('Select Documents')).not.toBeInTheDocument();
		});

		fireEvent.click(screen.getByText('Add Docs'));
		fireEvent.keyDown(document, { key: 'Escape' });
		await waitFor(() => {
			expect(screen.queryByText('Select Documents')).not.toBeInTheDocument();
		});
	});

	it('shows empty and loading selector states and removed-document refresh messages', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });

		function RefreshRemovedHarness() {
			const [allDocuments, setAllDocuments] = useState(['alpha', 'beta']);
			return (
				<DocumentsPanelHarness
					initialDocuments={[]}
					allDocuments={allDocuments}
					taskCounts={{ alpha: 1, beta: 0 }}
					loadingTaskCounts
					onRefreshDocuments={vi.fn().mockImplementation(async () => {
						setAllDocuments(['alpha']);
					})}
				/>
			);
		}

		const emptyRender = render(
			<DocumentsPanelHarness initialDocuments={[]} allDocuments={[]} loadingTaskCounts />
		);
		fireEvent.click(screen.getByText('Add Docs'));
		expect(screen.getByText('No documents found in folder')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Add 0 files .* \.\.\./ })).toBeInTheDocument();

		fireEvent.click(screen.getByText('Cancel'));
		emptyRender.unmount();

		render(<RefreshRemovedHarness />);
		fireEvent.click(screen.getByText('Add Docs'));
		expect(screen.getAllByText('...').length).toBeGreaterThan(0);
		fireEvent.click(screen.getByTitle('Refresh document list'));

		await act(async () => {
			await Promise.resolve();
			vi.advanceTimersByTime(500);
		});

		expect(screen.getByText('1 document removed')).toBeInTheDocument();
	});

	it('removes documents, toggles reset state, and keeps duplicate reset locked', async () => {
		const onDocumentsChange = vi.fn();
		render(
			<DocumentsPanelHarness
				initialDocuments={[
					createDocument('doc-alpha', 'alpha'),
					createDocument('doc-beta', 'beta', { resetOnCompletion: true }),
				]}
				onDocumentsChange={onDocumentsChange}
			/>
		);

		fireEvent.click(screen.getByTitle(/Enable reset/));
		expect(onDocumentsChange).toHaveBeenLastCalledWith([
			expect.objectContaining({ filename: 'alpha', resetOnCompletion: true }),
			expect.objectContaining({ filename: 'beta', resetOnCompletion: true }),
		]);

		fireEvent.click(screen.getAllByTitle('Duplicate document')[0]);
		expect(screen.getAllByTitle('alpha.md')).toHaveLength(2);

		fireEvent.click(screen.getAllByTitle(/Remove duplicates to disable/)[0]);
		expect(onDocumentsChange).toHaveBeenLastCalledWith([
			expect.objectContaining({ filename: 'alpha', resetOnCompletion: true }),
			expect.objectContaining({ filename: 'alpha', resetOnCompletion: true, isDuplicate: true }),
			expect.objectContaining({ filename: 'beta', resetOnCompletion: true }),
		]);

		const betaRemoveButton = screen
			.getByTitle('beta.md')
			.closest('[draggable="true"]')!
			.querySelector('[title="Remove document"]')!;
		fireEvent.click(betaRemoveButton);
		expect(screen.queryByTitle('beta.md')).not.toBeInTheDocument();
	});

	it('ignores duplicate requests when parent state no longer contains the document', () => {
		const renderedDocuments = [
			createDocument('doc-alpha', 'alpha', { resetOnCompletion: true }),
			createDocument('doc-beta', 'beta'),
		];
		const latestParentDocuments = [createDocument('doc-beta', 'beta')];
		const setDocuments = vi.fn((updater: React.SetStateAction<BatchDocumentEntry[]>) => {
			const nextDocuments =
				typeof updater === 'function' ? updater(latestParentDocuments) : updater;
			expect(nextDocuments).toBe(latestParentDocuments);
		}) as React.Dispatch<React.SetStateAction<BatchDocumentEntry[]>>;

		render(
			<LayerStackProvider>
				<DocumentsPanel
					theme={theme}
					documents={renderedDocuments}
					setDocuments={setDocuments}
					taskCounts={{ alpha: 2, beta: 3 }}
					loadingTaskCounts={false}
					loopEnabled={false}
					setLoopEnabled={vi.fn()}
					maxLoops={null}
					setMaxLoops={vi.fn()}
					allDocuments={['alpha', 'beta']}
					onRefreshDocuments={vi.fn().mockResolvedValue(undefined)}
				/>
			</LayerStackProvider>
		);

		fireEvent.click(screen.getByTitle('Duplicate document'));

		expect(setDocuments).toHaveBeenCalledTimes(1);
	});

	it('ignores stale drop operations for documents removed mid-interaction', async () => {
		const onDocumentsChange = vi.fn();
		render(
			<DocumentsPanelHarness
				initialDocuments={[
					createDocument('doc-alpha', 'alpha', { resetOnCompletion: true }),
					createDocument('doc-beta', 'beta'),
				]}
				onDocumentsChange={onDocumentsChange}
			/>
		);

		const alphaRow = getDraggableRow('alpha.md');
		const alphaRemoveButton = screen.getAllByTitle('Remove document')[0];

		dispatchDragEvent(alphaRow, 'dragstart', {
			clientX: 5,
			clientY: 5,
			dataTransfer: { effectAllowed: '', dropEffect: '' },
		});
		fireEvent.click(alphaRemoveButton);

		const betaRow = getDraggableRow('beta.md');
		setDropRect(betaRow, 0, 20);
		dispatchDragEvent(betaRow, 'dragover', {
			clientY: 15,
			dataTransfer: { dropEffect: '' },
		});
		dispatchDragEvent(betaRow, 'drop', { dataTransfer: {} });

		expect(screen.queryByTitle('alpha.md')).not.toBeInTheDocument();
		expect(screen.getByTitle('beta.md')).toBeInTheDocument();
		expect(onDocumentsChange).toHaveBeenLastCalledWith([
			expect.objectContaining({ filename: 'beta' }),
		]);
	});

	it('reorders documents by drag/drop and copies documents with modifier drag', async () => {
		const onDocumentsChange = vi.fn();
		render(
			<DocumentsPanelHarness
				initialDocuments={[
					createDocument('doc-alpha', 'alpha'),
					createDocument('doc-beta', 'beta'),
					createDocument('doc-gamma', 'gamma'),
				]}
				onDocumentsChange={onDocumentsChange}
			/>
		);

		const alphaRow = getDraggableRow('alpha.md');
		const gammaRow = getDraggableRow('gamma.md');
		setDropRect(gammaRow, 0, 20);

		fireEvent.dragStart(alphaRow, {
			clientX: 5,
			clientY: 5,
			dataTransfer: { effectAllowed: '', dropEffect: '' },
		});
		fireEvent.drag(gammaRow, { clientX: 10, clientY: 12, dataTransfer: {} });
		fireEvent.dragOver(gammaRow, {
			clientY: 15,
			dataTransfer: { dropEffect: '' },
		});
		fireEvent.drop(gammaRow, { dataTransfer: {} });

		expect(onDocumentsChange).toHaveBeenLastCalledWith([
			expect.objectContaining({ filename: 'beta' }),
			expect.objectContaining({ filename: 'gamma' }),
			expect.objectContaining({ filename: 'alpha' }),
		]);

		const betaRow = getDraggableRow('beta.md');
		const reorderedGammaRow = getDraggableRow('gamma.md');
		setDropRect(reorderedGammaRow, 0, 20);

		dispatchDragEvent(betaRow, 'dragstart', {
			clientX: 5,
			clientY: 5,
			ctrlKey: true,
			dataTransfer: { effectAllowed: '', dropEffect: '' },
		});
		dispatchDragEvent(betaRow, 'drag', {
			clientX: 14,
			clientY: 18,
			ctrlKey: true,
			dataTransfer: {},
		});
		dispatchDragEvent(reorderedGammaRow, 'dragover', {
			clientY: 5,
			ctrlKey: true,
			dataTransfer: { dropEffect: '' },
		});
		await waitFor(() => {
			expect(document.querySelector('.fixed.pointer-events-none')).toBeInTheDocument();
		});
		dispatchDragEvent(reorderedGammaRow, 'drop', { dataTransfer: {} });

		expect(onDocumentsChange).toHaveBeenLastCalledWith([
			expect.objectContaining({ filename: 'beta', resetOnCompletion: true }),
			expect.objectContaining({ filename: 'beta', resetOnCompletion: true, isDuplicate: true }),
			expect.objectContaining({ filename: 'gamma' }),
			expect.objectContaining({ filename: 'alpha' }),
		]);
	});

	it('ignores dragover before drag start and keeps the drop indicator through dragleave', async () => {
		render(
			<DocumentsPanelHarness
				initialDocuments={[
					createDocument('doc-alpha', 'alpha'),
					createDocument('doc-beta', 'beta'),
				]}
			/>
		);

		const alphaRow = getDraggableRow('alpha.md');
		const betaRow = getDraggableRow('beta.md');
		const list = alphaRow.parentElement!.parentElement as HTMLElement;
		setDropRect(betaRow, 0, 20);

		fireEvent.dragOver(betaRow, {
			clientY: 5,
			dataTransfer: { dropEffect: '' },
		});
		expect(getDropIndicators()).toHaveLength(0);

		fireEvent.dragStart(alphaRow, {
			clientX: 5,
			clientY: 5,
			dataTransfer: { effectAllowed: '', dropEffect: '' },
		});
		fireEvent.dragOver(betaRow, {
			clientY: 5,
			dataTransfer: { dropEffect: '' },
		});

		await waitFor(() => {
			expect(getDropIndicators().length).toBeGreaterThan(0);
		});

		fireEvent.dragLeave(list);
		expect(getDropIndicators().length).toBeGreaterThan(0);

		fireEvent.dragEnd(alphaRow);
	});

	it('handles same-position dragovers, dragend fallback, and upward moves', async () => {
		const onDocumentsChange = vi.fn();
		render(
			<DocumentsPanelHarness
				initialDocuments={[
					createDocument('doc-alpha', 'alpha'),
					createDocument('doc-beta', 'beta'),
					createDocument('doc-gamma', 'gamma'),
				]}
				onDocumentsChange={onDocumentsChange}
			/>
		);

		const alphaRow = getDraggableRow('alpha.md');
		setDropRect(alphaRow, 0, 20);
		dispatchDragEvent(alphaRow, 'dragstart', {
			clientX: 0,
			clientY: 0,
			dataTransfer: { effectAllowed: '', dropEffect: '' },
		});
		dispatchDragEvent(alphaRow, 'drag', { metaKey: true, dataTransfer: {} });
		dispatchDragEvent(alphaRow, 'dragover', { clientY: 5, dataTransfer: { dropEffect: '' } });
		expect(getDropIndicators()).toHaveLength(0);
		dispatchDragEvent(alphaRow, 'dragend', { dataTransfer: {} });

		const gammaRow = getDraggableRow('gamma.md');
		setDropRect(alphaRow, 0, 20);
		dispatchDragEvent(gammaRow, 'dragstart', {
			clientX: 5,
			clientY: 5,
			dataTransfer: { effectAllowed: '', dropEffect: '' },
		});
		dispatchDragEvent(alphaRow, 'dragover', { clientY: 5, dataTransfer: { dropEffect: '' } });

		await waitFor(() => {
			expect(getDropIndicators().length).toBeGreaterThan(0);
		});
		expect(getDropIndicators()[0]).toHaveStyle({ backgroundColor: theme.colors.accent });

		dispatchDragEvent(alphaRow, 'drop', { dataTransfer: {} });

		expect(onDocumentsChange).toHaveBeenLastCalledWith([
			expect.objectContaining({ filename: 'gamma' }),
			expect.objectContaining({ filename: 'alpha' }),
			expect.objectContaining({ filename: 'beta' }),
		]);
	});

	it('shows copy-colored drop indicators after the last document', async () => {
		render(
			<DocumentsPanelHarness
				initialDocuments={[
					createDocument('doc-alpha', 'alpha'),
					createDocument('doc-beta', 'beta'),
				]}
			/>
		);

		const alphaRow = getDraggableRow('alpha.md');
		const betaRow = getDraggableRow('beta.md');
		setDropRect(betaRow, 0, 20);

		dispatchDragEvent(alphaRow, 'dragstart', {
			clientX: 5,
			clientY: 5,
			metaKey: true,
			dataTransfer: { effectAllowed: '', dropEffect: '' },
		});
		dispatchDragEvent(betaRow, 'dragover', {
			clientY: 15,
			metaKey: true,
			dataTransfer: { dropEffect: '' },
		});

		await waitFor(() => {
			expect(getDropIndicators().length).toBeGreaterThan(0);
		});
		expect(getDropIndicators()[0]).toHaveStyle({ backgroundColor: theme.colors.success });
	});
});
