import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OrnateFrame } from '../../../../renderer/components/DidYouKnow/OrnateFrame';
import {
	APERTURE_INSET,
	FRAME_ASPECT,
} from '../../../../renderer/components/DidYouKnow/frameGeometry';

describe('OrnateFrame', () => {
	it('clips artwork behind the frame without letting content size the shell', () => {
		const { container, rerender } = render(
			<OrnateFrame className="w-full">
				<img alt="Feature preview" src="preview.png" />
			</OrnateFrame>
		);
		const shell = container.firstElementChild as HTMLElement;
		const aperture = screen.getByRole('img', { name: 'Feature preview' }).parentElement!;
		expect(shell).toHaveClass('relative', 'w-full');
		expect(shell.style.aspectRatio).toBe(String(FRAME_ASPECT));
		expect(aperture).toHaveClass('absolute', 'overflow-hidden', 'rounded-[2px]');
		expect(aperture).toHaveStyle({
			left: `${APERTURE_INSET.left}%`,
			top: `${APERTURE_INSET.top}%`,
			right: `${APERTURE_INSET.right}%`,
			bottom: `${APERTURE_INSET.bottom}%`,
		});
		expect(aperture.nextElementSibling).toBe(shell.lastElementChild);
		expect(shell.lastElementChild).toHaveClass('absolute', 'inset-0', 'w-full', 'h-full');

		rerender(
			<OrnateFrame className="w-full">
				<div style={{ height: 2000 }}>Tall artwork</div>
			</OrnateFrame>
		);
		expect(shell.style.aspectRatio).toBe(String(FRAME_ASPECT));
		expect(screen.getByText('Tall artwork').parentElement).toBe(aperture);
	});

	it('keeps the decoration silent and non-interactive while preserving artwork interaction', () => {
		const onClick = vi.fn();
		const { container } = render(
			<OrnateFrame>
				<button onClick={onClick}>Explore feature</button>
			</OrnateFrame>
		);
		expect(screen.queryByRole('img')).not.toBeInTheDocument();
		const decoration = container.querySelector('img')!;
		expect(decoration).toHaveAttribute('alt', '');
		expect(decoration).toHaveAttribute('aria-hidden', 'true');
		expect(decoration).toHaveAttribute('draggable', 'false');
		expect(decoration).toHaveClass('pointer-events-none', 'select-none');
		expect(decoration.getAttribute('src')).toContain('did-you-know-frame.png');
		fireEvent.click(screen.getByRole('button', { name: 'Explore feature' }));
		expect(onClick).toHaveBeenCalledOnce();
	});
});
