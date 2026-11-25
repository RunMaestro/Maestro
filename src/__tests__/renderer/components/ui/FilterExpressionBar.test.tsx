import { createRef, useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import {
	FilterExpressionBar,
	type FilterExpressionBarHandle,
	type FilterExpressionColumn,
} from '../../../../renderer/components/ui/FilterExpressionBar';
import type { ParquetFilterProblem } from '../../../../shared/parquet/types';
import { mockTheme } from '../../../helpers/mockTheme';
// lucide-react icons are auto-mocked globally in src/__tests__/setup.ts

const COLUMNS: FilterExpressionColumn[] = [
	{ name: 'customer_id', detail: 'INTEGER' },
	{ name: 'legacy_customer_ref' },
	{ name: 'order id', detail: 'TEXT' },
];

const EXAMPLES = [
	{ expression: 'acme', description: 'any column contains "acme"' },
	{ expression: 'status = active', description: 'exact match' },
];

function Harness(props: {
	initial?: string;
	problem?: ParquetFilterProblem;
	onChange?: (value: string) => void;
	barRef?: React.Ref<FilterExpressionBarHandle>;
}) {
	const [value, setValue] = useState(props.initial ?? '');
	return (
		<FilterExpressionBar
			ref={props.barRef}
			value={value}
			onChange={(next) => {
				setValue(next);
				props.onChange?.(next);
			}}
			columns={COLUMNS}
			problem={props.problem}
			busy={false}
			busyLabel="working…"
			placeholder="Filter rows"
			examples={EXAMPLES}
			footnote={<span>engine note</span>}
			testIdPrefix="demo"
			theme={mockTheme}
		>
			<div data-testid="demo-readout">readout</div>
		</FilterExpressionBar>
	);
}

describe('FilterExpressionBar', () => {
	it('offers matching columns while the caret sits on an identifier, prefix hits first', () => {
		render(<Harness />);
		const input = screen.getByTestId('demo-filter-input');
		fireEvent.change(input, { target: { value: 'cust', selectionStart: 4 } });
		const list = screen.getByTestId('demo-filter-suggestions');
		const names = Array.from(list.querySelectorAll('button')).map((button) => button.textContent);
		expect(names).toEqual(['customer_idINTEGER', 'legacy_customer_ref']);
	});

	it('completes with Tab, bracketing a name the language cannot read bare', () => {
		const onChange = vi.fn();
		render(<Harness onChange={onChange} />);
		const input = screen.getByTestId('demo-filter-input');
		fireEvent.change(input, { target: { value: 'ord', selectionStart: 3 } });
		fireEvent.keyDown(input, { key: 'Tab' });
		expect(onChange).toHaveBeenLastCalledWith('[order id]');
	});

	it('clears the filter on Escape', () => {
		render(<Harness initial="status = active" />);
		const input = screen.getByTestId('demo-filter-input');
		fireEvent.keyDown(input, { key: 'Escape' });
		expect(input).toHaveValue('');
	});

	it('shows the problem with a one-click fix, and hides the readout while it stands', () => {
		render(
			<Harness
				initial="custmer_id = 4"
				problem={{
					message: 'No column "custmer_id". Did you mean "customer_id"?',
					start: 0,
					end: 10,
					suggestion: 'customer_id',
				}}
			/>
		);
		expect(screen.getByTestId('demo-filter-error')).toHaveTextContent('Did you mean');
		expect(screen.queryByTestId('demo-readout')).not.toBeInTheDocument();
		fireEvent.click(screen.getByText('Use "customer_id"'));
		expect(screen.getByTestId('demo-filter-input')).toHaveValue('customer_id = 4');
	});

	it('shows the readout only while the box holds a valid filter', () => {
		const { unmount } = render(<Harness />);
		expect(screen.queryByTestId('demo-readout')).not.toBeInTheDocument();
		unmount();
		render(<Harness initial="acme" />);
		expect(screen.getByTestId('demo-readout')).toBeInTheDocument();
	});

	it('fills the box from a syntax example and shows the engine footnote', () => {
		render(<Harness />);
		fireEvent.click(screen.getByLabelText('Filter syntax'));
		expect(screen.getByText('engine note')).toBeInTheDocument();
		fireEvent.click(screen.getByText('status = active'));
		expect(screen.getByTestId('demo-filter-input')).toHaveValue('status = active');
	});

	it('focuses and selects the input through its handle', () => {
		const ref = createRef<FilterExpressionBarHandle>();
		render(<Harness initial="acme" barRef={ref} />);
		ref.current?.focus();
		expect(document.activeElement).toBe(screen.getByTestId('demo-filter-input'));
	});
});
