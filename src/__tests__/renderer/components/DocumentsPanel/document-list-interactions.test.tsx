// Source: src/__tests__/renderer/components/DocumentsPanel/DocumentsPanel.test.tsx
// Source: src/__tests__/renderer/components/DocumentsPanel/hooks/useDocumentListActions.test.tsx
import { fireEvent } from '@testing-library/react';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { waitFor } from '@testing-library/react';
import React from 'react';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { DocumentsPanel } from '../../../../renderer/components/DocumentsPanel';
import type { BatchDocumentEntry } from '../../../../renderer/types';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { mockTheme } from '../../../helpers/mockTheme';
import { act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { afterEach } from 'vitest';
import { beforeEach } from 'vitest';
import { useDocumentListActions } from '../../../../renderer/components/DocumentsPanel/hooks/useDocumentListActions';
import * as ids from '../../../../renderer/utils/ids';
describe('DocumentsPanel', () => {
	function TestHost({
		initialDocuments = [{ id: '1', filename: 'alpha', resetOnCompletion: false }],
	}: {
		initialDocuments?: BatchDocumentEntry[];
	}) {
		const [documents, setDocuments] = React.useState<BatchDocumentEntry[]>(initialDocuments);
		const [loopEnabled, setLoopEnabled] = React.useState(false);
		const [maxLoops, setMaxLoops] = React.useState<number | null>(null);

		return (
			<LayerStackProvider>
				<DocumentsPanel
					theme={mockTheme}
					documents={documents}
					setDocuments={setDocuments}
					taskCounts={{ alpha: 2, beta: 3 }}
					loadingTaskCounts={false}
					loopEnabled={loopEnabled}
					setLoopEnabled={setLoopEnabled}
					maxLoops={maxLoops}
					setMaxLoops={setMaxLoops}
					allDocuments={['alpha', 'beta']}
					onRefreshDocuments={vi.fn().mockResolvedValue(undefined)}
				/>
			</LayerStackProvider>
		);
	}

	describe('DocumentsPanel', () => {
		it('exports and renders the public component', () => {
			expect(DocumentsPanel).toBeDefined();
			render(<TestHost />);

			expect(screen.getByText('Documents to Run')).toBeInTheDocument();
			expect(screen.getByText('alpha.md')).toBeInTheDocument();
		});

		it('opens selector and adds newly selected documents', async () => {
			render(<TestHost />);

			fireEvent.click(screen.getByRole('button', { name: 'Add Docs' }));
			expect(screen.getByText('Select Documents')).toBeInTheDocument();

			fireEvent.click(screen.getByText('beta.md'));
			fireEvent.click(screen.getByRole('button', { name: /Add 2 files/ }));

			await waitFor(() => expect(screen.queryByText('Select Documents')).not.toBeInTheDocument());
			expect(screen.getByText('alpha.md')).toBeInTheDocument();
			expect(screen.getByText('beta.md')).toBeInTheDocument();
		});

		it('wires row actions and loop controls', () => {
			render(
				<TestHost
					initialDocuments={[
						{ id: '1', filename: 'alpha', resetOnCompletion: false },
						{ id: '2', filename: 'beta', resetOnCompletion: false },
					]}
				/>
			);

			fireEvent.click(screen.getAllByTitle(/Enable reset/)[0]);
			expect(screen.getByTitle(/Reset enabled/)).toBeInTheDocument();

			fireEvent.click(screen.getByText('Loop'));
			expect(screen.getByText('∞')).toBeInTheDocument();
			fireEvent.click(screen.getByText('max'));
			expect(screen.getByRole('slider')).toBeInTheDocument();
		});
	});
});
describe('useDocumentListActions', () => {
	const initialDocs: BatchDocumentEntry[] = [
		{ id: '1', filename: 'alpha', resetOnCompletion: false },
		{ id: '2', filename: 'beta', resetOnCompletion: true },
	];

	function setup(docs = initialDocs) {
		let currentDocs = docs;
		const setDocuments = vi.fn((next: React.SetStateAction<BatchDocumentEntry[]>) => {
			currentDocs = typeof next === 'function' ? next(currentDocs) : next;
		});
		const onAddComplete = vi.fn();
		const hook = renderHook(
			({ documents }) =>
				useDocumentListActions({
					documents,
					setDocuments,
					onAddComplete,
				}),
			{ initialProps: { documents: currentDocs } }
		);
		return {
			...hook,
			getDocs: () => currentDocs,
			setDocuments,
			onAddComplete,
			rerenderWithCurrent: () => hook.rerender({ documents: currentDocs }),
		};
	}

	describe('useDocumentListActions', () => {
		beforeEach(() => {
			vi.spyOn(ids, 'generateId').mockReturnValue('generated-id');
		});
		afterEach(() => vi.restoreAllMocks());
		beforeEach(() => {
			vi.clearAllMocks();
		});

		it('removes documents by id', () => {
			const { result, getDocs } = setup();

			act(() => result.current.handleRemoveDocument('1'));

			expect(getDocs()).toEqual([{ id: '2', filename: 'beta', resetOnCompletion: true }]);
		});

		it('toggles reset on completion', () => {
			const { result, getDocs } = setup();

			act(() => result.current.handleToggleReset('1'));

			expect(getDocs()[0].resetOnCompletion).toBe(true);
			expect(getDocs()[1].resetOnCompletion).toBe(true);
		});

		it('duplicates a document after the original with duplicate flags preserved', () => {
			const { result, getDocs } = setup();

			act(() => result.current.handleDuplicateDocument('2'));

			expect(getDocs()).toEqual([
				{ id: '1', filename: 'alpha', resetOnCompletion: false },
				{ id: '2', filename: 'beta', resetOnCompletion: true },
				{ id: 'generated-id', filename: 'beta', resetOnCompletion: true, isDuplicate: true },
			]);
		});

		it('filters removed selections and appends newly selected docs', () => {
			const { result, getDocs, onAddComplete } = setup();

			act(() => result.current.handleAddSelectedDocs(new Set(['beta', 'gamma'])));

			expect(getDocs()).toEqual([
				{ id: '2', filename: 'beta', resetOnCompletion: true },
				{ id: 'generated-id', filename: 'gamma', resetOnCompletion: false, isDuplicate: false },
			]);
			expect(onAddComplete).toHaveBeenCalledTimes(1);
		});
	});
});
