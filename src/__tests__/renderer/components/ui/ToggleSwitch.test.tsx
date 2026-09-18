/**
 * Tests for ToggleSwitch component
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToggleSwitch, ToggleSwitchTrack } from '../../../../renderer/components/ui/ToggleSwitch';
import { mockTheme } from '../../../helpers/mockTheme';

/** The pill graphic lives inside the button, so color assertions target it. */
const trackOf = (toggle: HTMLElement): HTMLElement => toggle.firstElementChild as HTMLElement;

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

	it('marks itself busy, shows a spinner, and refuses input while busy', () => {
		const onChange = vi.fn();
		const { container } = render(
			<ToggleSwitch checked={false} onChange={onChange} theme={mockTheme} busy />
		);
		const toggle = screen.getByRole('switch');
		expect(toggle).toHaveAttribute('aria-busy', 'true');
		expect(toggle).toBeDisabled();
		expect(container.querySelector('.animate-spin')).toBeTruthy();

		fireEvent.click(toggle);
		expect(onChange).not.toHaveBeenCalled();
	});

	it('omits aria-busy when it is not busy', () => {
		render(<ToggleSwitch checked={false} onChange={vi.fn()} theme={mockTheme} />);
		expect(screen.getByRole('switch')).not.toHaveAttribute('aria-busy');
	});

	it('uses the theme accent when checked, or activeColor when one is given', () => {
		const { rerender } = render(
			<ToggleSwitch checked={true} onChange={vi.fn()} theme={mockTheme} />
		);
		expect(trackOf(screen.getByRole('switch')).style.backgroundColor).toBe('rgb(189, 147, 249)');

		rerender(
			<ToggleSwitch checked={true} onChange={vi.fn()} theme={mockTheme} activeColor="#22c55e" />
		);
		expect(trackOf(screen.getByRole('switch')).style.backgroundColor).toBe('rgb(34, 197, 94)');
	});

	it('renders the compact pill when size is sm', () => {
		const { rerender } = render(
			<ToggleSwitch checked={false} onChange={vi.fn()} theme={mockTheme} />
		);
		expect(trackOf(screen.getByRole('switch')).className).toContain('w-10 h-5');

		rerender(<ToggleSwitch checked={false} onChange={vi.fn()} theme={mockTheme} size="sm" />);
		expect(trackOf(screen.getByRole('switch')).className).toContain('w-8 h-4');
	});
});

describe('ToggleSwitchTrack', () => {
	it('renders no click target of its own so it can nest inside a host switch', () => {
		const { container } = render(<ToggleSwitchTrack checked={false} theme={mockTheme} />);
		expect(container.querySelector('button')).toBeNull();
		expect(container.querySelector('[role="switch"]')).toBeNull();
	});

	it('honors inactiveColor for the unchecked track', () => {
		const { container } = render(
			<ToggleSwitchTrack checked={false} theme={mockTheme} inactiveColor="#22c55e" />
		);
		expect((container.firstElementChild as HTMLElement).style.backgroundColor).toBe(
			'rgb(34, 197, 94)'
		);
	});
});
