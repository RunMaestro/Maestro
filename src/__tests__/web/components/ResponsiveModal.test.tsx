/**
 * Tests for ResponsiveModal component (Phase 4 Task 4.2).
 *
 * jsdom doesn't load the Tailwind stylesheet, so color/layout checks assert on
 * className substrings rather than computed styles. The useBreakpoint mock
 * flips `isPhone` per describe block to cover both responsive branches.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { ResponsiveModal } from '../../../web/components/ResponsiveModal';

// Breakpoint mock — controlled per test via `setIsPhone` / `setIsShortViewport`.
let isPhone = false;
let isShortViewport = false;
function setIsPhone(next: boolean) {
	isPhone = next;
}
function setIsShortViewport(next: boolean) {
	isShortViewport = next;
}
vi.mock('../../../web/hooks/useBreakpoint', () => ({
	useBreakpoint: () => ({
		isPhone,
		isTablet: !isPhone,
		isDesktop: false,
		tier: isPhone ? 'phone' : 'tablet',
		width: isPhone ? 320 : 1024,
		height: isShortViewport ? 375 : 800,
		isShortViewport,
	}),
}));

describe('ResponsiveModal', () => {
	beforeEach(() => {
		setIsPhone(false);
		setIsShortViewport(false);
	});

	afterEach(() => {
		cleanup();
	});

	describe('render conditions', () => {
		it('returns null when isOpen is false', () => {
			const { container } = render(
				<ResponsiveModal isOpen={false} onClose={vi.fn()} title="Hidden">
					Content
				</ResponsiveModal>
			);
			expect(container.firstChild).toBeNull();
		});

		it('renders dialog with aria-label when isOpen is true', () => {
			render(
				<ResponsiveModal isOpen onClose={vi.fn()} title="Visible">
					<p>Body</p>
				</ResponsiveModal>
			);
			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-label', 'Visible');
			expect(screen.getByText('Body')).toBeInTheDocument();
		});

		it('renders the title in the header', () => {
			render(
				<ResponsiveModal isOpen onClose={vi.fn()} title="My Title">
					Content
				</ResponsiveModal>
			);
			const heading = screen.getByRole('heading', { name: 'My Title' });
			expect(heading).toBeInTheDocument();
			expect(heading.className).toContain('text-text-main');
		});

		it('renders a header icon when provided', () => {
			render(
				<ResponsiveModal
					isOpen
					onClose={vi.fn()}
					title="With Icon"
					headerIcon={<span data-testid="icon">★</span>}
				>
					Content
				</ResponsiveModal>
			);
			expect(screen.getByTestId('icon')).toBeInTheDocument();
		});

		it('renders footer content when provided', () => {
			render(
				<ResponsiveModal isOpen onClose={vi.fn()} title="With Footer" footer={<button>OK</button>}>
					Body
				</ResponsiveModal>
			);
			expect(screen.getByRole('button', { name: 'OK' })).toBeInTheDocument();
		});
	});

	describe('close behaviour', () => {
		it('calls onClose when the close (X) button is clicked', () => {
			const onClose = vi.fn();
			render(
				<ResponsiveModal isOpen onClose={onClose} title="Closable">
					Body
				</ResponsiveModal>
			);
			fireEvent.click(screen.getByRole('button', { name: 'Close modal' }));
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('calls onClose when Escape is pressed', () => {
			const onClose = vi.fn();
			render(
				<ResponsiveModal isOpen onClose={onClose} title="Escape">
					Body
				</ResponsiveModal>
			);
			fireEvent.keyDown(document, { key: 'Escape' });
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('does not react to Escape once the modal is closed', () => {
			const onClose = vi.fn();
			const { rerender } = render(
				<ResponsiveModal isOpen onClose={onClose} title="Escape">
					Body
				</ResponsiveModal>
			);
			rerender(
				<ResponsiveModal isOpen={false} onClose={onClose} title="Escape">
					Body
				</ResponsiveModal>
			);
			fireEvent.keyDown(document, { key: 'Escape' });
			expect(onClose).not.toHaveBeenCalled();
		});

		it('calls onClose when the backdrop is clicked', () => {
			const onClose = vi.fn();
			render(
				<ResponsiveModal isOpen onClose={onClose} title="Backdrop">
					Body
				</ResponsiveModal>
			);
			// The backdrop is the parent of the dialog
			const backdrop = screen.getByRole('dialog').parentElement!;
			fireEvent.click(backdrop);
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('does not call onClose when clicking inside the dialog', () => {
			const onClose = vi.fn();
			render(
				<ResponsiveModal isOpen onClose={onClose} title="Inner">
					<div data-testid="inner">Inner content</div>
				</ResponsiveModal>
			);
			fireEvent.click(screen.getByTestId('inner'));
			expect(onClose).not.toHaveBeenCalled();
		});
	});

	describe('focus management', () => {
		it('moves focus to the dialog container on open', async () => {
			render(
				<ResponsiveModal isOpen onClose={vi.fn()} title="Focus">
					<input data-testid="first" />
					<input data-testid="second" />
				</ResponsiveModal>
			);
			await new Promise((resolve) => requestAnimationFrame(resolve));
			expect(document.activeElement).toBe(screen.getByRole('dialog'));
		});

		it('routes Tab from the container to the first focusable element', () => {
			render(
				<ResponsiveModal isOpen onClose={vi.fn()} title="Route">
					<input data-testid="first" />
					<input data-testid="second" />
				</ResponsiveModal>
			);
			const dialog = screen.getByRole('dialog');
			dialog.focus();
			fireEvent.keyDown(dialog, { key: 'Tab' });
			// First focusable in DOM is the close button
			expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close modal' }));
		});

		it('traps Tab at the last focusable element (wraps to first)', () => {
			render(
				<ResponsiveModal isOpen onClose={vi.fn()} title="Trap">
					<button data-testid="first">First</button>
					<button data-testid="last-body">Last</button>
				</ResponsiveModal>
			);
			const last = screen.getByTestId('last-body');
			last.focus();
			expect(document.activeElement).toBe(last);
			const dialog = screen.getByRole('dialog');
			fireEvent.keyDown(dialog, { key: 'Tab' });
			// Close button is the first focusable in the DOM (the header button)
			expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close modal' }));
		});

		it('traps Shift+Tab at the first focusable element (wraps to last)', () => {
			render(
				<ResponsiveModal
					isOpen
					onClose={vi.fn()}
					title="Trap"
					footer={<button data-testid="footer">Save</button>}
				>
					<button data-testid="body">Body</button>
				</ResponsiveModal>
			);
			const closeBtn = screen.getByRole('button', { name: 'Close modal' });
			closeBtn.focus();
			const dialog = screen.getByRole('dialog');
			fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
			expect(document.activeElement).toBe(screen.getByTestId('footer'));
		});
	});

	describe('phone branch', () => {
		beforeEach(() => {
			setIsPhone(true);
		});

		it('applies bottom-sheet classes at phone tier', () => {
			render(
				<ResponsiveModal isOpen onClose={vi.fn()} title="Phone">
					Body
				</ResponsiveModal>
			);
			const dialog = screen.getByRole('dialog');
			expect(dialog.className).toContain('rounded-t-2xl');
			expect(dialog.className).toContain('w-full');
			expect(dialog.className).toContain('animate-slideUp');
			// Safe-area inset is applied via the shared utility class
			expect(dialog.className).toContain('safe-area-bottom');
		});

		it('anchors the backdrop to the bottom (items-end) at phone tier', () => {
			render(
				<ResponsiveModal isOpen onClose={vi.fn()} title="Phone">
					Body
				</ResponsiveModal>
			);
			const backdrop = screen.getByRole('dialog').parentElement!;
			expect(backdrop.className).toContain('items-end');
		});

		it('stacks footer buttons vertically at phone tier', () => {
			render(
				<ResponsiveModal isOpen onClose={vi.fn()} title="Phone" footer={<button>OK</button>}>
					Body
				</ResponsiveModal>
			);
			const footer = screen.getByRole('button', { name: 'OK' }).parentElement!;
			expect(footer.className).toContain('flex-col');
		});
	});

	describe('tablet+ branch', () => {
		beforeEach(() => {
			setIsPhone(false);
		});

		it('centers the modal at tablet+ tier', () => {
			render(
				<ResponsiveModal isOpen onClose={vi.fn()} title="Tablet">
					Body
				</ResponsiveModal>
			);
			const backdrop = screen.getByRole('dialog').parentElement!;
			expect(backdrop.className).toContain('items-center');
			expect(backdrop.className).toContain('justify-center');
		});

		it('sets a fixed width and maxWidth cap at the viewport edge', () => {
			render(
				<ResponsiveModal isOpen onClose={vi.fn()} title="Tablet" width={640}>
					Body
				</ResponsiveModal>
			);
			const dialog = screen.getByRole('dialog');
			expect(dialog.style.width).toBe('640px');
			expect(dialog.style.maxWidth).toBe('calc(100vw - 32px)');
		});

		it('uses modalIn animation at tablet+ tier', () => {
			render(
				<ResponsiveModal isOpen onClose={vi.fn()} title="Tablet">
					Body
				</ResponsiveModal>
			);
			const dialog = screen.getByRole('dialog');
			expect(dialog.className).toContain('animate-modalIn');
		});

		it('right-aligns footer buttons at tablet+ tier', () => {
			render(
				<ResponsiveModal isOpen onClose={vi.fn()} title="Tablet" footer={<button>OK</button>}>
					Body
				</ResponsiveModal>
			);
			const footer = screen.getByRole('button', { name: 'OK' }).parentElement!;
			expect(footer.className).toContain('justify-end');
		});
	});

	describe('short-viewport behaviour (Task 5.5)', () => {
		it('caps modal height at 90vh when not short-viewport (tablet+)', () => {
			setIsPhone(false);
			setIsShortViewport(false);
			render(
				<ResponsiveModal isOpen onClose={vi.fn()} title="Normal tablet">
					Body
				</ResponsiveModal>
			);
			const dialog = screen.getByRole('dialog');
			expect(dialog.className).toContain('max-h-[90vh]');
			expect(dialog.className).not.toContain('max-h-[calc(100vh-24px)]');
		});

		it('caps modal height at calc(100vh-24px) at short viewport (tablet+)', () => {
			setIsPhone(false);
			setIsShortViewport(true);
			render(
				<ResponsiveModal isOpen onClose={vi.fn()} title="Short tablet">
					Body
				</ResponsiveModal>
			);
			const dialog = screen.getByRole('dialog');
			expect(dialog.className).toContain('max-h-[calc(100vh-24px)]');
			expect(dialog.className).not.toContain('max-h-[90vh]');
		});

		it('caps modal height at calc(100vh-24px) at short viewport (phone bottom sheet)', () => {
			setIsPhone(true);
			setIsShortViewport(true);
			render(
				<ResponsiveModal isOpen onClose={vi.fn()} title="Landscape phone">
					Body
				</ResponsiveModal>
			);
			const dialog = screen.getByRole('dialog');
			expect(dialog.className).toContain('max-h-[calc(100vh-24px)]');
			expect(dialog.className).not.toContain('max-h-[90vh]');
		});

		it('keeps the body scrollable and flex-filling at short viewport', () => {
			setIsShortViewport(true);
			render(
				<ResponsiveModal isOpen onClose={vi.fn()} title="Scrollable" footer={<button>OK</button>}>
					<div data-testid="body-child">Body</div>
				</ResponsiveModal>
			);
			// The body wrapper is the direct parent of the body child
			const body = screen.getByTestId('body-child').parentElement!;
			expect(body.className).toContain('overflow-y-auto');
			expect(body.className).toContain('flex-1');
		});

		it('keeps the footer pinned (shrink-0) at short viewport', () => {
			setIsShortViewport(true);
			render(
				<ResponsiveModal
					isOpen
					onClose={vi.fn()}
					title="Pinned footer"
					footer={<button>OK</button>}
				>
					Body
				</ResponsiveModal>
			);
			const footer = screen.getByRole('button', { name: 'OK' }).parentElement!;
			expect(footer.className).toContain('shrink-0');
		});
	});

	// Task 5.6 — audit that the Task 5.5 scroll behaviour applies to the phone
	// bottom-sheet branch too. Forms taller than the ~351px cap (e.g. the
	// AgentCreationSheet with agent-type chips + name + cwd + group list) must
	// scroll inside the body while header + footer stay pinned.
	describe('phone bottom-sheet at short viewport (Task 5.6)', () => {
		beforeEach(() => {
			setIsPhone(true);
			setIsShortViewport(true);
		});

		it('keeps the phone bottom-sheet body scrollable and flex-filling', () => {
			render(
				<ResponsiveModal
					isOpen
					onClose={vi.fn()}
					title="Landscape phone scroll"
					footer={<button>Create</button>}
				>
					<div data-testid="tall-body" style={{ height: 600 }}>
						Tall form content
					</div>
				</ResponsiveModal>
			);
			const body = screen.getByTestId('tall-body').parentElement!;
			expect(body.className).toContain('overflow-y-auto');
			expect(body.className).toContain('flex-1');
		});

		it('pins the phone bottom-sheet header (shrink-0)', () => {
			render(
				<ResponsiveModal isOpen onClose={vi.fn()} title="Pinned phone header">
					Body
				</ResponsiveModal>
			);
			const header = screen.getByRole('heading', { name: 'Pinned phone header' }).parentElement!
				.parentElement!;
			expect(header.tagName).toBe('HEADER');
			expect(header.className).toContain('shrink-0');
		});

		it('pins the phone bottom-sheet footer (shrink-0)', () => {
			render(
				<ResponsiveModal
					isOpen
					onClose={vi.fn()}
					title="Pinned phone footer"
					footer={<button>Create Agent</button>}
				>
					Body
				</ResponsiveModal>
			);
			const footer = screen.getByRole('button', { name: 'Create Agent' }).parentElement!;
			expect(footer.className).toContain('shrink-0');
		});

		it('retains the bottom-sheet shape (rounded top, slide-up) alongside the height cap', () => {
			render(
				<ResponsiveModal isOpen onClose={vi.fn()} title="Bottom sheet shape">
					Body
				</ResponsiveModal>
			);
			const dialog = screen.getByRole('dialog');
			// Task 5.5 height cap applies...
			expect(dialog.className).toContain('max-h-[calc(100vh-24px)]');
			// ...without disturbing the phone-tier bottom-sheet affordances.
			expect(dialog.className).toContain('rounded-t-2xl');
			expect(dialog.className).toContain('animate-slideUp');
			expect(dialog.className).toContain('safe-area-bottom');
		});
	});

	describe('z-index', () => {
		it('defaults z-index to 400', () => {
			render(
				<ResponsiveModal isOpen onClose={vi.fn()} title="Default z">
					Body
				</ResponsiveModal>
			);
			const backdrop = screen.getByRole('dialog').parentElement!;
			expect(backdrop.style.zIndex).toBe('400');
		});

		it('accepts a custom zIndex prop', () => {
			render(
				<ResponsiveModal isOpen onClose={vi.fn()} title="Custom z" zIndex={9000}>
					Body
				</ResponsiveModal>
			);
			const backdrop = screen.getByRole('dialog').parentElement!;
			expect(backdrop.style.zIndex).toBe('9000');
		});
	});

	// Greptile P1: the desktop renderer's `LayerStack` provides scroll-lock
	// for free; the web variant has to do it locally. Without this lock, the
	// page underneath the modal scrolls behind the dim backdrop.
	describe('body scroll lock', () => {
		it('locks document.body overflow while open', () => {
			document.body.style.overflow = '';
			const { rerender } = render(
				<ResponsiveModal isOpen={false} onClose={vi.fn()} title="Locked">
					Body
				</ResponsiveModal>
			);
			expect(document.body.style.overflow).toBe('');

			rerender(
				<ResponsiveModal isOpen onClose={vi.fn()} title="Locked">
					Body
				</ResponsiveModal>
			);
			expect(document.body.style.overflow).toBe('hidden');
		});

		it('restores the previous overflow value on close', () => {
			document.body.style.overflow = 'auto';
			const { rerender } = render(
				<ResponsiveModal isOpen onClose={vi.fn()} title="Restore">
					Body
				</ResponsiveModal>
			);
			expect(document.body.style.overflow).toBe('hidden');

			rerender(
				<ResponsiveModal isOpen={false} onClose={vi.fn()} title="Restore">
					Body
				</ResponsiveModal>
			);
			expect(document.body.style.overflow).toBe('auto');
		});

		it('restores the previous overflow value on unmount', () => {
			document.body.style.overflow = 'scroll';
			const { unmount } = render(
				<ResponsiveModal isOpen onClose={vi.fn()} title="Unmount">
					Body
				</ResponsiveModal>
			);
			expect(document.body.style.overflow).toBe('hidden');

			unmount();
			expect(document.body.style.overflow).toBe('scroll');
		});
	});
});
