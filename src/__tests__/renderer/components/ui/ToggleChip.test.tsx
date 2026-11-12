/**
 * Tests for ToggleChip.
 *
 * The chip is the control behind a "pick any of these" row. What a caller cannot
 * see by eye: it is a real toggle button (pressed state announced), it reports
 * the NEXT state rather than a click, and "selected" is never colour alone.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToggleChip } from '../../../../renderer/components/ui/ToggleChip';
import { mockTheme } from '../../../helpers/mockTheme';

const renderChip = (props: Partial<ComponentProps<typeof ToggleChip>> = {}) => {
	const onToggle = vi.fn();
	const view = render(
		<ToggleChip theme={mockTheme} label="Hooks" selected={false} onToggle={onToggle} {...props} />
	);
	return { onToggle, ...view };
};

describe('ToggleChip', () => {
	it('renders a button named by its label', () => {
		renderChip();

		expect(screen.getByRole('button', { name: 'Hooks' })).toBeInTheDocument();
	});

	it('announces whether it is pressed', () => {
		const { rerender, onToggle } = renderChip({ selected: false });
		expect(screen.getByRole('button', { name: 'Hooks' })).toHaveAttribute('aria-pressed', 'false');

		rerender(<ToggleChip theme={mockTheme} label="Hooks" selected onToggle={onToggle} />);
		expect(screen.getByRole('button', { name: 'Hooks' })).toHaveAttribute('aria-pressed', 'true');
	});

	it('reports the next state when clicked', () => {
		const { onToggle, rerender } = renderChip({ selected: false });

		fireEvent.click(screen.getByRole('button', { name: 'Hooks' }));
		expect(onToggle).toHaveBeenLastCalledWith(true);

		rerender(<ToggleChip theme={mockTheme} label="Hooks" selected onToggle={onToggle} />);
		fireEvent.click(screen.getByRole('button', { name: 'Hooks' }));
		expect(onToggle).toHaveBeenLastCalledWith(false);
		expect(onToggle).toHaveBeenCalledTimes(2);
	});

	it('draws a check mark only while selected, so the state is not colour alone', () => {
		const { container, rerender, onToggle } = renderChip({ selected: false });
		expect(container.querySelector('svg')).toBeNull();

		rerender(<ToggleChip theme={mockTheme} label="Hooks" selected onToggle={onToggle} />);
		const check = container.querySelector('svg');
		expect(check).not.toBeNull();
		expect(check).toHaveAttribute('aria-hidden', 'true');
		// The mark is decoration: the chip's name stays the label alone.
		expect(screen.getByRole('button', { name: 'Hooks' })).toBeInTheDocument();
	});

	it('takes its colours from the theme', () => {
		const { rerender, onToggle } = renderChip({ selected: false });
		const chip = () => screen.getByRole('button', { name: 'Hooks' });
		expect(chip()).toHaveStyle({
			borderColor: mockTheme.colors.border,
			color: mockTheme.colors.textDim,
		});

		rerender(<ToggleChip theme={mockTheme} label="Hooks" selected onToggle={onToggle} />);
		expect(chip()).toHaveStyle({
			borderColor: mockTheme.colors.accent,
			backgroundColor: mockTheme.colors.accentDim,
			color: mockTheme.colors.accent,
		});
	});

	it('does not toggle while disabled', () => {
		const { onToggle } = renderChip({ disabled: true });
		const chip = screen.getByRole('button', { name: 'Hooks' });

		expect(chip).toBeDisabled();
		fireEvent.click(chip);
		expect(onToggle).not.toHaveBeenCalled();
	});

	it('forwards the tooltip and the test id', () => {
		renderChip({ title: 'Run hooks on every tool call', testId: 'chip-hooks' });

		const chip = screen.getByTestId('chip-hooks');
		expect(chip).toHaveAttribute('title', 'Run hooks on every tool call');
	});
});
