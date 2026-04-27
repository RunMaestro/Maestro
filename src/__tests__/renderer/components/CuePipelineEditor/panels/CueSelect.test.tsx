import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ThemedSelect as CueSelect } from '../../../../../renderer/components/shared/ThemedSelect';
import type { Theme } from '../../../../../renderer/types';

// Use real useClickOutside so click-outside behavior is testable
vi.mock('../../../../../renderer/hooks/ui', async () => {
	const actual = await vi.importActual<Record<string, unknown>>('../../../../../renderer/hooks/ui');
	return actual;
});

const theme = {
	colors: {
		bgMain: '#1a1a1a',
		bgSidebar: '#222',
		bgActivity: '#333',
		border: '#444',
		textMain: '#fff',
		textDim: '#999',
		accent: '#06b6d4',
	},
} as Theme;

const options = [
	{ value: 'a', label: 'Alpha' },
	{ value: 'b', label: 'Beta' },
	{ value: 'c', label: 'Gamma' },
];

describe('CueSelect', () => {
	let onChange: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		onChange = vi.fn();
	});

	it('renders the selected option label', () => {
		render(<CueSelect value="b" options={options} onChange={onChange} theme={theme} />);
		expect(screen.getByText('Beta')).toBeInTheDocument();
	});

	it('opens dropdown on click and shows all options', () => {
		render(<CueSelect value="a" options={options} onChange={onChange} theme={theme} />);
		const trigger = screen.getByText('Alpha').closest('button')!;
		fireEvent.click(trigger);
		// All three options visible (Alpha appears twice: trigger + dropdown)
		expect(screen.getAllByText('Alpha')).toHaveLength(2);
		expect(screen.getByText('Beta')).toBeInTheDocument();
		expect(screen.getByText('Gamma')).toBeInTheDocument();
	});

	it('calls onChange and closes on option select', () => {
		render(<CueSelect value="a" options={options} onChange={onChange} theme={theme} />);
		fireEvent.click(screen.getByRole('button', { name: /alpha/i }));
		fireEvent.click(screen.getByText('Gamma'));
		expect(onChange).toHaveBeenCalledWith('c');
		// Dropdown should close — only the trigger button visible
		expect(screen.queryAllByText('Beta')).toHaveLength(0);
	});

	it('closes on Escape key', () => {
		render(<CueSelect value="a" options={options} onChange={onChange} theme={theme} />);
		const trigger = screen.getByText('Alpha').closest('button')!;
		fireEvent.click(trigger);
		expect(screen.getByText('Gamma')).toBeInTheDocument();
		// Press Escape on the menu
		const menu = screen.getByRole('listbox');
		fireEvent.keyDown(menu, { key: 'Escape' });
		expect(screen.queryByText('Gamma')).not.toBeInTheDocument();
	});

	it('closes on click outside', () => {
		render(<CueSelect value="a" options={options} onChange={onChange} theme={theme} />);
		const trigger = screen.getByText('Alpha').closest('button')!;
		fireEvent.click(trigger);
		expect(screen.getByText('Gamma')).toBeInTheDocument();
		// Click outside the component
		act(() => {
			fireEvent.mouseDown(document.body);
		});
		expect(screen.queryByText('Gamma')).not.toBeInTheDocument();
	});

	it('highlights the selected option with fontWeight 500', () => {
		render(<CueSelect value="b" options={options} onChange={onChange} theme={theme} />);
		// Open the dropdown
		const trigger = screen.getByText('Beta').closest('button')!;
		fireEvent.click(trigger);
		// Find the dropdown option via role="option"
		const betaOption = screen.getByRole('option', { name: 'Beta' });
		expect(betaOption).toBeInTheDocument();
		expect(betaOption.style.fontWeight).toBe('500');
	});

	it('falls back to raw value when no option matches', () => {
		render(<CueSelect value="unknown" options={options} onChange={onChange} theme={theme} />);
		expect(screen.getByText('unknown')).toBeInTheDocument();
	});

	it('navigates options with arrow keys', () => {
		render(<CueSelect value="a" options={options} onChange={onChange} theme={theme} />);
		fireEvent.click(screen.getByText('Alpha').closest('button')!);
		const menu = screen.getByRole('listbox');

		// Active index starts on the selected option (Alpha, index 0)
		// Arrow down → Beta (index 1)
		fireEvent.keyDown(menu, { key: 'ArrowDown' });
		// Arrow down → Gamma (index 2)
		fireEvent.keyDown(menu, { key: 'ArrowDown' });
		// Press Enter to select Gamma
		fireEvent.keyDown(menu, { key: 'Enter' });
		expect(onChange).toHaveBeenCalledWith('c');
	});

	it('supports Home/End keys', () => {
		render(<CueSelect value="b" options={options} onChange={onChange} theme={theme} />);
		fireEvent.click(screen.getByText('Beta').closest('button')!);
		const menu = screen.getByRole('listbox');

		// End → last option (Gamma)
		fireEvent.keyDown(menu, { key: 'End' });
		fireEvent.keyDown(menu, { key: 'Enter' });
		expect(onChange).toHaveBeenCalledWith('c');
	});

	it('selects option with Space key', () => {
		render(<CueSelect value="a" options={options} onChange={onChange} theme={theme} />);
		fireEvent.click(screen.getByText('Alpha').closest('button')!);
		const menu = screen.getByRole('listbox');

		fireEvent.keyDown(menu, { key: 'ArrowDown' });
		fireEvent.keyDown(menu, { key: ' ' });
		expect(onChange).toHaveBeenCalledWith('b');
	});

	it('wraps around on arrow key navigation', () => {
		render(<CueSelect value="c" options={options} onChange={onChange} theme={theme} />);
		fireEvent.click(screen.getByText('Gamma').closest('button')!);
		const menu = screen.getByRole('listbox');

		// Active starts at Gamma (index 2), ArrowDown wraps to Alpha (index 0)
		fireEvent.keyDown(menu, { key: 'ArrowDown' });
		fireEvent.keyDown(menu, { key: 'Enter' });
		expect(onChange).toHaveBeenCalledWith('a');
	});

	describe('filterable', () => {
		it('omits the search input when filterable is false', () => {
			render(<CueSelect value="a" options={options} onChange={onChange} theme={theme} />);
			fireEvent.click(screen.getByRole('button', { name: /alpha/i }));
			expect(screen.queryByPlaceholderText('Filter…')).not.toBeInTheDocument();
		});

		it('renders the search input when filterable is true', () => {
			render(
				<CueSelect value="a" options={options} onChange={onChange} theme={theme} filterable />
			);
			fireEvent.click(screen.getByRole('button', { name: /alpha/i }));
			expect(screen.getByPlaceholderText('Filter…')).toBeInTheDocument();
		});

		it('honors a custom filterPlaceholder', () => {
			render(
				<CueSelect
					value="a"
					options={options}
					onChange={onChange}
					theme={theme}
					filterable
					filterPlaceholder="Filter agents…"
				/>
			);
			fireEvent.click(screen.getByText('Alpha').closest('button')!);
			expect(screen.getByPlaceholderText('Filter agents…')).toBeInTheDocument();
		});

		it('filters options by case-insensitive label match as the user types', () => {
			render(
				<CueSelect value="a" options={options} onChange={onChange} theme={theme} filterable />
			);
			fireEvent.click(screen.getByText('Alpha').closest('button')!);
			const input = screen.getByPlaceholderText('Filter…');

			fireEvent.change(input, { target: { value: 'be' } });
			expect(screen.getByRole('option', { name: 'Beta' })).toBeInTheDocument();
			expect(screen.queryByRole('option', { name: 'Alpha' })).not.toBeInTheDocument();
			expect(screen.queryByRole('option', { name: 'Gamma' })).not.toBeInTheDocument();

			// Case-insensitive
			fireEvent.change(input, { target: { value: 'GAM' } });
			expect(screen.getByRole('option', { name: 'Gamma' })).toBeInTheDocument();
		});

		it('shows a "No matches" hint when the filter excludes everything', () => {
			render(
				<CueSelect value="a" options={options} onChange={onChange} theme={theme} filterable />
			);
			fireEvent.click(screen.getByText('Alpha').closest('button')!);
			fireEvent.change(screen.getByPlaceholderText('Filter…'), { target: { value: 'zzz' } });
			expect(screen.getByText('No matches')).toBeInTheDocument();
			expect(screen.queryByRole('option')).not.toBeInTheDocument();
		});

		it('preserves Space as a literal character inside the filter input', () => {
			render(
				<CueSelect value="a" options={options} onChange={onChange} theme={theme} filterable />
			);
			fireEvent.click(screen.getByText('Alpha').closest('button')!);
			const input = screen.getByPlaceholderText('Filter…') as HTMLInputElement;

			// Space must NOT submit the active option when typing in the search box;
			// otherwise users can't search for multi-word labels.
			fireEvent.keyDown(input, { key: ' ' });
			expect(onChange).not.toHaveBeenCalled();
		});

		it('navigates the filtered list with arrow keys and selects with Enter', () => {
			render(
				<CueSelect value="a" options={options} onChange={onChange} theme={theme} filterable />
			);
			fireEvent.click(screen.getByText('Alpha').closest('button')!);
			const input = screen.getByPlaceholderText('Filter…');

			// Narrow to Beta + Gamma (labels containing "a" — Alpha, Beta, Gamma all contain 'a')
			fireEvent.change(input, { target: { value: 'a' } });
			// Active resets to first match. ArrowDown → next match. Enter selects it.
			fireEvent.keyDown(input, { key: 'ArrowDown' });
			fireEvent.keyDown(input, { key: 'Enter' });
			// First match is Alpha (index 0), ArrowDown moves to Beta (index 1) → 'b'
			expect(onChange).toHaveBeenCalledWith('b');
		});

		it('clears the query when the dropdown is closed and reopened', () => {
			render(
				<CueSelect value="a" options={options} onChange={onChange} theme={theme} filterable />
			);
			fireEvent.click(screen.getByText('Alpha').closest('button')!);
			fireEvent.change(screen.getByPlaceholderText('Filter…'), { target: { value: 'be' } });
			fireEvent.keyDown(screen.getByPlaceholderText('Filter…'), { key: 'Escape' });

			fireEvent.click(screen.getByText('Alpha').closest('button')!);
			const input = screen.getByPlaceholderText('Filter…') as HTMLInputElement;
			expect(input.value).toBe('');
			// All options visible again
			expect(screen.getByRole('option', { name: 'Alpha' })).toBeInTheDocument();
			expect(screen.getByRole('option', { name: 'Beta' })).toBeInTheDocument();
			expect(screen.getByRole('option', { name: 'Gamma' })).toBeInTheDocument();
		});
	});

	it('forwards id and aria-label to trigger button', () => {
		render(
			<CueSelect
				value="a"
				options={options}
				onChange={onChange}
				theme={theme}
				id="test-select"
				aria-label="Test label"
			/>
		);
		const trigger = screen.getByRole('button');
		expect(trigger).toHaveAttribute('id', 'test-select');
		expect(trigger).toHaveAttribute('aria-label', 'Test label');
	});
});
