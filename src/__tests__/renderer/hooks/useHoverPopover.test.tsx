/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Tests for useHoverPopover: a mouse hover PEEKS the menu (no focus, closes on
 * leave) and a click PINS it (takes focus, survives leave, restores on dismiss).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useRef } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import {
	useHoverPopover,
	HOVER_POPOVER_OPEN_DELAY_MS,
	HOVER_POPOVER_CLOSE_DELAY_MS,
} from '../../../renderer/hooks';

function Harness({ hoverEnabled = true, onAction = vi.fn() }) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const popover = useHoverPopover({ triggerRef, contentRef, hoverEnabled });
	return (
		<>
			<input aria-label="composer" />
			<button ref={triggerRef} onClick={popover.toggle} {...popover.triggerHandlers}>
				trigger
			</button>
			{popover.isOpen && (
				<div ref={contentRef} tabIndex={0} data-testid="menu" {...popover.contentHandlers}>
					<button
						onClick={() => {
							popover.closeForAction();
							onAction();
						}}
					>
						item
					</button>
				</div>
			)}
			<div data-testid="outside">outside</div>
		</>
	);
}

/** Advance timers and flush the rAF the pin uses to focus the menu. */
function advance(ms: number) {
	act(() => {
		vi.advanceTimersByTime(ms);
	});
}

describe('useHoverPopover', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame'] });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('peeks open after the open delay when a mouse rests on the trigger', () => {
		render(<Harness />);
		fireEvent.pointerEnter(screen.getByText('trigger'), { pointerType: 'mouse' });
		expect(screen.queryByTestId('menu')).not.toBeInTheDocument();
		advance(HOVER_POPOVER_OPEN_DELAY_MS);
		expect(screen.getByTestId('menu')).toBeInTheDocument();
	});

	it('does not open when the pointer only passes over the trigger', () => {
		render(<Harness />);
		const trigger = screen.getByText('trigger');
		fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
		fireEvent.pointerLeave(trigger, { pointerType: 'mouse' });
		advance(HOVER_POPOVER_OPEN_DELAY_MS + HOVER_POPOVER_CLOSE_DELAY_MS);
		expect(screen.queryByTestId('menu')).not.toBeInTheDocument();
	});

	// The composer keeps its keystrokes: a peek never moves focus.
	it('leaves focus where it was while peeking', () => {
		render(<Harness />);
		const composer = screen.getByLabelText('composer');
		composer.focus();
		fireEvent.pointerEnter(screen.getByText('trigger'), { pointerType: 'mouse' });
		advance(HOVER_POPOVER_OPEN_DELAY_MS + 50);
		expect(screen.getByTestId('menu')).toBeInTheDocument();
		expect(composer).toHaveFocus();
	});

	it('survives the trip from the trigger into the menu, then closes on leave', () => {
		render(<Harness />);
		const trigger = screen.getByText('trigger');
		fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
		advance(HOVER_POPOVER_OPEN_DELAY_MS);
		fireEvent.pointerLeave(trigger, { pointerType: 'mouse' });
		fireEvent.pointerEnter(screen.getByTestId('menu'), { pointerType: 'mouse' });
		advance(HOVER_POPOVER_CLOSE_DELAY_MS);
		expect(screen.getByTestId('menu')).toBeInTheDocument();

		fireEvent.pointerLeave(screen.getByTestId('menu'), { pointerType: 'mouse' });
		advance(HOVER_POPOVER_CLOSE_DELAY_MS);
		expect(screen.queryByTestId('menu')).not.toBeInTheDocument();
	});

	// A tablet tap fires pointerenter too; it must take a press to open.
	it('ignores touch hover', () => {
		render(<Harness />);
		fireEvent.pointerEnter(screen.getByText('trigger'), { pointerType: 'touch' });
		advance(HOVER_POPOVER_OPEN_DELAY_MS);
		expect(screen.queryByTestId('menu')).not.toBeInTheDocument();
	});

	it('never peeks when hover is disabled', () => {
		render(<Harness hoverEnabled={false} />);
		fireEvent.pointerEnter(screen.getByText('trigger'), { pointerType: 'mouse' });
		advance(HOVER_POPOVER_OPEN_DELAY_MS);
		expect(screen.queryByTestId('menu')).not.toBeInTheDocument();
	});

	it('pins on click: takes focus and survives the pointer leaving', () => {
		render(<Harness />);
		const trigger = screen.getByText('trigger');
		fireEvent.click(trigger);
		advance(16);
		expect(screen.getByTestId('menu')).toHaveFocus();

		fireEvent.pointerLeave(trigger, { pointerType: 'mouse' });
		advance(HOVER_POPOVER_CLOSE_DELAY_MS);
		expect(screen.getByTestId('menu')).toBeInTheDocument();
	});

	// "Hover, then click" must not flicker the menu shut.
	it('pins a peeking menu on click instead of closing it', () => {
		render(<Harness />);
		const trigger = screen.getByText('trigger');
		fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
		advance(HOVER_POPOVER_OPEN_DELAY_MS);
		fireEvent.click(trigger);
		expect(screen.getByTestId('menu')).toBeInTheDocument();

		fireEvent.click(trigger);
		expect(screen.queryByTestId('menu')).not.toBeInTheDocument();
	});

	it('closes on an outside press and returns focus to the trigger', () => {
		render(<Harness />);
		const trigger = screen.getByText('trigger');
		fireEvent.click(trigger);
		advance(16);
		fireEvent.mouseDown(screen.getByTestId('outside'));
		expect(screen.queryByTestId('menu')).not.toBeInTheDocument();
		expect(trigger).toHaveFocus();
	});

	it('leaves focus alone when a menu item runs', () => {
		const onAction = vi.fn();
		render(<Harness onAction={onAction} />);
		const trigger = screen.getByText('trigger');
		fireEvent.click(trigger);
		advance(16);
		fireEvent.click(screen.getByText('item'));
		expect(onAction).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId('menu')).not.toBeInTheDocument();
		expect(trigger).not.toHaveFocus();
	});

	it('does not focus the trigger on mount', () => {
		render(<Harness />);
		expect(screen.getByText('trigger')).not.toHaveFocus();
	});
});
