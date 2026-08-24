/**
 * Tests for GhostIconButton component
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GhostIconButton } from '../../../../renderer/components/ui/GhostIconButton';

describe('GhostIconButton', () => {
	it('renders children and default classes', () => {
		render(
			<GhostIconButton ariaLabel="Close">
				<span data-testid="icon">x</span>
			</GhostIconButton>
		);
		const btn = screen.getByRole('button', { name: 'Close' });
		expect(btn).toBeInTheDocument();
		expect(btn).toHaveClass('rounded');
		expect(btn).toHaveClass('hover:bg-white/10');
		expect(btn).toHaveClass('p-1');
		expect(screen.getByTestId('icon')).toBeInTheDocument();
	});

	it('centers its icon rather than baseline-aligning it', () => {
		render(
			<GhostIconButton ariaLabel="Centered">
				<span>x</span>
			</GhostIconButton>
		);
		// jsdom has no layout engine, so this guards the mechanism rather than the
		// pixels: without these the icon becomes inline content on the line box's
		// baseline, the button's height is driven by the inherited line-height
		// instead of the icon, and the icon rides above the center of its own
		// hover pill.
		const btn = screen.getByRole('button', { name: 'Centered' });
		expect(btn).toHaveClass('inline-flex');
		expect(btn).toHaveClass('items-center');
		expect(btn).toHaveClass('justify-center');
	});

	it('calls onClick when clicked', () => {
		const onClick = vi.fn();
		render(
			<GhostIconButton onClick={onClick} ariaLabel="Do it">
				<span>x</span>
			</GhostIconButton>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Do it' }));
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it('respects disabled prop', () => {
		const onClick = vi.fn();
		render(
			<GhostIconButton onClick={onClick} disabled ariaLabel="Disabled">
				<span>x</span>
			</GhostIconButton>
		);
		const btn = screen.getByRole('button', { name: 'Disabled' });
		expect(btn).toBeDisabled();
		fireEvent.click(btn);
		expect(onClick).not.toHaveBeenCalled();
	});

	it('applies custom padding', () => {
		render(
			<GhostIconButton padding="p-2" ariaLabel="Pad">
				<span>x</span>
			</GhostIconButton>
		);
		expect(screen.getByRole('button', { name: 'Pad' })).toHaveClass('p-2');
	});

	it('stops propagation when stopPropagation is true', () => {
		const parentClick = vi.fn();
		const onClick = vi.fn();
		render(
			<div onClick={parentClick}>
				<GhostIconButton onClick={onClick} stopPropagation ariaLabel="Stop">
					<span>x</span>
				</GhostIconButton>
			</div>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
		expect(onClick).toHaveBeenCalledTimes(1);
		expect(parentClick).not.toHaveBeenCalled();
	});
});
