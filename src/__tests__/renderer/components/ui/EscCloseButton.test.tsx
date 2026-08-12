/**
 * Tests for EscCloseButton.
 *
 * The pill used to be an inert `<div>` in nine places, which meant every one of
 * those surfaces advertised an exit that only worked from a keyboard. These
 * tests pin the two things that matter: it is a real button, and it fires.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EscCloseButton } from '../../../../renderer/components/ui/EscCloseButton';
import { mockTheme } from '../../../helpers/mockTheme';

// isCoarsePointer() reads window.matchMedia('(pointer: coarse)'). jsdom has no
// matchMedia, so the default is a fine (non-coarse) pointer; define it to
// drive the touch branch.
const originalMatchMedia = window.matchMedia;

function setCoarsePointer(coarse: boolean) {
	Object.defineProperty(window, 'matchMedia', {
		writable: true,
		configurable: true,
		value: (query: string) => ({
			matches: coarse,
			media: query,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			onchange: null,
			dispatchEvent: vi.fn(),
		}),
	});
}

afterEach(() => {
	Object.defineProperty(window, 'matchMedia', {
		writable: true,
		configurable: true,
		value: originalMatchMedia,
	});
});

describe('EscCloseButton', () => {
	it('renders a labelled button and calls onClose when clicked', () => {
		const onClose = vi.fn();
		render(<EscCloseButton theme={mockTheme} onClose={onClose} />);

		const button = screen.getByRole('button', { name: 'Close (Esc)' });
		expect(button).toHaveTextContent('ESC');

		fireEvent.click(button);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('accepts a surface-specific label', () => {
		render(<EscCloseButton theme={mockTheme} onClose={vi.fn()} label="Close filter (Esc)" />);

		expect(screen.getByRole('button', { name: 'Close filter (Esc)' })).toHaveAttribute(
			'title',
			'Close filter (Esc)'
		);
	});

	it('positions itself inside the input when used as an adornment', () => {
		render(<EscCloseButton theme={mockTheme} onClose={vi.fn()} variant="adornment" />);

		expect(screen.getByRole('button', { name: 'Close (Esc)' }).className).toContain('absolute');
	});

	// The pill sits inside clickable rows and draggable headers; the click must
	// not also land on whatever is underneath it.
	it('stops the click from reaching an enclosing handler', () => {
		const onParentClick = vi.fn();
		const onClose = vi.fn();
		render(
			<div onClick={onParentClick}>
				<EscCloseButton theme={mockTheme} onClose={onClose} />
			</div>
		);

		fireEvent.click(screen.getByRole('button', { name: 'Close (Esc)' }));
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onParentClick).not.toHaveBeenCalled();
	});

	// A phone/tablet has no Escape key, so the "ESC" keycap names a control the
	// user does not have. Same button and handler either way - only the glyph
	// changes. (Carried over from the retired EscCloseHint.)
	describe('coarse pointers', () => {
		it('renders the ESC keycap on fine pointers', () => {
			setCoarsePointer(false);
			render(<EscCloseButton theme={mockTheme} onClose={vi.fn()} />);

			expect(screen.getByRole('button', { name: 'Close (Esc)' })).toHaveTextContent('ESC');
		});

		it('swaps the keycap for an X glyph on touch, and still closes', () => {
			const onClose = vi.fn();
			setCoarsePointer(true);
			render(<EscCloseButton theme={mockTheme} onClose={onClose} />);

			expect(screen.queryByText('ESC')).not.toBeInTheDocument();
			const button = screen.getByRole('button', { name: 'Close (Esc)' });
			fireEvent.click(button);
			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});
});
