/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { QueuedItemsList } from '../../../renderer/components/QueuedItemsList';
import { mockTheme } from '../../helpers/mockTheme';
import type { QueuedItem } from '../../../renderer/types';

function item(overrides: Partial<QueuedItem> = {}): QueuedItem {
	return {
		id: 'q1',
		timestamp: 0,
		tabId: 'tab-1',
		type: 'message',
		text: 'a queued message',
		...overrides,
	};
}

function setup(overrides: Record<string, unknown> = {}) {
	const props = {
		executionQueue: [item()],
		theme: mockTheme,
		onRemoveQueuedItem: vi.fn(),
		onTogglePauseQueuedItem: vi.fn(),
		...overrides,
	};
	const utils = render(<QueuedItemsList {...(props as any)} />);
	return { ...props, ...utils };
}

describe('QueuedItemsList pause/hold', () => {
	it('renders a Hold button and fires onTogglePauseQueuedItem for a runnable item', () => {
		const props = setup();
		fireEvent.click(screen.getByTitle(/Hold this message/i));
		expect(props.onTogglePauseQueuedItem).toHaveBeenCalledWith('q1');
	});

	it('shows the HELD badge and a Resume control for a paused item', () => {
		const props = setup({ executionQueue: [item({ paused: true })] });
		expect(screen.getByText('HELD')).toBeTruthy();
		fireEvent.click(screen.getByTitle(/Resume this message/i));
		expect(props.onTogglePauseQueuedItem).toHaveBeenCalledWith('q1');
	});

	it('omits the hold control when no toggle handler is provided', () => {
		setup({ onTogglePauseQueuedItem: undefined });
		expect(screen.queryByTitle(/Hold this message/i)).toBeNull();
		expect(screen.queryByText('HELD')).toBeNull();
	});
});

describe('QueuedItemsList drag-to-reorder', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	const twoItems = [item({ id: 'q1', text: 'first' }), item({ id: 'q2', text: 'second' })];

	it('does not enable drag without a reorder handler', () => {
		const { container } = setup({ executionQueue: twoItems });
		const cards = container.querySelectorAll('.group.select-none');
		expect(cards.length).toBe(2);
		cards.forEach((card) => expect(card).not.toHaveStyle({ cursor: 'grab' }));
		// No drag handle dots when not draggable.
		expect(container.querySelector('.absolute.left-1')).toBeNull();
	});

	it('does not enable drag with only one item', () => {
		const { container } = setup({ executionQueue: [item()], onReorderItems: vi.fn() });
		const card = container.querySelector('.group.select-none');
		expect(card).not.toHaveStyle({ cursor: 'grab' });
		expect(container.querySelector('.absolute.left-1')).toBeNull();
	});

	it('enables drag (grab cursor, handle, drop zones) with a handler and multiple items', () => {
		const { container } = setup({ executionQueue: twoItems, onReorderItems: vi.fn() });
		const cards = container.querySelectorAll('.group.select-none');
		expect(cards.length).toBe(2);
		cards.forEach((card) => expect(card).toHaveStyle({ cursor: 'grab' }));
		// Drag handle is present (hidden until hover/grab via opacity).
		expect(container.querySelector('.absolute.left-1')).toBeInTheDocument();
		// n + 1 drop zones for n items.
		expect(container.querySelectorAll('.relative.h-1').length).toBe(3);
	});

	it('fires onReorderItems after a press-hold drag onto a later drop zone', () => {
		vi.useFakeTimers();
		const onReorderItems = vi.fn();
		const { container } = setup({ executionQueue: twoItems, onReorderItems });

		const firstCard = container.querySelectorAll('.group.select-none')[0];
		// Press and hold past the drag-initiation delay.
		fireEvent.mouseDown(firstCard, { button: 0 });
		// The drag starts after a press-hold delay; advancing the timer fires a
		// state update, so flush it inside act().
		act(() => {
			vi.advanceTimersByTime(200);
		});

		// Hover the final drop zone (gap after the last item) to set the drop target.
		const dropZones = container.querySelectorAll('.relative.h-1');
		fireEvent.mouseEnter(dropZones[dropZones.length - 1]);

		// Release to commit the reorder. The global mouseup listener completes it.
		fireEvent.mouseUp(window);

		// Item 0 dropped after item 1 → splice destination index 1.
		expect(onReorderItems).toHaveBeenCalledWith(0, 1);
	});

	it('does not start a drag when pressing an action button', () => {
		vi.useFakeTimers();
		const onReorderItems = vi.fn();
		setup({ executionQueue: twoItems, onReorderItems });

		const holdButton = screen.getAllByTitle(/Hold this message/i)[0];
		fireEvent.mouseDown(holdButton, { button: 0 });
		vi.advanceTimersByTime(200);
		fireEvent.mouseUp(window);

		expect(onReorderItems).not.toHaveBeenCalled();
	});
});
