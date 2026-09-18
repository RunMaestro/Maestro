/**
 * Tests for TabOverlayPortal - the one shell every tab chip's action menu is
 * drawn in. Anchored popover on desktop; a dismissable, scrollable bottom sheet
 * on a phone, where the anchored menu used to run off the bottom of the screen
 * with no way to scroll it and no way to close it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
	TabOverlayPortal,
	TAB_SHEET_SCRIM_ARM_MS,
} from '../../../../renderer/components/TabBar/TabOverlayPortal';
import { usePhoneLayout } from '../../../../renderer/hooks/ui/useViewportBreakpoint';
import { mockTheme } from '../../../helpers/mockTheme';

vi.mock('../../../../renderer/hooks/ui/useViewportBreakpoint', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../renderer/hooks/ui/useViewportBreakpoint')>()),
	usePhoneLayout: vi.fn(() => false),
}));
const mockedUsePhoneLayout = vi.mocked(usePhoneLayout);

function renderPortal(overrides: Partial<React.ComponentProps<typeof TabOverlayPortal>> = {}) {
	const props: React.ComponentProps<typeof TabOverlayPortal> = {
		open: true,
		position: { top: 40, left: 120, tabWidth: 90 },
		positionReady: true,
		setOverlayRef: vi.fn(),
		onMouseEnter: vi.fn(),
		onMouseLeave: vi.fn(),
		onClose: vi.fn(),
		theme: mockTheme,
		children: <div data-testid="menu-content">menu</div>,
		...overrides,
	};
	return { ...props, ...render(<TabOverlayPortal {...props} />) };
}

afterEach(() => {
	mockedUsePhoneLayout.mockReturnValue(false);
});

describe('TabOverlayPortal', () => {
	it('renders nothing while closed', () => {
		renderPortal({ open: false });
		expect(screen.queryByTestId('menu-content')).not.toBeInTheDocument();
	});

	describe('desktop (anchored popover)', () => {
		it('anchors the menu at the measured position and fades it in once clamped', () => {
			const setOverlayRef = vi.fn();
			renderPortal({ setOverlayRef, positionReady: false });
			const shell = screen.getByTestId('menu-content').parentElement as HTMLElement;
			expect(shell.style.top).toBe('40px');
			expect(shell.style.left).toBe('120px');
			expect(shell.style.opacity).toBe('0');
			expect(setOverlayRef).toHaveBeenCalledWith(shell);
			expect(screen.queryByTestId('tab-overlay-sheet')).not.toBeInTheDocument();
		});

		it('waits for a position before drawing anything', () => {
			renderPortal({ position: null });
			expect(screen.queryByTestId('menu-content')).not.toBeInTheDocument();
		});

		it('forwards hover bookkeeping to the shell', () => {
			const onMouseEnter = vi.fn();
			const onMouseLeave = vi.fn();
			renderPortal({ onMouseEnter, onMouseLeave });
			const shell = screen.getByTestId('menu-content').parentElement as HTMLElement;
			fireEvent.mouseEnter(shell);
			fireEvent.mouseLeave(shell);
			expect(onMouseEnter).toHaveBeenCalledTimes(1);
			expect(onMouseLeave).toHaveBeenCalledTimes(1);
		});
	});

	describe('phone (bottom sheet)', () => {
		it('draws the same menu content inside a dialog sheet, ignoring the anchor', () => {
			mockedUsePhoneLayout.mockReturnValue(true);
			const setOverlayRef = vi.fn();
			renderPortal({ setOverlayRef, position: null });
			expect(screen.getByTestId('tab-overlay-sheet')).toBeInTheDocument();
			const panel = screen.getByRole('dialog', { name: 'Tab actions' });
			expect(panel).toContainElement(screen.getByTestId('menu-content'));
			// useTabHoverOverlay's click-outside reads this ref. It is the SCRIM, which
			// spans the screen, so nothing counts as "outside" and the sheet owns its
			// own dismissal - the synthesized events that trail the opening long-press
			// land on the scrim and must not close it.
			expect(setOverlayRef).toHaveBeenCalledWith(screen.getByTestId('tab-overlay-sheet'));
		});

		it('closes from its own close button', () => {
			mockedUsePhoneLayout.mockReturnValue(true);
			const { onClose } = renderPortal();
			fireEvent.click(screen.getByLabelText('Close'));
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('closes on a tap on the scrim once armed, but not on a tap inside the panel', () => {
			vi.useFakeTimers();
			try {
				mockedUsePhoneLayout.mockReturnValue(true);
				const { onClose } = renderPortal();
				fireEvent.click(screen.getByTestId('menu-content'));
				expect(onClose).not.toHaveBeenCalled();
				// The click the browser synthesizes when the opening long-press ends
				// lands on the scrim within a few ms; it must not close the sheet.
				fireEvent.click(screen.getByTestId('tab-overlay-sheet'));
				expect(onClose).not.toHaveBeenCalled();
				vi.advanceTimersByTime(TAB_SHEET_SCRIM_ARM_MS + 50);
				fireEvent.click(screen.getByTestId('tab-overlay-sheet'));
				expect(onClose).toHaveBeenCalledTimes(1);
			} finally {
				vi.useRealTimers();
			}
		});

		it('closes on a swipe down from the grip', () => {
			mockedUsePhoneLayout.mockReturnValue(true);
			const { onClose } = renderPortal();
			const grip = screen.getByTestId('tab-overlay-sheet-grip');
			fireEvent.touchStart(grip, { touches: [{ clientX: 100, clientY: 500 }] });
			fireEvent.touchMove(grip, { touches: [{ clientX: 102, clientY: 560 }] });
			fireEvent.touchEnd(grip, { changedTouches: [{ clientX: 102, clientY: 600 }] });
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('does not close on a swipe up or a sideways drag', () => {
			mockedUsePhoneLayout.mockReturnValue(true);
			const { onClose } = renderPortal();
			const grip = screen.getByTestId('tab-overlay-sheet-grip');
			fireEvent.touchStart(grip, { touches: [{ clientX: 100, clientY: 500 }] });
			fireEvent.touchMove(grip, { touches: [{ clientX: 100, clientY: 440 }] });
			fireEvent.touchEnd(grip, { changedTouches: [{ clientX: 100, clientY: 400 }] });
			expect(onClose).not.toHaveBeenCalled();
		});
	});
});
