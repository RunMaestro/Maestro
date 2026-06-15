import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { useBadgeTooltipState } from '../../../../renderer/components/AchievementCard/hooks/useBadgeTooltipState';
import type { BadgeEscapeHandler } from '../../../../renderer/components/AchievementCard/types';

function Harness({ onEscape }: { onEscape?: (handler: BadgeEscapeHandler | null) => void }) {
	const { selectedBadge, badgeContainerRef, toggleBadge } = useBadgeTooltipState(onEscape);

	return (
		<div>
			<div ref={badgeContainerRef}>
				<button onClick={() => toggleBadge(1)}>Level 1 trigger</button>
				<button onClick={() => toggleBadge(2)}>Level 2 trigger</button>
				<span>inside tooltip area</span>
			</div>
			<span>selected: {selectedBadge ?? 'none'}</span>
			<button>outside target</button>
		</div>
	);
}

describe('useBadgeTooltipState', () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('selects and toggles the same badge closed', () => {
		render(<Harness />);

		fireEvent.click(screen.getByText('Level 1 trigger'));
		expect(screen.getByText('selected: 1')).toBeInTheDocument();

		fireEvent.click(screen.getByText('Level 1 trigger'));
		expect(screen.getByText('selected: none')).toBeInTheDocument();
	});

	it('keeps the last badge during rapid selection changes', () => {
		render(<Harness />);

		fireEvent.click(screen.getByText('Level 1 trigger'));
		fireEvent.click(screen.getByText('Level 2 trigger'));

		expect(screen.getByText('selected: 2')).toBeInTheDocument();
	});

	it('delays outside-click registration until after the opening click', () => {
		render(<Harness />);

		fireEvent.click(screen.getByText('Level 1 trigger'));
		fireEvent.click(document.body);
		expect(screen.getByText('selected: 1')).toBeInTheDocument();

		act(() => {
			vi.advanceTimersByTime(1);
		});

		fireEvent.click(document.body);
		expect(screen.getByText('selected: none')).toBeInTheDocument();
	});

	it('ignores clicks inside the badge container', () => {
		render(<Harness />);

		fireEvent.click(screen.getByText('Level 1 trigger'));
		act(() => {
			vi.advanceTimersByTime(1);
		});

		fireEvent.click(screen.getByText('inside tooltip area'));
		expect(screen.getByText('selected: 1')).toBeInTheDocument();
	});

	it('registers, clears, and cleans up the Escape handler', () => {
		const onEscape = vi.fn();
		const { unmount } = render(<Harness onEscape={onEscape} />);

		fireEvent.click(screen.getByText('Level 1 trigger'));
		expect(onEscape).toHaveBeenCalledWith(expect.any(Function));

		fireEvent.click(screen.getByText('Level 1 trigger'));
		expect(onEscape).toHaveBeenCalledWith(null);

		fireEvent.click(screen.getByText('Level 2 trigger'));
		onEscape.mockClear();
		unmount();

		expect(onEscape).toHaveBeenCalledWith(null);
	});

	it('Escape handler closes the selected badge and returns true', () => {
		let capturedHandler: BadgeEscapeHandler | null = null;
		const onEscape = vi.fn((handler: BadgeEscapeHandler | null) => {
			capturedHandler = handler;
		});

		render(<Harness onEscape={onEscape} />);
		fireEvent.click(screen.getByText('Level 1 trigger'));

		expect(capturedHandler).not.toBeNull();
		let handled = false;
		act(() => {
			handled = capturedHandler!();
		});

		expect(handled).toBe(true);
		expect(screen.getByText('selected: none')).toBeInTheDocument();
	});
});
