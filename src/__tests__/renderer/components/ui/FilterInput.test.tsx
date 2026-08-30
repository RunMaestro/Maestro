/**
 * Tests for FilterInput - the shared "narrow this list" text box.
 *
 * The behaviors worth pinning down are the ones the hand-rolled copies kept
 * getting wrong: the clear button only exists once there is something to clear,
 * and Escape resets the query rather than bubbling up to close the surface.
 */

import { describe, it, expect, vi } from 'vitest';
import { createRef } from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { FilterInput } from '../../../../renderer/components/ui/FilterInput';
import { mockTheme } from '../../../helpers/mockTheme';

describe('FilterInput', () => {
	it('reports every keystroke to the consumer', () => {
		const onChange = vi.fn();
		render(<FilterInput theme={mockTheme} value="" onChange={onChange} placeholder="Filter..." />);

		fireEvent.change(screen.getByPlaceholderText('Filter...'), { target: { value: 'work' } });
		expect(onChange).toHaveBeenCalledWith('work');
	});

	it('hides the clear button until there is something to clear', () => {
		const { rerender } = render(<FilterInput theme={mockTheme} value="" onChange={vi.fn()} />);
		expect(screen.queryByLabelText('Clear filter')).not.toBeInTheDocument();

		rerender(<FilterInput theme={mockTheme} value="tree" onChange={vi.fn()} />);
		expect(screen.getByLabelText('Clear filter')).toBeInTheDocument();
	});

	it('empties the query from the clear button', () => {
		const onChange = vi.fn();
		render(<FilterInput theme={mockTheme} value="tree" onChange={onChange} />);

		fireEvent.click(screen.getByLabelText('Clear filter'));
		expect(onChange).toHaveBeenCalledWith('');
	});

	it('clears on Escape and stops the key there', () => {
		const onChange = vi.fn();
		render(
			<FilterInput theme={mockTheme} value="tree" onChange={onChange} placeholder="Filter..." />
		);

		const event = createEscapeEvent();
		fireEvent(screen.getByPlaceholderText('Filter...'), event);

		expect(onChange).toHaveBeenCalledWith('');
		expect(event.defaultPrevented).toBe(true);
	});

	it('lets Escape through when the box is already empty', () => {
		const onChange = vi.fn();
		const onKeyDown = vi.fn();
		render(
			<FilterInput
				theme={mockTheme}
				value=""
				onChange={onChange}
				onKeyDown={onKeyDown}
				placeholder="Filter..."
			/>
		);

		const event = createEscapeEvent();
		fireEvent(screen.getByPlaceholderText('Filter...'), event);

		expect(onChange).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
		expect(onKeyDown).toHaveBeenCalled();
	});

	it('forwards other keys to the consumer', () => {
		const onKeyDown = vi.fn();
		render(
			<FilterInput
				theme={mockTheme}
				value="tree"
				onChange={vi.fn()}
				onKeyDown={onKeyDown}
				placeholder="Filter..."
			/>
		);

		fireEvent.keyDown(screen.getByPlaceholderText('Filter...'), { key: 'ArrowDown' });
		expect(onKeyDown).toHaveBeenCalled();
	});

	it('renders the result count only when one is supplied', () => {
		const { rerender } = render(<FilterInput theme={mockTheme} value="tree" onChange={vi.fn()} />);
		expect(screen.queryByText('3/77')).not.toBeInTheDocument();

		rerender(<FilterInput theme={mockTheme} value="tree" onChange={vi.fn()} resultLabel="3/77" />);
		expect(screen.getByText('3/77')).toBeInTheDocument();
	});

	describe('collapsible', () => {
		it('keeps the input mounted while collapsed so a host hotkey can focus it', () => {
			const ref = createRef<HTMLInputElement>();
			render(
				<FilterInput
					ref={ref}
					theme={mockTheme}
					value=""
					onChange={vi.fn()}
					collapsible
					ariaLabel="Filter memories"
				/>
			);

			// Unmounting the input when closed would null the ref, and the host's
			// `/` and Cmd+F would silently do nothing.
			expect(ref.current).toBeInstanceOf(HTMLInputElement);
			act(() => ref.current?.focus());
			expect(document.activeElement).toBe(ref.current);
		});

		it('reports expansion so the host can yield the space', () => {
			const onExpandedChange = vi.fn();
			const ref = createRef<HTMLInputElement>();
			render(
				<FilterInput
					ref={ref}
					theme={mockTheme}
					value=""
					onChange={vi.fn()}
					collapsible
					onExpandedChange={onExpandedChange}
				/>
			);

			expect(onExpandedChange).toHaveBeenLastCalledWith(false);

			act(() => ref.current?.focus());
			expect(onExpandedChange).toHaveBeenLastCalledWith(true);

			act(() => ref.current?.blur());
			expect(onExpandedChange).toHaveBeenLastCalledWith(false);
		});

		it('stays open while a query is live, even unfocused', () => {
			const onExpandedChange = vi.fn();
			// Collapsing over a live query would hide the reason the list is short.
			render(
				<FilterInput
					theme={mockTheme}
					value="tree"
					onChange={vi.fn()}
					collapsible
					onExpandedChange={onExpandedChange}
					resultLabel="3/77"
				/>
			);

			expect(onExpandedChange).toHaveBeenLastCalledWith(true);
			expect(screen.getByText('3/77')).toBeInTheDocument();
		});

		it('does not report expansion at all when not collapsible', () => {
			const onExpandedChange = vi.fn();
			render(
				<FilterInput
					theme={mockTheme}
					value=""
					onChange={vi.fn()}
					onExpandedChange={onExpandedChange}
				/>
			);

			expect(onExpandedChange).not.toHaveBeenCalled();
		});
	});
});

function createEscapeEvent(): KeyboardEvent {
	return new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
}
