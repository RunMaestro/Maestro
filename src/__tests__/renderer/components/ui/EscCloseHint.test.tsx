import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EscCloseHint } from '../../../../renderer/components/ui/EscCloseHint';
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

describe('EscCloseHint', () => {
	it('renders the passive ESC keycap hint on fine pointers', () => {
		setCoarsePointer(false);
		const onClose = vi.fn();
		render(<EscCloseHint theme={mockTheme} onClose={onClose} />);

		expect(screen.getByText('ESC')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
	});

	it('renders a working X close button on coarse pointers', () => {
		setCoarsePointer(true);
		const onClose = vi.fn();
		render(<EscCloseHint theme={mockTheme} onClose={onClose} />);

		expect(screen.queryByText('ESC')).not.toBeInTheDocument();
		const button = screen.getByRole('button', { name: 'Close' });
		fireEvent.click(button);
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
