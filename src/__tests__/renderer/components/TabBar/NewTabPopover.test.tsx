/**
 * Tests for NewTabPopover.
 *
 * The chord beside each row is a keyboard hint, so it carries
 * `data-shortcut-hint` and the phone stylesheet retires all of them at once.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NewTabPopover } from '../../../../renderer/components/TabBar/NewTabPopover';
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
		const badges = document.querySelectorAll('span.ml-auto.text-xs');
		expect(badges.length).toBeGreaterThanOrEqual(3);
		for (const badge of badges) {
			expect(badge).toHaveAttribute('data-shortcut-hint');
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
