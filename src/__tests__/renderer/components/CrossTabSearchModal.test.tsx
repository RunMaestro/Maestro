/**
 * Tests for CrossTabSearchModal (Opt+Cmd+F).
 *
 * Searches message history across every open AI tab of the current agent and
 * jumps to the selected hit. Covers: grouped rendering, snippet highlighting,
 * regex toggle, keyboard navigation, and the jump payload handed to the caller.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CrossTabSearchModal } from '../../../renderer/components/CrossTabSearchModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { MOUNT_FOCUS_DELAY_MS } from '../../../renderer/hooks/utils/useFocusAfterRender';
import { mockTheme } from '../../helpers/mockTheme';
import { createMockAITab } from '../../helpers';
import type { AITab, LogEntry } from '../../../renderer/types';

function log(id: string, text: string, overrides: Partial<LogEntry> = {}): LogEntry {
	return { id, text, timestamp: 1_700_000_000_000, source: 'ai', ...overrides } as LogEntry;
}

const TABS: AITab[] = [
	createMockAITab({
		id: 'tab-a',
		name: 'Auth work',
		logs: [
			log('a1', 'refactor the login handler', { source: 'user' }),
			log('a2', 'nothing relevant here'),
		],
	}),
	createMockAITab({
		id: 'tab-b',
		name: 'Billing work',
		logs: [log('b1', 'the login flow charges twice')],
	}),
];

/** The modal debounces its query by 150ms. */
function typeQuery(value: string) {
	fireEvent.change(screen.getByRole('textbox'), { target: { value } });
	act(() => {
		vi.advanceTimersByTime(200);
	});
}

function renderModal(props: Partial<React.ComponentProps<typeof CrossTabSearchModal>> = {}) {
	const onJump = vi.fn();
	const onClose = vi.fn();
	render(
		<LayerStackProvider>
			<CrossTabSearchModal
				theme={mockTheme}
				tabs={TABS}
				activeTabId="tab-a"
				onJump={onJump}
				onClose={onClose}
				{...props}
			/>
		</LayerStackProvider>
	);
	return { onJump, onClose };
}

describe('CrossTabSearchModal', () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	it('prompts for a query before anything has been typed', () => {
		renderModal();
		expect(screen.getByText('Type to search every open tab in this agent')).toBeInTheDocument();
	});

	// Keyboard-first: however the modal is opened (shortcut, tab-bar popover,
	// command palette), the caret must already be in the search box.
	it('focuses the search input when it opens', () => {
		renderModal();
		act(() => {
			vi.advanceTimersByTime(MOUNT_FOCUS_DELAY_MS);
		});
		expect(screen.getByRole('textbox')).toHaveFocus();
	});

	it('groups hits under each tab that contains them', () => {
		renderModal();
		typeQuery('login');

		expect(screen.getByText('Auth work')).toBeInTheDocument();
		expect(screen.getByText('Billing work')).toBeInTheDocument();
		expect(screen.getByText('2 messages in 2 tabs')).toBeInTheDocument();
	});

	it('marks which group is the tab the user is already on', () => {
		renderModal();
		typeQuery('login');
		expect(screen.getByText('current')).toBeInTheDocument();
	});

	it('highlights the matched span inside the snippet', () => {
		const { container } = { container: document.body };
		renderModal();
		typeQuery('login');

		const marks = Array.from(container.querySelectorAll('mark')).map((m) => m.textContent);
		expect(marks).toEqual(['login', 'login']);
	});

	it('reports when nothing matches', () => {
		renderModal();
		typeQuery('zzzznotfound');
		expect(screen.getByText('No matching messages')).toBeInTheDocument();
	});

	it('hands the tab, entry, and query to onJump, then closes', () => {
		const { onJump, onClose } = renderModal();
		typeQuery('charges');

		// The snippet is split across text nodes by the <mark>, so click the row
		// that owns the highlighted span rather than matching the whole sentence.
		fireEvent.click(screen.getByText('charges').closest('button')!);

		expect(onJump).toHaveBeenCalledWith({
			tabId: 'tab-b',
			logId: 'b1',
			query: 'charges',
			regex: false,
		});
		expect(onClose).toHaveBeenCalled();
	});

	it('jumps to the first hit on Enter', () => {
		const { onJump } = renderModal();
		typeQuery('login');

		fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

		expect(onJump).toHaveBeenCalledWith(expect.objectContaining({ tabId: 'tab-a', logId: 'a1' }));
	});

	it('moves the selection with the arrow keys', () => {
		const { onJump } = renderModal();
		typeQuery('login');

		fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowDown' });
		fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

		expect(onJump).toHaveBeenCalledWith(expect.objectContaining({ tabId: 'tab-b', logId: 'b1' }));
	});

	it('switches to regex matching when the chip is toggled', () => {
		const { onJump } = renderModal();

		fireEvent.click(screen.getByTitle('Switch to regex search'));
		typeQuery('charges? twice');

		fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
		expect(onJump).toHaveBeenCalledWith(expect.objectContaining({ logId: 'b1', regex: true }));
	});

	it('surfaces an invalid regex instead of crashing', () => {
		renderModal();
		fireEvent.click(screen.getByTitle('Switch to regex search'));
		typeQuery('(unclosed');

		expect(screen.getByText(/Invalid regex:/)).toBeInTheDocument();
	});

	// Remote desktop and tablet users have no Escape key to reach for.
	it('closes when the ESC pill is clicked', () => {
		const { onClose } = renderModal();

		fireEvent.click(screen.getByRole('button', { name: 'Close (Esc)' }));

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	// jsdom has no layout engine, so this pins the geometry by class: the overlay
	// must center its box the way TabSwitcherModal does (p-8 == the 32px
	// MODAL_VIEWPORT_PADDING) with the same 700px height, so both search entry
	// points in the search popover open at the same top Y.
	it('centers its box like the tab switcher instead of hugging the top', () => {
		renderModal();
		const dialog = screen.getByRole('dialog');
		const overlay = dialog.parentElement as HTMLElement;

		expect(overlay.className).toContain('items-center');
		expect(overlay.className).toContain('p-8');
		expect(overlay.className).not.toContain('items-start');
		expect(dialog.className).toContain('h-[700px]');
	});

	it('shows a match-count pill when an entry contains several hits', () => {
		renderModal({
			tabs: [
				createMockAITab({ id: 'tab-a', name: 'Repeats', logs: [log('r1', 'ping ping ping')] }),
			],
		});
		typeQuery('ping');
		expect(screen.getByText('3 matches')).toBeInTheDocument();
	});

	// A hidden cross-agent consult tab has no chip in the strip, so a hit inside one
	// would jump the user into a conversation they never opened.
	it('keeps hidden consult tabs out of the search corpus', () => {
		renderModal({
			tabs: [
				...TABS,
				createMockAITab({
					id: 'tab-consult',
					name: 'Consult',
					hidden: true,
					logs: [log('c1', 'the login secret lives here')],
				}),
			],
		});
		typeQuery('login');

		expect(screen.getByText('Auth work')).toBeInTheDocument();
		expect(screen.queryByText('Consult')).not.toBeInTheDocument();
		expect(screen.getByText('Searching 2 open tabs')).toBeInTheDocument();
	});
});
