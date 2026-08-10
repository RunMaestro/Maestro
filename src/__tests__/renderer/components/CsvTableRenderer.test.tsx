import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CsvTableRenderer } from '../../../renderer/components/CsvTableRenderer';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';

import { mockTheme } from '../../helpers/mockTheme';
// lucide-react icons are auto-mocked globally in src/__tests__/setup.ts

describe('CsvTableRenderer', () => {
	describe('basic rendering', () => {
		it('renders a table with header and data rows', () => {
			render(
				<CsvTableRenderer content={'Name,Age,City\nAlice,30,NYC\nBob,25,LA'} theme={mockTheme} />
			);

			expect(screen.getByText('Name')).toBeInTheDocument();
			expect(screen.getByText('Age')).toBeInTheDocument();
			expect(screen.getByText('City')).toBeInTheDocument();
			expect(screen.getByText('Alice')).toBeInTheDocument();
			expect(screen.getByText('30')).toBeInTheDocument();
			expect(screen.getByText('NYC')).toBeInTheDocument();
			expect(screen.getByText('Bob')).toBeInTheDocument();
		});

		it('shows row and column count', () => {
			render(<CsvTableRenderer content={'A,B\n1,2\n3,4\n5,6'} theme={mockTheme} />);

			expect(screen.getByText('3 rows × 2 columns')).toBeInTheDocument();
		});

		it('renders empty state for empty content', () => {
			render(<CsvTableRenderer content="" theme={mockTheme} />);

			expect(screen.getByText('Empty CSV file')).toBeInTheDocument();
		});

		it('shows row numbers starting at 1', () => {
			render(<CsvTableRenderer content={'Name\nAlice\nBob'} theme={mockTheme} />);

			expect(screen.getByText('1')).toBeInTheDocument();
			expect(screen.getByText('2')).toBeInTheDocument();
		});
	});

	describe('CSV parsing', () => {
		it('handles quoted fields with commas', () => {
			render(
				<CsvTableRenderer
					content={'Name,Location\n"Smith, John","New York, NY"'}
					theme={mockTheme}
				/>
			);

			expect(screen.getByText('Smith, John')).toBeInTheDocument();
			expect(screen.getByText('New York, NY')).toBeInTheDocument();
		});

		it('handles escaped quotes inside quoted fields', () => {
			render(<CsvTableRenderer content={'Quote\n"He said ""hello"""'} theme={mockTheme} />);

			expect(screen.getByText('He said "hello"')).toBeInTheDocument();
		});

		it('handles CRLF line endings', () => {
			const { container } = render(
				<CsvTableRenderer content={'A,B\r\n1,2\r\n3,4'} theme={mockTheme} />
			);

			const cells = container.querySelectorAll('tbody td');
			const cellTexts = Array.from(cells).map((c) => c.textContent);
			expect(cellTexts).toContain('1');
			expect(cellTexts).toContain('4');
			expect(screen.getByText('2 rows × 2 columns')).toBeInTheDocument();
		});

		it('handles rows with different column counts', () => {
			render(<CsvTableRenderer content={'A,B,C\n1,2\n3,4,5,6'} theme={mockTheme} />);

			// Should not crash - fills missing cells with empty, ignores extra
			expect(screen.getByText('A')).toBeInTheDocument();
			expect(screen.getByText('3')).toBeInTheDocument();
		});
	});

	describe('column sorting', () => {
		it('sorts ascending on first click', () => {
			const { container } = render(
				<CsvTableRenderer content={'Name,Value\nCharlie,3\nAlice,1\nBob,2'} theme={mockTheme} />
			);

			// Click on the Name header
			fireEvent.click(screen.getByText('Name'));

			// After ascending sort, first data row should be Alice
			const rows = container.querySelectorAll('tbody tr');
			expect(rows[0]).toHaveTextContent('Alice');
			expect(rows[1]).toHaveTextContent('Bob');
			expect(rows[2]).toHaveTextContent('Charlie');
		});

		it('sorts descending on second click', () => {
			const { container } = render(
				<CsvTableRenderer content={'Name,Value\nCharlie,3\nAlice,1\nBob,2'} theme={mockTheme} />
			);

			// Click twice for descending
			fireEvent.click(screen.getByText('Name'));
			fireEvent.click(screen.getByText('Name'));

			const rows = container.querySelectorAll('tbody tr');
			expect(rows[0]).toHaveTextContent('Charlie');
			expect(rows[1]).toHaveTextContent('Bob');
			expect(rows[2]).toHaveTextContent('Alice');
		});

		it('clears sort on third click', () => {
			const { container } = render(
				<CsvTableRenderer content={'Name,Value\nCharlie,3\nAlice,1\nBob,2'} theme={mockTheme} />
			);

			// Click three times to clear sort
			fireEvent.click(screen.getByText('Name'));
			fireEvent.click(screen.getByText('Name'));
			fireEvent.click(screen.getByText('Name'));

			// Back to original order
			const rows = container.querySelectorAll('tbody tr');
			expect(rows[0]).toHaveTextContent('Charlie');
			expect(rows[1]).toHaveTextContent('Alice');
			expect(rows[2]).toHaveTextContent('Bob');
		});

		it('sorts numeric columns numerically', () => {
			const { container } = render(
				<CsvTableRenderer content={'Item,Price\nA,10\nB,2\nC,100'} theme={mockTheme} />
			);

			fireEvent.click(screen.getByText('Price'));

			const rows = container.querySelectorAll('tbody tr');
			// Numeric sort: 2, 10, 100 (not lexicographic "10", "100", "2")
			expect(rows[0]).toHaveTextContent('2');
			expect(rows[1]).toHaveTextContent('10');
			expect(rows[2]).toHaveTextContent('100');
		});

		it('shows sort indicator on sorted column', () => {
			render(<CsvTableRenderer content={'Name,Age\nAlice,30'} theme={mockTheme} />);

			fireEvent.click(screen.getByText('Name'));

			expect(screen.getByTestId('chevronup-icon')).toBeInTheDocument();
		});
	});

	describe('truncation', () => {
		it('shows truncation banner for large datasets', () => {
			// Generate 600 rows
			const header = 'ID,Value';
			const rows = Array.from({ length: 600 }, (_, i) => `${i},val${i}`).join('\n');
			const content = `${header}\n${rows}`;

			render(<CsvTableRenderer content={content} theme={mockTheme} />);

			expect(screen.getByText(/Showing 500 of 600 rows/)).toBeInTheDocument();
		});

		it('does not show truncation banner for small datasets', () => {
			render(<CsvTableRenderer content={'A,B\n1,2\n3,4'} theme={mockTheme} />);

			expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
		});
	});

	describe('TSV delimiter support', () => {
		it('parses tab-delimited content with delimiter prop', () => {
			render(
				<CsvTableRenderer
					content={'Name\tAge\tCity\nAlice\t30\tNYC\nBob\t25\tLA'}
					theme={mockTheme}
					delimiter={'\t'}
				/>
			);

			expect(screen.getByText('Name')).toBeInTheDocument();
			expect(screen.getByText('Age')).toBeInTheDocument();
			expect(screen.getByText('Alice')).toBeInTheDocument();
			expect(screen.getByText('NYC')).toBeInTheDocument();
			expect(screen.getByText('2 rows × 3 columns')).toBeInTheDocument();
		});

		it('handles quoted fields in TSV', () => {
			render(
				<CsvTableRenderer
					content={'Name\tNote\n"Smith, John"\t"Has\ttab"'}
					theme={mockTheme}
					delimiter={'\t'}
				/>
			);

			expect(screen.getByText('Smith, John')).toBeInTheDocument();
		});

		it('sorts TSV columns correctly', () => {
			const { container } = render(
				<CsvTableRenderer
					content={'Name\tValue\nCharlie\t3\nAlice\t1\nBob\t2'}
					theme={mockTheme}
					delimiter={'\t'}
				/>
			);

			fireEvent.click(screen.getByText('Name'));
			const rows = container.querySelectorAll('tbody tr');
			expect(rows[0]).toHaveTextContent('Alice');
			expect(rows[2]).toHaveTextContent('Charlie');
		});
	});

	describe('numeric detection', () => {
		it('right-aligns columns with majority numeric values', () => {
			const { container } = render(
				<CsvTableRenderer content={'Value\n100\n200\n300'} theme={mockTheme} />
			);

			// Numeric columns get right-aligned td cells
			const cells = container.querySelectorAll('tbody td');
			// Skip row-number cell (index 0), check data cell (index 1)
			expect((cells[1] as HTMLElement).style.textAlign).toBe('right');
		});

		it('does not treat trailing-dot numbers as numeric (e.g., "123.")', () => {
			const { container } = render(
				<CsvTableRenderer content={'Value\n123.\n456.\n789.'} theme={mockTheme} />
			);

			// "123." is not a valid number - column should be left-aligned
			const cells = container.querySelectorAll('tbody td');
			expect((cells[1] as HTMLElement).style.textAlign).toBe('left');
		});

		it('treats proper decimals as numeric', () => {
			const { container } = render(
				<CsvTableRenderer content={'Value\n1.50\n2.75\n3.00'} theme={mockTheme} />
			);

			const cells = container.querySelectorAll('tbody td');
			expect((cells[1] as HTMLElement).style.textAlign).toBe('right');
		});
	});

	describe('search filtering', () => {
		it('filters rows to only those matching the search query', () => {
			const { container } = render(
				<CsvTableRenderer
					content={'Name,City\nAlice,NYC\nBob,LA\nCharlie,NYC'}
					theme={mockTheme}
					searchQuery="NYC"
				/>
			);

			const rows = container.querySelectorAll('tbody tr');
			expect(rows).toHaveLength(2);
			expect(rows[0]).toHaveTextContent('Alice');
			expect(rows[1]).toHaveTextContent('Charlie');
		});

		it('performs case-insensitive search', () => {
			const { container } = render(
				<CsvTableRenderer
					content={'Name,City\nAlice,NYC\nBob,LA'}
					theme={mockTheme}
					searchQuery="nyc"
				/>
			);

			const rows = container.querySelectorAll('tbody tr');
			expect(rows).toHaveLength(1);
			expect(rows[0]).toHaveTextContent('Alice');
		});

		it('shows match count in footer when filtering', () => {
			render(
				<CsvTableRenderer
					content={'Name,City\nAlice,NYC\nBob,LA\nCharlie,NYC'}
					theme={mockTheme}
					searchQuery="NYC"
				/>
			);

			expect(screen.getByText(/2 of 3 rows match/)).toBeInTheDocument();
		});

		it('shows all rows when search query is empty', () => {
			const { container } = render(
				<CsvTableRenderer
					content={'Name,City\nAlice,NYC\nBob,LA'}
					theme={mockTheme}
					searchQuery=""
				/>
			);

			const rows = container.querySelectorAll('tbody tr');
			expect(rows).toHaveLength(2);
		});

		it('calls onMatchCount with filtered row count', () => {
			const onMatchCount = vi.fn();
			render(
				<CsvTableRenderer
					content={'Name,City\nAlice,NYC\nBob,LA\nCharlie,NYC'}
					theme={mockTheme}
					searchQuery="NYC"
					onMatchCount={onMatchCount}
				/>
			);

			expect(onMatchCount).toHaveBeenCalledWith(2);
		});

		it('truncates very long search queries to prevent ReDoS', () => {
			const longQuery = 'a'.repeat(300);
			const { container } = render(
				<CsvTableRenderer
					content={'Name\n' + 'a'.repeat(250)}
					theme={mockTheme}
					searchQuery={longQuery}
				/>
			);

			// Should render without hanging - the query is truncated to 200 chars
			const rows = container.querySelectorAll('tbody tr');
			expect(rows).toHaveLength(1);
		});

		it('highlights matching text in cells', () => {
			const { container } = render(
				<CsvTableRenderer content={'Name,City\nAlice,NYC'} theme={mockTheme} searchQuery="NYC" />
			);

			const marks = container.querySelectorAll('mark');
			expect(marks).toHaveLength(1);
			expect(marks[0]).toHaveTextContent('NYC');
		});
	});

	describe('row detail modal', () => {
		const renderWithLayers = (ui: React.ReactElement) =>
			render(<LayerStackProvider>{ui}</LayerStackProvider>);

		const openRow = (container: HTMLElement, rowIdx: number) => {
			const rows = container.querySelectorAll('tbody tr');
			fireEvent.doubleClick(rows[rowIdx]);
		};

		it('opens on double-click with the row as field/value pairs', () => {
			const { container } = renderWithLayers(
				<CsvTableRenderer content={'Name,City\nAlice,NYC\nBob,LA'} theme={mockTheme} />
			);

			expect(screen.queryByTestId('csv-row-detail-modal')).not.toBeInTheDocument();

			openRow(container, 1);

			const modal = screen.getByTestId('csv-row-detail-modal');
			expect(modal).toBeInTheDocument();
			expect(modal).toHaveTextContent('Row 2');
			// Field names come from the header row, values from the clicked row
			const pairs = modal.querySelectorAll('tbody tr');
			expect(pairs).toHaveLength(2);
			expect(pairs[0]).toHaveTextContent('Name');
			expect(pairs[0]).toHaveTextContent('Bob');
			expect(pairs[1]).toHaveTextContent('City');
			expect(pairs[1]).toHaveTextContent('LA');
		});

		it('preserves newlines inside a quoted multi-line cell', () => {
			const { container } = renderWithLayers(
				<CsvTableRenderer content={'Name,Notes\nAlice,"line one\nline two"'} theme={mockTheme} />
			);

			openRow(container, 0);

			const valueCell = screen
				.getByTestId('csv-row-detail-modal')
				.querySelectorAll('tbody tr')[1]
				?.querySelectorAll('td')[1];
			expect(valueCell?.textContent).toBe('line one\nline two');
			expect(valueCell).toHaveStyle({ whiteSpace: 'pre-wrap' });
		});

		it('filters fields by key or value', () => {
			const { container } = renderWithLayers(
				<CsvTableRenderer content={'Name,City,Age\nAlice,NYC,30'} theme={mockTheme} />
			);

			openRow(container, 0);
			fireEvent.change(screen.getByTestId('csv-row-detail-search'), {
				target: { value: 'nyc' },
			});

			const modal = screen.getByTestId('csv-row-detail-modal');
			const pairs = modal.querySelectorAll('tbody tr');
			expect(pairs).toHaveLength(1);
			expect(pairs[0]).toHaveTextContent('City');
			// Matches are highlighted
			expect(modal.querySelectorAll('mark')).toHaveLength(1);
		});

		it('shows an empty state when nothing matches the filter', () => {
			const { container } = renderWithLayers(
				<CsvTableRenderer content={'Name,City\nAlice,NYC'} theme={mockTheme} />
			);

			openRow(container, 0);
			fireEvent.change(screen.getByTestId('csv-row-detail-search'), {
				target: { value: 'zzz' },
			});

			expect(screen.getByText(/No fields match/)).toBeInTheDocument();
		});

		it('navigates between rows with the header buttons', () => {
			const { container } = renderWithLayers(
				<CsvTableRenderer content={'Name\nAlice\nBob\nCarol'} theme={mockTheme} />
			);

			openRow(container, 0);
			const modal = screen.getByTestId('csv-row-detail-modal');
			expect(modal).toHaveTextContent('Alice');

			fireEvent.click(screen.getByLabelText('Next row'));
			expect(screen.getByTestId('csv-row-detail-modal')).toHaveTextContent('Bob');

			fireEvent.click(screen.getByLabelText('Previous row'));
			expect(screen.getByTestId('csv-row-detail-modal')).toHaveTextContent('Alice');
			// First row: no previous
			expect(screen.getByLabelText('Previous row')).toBeDisabled();
		});

		it('navigates rows with Left and Right arrows', () => {
			const { container } = renderWithLayers(
				<CsvTableRenderer content={'Name\nAlice\nBob\nCarol'} theme={mockTheme} />
			);

			openRow(container, 0);
			const fields = screen.getByTestId('csv-row-detail-fields');
			expect(screen.getByTestId('csv-row-detail-modal')).toHaveTextContent('Alice');

			fireEvent.keyDown(fields, { key: 'ArrowRight' });
			expect(screen.getByTestId('csv-row-detail-modal')).toHaveTextContent('Bob');

			fireEvent.keyDown(fields, { key: 'ArrowRight' });
			expect(screen.getByTestId('csv-row-detail-modal')).toHaveTextContent('Carol');

			fireEvent.keyDown(fields, { key: 'ArrowLeft' });
			expect(screen.getByTestId('csv-row-detail-modal')).toHaveTextContent('Bob');
		});

		it('stops at the first and last row', () => {
			const { container } = renderWithLayers(
				<CsvTableRenderer content={'Name\nAlice\nBob'} theme={mockTheme} />
			);

			openRow(container, 0);
			const fields = screen.getByTestId('csv-row-detail-fields');

			fireEvent.keyDown(fields, { key: 'ArrowLeft' });
			expect(screen.getByTestId('csv-row-detail-modal')).toHaveTextContent('Alice');

			fireEvent.keyDown(fields, { key: 'ArrowRight' });
			fireEvent.keyDown(fields, { key: 'ArrowRight' });
			expect(screen.getByTestId('csv-row-detail-modal')).toHaveTextContent('Bob');
		});

		it('scrolls instead of navigating on Up and Down', () => {
			const { container } = renderWithLayers(
				<CsvTableRenderer content={'Name\nAlice\nBob'} theme={mockTheme} />
			);

			openRow(container, 0);
			const fields = screen.getByTestId('csv-row-detail-fields');
			const scrollBy = vi.fn();
			fields.scrollBy = scrollBy;

			fireEvent.keyDown(fields, { key: 'ArrowDown' });
			// Still row 1: Down must not step to the next record
			expect(screen.getByTestId('csv-row-detail-modal')).toHaveTextContent('Alice');
			expect(scrollBy).toHaveBeenCalledWith({ top: 48 });

			fireEvent.keyDown(fields, { key: 'ArrowUp' });
			expect(scrollBy).toHaveBeenCalledWith({ top: -48 });
			expect(screen.getByTestId('csv-row-detail-modal')).toHaveTextContent('Alice');
		});

		it('leaves arrow keys to the caret while the filter has focus', () => {
			const { container } = renderWithLayers(
				<CsvTableRenderer content={'Name\nAlice\nBob'} theme={mockTheme} />
			);

			openRow(container, 0);
			const search = screen.getByTestId('csv-row-detail-search');
			fireEvent.keyDown(search, { key: 'ArrowRight' });

			// Right inside the input moves the caret, it does not change rows
			expect(screen.getByTestId('csv-row-detail-modal')).toHaveTextContent('Alice');
		});

		it('ignores modified arrows so OS and browser bindings still work', () => {
			const { container } = renderWithLayers(
				<CsvTableRenderer content={'Name\nAlice\nBob'} theme={mockTheme} />
			);

			openRow(container, 0);
			const fields = screen.getByTestId('csv-row-detail-fields');
			fireEvent.keyDown(fields, { key: 'ArrowRight', metaKey: true });

			expect(screen.getByTestId('csv-row-detail-modal')).toHaveTextContent('Alice');
		});

		it('focuses the field list on open so the arrows work without a click', async () => {
			// If the filter input took initial focus the arrows would all be caret
			// movement and the whole scheme would be dead until the user clicked.
			const { container } = renderWithLayers(
				<CsvTableRenderer content={'Name\nAlice'} theme={mockTheme} />
			);

			openRow(container, 0);

			await waitFor(() => expect(screen.getByTestId('csv-row-detail-fields')).toHaveFocus());
		});

		it('focuses the filter on / and returns to the list on Enter', () => {
			const { container } = renderWithLayers(
				<CsvTableRenderer content={'Name\nAlice'} theme={mockTheme} />
			);

			openRow(container, 0);
			const fields = screen.getByTestId('csv-row-detail-fields');
			const search = screen.getByTestId('csv-row-detail-search');

			fireEvent.keyDown(fields, { key: '/' });
			expect(search).toHaveFocus();

			fireEvent.keyDown(search, { key: 'Enter' });
			expect(fields).toHaveFocus();
		});

		it('labels columns with no header cell', () => {
			const { container } = renderWithLayers(
				<CsvTableRenderer content={'Name\nAlice,extra'} theme={mockTheme} />
			);

			openRow(container, 0);

			expect(screen.getByTestId('csv-row-detail-modal')).toHaveTextContent('Column 2');
		});

		it('renders outside the table subtree so the backdrop can dim the side panels', () => {
			// The table lives inside the Main Panel, whose `isolate` wrapper is a
			// stacking context: an in-place backdrop dims only the center while the
			// Left Bar (relative z-20) and Right Panel paint over it. jsdom has no
			// layout engine, so assert the modal is NOT a descendant of the
			// renderer rather than that it is visible.
			const { container } = renderWithLayers(
				<CsvTableRenderer content={'Name\nAlice'} theme={mockTheme} />
			);

			openRow(container, 0);

			const modal = screen.getByTestId('csv-row-detail-modal');
			expect(container.querySelector('.csv-table-renderer')).not.toContainElement(modal);
			expect(modal.parentElement).toBe(document.body);
		});

		it('closes on the header close button', () => {
			const { container } = renderWithLayers(
				<CsvTableRenderer content={'Name\nAlice'} theme={mockTheme} />
			);

			openRow(container, 0);
			fireEvent.click(screen.getByLabelText('Close modal'));

			expect(screen.queryByTestId('csv-row-detail-modal')).not.toBeInTheDocument();
		});
	});
});
