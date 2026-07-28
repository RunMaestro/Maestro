/**
 * Tests for ToggleSwitch component
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToggleSwitch } from '../../../../renderer/components/ui/ToggleSwitch';
import { mockTheme } from '../../../helpers/mockTheme';

describe('ToggleSwitch', () => {
	it('renders as a switch with aria-checked reflecting the state', () => {
		render(<ToggleSwitch checked={true} onChange={vi.fn()} theme={mockTheme} />);
		const toggle = screen.getByRole('switch');
		expect(toggle).toHaveAttribute('aria-checked', 'true');
	});

	it('reports the toggled value on click', () => {
		const onChange = vi.fn();
		render(<ToggleSwitch checked={false} onChange={onChange} theme={mockTheme} />);
		fireEvent.click(screen.getByRole('switch'));
		expect(onChange).toHaveBeenCalledWith(true);
	});

	it('exposes ariaLabel and title', () => {
		render(
			<ToggleSwitch
				checked={false}
				onChange={vi.fn()}
				theme={mockTheme}
				ariaLabel="Show commands"
				title="Show in autocomplete"
			/>
		);
		const toggle = screen.getByRole('switch', { name: 'Show commands' });
		expect(toggle).toHaveAttribute('title', 'Show in autocomplete');
	});

	it('does not fire onChange while disabled', () => {
		const onChange = vi.fn();
		render(<ToggleSwitch checked={false} onChange={onChange} theme={mockTheme} disabled />);
		fireEvent.click(screen.getByRole('switch'));
		expect(onChange).not.toHaveBeenCalled();
	});
});
