import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CsvTableRenderer } from '../../../renderer/components/CsvTableRenderer';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
	ChevronUp: () => <span data-testid="chevron-up">ChevronUp</span>,
	ChevronDown: () => <span data-testid="chevron-down">ChevronDown</span>,
}));

const mockTheme = {
	colors: {
		bgMain: '#1a1a2e',
		bgActivity: '#16213e',
		textMain: '#eee',
		textDim: '#888',
		border: '#333',
		accent: '#4a9eff',
		warning: '#f59e0b',
		success: '#22c55e',
		accentForeground: '#fff',
		bgSidebar: '#111',
	},
} as any;

describe('CsvTableRenderer', () => {
	describe('basic rendering', () => {
		it('renders a table with header and data rows', () => {
			render(<CsvTableRenderer content={"Name,Age,City\nAlice,30,NYC\nBob,25,LA"} theme={mockTheme} />);

			expect(screen.getByText('Name')).toBeInTheDocument();
			expect(screen.getByText('Age')).toBeInTheDocument();
			expect(screen.getByText('City')).toBeInTheDocument();
			expect(screen.getByText('Alice')).toBeInTheDocument();
			expect(screen.getByText('30')).toBeInTheDocument();
			expect(screen.getByText('NYC')).toBeInTheDocument();
			expect(screen.getByText('Bob')).toBeInTheDocument();
		});

		it('shows row and column count', () => {
			render(<CsvTableRenderer content={"A,B\n1,2\n3,4\n5,6"} theme={mockTheme} />);

			expect(screen.getByText('3 rows × 2 columns')).toBeInTheDocument();
		});

		it('renders empty state for empty content', () => {
			render(<CsvTableRenderer content="" theme={mockTheme} />);

			expect(screen.getByText('Empty CSV file')).toBeInTheDocument();
		});

		it('shows row numbers starting at 1', () => {
			render(<CsvTableRenderer content={"Name\nAlice\nBob"} theme={mockTheme} />);

			expect(screen.getByText('1')).toBeInTheDocument();
			expect(screen.getByText('2')).toBeInTheDocument();
		});
	});

	describe('CSV parsing', () => {
		it('handles quoted fields with commas', () => {
			render(<CsvTableRenderer content={'Name,Location\n"Smith, John","New York, NY"'} theme={mockTheme} />);

			expect(screen.getByText('Smith, John')).toBeInTheDocument();
			expect(screen.getByText('New York, NY')).toBeInTheDocument();
		});

		it('handles escaped quotes inside quoted fields', () => {
			render(<CsvTableRenderer content={'Quote\n"He said ""hello"""'} theme={mockTheme} />);

			expect(screen.getByText('He said "hello"')).toBeInTheDocument();
		});

		it('handles CRLF line endings', () => {
			const { container } = render(<CsvTableRenderer content={"A,B\r\n1,2\r\n3,4"} theme={mockTheme} />);

			const cells = container.querySelectorAll('tbody td');
			const cellTexts = Array.from(cells).map((c) => c.textContent);
			expect(cellTexts).toContain('1');
			expect(cellTexts).toContain('4');
			expect(screen.getByText('2 rows × 2 columns')).toBeInTheDocument();
		});

		it('handles rows with different column counts', () => {
			render(<CsvTableRenderer content={"A,B,C\n1,2\n3,4,5,6"} theme={mockTheme} />);

			// Should not crash — fills missing cells with empty, ignores extra
			expect(screen.getByText('A')).toBeInTheDocument();
			expect(screen.getByText('3')).toBeInTheDocument();
		});
	});

	describe('column sorting', () => {
		it('sorts ascending on first click', () => {
			const { container } = render(
				<CsvTableRenderer content={"Name,Value\nCharlie,3\nAlice,1\nBob,2"} theme={mockTheme} />
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
				<CsvTableRenderer content={"Name,Value\nCharlie,3\nAlice,1\nBob,2"} theme={mockTheme} />
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
				<CsvTableRenderer content={"Name,Value\nCharlie,3\nAlice,1\nBob,2"} theme={mockTheme} />
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
				<CsvTableRenderer content={"Item,Price\nA,10\nB,2\nC,100"} theme={mockTheme} />
			);

			fireEvent.click(screen.getByText('Price'));

			const rows = container.querySelectorAll('tbody tr');
			// Numeric sort: 2, 10, 100 (not lexicographic "10", "100", "2")
			expect(rows[0]).toHaveTextContent('2');
			expect(rows[1]).toHaveTextContent('10');
			expect(rows[2]).toHaveTextContent('100');
		});

		it('shows sort indicator on sorted column', () => {
			render(<CsvTableRenderer content={"Name,Age\nAlice,30"} theme={mockTheme} />);

			fireEvent.click(screen.getByText('Name'));

			expect(screen.getByTestId('chevron-up')).toBeInTheDocument();
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
			render(<CsvTableRenderer content={"A,B\n1,2\n3,4"} theme={mockTheme} />);

			expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
		});
	});

	describe('TSV delimiter support', () => {
		it('parses tab-delimited content with delimiter prop', () => {
			render(
				<CsvTableRenderer
					content={"Name\tAge\tCity\nAlice\t30\tNYC\nBob\t25\tLA"}
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
					content={"Name\tValue\nCharlie\t3\nAlice\t1\nBob\t2"}
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
				<CsvTableRenderer content={"Value\n100\n200\n300"} theme={mockTheme} />
			);

			// Numeric columns get right-aligned td cells
			const cells = container.querySelectorAll('tbody td');
			// Skip row-number cell (index 0), check data cell (index 1)
			expect((cells[1] as HTMLElement).style.textAlign).toBe('right');
		});

		it('does not treat trailing-dot numbers as numeric (e.g., "123.")', () => {
			const { container } = render(
				<CsvTableRenderer content={"Value\n123.\n456.\n789."} theme={mockTheme} />
			);

			// "123." is not a valid number — column should be left-aligned
			const cells = container.querySelectorAll('tbody td');
			expect((cells[1] as HTMLElement).style.textAlign).toBe('left');
		});

		it('treats proper decimals as numeric', () => {
			const { container } = render(
				<CsvTableRenderer content={"Value\n1.50\n2.75\n3.00"} theme={mockTheme} />
			);

			const cells = container.querySelectorAll('tbody td');
			expect((cells[1] as HTMLElement).style.textAlign).toBe('right');
		});

		it('right-aligns currency and percentage values via pre-compiled regex', () => {
			const { container } = render(
				<CsvTableRenderer content={"Amount\n$1,000\n($500)\n25%"} theme={mockTheme} />
			);

			const cells = container.querySelectorAll('tbody td');
			expect((cells[1] as HTMLElement).style.textAlign).toBe('right');
		});

		it('left-aligns columns with majority non-numeric values', () => {
			const { container } = render(
				<CsvTableRenderer content={"Label\nhello\nworld\nfoo"} theme={mockTheme} />
			);

			const cells = container.querySelectorAll('tbody td');
			expect((cells[1] as HTMLElement).style.textAlign).toBe('left');
		});
	});

	describe('search filtering', () => {
		it('filters rows to only those matching the search query', () => {
			const { container } = render(
				<CsvTableRenderer
					content={"Name,City\nAlice,NYC\nBob,LA\nCharlie,NYC"}
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
					content={"Name,City\nAlice,NYC\nBob,LA"}
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
					content={"Name,City\nAlice,NYC\nBob,LA\nCharlie,NYC"}
					theme={mockTheme}
					searchQuery="NYC"
				/>
			);

			expect(screen.getByText(/2 of 3 rows match/)).toBeInTheDocument();
		});

		it('shows all rows when search query is empty', () => {
			const { container } = render(
				<CsvTableRenderer
					content={"Name,City\nAlice,NYC\nBob,LA"}
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
					content={"Name,City\nAlice,NYC\nBob,LA\nCharlie,NYC"}
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
					content={"Name\n" + 'a'.repeat(250)}
					theme={mockTheme}
					searchQuery={longQuery}
				/>
			);

			// Should render without hanging — the query is truncated to 200 chars
			const rows = container.querySelectorAll('tbody tr');
			expect(rows).toHaveLength(1);
		});

		it('highlights matching text in cells', () => {
			const { container } = render(
				<CsvTableRenderer
					content={"Name,City\nAlice,NYC"}
					theme={mockTheme}
					searchQuery="NYC"
				/>
			);

			const marks = container.querySelectorAll('mark');
			expect(marks).toHaveLength(1);
			expect(marks[0]).toHaveTextContent('NYC');
		});

		it('highlights matches across multiple cells using memoized regex', () => {
			const { container } = render(
				<CsvTableRenderer
					content={"Name,City\nAlice NYC,NYC"}
					theme={mockTheme}
					searchQuery="NYC"
				/>
			);

			const marks = container.querySelectorAll('mark');
			// One mark in "Alice NYC" cell, one in "NYC" cell
			expect(marks).toHaveLength(2);
		});

		it('escapes regex special characters in search query', () => {
			const { container } = render(
				<CsvTableRenderer
					content={"Expr,Value\n(1+2),3\nfoo,bar"}
					theme={mockTheme}
					searchQuery="(1+2)"
				/>
			);

			// Should not throw or match incorrectly — regex chars are escaped
			const rows = container.querySelectorAll('tbody tr');
			expect(rows).toHaveLength(1);
			expect(rows[0]).toHaveTextContent('(1+2)');

			const marks = container.querySelectorAll('mark');
			expect(marks).toHaveLength(1);
			expect(marks[0]).toHaveTextContent('(1+2)');
		});

		it('renders no highlights when search query is empty', () => {
			const { container } = render(
				<CsvTableRenderer
					content={"Name,City\nAlice,NYC"}
					theme={mockTheme}
					searchQuery=""
				/>
			);

			const marks = container.querySelectorAll('mark');
			expect(marks).toHaveLength(0);
		});
	});
});
