import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import {
	DATA_GRID_MIN_COLUMN_WIDTH,
	DataGrid,
	dataGridColumnWidth,
	nextDataGridSort,
	type DataGridColumn,
	type DataGridSort,
} from '../../../../renderer/components/ui/DataGrid';
import { mockTheme } from '../../../helpers/mockTheme';
import { restorePointer, setCoarsePointer } from '../../../helpers/mockPointer';

// jsdom has no layout, so the virtualizer is stubbed to draw every row.
vi.mock('@tanstack/react-virtual', () => ({
	useVirtualizer: (opts: { count: number; estimateSize: () => number }) => {
		const items = Array.from({ length: opts.count }, (_, index) => ({
			index,
			key: index,
			start: index * opts.estimateSize(),
			size: opts.estimateSize(),
		}));
		return {
			getTotalSize: () => opts.count * opts.estimateSize(),
			getVirtualItems: () => items,
		};
	},
}));

const COLUMNS: DataGridColumn[] = [
	{ key: 'id', label: 'id', subtitle: 'INTEGER', initialWidth: 100, align: 'right' },
	{ key: 'name', label: 'name', initialWidth: 180 },
	{ key: 'tags', label: 'tags', initialWidth: 200, sortable: false, title: 'tags - nested' },
];

const ROWS = [
	[1, 'ada', null],
	[2, '', null],
];

function renderGrid(overrides: Partial<Parameters<typeof DataGrid>[0]> = {}) {
	const props: Parameters<typeof DataGrid>[0] = {
		columns: COLUMNS,
		rowCount: ROWS.length,
		getCell: (row, column) => {
			const value = ROWS[row][column];
			return value === null ? { text: 'null', placeholder: true } : { text: String(value) };
		},
		getRowLabel: (row) => String(row + 1),
		gutterTitle: 'Row number',
		theme: mockTheme,
		sort: null,
		onSortChange: vi.fn(),
		onReachEnd: vi.fn(),
		loadingMore: false,
		testIdPrefix: 'grid',
		...overrides,
	};
	return { props, ...render(<DataGrid {...props} />) };
}

afterEach(() => {
	restorePointer();
	vi.restoreAllMocks();
});

describe('nextDataGridSort', () => {
	it('cycles ascending, descending, then no sort', () => {
		const asc = nextDataGridSort(null, 'name');
		expect(asc).toEqual({ column: 'name', direction: 'asc' });
		const desc = nextDataGridSort(asc, 'name');
		expect(desc).toEqual({ column: 'name', direction: 'desc' });
		expect(nextDataGridSort(desc, 'name')).toBeNull();
	});

	it('starts ascending on a different column', () => {
		expect(nextDataGridSort({ column: 'id', direction: 'desc' }, 'name')).toEqual({
			column: 'name',
			direction: 'asc',
		});
	});
});

describe('dataGridColumnWidth', () => {
	it('fits the header, the content, and the clamp', () => {
		expect(dataGridColumnWidth('id', 0)).toBeGreaterThanOrEqual(DATA_GRID_MIN_COLUMN_WIDTH);
		expect(dataGridColumnWidth('id', 150)).toBe(150);
		expect(dataGridColumnWidth('a_very_long_column_name_indeed', 80)).toBeGreaterThan(200);
		expect(dataGridColumnWidth('x', 5000)).toBe(320);
	});
});

describe('DataGrid', () => {
	it('draws headers with subtitles, gutter labels, and cells', () => {
		renderGrid();
		expect(screen.getByTestId('grid-grid')).toBeInTheDocument();
		expect(screen.getByTestId('grid-header-id')).toHaveTextContent('INTEGER');
		expect(screen.getByTestId('grid-row-0')).toHaveTextContent('1');
		expect(screen.getByTestId('grid-row-0')).toHaveTextContent('ada');
	});

	it('styles a placeholder cell apart from an empty value', () => {
		renderGrid();
		const placeholder = screen.getAllByTitle('null')[0];
		expect(placeholder).toHaveStyle({ fontStyle: 'italic' });
		const row = screen.getByTestId('grid-row-1');
		const empty = [...row.children].find((cell) => cell.getAttribute('title') === '');
		expect(empty).toHaveStyle({ fontStyle: 'normal' });
	});

	it('reports the next sort on a header click and marks the sorted column', () => {
		const onSortChange = vi.fn();
		const sort: DataGridSort = { column: 'name', direction: 'asc' };
		renderGrid({ sort, onSortChange });
		expect(screen.getByTestId('grid-header-name')).toHaveAttribute('aria-sort', 'ascending');
		fireEvent.click(screen.getByTestId('grid-header-name'));
		expect(onSortChange).toHaveBeenLastCalledWith({ column: 'name', direction: 'desc' });
		fireEvent.click(screen.getByTestId('grid-header-id'));
		expect(onSortChange).toHaveBeenLastCalledWith({ column: 'id', direction: 'asc' });
	});

	it('leaves an unsortable column inert', () => {
		const onSortChange = vi.fn();
		renderGrid({ onSortChange });
		fireEvent.click(screen.getByTestId('grid-header-tags'));
		expect(onSortChange).not.toHaveBeenCalled();
		expect(screen.getByTestId('grid-header-tags')).toHaveAttribute('title', 'tags - nested');
	});

	it('opens a row on double-click, and on one tap with a coarse pointer', () => {
		const onOpenRow = vi.fn();
		renderGrid({ onOpenRow });
		fireEvent.click(screen.getByTestId('grid-row-1'));
		expect(onOpenRow).not.toHaveBeenCalled();
		fireEvent.doubleClick(screen.getByTestId('grid-row-1'));
		expect(onOpenRow).toHaveBeenCalledWith(1);

		setCoarsePointer(true);
		fireEvent.click(screen.getByTestId('grid-row-0'));
		expect(onOpenRow).toHaveBeenLastCalledWith(0);
	});

	it('does not ask for more rows while the grid has no laid-out height', () => {
		const onReachEnd = vi.fn();
		renderGrid({ onReachEnd });
		expect(onReachEnd).not.toHaveBeenCalled();
	});

	it('asks for more rows once the last loaded row is drawn on a measured grid', () => {
		vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
		const onReachEnd = vi.fn();
		renderGrid({ onReachEnd });
		expect(onReachEnd).toHaveBeenCalled();
	});

	it('renders the header action the caller supplies', () => {
		renderGrid({
			renderHeaderAction: (column) => <button type="button">filter {column.key}</button>,
		});
		expect(screen.getByText('filter name')).toBeInTheDocument();
	});

	it('shows the empty message when there are no columns', () => {
		renderGrid({ columns: [], emptyMessage: 'No columns selected.' });
		expect(screen.getByText('No columns selected.')).toBeInTheDocument();
	});
});
