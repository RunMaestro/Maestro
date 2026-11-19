/**
 * Tests for ToggleChipGroup, the multi-select counterpart to SegmentedControl.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToggleChipGroup } from '../../../../renderer/components/ui/ToggleChipGroup';
import { mockTheme } from '../../../helpers/mockTheme';

const OPTIONS = [
	{ value: 'lint', label: 'Lint' },
	{ value: 'types', label: 'Types' },
	{ value: 'tests', label: 'Tests', title: 'Unit tests' },
];

function renderGroup(selected: string[], onChange = vi.fn(), extra = {}) {
	render(
		<ToggleChipGroup
			selected={selected}
			onChange={onChange}
			options={OPTIONS}
			theme={mockTheme}
			ariaLabel="Checks"
			testId="checks"
			{...extra}
		/>
	);
	return onChange;
}

describe('ToggleChipGroup', () => {
	it('renders one toggle button per option, pressed when selected', () => {
		renderGroup(['types']);
		expect(screen.getByRole('group', { name: 'Checks' })).toBeInTheDocument();
		expect(screen.getByTestId('checks-lint')).toHaveAttribute('aria-pressed', 'false');
		expect(screen.getByTestId('checks-types')).toHaveAttribute('aria-pressed', 'true');
		expect(screen.getByTestId('checks-tests')).toHaveAttribute('title', 'Unit tests');
	});

	it('adds a chip in option order, not click order', () => {
		const onChange = renderGroup(['tests']);
		fireEvent.click(screen.getByTestId('checks-lint'));
		expect(onChange).toHaveBeenCalledWith(['lint', 'tests']);
	});

	it('removes a selected chip', () => {
		const onChange = renderGroup(['lint', 'types']);
		fireEvent.click(screen.getByTestId('checks-lint'));
		expect(onChange).toHaveBeenCalledWith(['types']);
	});

	it('keeps a selected value the options do not list', () => {
		const onChange = renderGroup(['legacy', 'lint']);
		fireEvent.click(screen.getByTestId('checks-types'));
		expect(onChange).toHaveBeenCalledWith(['lint', 'types', 'legacy']);
	});

	it('marks the group invalid and disables chips on request', () => {
		renderGroup([], vi.fn(), { invalid: true, disabled: true });
		expect(screen.getByRole('group')).toHaveAttribute('aria-invalid', 'true');
		expect(screen.getByTestId('checks-lint')).toBeDisabled();
	});
});
