import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DocumentSelectorModal } from '../../../../../renderer/components/DocumentsPanel/components/DocumentSelectorModal';
import type { DocTreeNode } from '../../../../../renderer/components/DocumentsPanel';
import { LayerStackProvider } from '../../../../../renderer/contexts/LayerStackContext';
import type { BatchDocumentEntry } from '../../../../../renderer/types';
import { mockTheme } from '../../../../helpers/mockTheme';

const documents: BatchDocumentEntry[] = [{ id: '1', filename: 'alpha', resetOnCompletion: false }];

const tree: DocTreeNode[] = [
	{
		name: 'folder',
		type: 'folder',
		path: 'folder',
		children: [{ name: 'nested', type: 'file', path: 'folder/nested' }],
	},
];

function renderModal(overrides = {}) {
	const props = {
		theme: mockTheme,
		allDocuments: ['alpha', 'beta'],
		taskCounts: { alpha: 2, beta: 0, 'folder/nested': 3 },
		loadingTaskCounts: false,
		documents,
		onClose: vi.fn(),
		onAdd: vi.fn(),
		onRefresh: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
	render(
		<LayerStackProvider>
			<DocumentSelectorModal {...props} />
		</LayerStackProvider>
	);
	return props;
}

describe('DocumentSelectorModal', () => {
	it('renders flat documents, counts, and add footer', () => {
		const props = renderModal();
		const dialog = screen.getByRole('dialog');

		expect(screen.getByText('Select Documents')).toBeInTheDocument();
		expect(dialog).toHaveAttribute('aria-modal', 'true');
		expect(dialog).toHaveClass('select-none');
		expect(screen.getAllByText('2 tasks').length).toBeGreaterThan(0);
		expect(screen.getByText('alpha.md')).toBeInTheDocument();
		expect(screen.getByText('beta.md')).toBeInTheDocument();

		fireEvent.click(screen.getByText('beta.md'));
		fireEvent.click(screen.getByRole('button', { name: /Add 2 files/ }));

		expect(props.onAdd).toHaveBeenCalledWith(new Set(['alpha', 'beta']));
	});

	it('renders tree folders and toggles nested files', () => {
		renderModal({ allDocuments: ['folder/nested'], documentTree: tree, documents: [] });

		expect(screen.getByText('folder')).toBeInTheDocument();
		expect(screen.queryByText('nested.md')).not.toBeInTheDocument();

		const expandButton = screen.getByRole('button', { name: 'Expand folder folder' });
		expect(expandButton).toHaveAttribute('aria-expanded', 'false');

		fireEvent.click(expandButton);
		expect(screen.getByRole('button', { name: 'Collapse folder folder' })).toHaveAttribute(
			'aria-expanded',
			'true'
		);
		expect(screen.getByText('nested.md')).toBeInTheDocument();
		expect(screen.getAllByText('3 tasks').length).toBeGreaterThan(0);
	});

	it('shows empty state and closes from footer cancel and Escape', async () => {
		const props = renderModal({ allDocuments: [], documents: [] });

		expect(screen.getByText('No documents found in folder')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(props.onClose).toHaveBeenCalledTimes(1);

		fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(2));
	});

	it('refreshes and closes on backdrop without closing for inner content clicks', () => {
		const props = renderModal();
		const modal = screen.getByText('Select Documents').closest('.fixed')!;
		const content = within(modal).getByText('alpha.md');

		fireEvent.click(content);
		expect(props.onClose).not.toHaveBeenCalled();

		fireEvent.click(screen.getByTitle('Refresh document list'));
		expect(props.onRefresh).toHaveBeenCalledTimes(1);

		fireEvent.click(modal);
		expect(props.onClose).toHaveBeenCalledTimes(1);
	});
});
