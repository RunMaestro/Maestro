/**
 * Tests for LaunchCheckbox: the labeled checkbox row of the launch dialog.
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LaunchCheckbox } from '../../../../../renderer/components/MarketplaceModal/launch/LaunchCheckbox';
import { mockTheme } from '../../../../helpers/mockTheme';

function renderCheckbox(props: Partial<React.ComponentProps<typeof LaunchCheckbox>> = {}) {
	const onChange = vi.fn();
	render(
		<LaunchCheckbox
			theme={mockTheme}
			checked={false}
			onChange={onChange}
			label="I understand"
			{...props}
		/>
	);
	return { onChange };
}

describe('LaunchCheckbox', () => {
	it('is a checkbox named by its label', () => {
		renderCheckbox();

		expect(screen.getByRole('checkbox', { name: /I understand/ })).not.toBeChecked();
	});

	it('shows the state it is given', () => {
		renderCheckbox({ checked: true });

		expect(screen.getByRole('checkbox')).toBeChecked();
	});

	it('reports the next state when the box is clicked', () => {
		const { onChange } = renderCheckbox();

		fireEvent.click(screen.getByRole('checkbox'));

		expect(onChange).toHaveBeenCalledWith(true);
	});

	it('reports the next state when the label text is clicked', () => {
		const { onChange } = renderCheckbox({ checked: true });

		fireEvent.click(screen.getByText('I understand'));

		expect(onChange).toHaveBeenCalledWith(false);
	});

	it('describes the box with its help text', () => {
		renderCheckbox({ help: 'Keeps it after the run.' });

		expect(screen.getByRole('checkbox')).toHaveAccessibleDescription('Keeps it after the run.');
	});

	it('has no description without help text', () => {
		renderCheckbox();

		expect(screen.getByRole('checkbox')).not.toHaveAttribute('aria-describedby');
	});

	it('cannot be clicked while disabled', () => {
		const { onChange } = renderCheckbox({ disabled: true });

		expect(screen.getByRole('checkbox')).toBeDisabled();
		fireEvent.click(screen.getByRole('checkbox'));
		expect(onChange).not.toHaveBeenCalled();
	});

	it('takes the accent color from the theme', () => {
		renderCheckbox({ testId: 'row' });

		expect(screen.getByRole('checkbox')).toHaveStyle({ accentColor: mockTheme.colors.accent });
		expect(screen.getByTestId('row')).toBeInTheDocument();
	});
});
