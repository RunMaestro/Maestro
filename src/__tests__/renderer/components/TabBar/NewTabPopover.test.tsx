/**
 * Tests for NewTabPopover.
 *
 * The chord beside each row is a keyboard hint, so it carries
 * `data-shortcut-hint` and the phone stylesheet retires all of them at once.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { NewTabPopover } from '../../../../renderer/components/TabBar/NewTabPopover';
import { HOVER_POPOVER_OPEN_DELAY_MS } from '../../../../renderer/hooks/ui/useHoverPopover';
import { mockTheme } from '../../../helpers/mockTheme';

function renderPopover() {
	const props = {
		theme: mockTheme,
		onNewTab: vi.fn(),
		onNewFileTab: vi.fn(),
		onNewBrowserTab: vi.fn(),
		onNewTerminalTab: vi.fn(),
		newTabKeys: ['Meta', 't'],
		fileTabKeys: ['Meta', 'o'],
		browserTabKeys: ['Meta', 'l'],
		terminalKeys: ['Meta', 'j'],
		isOverflowing: false,
	};
	render(<NewTabPopover {...props} />);
	return props;
}

describe('NewTabPopover', () => {
	it('opens a menu whose chord badges are all tagged as shortcut hints', () => {
		renderPopover();
		fireEvent.click(screen.getByTitle('New tab…'));
		expect(screen.getByText('New Terminal')).toBeInTheDocument();
		const badges = document.querySelectorAll('[data-shortcut-keys]');
		expect(badges.length).toBeGreaterThanOrEqual(3);
		for (const badge of badges) {
			expect(badge).toHaveAttribute('data-shortcut-hint');
		}
	});

	it('peeks the menu on mouse hover without a click', () => {
		vi.useFakeTimers();
		try {
			renderPopover();
			fireEvent.pointerEnter(screen.getByTitle('New tab…'), { pointerType: 'mouse' });
			act(() => {
				vi.advanceTimersByTime(HOVER_POPOVER_OPEN_DELAY_MS);
			});
			expect(screen.getByText('New Terminal')).toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not peek on hover when the + has no menu (AI tabs only)', () => {
		vi.useFakeTimers();
		try {
			const onNewTab = vi.fn();
			render(
				<NewTabPopover
					theme={mockTheme}
					onNewTab={onNewTab}
					newTabKeys={['Meta', 't']}
					fileTabKeys={['Meta', 'o']}
					browserTabKeys={['Meta', 'l']}
					terminalKeys={['Meta', 'j']}
					isOverflowing={false}
				/>
			);
			const button = screen.getByRole('button');
			fireEvent.pointerEnter(button, { pointerType: 'mouse' });
			act(() => {
				vi.advanceTimersByTime(HOVER_POPOVER_OPEN_DELAY_MS);
			});
			expect(screen.queryByText('New AI Chat')).not.toBeInTheDocument();
			fireEvent.click(button);
			expect(onNewTab).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('runs the chosen handler and closes', () => {
		const props = renderPopover();
		fireEvent.click(screen.getByTitle('New tab…'));
		fireEvent.click(screen.getByText('New Terminal'));
		expect(props.onNewTerminalTab).toHaveBeenCalledTimes(1);
		expect(screen.queryByText('New Terminal')).not.toBeInTheDocument();
	});
});
