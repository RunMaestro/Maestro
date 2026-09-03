import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FontSizeStepper } from '../../../../renderer/components/ui/FontSizeStepper';
import { mockTheme } from '../../../helpers/mockTheme';

function renderStepper(props: Partial<Parameters<typeof FontSizeStepper>[0]> = {}) {
	const onChange = vi.fn();
	render(
		<FontSizeStepper
			theme={mockTheme}
			value={0}
			inheritedSize={15}
			onChange={onChange}
			testId="size"
			{...props}
		/>
	);
	return { onChange };
}

afterEach(cleanup);

describe('FontSizeStepper', () => {
	it('steps by one pixel from the size the user can currently see', () => {
		const { onChange } = renderStepper({ value: 0, inheritedSize: 15 });

		fireEvent.click(screen.getByTestId('size-increase'));
		expect(onChange).toHaveBeenCalledWith(16);

		fireEvent.click(screen.getByTestId('size-decrease'));
		expect(onChange).toHaveBeenCalledWith(14);
	});

	it('shows the effective size as a bare number, inheriting or not', () => {
		// The number lives in a fixed-width slot, so it must stay a number: an
		// "Inherit (15px)" label sizes past that slot and shifts the plus button
		// out from under the cursor the moment the surface stops inheriting.
		renderStepper({ value: 0, inheritedSize: 15 });
		expect(screen.getByTestId('size-value')).toHaveTextContent('15px');
		expect(screen.getByTestId('size-value')).toHaveAttribute(
			'title',
			'Inheriting the interface size (15px)'
		);

		cleanup();
		renderStepper({ value: 12, inheritedSize: 15 });
		expect(screen.getByTestId('size-value')).toHaveTextContent('12px');
	});

	it('names the inherited state in the trailing slot rather than the value', () => {
		renderStepper({ value: 0, inheritedSize: 15 });

		expect(screen.getByTestId('size-inheriting')).toHaveTextContent('Inherited');
		// Nothing to escape back to, so no live control that would do nothing.
		expect(screen.queryByTestId('size-inherit')).not.toBeInTheDocument();
	});

	it('offers the escape back to inheriting once a surface carries its own size', () => {
		const { onChange } = renderStepper({ value: 12, inheritedSize: 15 });

		fireEvent.click(screen.getByTestId('size-inherit'));
		expect(onChange).toHaveBeenCalledWith(0);
		expect(screen.queryByTestId('size-inheriting')).not.toBeInTheDocument();
	});

	it('reserves the trailing slot even where inheriting is impossible', () => {
		// The interface surface is the base and has nothing to inherit from, but
		// it sits beside the terminal in the first grid row: drop the slot and
		// the two rows of controls no longer line up.
		const { container } = render(
			<FontSizeStepper
				theme={mockTheme}
				value={15}
				inheritedSize={15}
				allowInherit={false}
				onChange={vi.fn()}
				testId="base"
			/>
		);

		expect(screen.queryByTestId('base-inherit')).not.toBeInTheDocument();
		expect(screen.queryByTestId('base-inheriting')).not.toBeInTheDocument();
		expect(container.querySelector('.w-16')).toBeInTheDocument();
	});

	it('clamps at the surface size bounds', () => {
		const { onChange } = renderStepper({ value: 8, inheritedSize: 15 });
		expect(screen.getByTestId('size-decrease')).toBeDisabled();

		cleanup();
		renderStepper({ value: 32, inheritedSize: 15 });
		expect(screen.getByTestId('size-increase')).toBeDisabled();
		expect(onChange).not.toHaveBeenCalled();
	});

	it('draws the stepper buttons in the app stepper language', () => {
		renderStepper({ value: 12 });

		for (const id of ['size-decrease', 'size-increase']) {
			const button = screen.getByTestId(id);
			expect(button.className).toContain('w-7 h-7');
			expect(button.className).toContain('focus-ring');
			// A white wash is invisible on a light theme, so the hover is the
			// theme's own activity color.
			expect(button.className).not.toContain('hover:bg-white');
			expect(button).toHaveAttribute('title');
		}
	});
});
