import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DocumentList } from '../../../../../renderer/components/DocumentsPanel/components/DocumentList';
import type { BatchDocumentEntry } from '../../../../../renderer/types';
import { mockTheme } from '../../../../helpers/mockTheme';

const documents: BatchDocumentEntry[] = [
	{ id: '1', filename: 'alpha', resetOnCompletion: false },
	{ id: '2', filename: 'beta', resetOnCompletion: true },
	{ id: '3', filename: 'missing', resetOnCompletion: false, isMissing: true },
];

const handlers = {
	handleDragStart: vi.fn(),
	handleDrag: vi.fn(),
	handleDragOver: vi.fn(),
	handleDragLeave: vi.fn(),
	handleDrop: vi.fn(),
	handleDragEnd: vi.fn(),
	onRemoveDocument: vi.fn(),
	onToggleReset: vi.fn(),
	onDuplicateDocument: vi.fn(),
};

function renderList(overrides = {}) {
	const props = {
		theme: mockTheme,
		documents,
		taskCounts: { alpha: 0, beta: 4 },
		loadingTaskCounts: false,
		loopEnabled: false,
		draggedId: null,
		dropTargetIndex: null,
		isCopyDrag: false,
		...handlers,
		...overrides,
	};
	render(<DocumentList {...props} />);
	return props;
}

describe('DocumentList', () => {
	it('renders empty state', () => {
		renderList({ documents: [] });

		expect(screen.getByText('No documents selected')).toBeInTheDocument();
		expect(screen.getByText(/Load a playbook/)).toBeInTheDocument();
	});

	it('renders rows, task badges, missing state, and actions', () => {
		const props = renderList();

		expect(screen.getByText('alpha.md')).toBeInTheDocument();
		expect(screen.getAllByText('0 tasks').length).toBeGreaterThan(0);
		expect(screen.getByText('4 tasks')).toBeInTheDocument();
		expect(screen.getByText('Missing')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle(/Enable reset/));
		expect(props.onToggleReset).toHaveBeenCalledWith('1');

		fireEvent.click(screen.getByTitle('Duplicate document'));
		expect(props.onDuplicateDocument).toHaveBeenCalledWith('2');

		fireEvent.click(screen.getByTitle('Remove missing document'));
		expect(props.onRemoveDocument).toHaveBeenCalledWith('3');
	});

	it('shows loop path and drop indicators', () => {
		renderList({
			loopEnabled: true,
			draggedId: '1',
			dropTargetIndex: 1,
			isCopyDrag: true,
		});

		expect(document.querySelector('.ml-7')).toBeInTheDocument();
		expect(document.querySelector('.absolute.left-0.right-0')).toBeInTheDocument();
	});
});
