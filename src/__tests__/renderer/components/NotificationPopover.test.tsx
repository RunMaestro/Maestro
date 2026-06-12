/**
 * Tests for NotificationPopover — popover for toggling notification types.
 *
 * Characterization tests for Tier 2 listener-hygiene refactor: pin down the
 * Escape-key dismissal and listener cleanup before swapping to useEventListener.
 */

import { useRef, type RefObject } from 'react';
import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NotificationPopover } from '../../../renderer/components/NotificationPopover';
import { mockTheme } from '../../helpers/mockTheme';
import { spyOnListeners, expectAllListenersRemoved } from '../../helpers/listenerLeakAssertions';

// useClickOutside also attaches listeners; stub it so we only measure the
// popover's own keydown listener in the leak assertion.
vi.mock('../../../renderer/hooks/ui/useClickOutside', () => ({
	useClickOutside: vi.fn(),
}));

// Test harness: provide an anchor ref backed by a real element so the popover
// can measure its bounding rect and render.
function Harness({ onClose }: { onClose: () => void }) {
	const anchorRef = useRef<HTMLButtonElement>(null);
	return (
		<>
			<button ref={anchorRef} data-testid="anchor">
				anchor
			</button>
			<NotificationPopover
				theme={mockTheme}
				anchorRef={anchorRef as RefObject<HTMLElement | null>}
				onClose={onClose}
			/>
		</>
	);
}

describe('NotificationPopover', () => {
	let onClose: ReturnType<typeof vi.fn>;
	let originalGetBoundingClientRect: typeof HTMLElement.prototype.getBoundingClientRect;

	beforeEach(() => {
		onClose = vi.fn();
		// Provide a non-zero rect so the popover renders (it bails out if rect is null).
		// Save the original so we can restore it in afterEach — vi.clearAllMocks()
		// does NOT undo prototype-method assignments, and leaving the mock in place
		// pollutes other tests in the same vitest worker.
		originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
		HTMLElement.prototype.getBoundingClientRect = vi.fn(() => ({
			top: 100,
			left: 100,
			right: 200,
			bottom: 150,
			width: 100,
			height: 50,
			x: 100,
			y: 100,
			toJSON: () => ({}),
		})) as never;
	});

	afterEach(() => {
		HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
		vi.clearAllMocks();
	});

	it('calls onClose on Escape key', () => {
		render(<Harness onClose={onClose} />);
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('ignores non-Escape keys', () => {
		render(<Harness onClose={onClose} />);
		fireEvent.keyDown(document, { key: 'Enter' });
		fireEvent.keyDown(document, { key: 'a' });
		fireEvent.keyDown(document, { key: 'ArrowDown' });
		expect(onClose).not.toHaveBeenCalled();
	});

	it('does not call onClose after unmount', () => {
		const { unmount } = render(<Harness onClose={onClose} />);
		unmount();
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(onClose).not.toHaveBeenCalled();
	});

	it('removes its keydown listener on unmount (no leak)', () => {
		const spies = spyOnListeners(document);
		try {
			const { unmount } = render(<Harness onClose={onClose} />);
			unmount();
			expectAllListenersRemoved(spies.addSpy, spies.removeSpy);
		} finally {
			// Restore in finally so the document spy is undone even if the
			// assertion throws — otherwise the prototype patch leaks into the
			// next test in this worker.
			spies.restore();
		}
	});
});
