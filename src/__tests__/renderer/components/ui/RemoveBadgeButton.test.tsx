/**
 * Tests for RemoveBadgeButton - the red X that takes an attachment off a message.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RemoveBadgeButton } from '../../../../renderer/components/ui/RemoveBadgeButton';

describe('RemoveBadgeButton', () => {
	it('is a named, non-draggable button placed by its caller', () => {
		render(
			<RemoveBadgeButton
				label="Remove image 2"
				onRemove={vi.fn()}
				className="absolute top-0.5 right-0.5"
				testId="remove"
			/>
		);

		const button = screen.getByRole('button', { name: 'Remove image 2' });
		expect(button).toBe(screen.getByTestId('remove'));
		expect(button).toHaveAttribute('type', 'button');
		expect(button).toHaveAttribute('title', 'Remove image 2');
		expect(button).toHaveAttribute('draggable', 'false');
		expect(button).toHaveClass('bg-red-500', 'rounded-full', 'absolute', 'top-0.5', 'right-0.5');
		expect(screen.getByTestId('x-icon')).toBeInTheDocument();
	});

	it('removes without the click reaching the element under it', () => {
		const onRemove = vi.fn();
		const onOpen = vi.fn();
		render(
			<div onClick={onOpen}>
				<RemoveBadgeButton label="Remove pick h1" onRemove={onRemove} />
			</div>
		);

		fireEvent.click(screen.getByRole('button', { name: 'Remove pick h1' }));

		expect(onRemove).toHaveBeenCalledTimes(1);
		expect(onOpen).not.toHaveBeenCalled();
	});
});
