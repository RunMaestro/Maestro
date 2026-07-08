import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	AutoRunDocumentSelector,
	type DocTreeNode,
	type DocumentTaskCount,
} from '../../renderer/components/AutoRun/AutoRunDocumentSelector';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../renderer/types';

const theme: Theme = {
	id: 'integration-selector',
	name: 'Integration Selector',
	mode: 'dark',
	colors: {
		accent: '#4f46e5',
		accentDim: '#312e81',
		accentForeground: '#ffffff',
		accentText: '#a5b4fc',
		bgActivity: '#111827',
		bgMain: '#030712',
		bgSidebar: '#1f2937',
		border: '#374151',
		error: '#ef4444',
		success: '#22c55e',
		textDim: '#9ca3af',
		textMain: '#f9fafb',
		warning: '#f59e0b',
	},
};

const documentTree: DocTreeNode[] = [
	{
		name: 'specs',
		path: 'specs',
		type: 'folder',
		children: [
			{ name: 'phase-one', path: 'specs/phase-one', type: 'file' },
			{
				name: 'nested',
				path: 'specs/nested',
				type: 'folder',
				children: [{ name: 'deep-plan', path: 'specs/nested/deep-plan', type: 'file' }],
			},
		],
	},
	{ name: 'empty-folder', path: 'empty-folder', type: 'folder' },
	{ name: 'root-plan', path: 'root-plan', type: 'file' },
];

describe('AutoRunDocumentSelector integration', () => {
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it('opens the flat document menu, selects a document, and runs adjacent controls', () => {
		const onChangeFolder = vi.fn();
		const onRefresh = vi.fn();
		const onSelectDocument = vi.fn();
		const counts = new Map<string, DocumentTaskCount>([
			['alpha', { completed: 1, total: 2 }],
			['done', { completed: 4, total: 4 }],
		]);

		renderSelector({
			documentTaskCounts: counts,
			documents: ['alpha', 'beta', 'done'],
			onChangeFolder,
			onRefresh,
			onSelectDocument,
			selectedDocument: 'alpha',
		});

		expect(screen.getByRole('button', { name: /alpha\.md/i })).toHaveTextContent('alpha.md');
		fireEvent.click(screen.getByRole('button', { name: /alpha\.md/i }));

		expect(screen.getByText('beta.md')).toBeInTheDocument();
		expect(screen.getByText('50% (2)')).toBeInTheDocument();
		expect(screen.getAllByText('100% (4)')).toHaveLength(1);

		fireEvent.click(screen.getByText('beta.md'));
		expect(onSelectDocument).toHaveBeenCalledWith('beta');
		expect(screen.queryByText('done.md')).not.toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Refresh document list'));
		expect(onRefresh).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByTitle('Change folder'));
		expect(onChangeFolder).toHaveBeenCalledTimes(1);
	});

	it('uses the real tree dropdown, outside-click, Escape, and folder-change paths', () => {
		const onChangeFolder = vi.fn();
		const onSelectDocument = vi.fn();
		const counts = new Map<string, DocumentTaskCount>([
			['specs/phase-one', { completed: 1, total: 4 }],
			['specs/nested/deep-plan', { completed: 3, total: 3 }],
		]);
		const { rerender } = renderSelector({
			documentTaskCounts: counts,
			documentTree,
			documents: ['root-plan', 'specs/phase-one', 'specs/nested/deep-plan'],
			onChangeFolder,
			onSelectDocument,
			selectedDocument: 'root-plan',
		});

		fireEvent.click(screen.getByRole('button', { name: /root-plan\.md/i }));
		expect(screen.getByText('specs')).toBeInTheDocument();
		expect(screen.getByText('phase-one.md')).toBeInTheDocument();
		expect(screen.getByText('25% (4)')).toBeInTheDocument();

		fireEvent.click(screen.getByText('specs'));
		expect(screen.queryByText('phase-one.md')).not.toBeInTheDocument();
		fireEvent.click(screen.getByText('specs'));
		expect(screen.getByText('phase-one.md')).toBeInTheDocument();
		fireEvent.click(screen.getByText('empty-folder'));
		fireEvent.click(screen.getByText('nested'));
		expect(screen.queryByText('deep-plan.md')).not.toBeInTheDocument();
		fireEvent.click(screen.getByText('nested'));
		expect(screen.getByText('100% (3)')).toBeInTheDocument();
		fireEvent.click(screen.getByText('deep-plan.md'));
		expect(onSelectDocument).toHaveBeenCalledWith('specs/nested/deep-plan');

		fireEvent.click(screen.getByRole('button', { name: /root-plan\.md/i }));
		fireEvent.mouseDown(document.body);
		expect(screen.queryByText('Change Folder...')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /root-plan\.md/i }));
		fireEvent.keyDown(document, { key: 'ArrowDown' });
		expect(screen.getByText('Change Folder...')).toBeInTheDocument();
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(screen.queryByText('Change Folder...')).not.toBeInTheDocument();

		rerender(
			<LayerStackProvider>
				<AutoRunDocumentSelector
					{...createProps({
						documentTree,
						documents: ['root-plan'],
						onChangeFolder,
						selectedDocument: 'root-plan',
					})}
				/>
			</LayerStackProvider>
		);
		fireEvent.click(screen.getByRole('button', { name: /root-plan\.md/i }));
		fireEvent.click(screen.getByText('Change Folder...'));
		expect(onChangeFolder).toHaveBeenCalledTimes(1);
	});

	it('creates a document inside a selected folder and blocks duplicate names', async () => {
		const onCreateDocument = vi.fn().mockResolvedValue(true);
		renderSelector({
			documentTree,
			documents: ['existing-doc', 'specs/existing-doc'],
			onCreateDocument,
		});

		fireEvent.click(screen.getByTitle('Create new document'));
		const dialog = screen.getByRole('dialog', { name: 'Create New Document' });
		const input = within(dialog).getByRole('textbox');
		const create = within(dialog).getByRole('button', { name: 'Create' });

		fireEvent.change(input, { target: { value: 'Existing-Doc.md' } });
		expect(screen.getByText('A document with this name already exists')).toBeInTheDocument();
		expect(create).toBeDisabled();

		fireEvent.change(input, { target: { value: '' } });
		fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'specs' } });
		fireEvent.change(input, { target: { value: 'existing-doc' } });
		expect(
			screen.getByText('A document with this name already exists in specs')
		).toBeInTheDocument();
		expect(create).toBeDisabled();

		fireEvent.change(input, { target: { value: '' } });
		fireEvent.change(input, { target: { value: 'new-plan' } });
		expect(screen.getByText('Will create: specs/new-plan.md')).toBeInTheDocument();

		await act(async () => {
			fireEvent.click(create);
		});
		expect(onCreateDocument).toHaveBeenCalledWith('specs/new-plan');
		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

		fireEvent.click(screen.getByTitle('Create new document'));
		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'root-note.md' } });
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Create' }));
		});
		expect(onCreateDocument).toHaveBeenCalledWith('specs/root-note');
		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
	});

	it('keeps the modal open on failed creation, then resets it from Escape and backdrop', async () => {
		let resolveCreate: (value: boolean) => void = () => {};
		const onCreateDocument = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					resolveCreate = resolve;
				})
		);
		renderSelector({ onCreateDocument });

		fireEvent.click(screen.getByTitle('Create new document'));
		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'failed-plan' } });
		fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowDown' });
		fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

		expect(onCreateDocument).toHaveBeenCalledWith('failed-plan');
		expect(await screen.findByRole('button', { name: 'Creating...' })).toBeDisabled();

		fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
		expect(onCreateDocument).toHaveBeenCalledTimes(1);

		await act(async () => {
			resolveCreate(false);
		});
		await waitFor(() => expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled());

		fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Create new document'));
		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'overlay-close' } });
		fireEvent.click(screen.getByRole('dialog'));

		fireEvent.click(screen.getByTitle('Create new document'));
		expect(screen.getByRole('textbox')).toHaveValue('');
	});

	it('renders empty and loading states without invoking disabled actions', () => {
		const onRefresh = vi.fn();
		renderSelector({
			documentTaskCounts: new Map([['alpha', { completed: 1, total: 1 }]]),
			documents: [],
			isLoading: true,
			onRefresh,
			selectedDocument: 'alpha',
		});

		fireEvent.click(screen.getByRole('button', { name: /alpha\.md/i }));
		expect(screen.getByRole('button', { name: /alpha\.md/i })).toHaveTextContent('alpha.md');
		expect(screen.getByText('No markdown files found')).toBeInTheDocument();

		const refresh = screen.getByTitle('Refresh document list');
		expect(refresh).toBeDisabled();
		fireEvent.click(refresh);
		expect(onRefresh).not.toHaveBeenCalled();
	});
});

function renderSelector(overrides: Partial<ComponentProps<typeof AutoRunDocumentSelector>> = {}) {
	return render(
		<LayerStackProvider>
			<AutoRunDocumentSelector {...createProps(overrides)} />
		</LayerStackProvider>
	);
}

function createProps(overrides: Partial<ComponentProps<typeof AutoRunDocumentSelector>> = {}) {
	return {
		theme,
		documents: ['alpha', 'beta'],
		selectedDocument: null,
		onSelectDocument: vi.fn(),
		onRefresh: vi.fn(),
		onChangeFolder: vi.fn(),
		onCreateDocument: vi.fn().mockResolvedValue(true),
		isLoading: false,
		...overrides,
	};
}
