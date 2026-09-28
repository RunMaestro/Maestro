import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HeadingPalette } from '../../../../renderer/components/FilePreview/HeadingPalette';
import { mockTheme } from '../../../helpers/mockTheme';
import type { TocEntry } from '../../../../renderer/components/FilePreview/types';

const ENTRIES: TocEntry[] = [
	{ level: 1, text: 'Reminders Archive', slug: 'reminders-archive' },
	{ level: 2, text: 'Swept 2026-09-04', slug: 'swept-2026-09-04' },
	{ level: 2, text: 'Swept 2026-09-03', slug: 'swept-2026-09-03' },
	{ level: 3, text: 'OPSWAT Equity Case', slug: 'opswat-equity-case' },
];

function renderPalette(overrides: Partial<React.ComponentProps<typeof HeadingPalette>> = {}) {
	const onJump = overrides.onJump ?? vi.fn();
	const onClose = overrides.onClose ?? vi.fn();
	const result = render(
		<HeadingPalette
			theme={mockTheme}
			entries={overrides.entries ?? ENTRIES}
			onJump={onJump}
			onClose={onClose}
		/>
	);
	return { ...result, onJump, onClose, input: screen.getByTestId('heading-palette-input') };
}

/** Text of every heading row currently rendered, top to bottom. */
function visibleHeadings(container: HTMLElement): string[] {
	return Array.from(
		container.querySelectorAll<HTMLButtonElement>('[data-testid="heading-palette-row"]')
	).map((el) => el.title);
}

describe('HeadingPalette', () => {
	describe('listing', () => {
		it('lists every heading in document order', () => {
			const { container } = renderPalette();
			expect(visibleHeadings(container)).toEqual(ENTRIES.map((e) => e.text));
		});

		it('shows the filtered / total count', () => {
			renderPalette();
			expect(screen.getByText('4 of 4')).toBeTruthy();
		});
	});

	describe('fuzzy filtering', () => {
		it('narrows to fuzzy matches', () => {
			const { container, input } = renderPalette();
			fireEvent.change(input, { target: { value: 'opswat' } });
			expect(visibleHeadings(container)).toEqual(['OPSWAT Equity Case']);
		});

		it('matches non-contiguous characters', () => {
			const { container, input } = renderPalette();
			fireEvent.change(input, { target: { value: 'oec' } });
			expect(visibleHeadings(container)).toEqual(['OPSWAT Equity Case']);
		});

		it('keeps survivors in document order rather than by score', () => {
			const { container, input } = renderPalette();
			fireEvent.change(input, { target: { value: 'swept' } });
			expect(visibleHeadings(container)).toEqual(['Swept 2026-09-04', 'Swept 2026-09-03']);
		});

		it('reports when nothing matches', () => {
			const { container, input } = renderPalette();
			fireEvent.change(input, { target: { value: 'zzzz' } });
			expect(visibleHeadings(container)).toEqual([]);
			expect(screen.getByText(/No heading matches/)).toBeTruthy();
		});
	});

	describe('jumping', () => {
		it('jumps to the clicked heading and closes', () => {
			const { onJump, onClose } = renderPalette();
			fireEvent.click(screen.getByTitle('OPSWAT Equity Case'));
			expect(onJump).toHaveBeenCalledWith(ENTRIES[3], 'smooth');
			expect(onClose).toHaveBeenCalled();
		});

		it('Enter jumps to the selected heading', () => {
			const { input, onJump, onClose } = renderPalette();
			fireEvent.keyDown(input, { key: 'ArrowDown' });
			fireEvent.keyDown(input, { key: 'Enter' });
			expect(onJump).toHaveBeenCalledWith(ENTRIES[1], 'smooth');
			expect(onClose).toHaveBeenCalled();
		});

		it('Enter jumps to the first survivor after filtering', () => {
			const { input, onJump } = renderPalette();
			fireEvent.change(input, { target: { value: 'equity' } });
			fireEvent.keyDown(input, { key: 'Enter' });
			expect(onJump).toHaveBeenCalledWith(ENTRIES[3], 'smooth');
		});

		it('does nothing on Enter when nothing matches', () => {
			const { input, onJump, onClose } = renderPalette();
			fireEvent.change(input, { target: { value: 'zzzz' } });
			fireEvent.keyDown(input, { key: 'Enter' });
			expect(onJump).not.toHaveBeenCalled();
			expect(onClose).not.toHaveBeenCalled();
		});

		it('arrow navigation wraps at the ends', () => {
			const { input, onJump } = renderPalette();
			fireEvent.keyDown(input, { key: 'ArrowUp' });
			fireEvent.keyDown(input, { key: 'Enter' });
			expect(onJump).toHaveBeenCalledWith(ENTRIES[3], 'smooth');
		});
	});

	describe('dismissal', () => {
		it('Escape closes without jumping', () => {
			const { input, onJump, onClose } = renderPalette();
			fireEvent.keyDown(input, { key: 'Escape' });
			expect(onClose).toHaveBeenCalled();
			expect(onJump).not.toHaveBeenCalled();
		});

		it('the ESC pill closes it for pointer-only users', () => {
			const { onClose } = renderPalette();
			fireEvent.click(screen.getByLabelText('Close (Esc)'));
			expect(onClose).toHaveBeenCalled();
		});

		it('a mousedown on the backdrop closes it', () => {
			const { container, onClose } = renderPalette();
			fireEvent.mouseDown(container.firstElementChild as HTMLElement);
			expect(onClose).toHaveBeenCalled();
		});

		it('a mousedown on the panel does not close it', () => {
			const { onClose, input } = renderPalette();
			fireEvent.mouseDown(input);
			expect(onClose).not.toHaveBeenCalled();
		});
	});

	describe('key containment', () => {
		it('keeps its keys away from the preview underneath', () => {
			// The preview container scrolls on arrows and zooms on bare -/0, so a
			// key that escaped the palette would move the document behind it.
			const onOuterKeyDown = vi.fn();
			render(
				<div onKeyDown={onOuterKeyDown}>
					<HeadingPalette theme={mockTheme} entries={ENTRIES} onJump={vi.fn()} onClose={vi.fn()} />
				</div>
			);
			const inputs = screen.getAllByTestId('heading-palette-input');
			const input = inputs[inputs.length - 1];
			fireEvent.keyDown(input, { key: 'ArrowDown' });
			fireEvent.keyDown(input, { key: '-' });
			fireEvent.keyDown(input, { key: '0' });
			expect(onOuterKeyDown).not.toHaveBeenCalled();
		});
	});
});
