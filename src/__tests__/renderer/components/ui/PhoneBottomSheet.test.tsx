/**
 * Tests for PhoneBottomSheet - the shared bottom-sheet shell behind every phone
 * surface that is an anchored popover on desktop (the tab action menu, the
 * composer options sheet).
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
	PhoneBottomSheet,
	PHONE_SHEET_SCRIM_ARM_MS,
} from '../../../../renderer/components/ui/PhoneBottomSheet';
import { mockTheme } from '../../../helpers/mockTheme';

function renderSheet(overrides: Partial<React.ComponentProps<typeof PhoneBottomSheet>> = {}) {
	const props: React.ComponentProps<typeof PhoneBottomSheet> = {
		open: true,
		onClose: vi.fn(),
		theme: mockTheme,
		ariaLabel: 'Test sheet',
		testId: 'test-sheet',
		children: <div data-testid="sheet-content">body</div>,
		...overrides,
	};
	return { ...props, ...render(<PhoneBottomSheet {...props} />) };
}

describe('PhoneBottomSheet', () => {
	it('renders nothing while closed', () => {
		renderSheet({ open: false });
		expect(screen.queryByTestId('sheet-content')).not.toBeInTheDocument();
	});

	it('renders the body inside a labelled modal dialog', () => {
		renderSheet();
		const dialog = screen.getByRole('dialog');
		expect(dialog).toHaveAttribute('aria-modal', 'true');
		expect(dialog).toHaveAttribute('aria-label', 'Test sheet');
		expect(screen.getByTestId('sheet-content')).toBeInTheDocument();
	});

	it('caps the panel at the requested height', () => {
		renderSheet({ maxHeight: '50dvh' });
		expect(screen.getByRole('dialog').style.maxHeight).toBe('50dvh');
	});

	it('defaults the panel height to 80dvh', () => {
		renderSheet();
		expect(screen.getByRole('dialog').style.maxHeight).toBe('80dvh');
	});

	it('closes on the close button', () => {
		const onClose = vi.fn();
		renderSheet({ onClose });
		fireEvent.click(screen.getByLabelText('Close'));
		expect(onClose).toHaveBeenCalled();
	});

	it('ignores a scrim tap inside the arm window', () => {
		// A sheet opened by a long-press gets a synthesized click at the finger's
		// position the moment it lifts, which lands on the scrim covering the
		// control. Answering it would close the sheet before it could be read.
		vi.useFakeTimers();
		try {
			const onClose = vi.fn();
			renderSheet({ onClose });
			fireEvent.click(screen.getByTestId('test-sheet'));
			expect(onClose).not.toHaveBeenCalled();

			vi.advanceTimersByTime(PHONE_SHEET_SCRIM_ARM_MS + 1);
			fireEvent.click(screen.getByTestId('test-sheet'));
			expect(onClose).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('answers a scrim tap immediately when the arm window is zero', () => {
		// A sheet opened by a plain tap has no trailing synthesized click, so
		// arming it would just make the first dismissal feel broken.
		const onClose = vi.fn();
		renderSheet({ onClose, scrimArmMs: 0 });
		fireEvent.click(screen.getByTestId('test-sheet'));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('does not close when the tap lands inside the panel', () => {
		const onClose = vi.fn();
		renderSheet({ onClose, scrimArmMs: 0 });
		fireEvent.click(screen.getByTestId('sheet-content'));
		expect(onClose).not.toHaveBeenCalled();
	});

	it('hands the scrim to scrimRef, not the panel', () => {
		// TabOverlayPortal's click-outside treats anything inside the ref as
		// inside the menu; the scrim spans the screen so the sheet owns its own
		// dismissal.
		const scrimRef = vi.fn();
		renderSheet({ scrimRef });
		expect(scrimRef).toHaveBeenCalledWith(screen.getByTestId('test-sheet'));
	});

	it('applies the caller styling hooks to the scrim and the body', () => {
		renderSheet({ scrimClassName: 'my-scrim', bodyClassName: 'my-body' });
		expect(screen.getByTestId('test-sheet')).toHaveClass('my-scrim');
		expect(screen.getByTestId('sheet-content').parentElement).toHaveClass('my-body');
	});

	it('renders an optional header between the grip and the body', () => {
		renderSheet({ header: <div data-testid="sheet-header">header</div> });
		expect(screen.getByTestId('sheet-header')).toBeInTheDocument();
	});
});
