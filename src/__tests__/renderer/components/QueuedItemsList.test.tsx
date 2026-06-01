import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
	render(<QueuedItemsList {...(props as any)} />);
	return props;
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
