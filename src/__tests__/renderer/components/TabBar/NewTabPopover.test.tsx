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

function renderPopover(overrides: Partial<Parameters<typeof NewTabPopover>[0]> = {}) {
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
		...overrides,
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

	it('runs the chosen handler and closes', () => {
		const props = renderPopover();
		fireEvent.click(screen.getByTitle('New tab…'));
		fireEvent.click(screen.getByText('New Terminal'));
		expect(props.onNewTerminalTab).toHaveBeenCalledTimes(1);
		expect(screen.queryByText('New Terminal')).not.toBeInTheDocument();
	});

	it('offers Sketch Book only when a handler is passed (the Encore Feature is on)', () => {
		renderPopover();
		fireEvent.click(screen.getByTitle('New tab…'));
		expect(screen.queryByText('Sketch Book')).not.toBeInTheDocument();
	});

	it('lists chat, file, sketch, terminal, then the browsers', () => {
		renderPopover({ onNewSketchBook: vi.fn(), sketchBookKeys: ['Alt', 'Meta', 'k'] });
		fireEvent.click(screen.getByTitle('New tab…'));
		const labels = [
			'New AI Chat',
			'New File',
			'Sketch Book',
			'New Terminal',
			'New Browser',
			'New Incognito Browser',
		];
		const order = screen
			.getAllByRole('button')
			.map((button) => labels.find((label) => button.textContent?.startsWith(label)))
			.filter(Boolean);
		expect(order).toEqual(labels);
	});

	it('runs New Sketch Book from the menu and closes', () => {
		const onNewSketchBook = vi.fn();
		renderPopover({ onNewSketchBook, sketchBookKeys: ['Alt', 'Meta', 'k'] });
		fireEvent.click(screen.getByTitle('New tab…'));
		fireEvent.click(screen.getByText('Sketch Book'));
		expect(onNewSketchBook).toHaveBeenCalledTimes(1);
		expect(screen.queryByText('Sketch Book')).not.toBeInTheDocument();
	});
});
