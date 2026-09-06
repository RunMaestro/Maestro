/**
 * Tests for HeaderActionButton - the labeled accent action in a panel header.
 *
 * The sizing assertions are the point of the file: five hand-rolled copies had
 * drifted to `text-sm`, which is the header TITLE's size, so the button read as
 * heavy as the heading it sits beside. Pinning `text-xs` here stops a future
 * edit from quietly restoring that.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HeaderActionButton } from '../../../../renderer/components/ui/HeaderActionButton';
import { mockTheme } from '../../../helpers/mockTheme';

describe('HeaderActionButton', () => {
	it('renders its label and fires onClick', () => {
		const onClick = vi.fn();
		render(
			<HeaderActionButton theme={mockTheme} onClick={onClick}>
				New Memory
			</HeaderActionButton>
		);

		const button = screen.getByRole('button', { name: 'New Memory' });
		button.click();
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it('sits one step below the header title rather than matching it', () => {
		render(
			<HeaderActionButton theme={mockTheme} onClick={vi.fn()}>
				New Session
			</HeaderActionButton>
		);

		const button = screen.getByRole('button', { name: 'New Session' });
		expect(button.className).toContain('text-xs');
		expect(button.className).not.toContain('text-sm');
	});

	it('fills with the accent color by default', () => {
		render(
			<HeaderActionButton theme={mockTheme} onClick={vi.fn()}>
				Resume
			</HeaderActionButton>
		);

		const button = screen.getByRole('button', { name: 'Resume' });
		expect(button.style.backgroundColor).toBeTruthy();
	});

	it('renders the ghost variant without an accent fill', () => {
		// A secondary action beside a primary one must not compete with it.
		render(
			<HeaderActionButton theme={mockTheme} onClick={vi.fn()} variant="ghost">
				Graph
			</HeaderActionButton>
		);

		const button = screen.getByRole('button', { name: 'Graph' });
		expect(button.style.backgroundColor).toBe('');
	});

	it('sizes the icon it is given, so callers do not have to', () => {
		render(
			<HeaderActionButton theme={mockTheme} onClick={vi.fn()} icon={<svg data-testid="icon" />}>
				New
			</HeaderActionButton>
		);

		const wrapper = screen.getByTestId('icon').parentElement;
		expect(wrapper?.className).toContain('[&>svg]:w-3.5');
	});

	it('does not fire while disabled', () => {
		const onClick = vi.fn();
		render(
			<HeaderActionButton theme={mockTheme} onClick={onClick} disabled>
				New Memory
			</HeaderActionButton>
		);

		const button = screen.getByRole('button', { name: 'New Memory' });
		button.click();
		expect(onClick).not.toHaveBeenCalled();
		expect((button as HTMLButtonElement).disabled).toBe(true);
	});
});
