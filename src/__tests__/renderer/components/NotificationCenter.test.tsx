/**
 * Tests for NotificationCenter - the header bell and its history popover.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import {
	NotificationCenter,
	NotificationCenterHost,
} from '../../../renderer/components/NotificationCenter';
import {
	useNotificationStore,
	type NotificationRecord,
} from '../../../renderer/stores/notificationStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { mockTheme } from '../../helpers/mockTheme';

const mockOpenUrl = vi.fn();
vi.mock('../../../renderer/utils/openUrl', () => ({
	openUrl: (...args: unknown[]) => mockOpenUrl(...args),
}));
const mockJumpToAgent = vi.fn();
vi.mock('../../../renderer/services/agentNavigation', () => ({
	jumpToAgent: (...args: unknown[]) => mockJumpToAgent(...args),
}));

// Mock the LayerStackContext (Escape handling is covered by its own tests)
vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: vi.fn().mockReturnValue('mock-layer-id'),
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
	}),
}));

function record(overrides: Partial<NotificationRecord> = {}): NotificationRecord {
	return {
		id: 'n1',
		color: 'green',
		type: 'success',
		title: 'Task complete',
		message: 'All done',
		timestamp: Date.now(),
		read: false,
		...overrides,
	};
}

function seed(history: NotificationRecord[], open = false) {
	useNotificationStore.setState({ history, toasts: [], notificationCenterOpen: open });
}

const items = () => screen.queryAllByTestId('notification-center-item');

describe('NotificationCenter', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useSettingsStore.setState(useSettingsStore.getInitialState(), true);
		useNotificationStore.setState({ notificationCenterExpandedId: null });
		mockJumpToAgent.mockReturnValue(true);
		seed([]);
		useNotificationStore.setState({ historyPersistenceFailed: false });
		useNotificationStore.getState().setDefaultDuration(20);
	});

	it('shows the unread count on the bell, and no badge at zero', () => {
		seed([record({ id: 'a' }), record({ id: 'b' }), record({ id: 'c', read: true })]);
		const { rerender } = render(
			<>
				<NotificationCenter theme={mockTheme} />
				<NotificationCenterHost theme={mockTheme} />
			</>
		);
		expect(screen.getByTestId('notification-center-badge')).toHaveTextContent('2');

		seed([record({ id: 'c', read: true })]);
		rerender(
			<>
				<NotificationCenter theme={mockTheme} />
				<NotificationCenterHost theme={mockTheme} />
			</>
		);
		expect(screen.queryByTestId('notification-center-badge')).not.toBeInTheDocument();
	});

	it('opens and closes from the bell', () => {
		render(
			<>
				<NotificationCenter theme={mockTheme} />
				<NotificationCenterHost theme={mockTheme} />
			</>
		);
		expect(screen.queryByTestId('notification-center')).not.toBeInTheDocument();

		fireEvent.click(screen.getByTestId('notification-center-button'));
		expect(screen.getByTestId('notification-center')).toBeInTheDocument();

		fireEvent.click(screen.getByTestId('notification-center-button'));
		expect(screen.queryByTestId('notification-center')).not.toBeInTheDocument();
	});

	it('portals the popover out of the header subtree', () => {
		// The header clips and re-contains anything positioned inside it, which a
		// jsdom toBeInTheDocument() cannot see.
		seed([], true);
		const { container } = render(
			<>
				<NotificationCenter theme={mockTheme} />
				<NotificationCenterHost theme={mockTheme} />
			</>
		);
		expect(container.contains(screen.getByTestId('notification-center'))).toBe(false);
	});

	it('opens on Unread when something is unread, and All shows the rest', () => {
		seed(
			[
				record({ id: 'a', title: 'Unread one' }),
				record({ id: 'b', title: 'Read one', read: true }),
			],
			true
		);
		render(
			<>
				<NotificationCenter theme={mockTheme} />
				<NotificationCenterHost theme={mockTheme} />
			</>
		);

		expect(items()).toHaveLength(1);
		expect(screen.getByText('Unread one')).toBeInTheDocument();

		fireEvent.click(screen.getByTestId('notification-center-filter-all'));
		expect(items()).toHaveLength(2);
		expect(screen.getByText('Read one')).toBeInTheDocument();
	});

	it('opens on All when nothing is unread', () => {
		seed([record({ id: 'b', read: true })], true);
		render(
			<>
				<NotificationCenter theme={mockTheme} />
				<NotificationCenterHost theme={mockTheme} />
			</>
		);
		expect(items()).toHaveLength(1);
	});

	it('shows the source agent and tab on an entry', () => {
		seed([record({ group: 'Backend', project: 'API Agent', tabName: 'Refactor' })], true);
		render(
			<>
				<NotificationCenter theme={mockTheme} />
				<NotificationCenterHost theme={mockTheme} />
			</>
		);
		expect(within(items()[0]).getByText('Backend · API Agent · Refactor')).toBeInTheDocument();
	});

	it('marks an entry read, jumps to its agent, and closes', () => {
		seed([record({ id: 'a', sessionId: 'agent-1', tabId: 'tab-1' })], true);
		render(
			<>
				<NotificationCenter theme={mockTheme} />
				<NotificationCenterHost theme={mockTheme} />
			</>
		);

		fireEvent.click(items()[0]);

		expect(mockJumpToAgent).toHaveBeenCalledWith('agent-1', { tabId: 'tab-1' });
		expect(useNotificationStore.getState().history[0].read).toBe(true);
		expect(screen.queryByTestId('notification-center')).not.toBeInTheDocument();
	});

	it('says so when the source agent no longer exists', () => {
		mockJumpToAgent.mockReturnValue(false);
		seed([record({ id: 'a', sessionId: 'gone' })], true);
		render(
			<>
				<NotificationCenter theme={mockTheme} />
				<NotificationCenterHost theme={mockTheme} />
			</>
		);

		fireEvent.click(items()[0]);

		const { toasts, history } = useNotificationStore.getState();
		expect(toasts.map((t) => t.title)).toEqual(['Agent Not Found']);
		// The miss itself is not worth an inbox entry.
		expect(history).toHaveLength(1);
	});

	it('renders without a header bell when opened globally', () => {
		seed([], true);
		render(<NotificationCenterHost theme={mockTheme} />);
		expect(screen.getByTestId('notification-center')).toHaveStyle({ opacity: '1' });
		fireEvent.click(screen.getByRole('button', { name: 'Close notifications' }));
		expect(useNotificationStore.getState().notificationCenterOpen).toBe(false);
	});

	it('keeps missing-agent feedback in history when floating toasts are off', () => {
		useNotificationStore.getState().setDefaultDuration(-1);
		mockJumpToAgent.mockReturnValue(false);
		seed([record({ sessionId: 'gone' })], true);
		render(
			<>
				<NotificationCenter theme={mockTheme} />
				<NotificationCenterHost theme={mockTheme} />
			</>
		);
		fireEvent.click(items()[0]);
		expect(useNotificationStore.getState().toasts).toHaveLength(0);
		expect(useNotificationStore.getState().history[0].title).toBe('Agent Not Found');
	});

	it.each([false, true])(
		'opens the independent inline link with a body action: %s',
		(hasBodyAction) => {
			const onClick = vi.fn();
			useNotificationStore.getState().setDefaultDuration(-1);
			seed(
				[
					record({
						actionUrl: 'https://example.com/pr',
						actionLabel: 'View PR',
						onClick: hasBodyAction ? onClick : undefined,
					}),
				],
				true
			);
			render(
				<>
					<NotificationCenter theme={mockTheme} />
					<NotificationCenterHost theme={mockTheme} />
				</>
			);
			fireEvent.click(screen.getByRole('button', { name: 'View PR' }));
			expect(mockOpenUrl).toHaveBeenCalledWith('https://example.com/pr');
			expect(onClick).not.toHaveBeenCalled();
			expect(useNotificationStore.getState().history[0].read).toBe(true);
		}
	);

	it('uses the URL as the inline link label when no label was supplied', () => {
		seed([record({ actionUrl: 'https://example.com/pr' })], true);
		render(
			<>
				<NotificationCenter theme={mockTheme} />
				<NotificationCenterHost theme={mockTheme} />
			</>
		);
		expect(screen.getByRole('button', { name: 'https://example.com/pr' })).toBeInTheDocument();
	});

	it('stays open when an entry has nowhere to go', () => {
		seed([record({ id: 'a' }), record({ id: 'b' })], true);
		render(
			<>
				<NotificationCenter theme={mockTheme} />
				<NotificationCenterHost theme={mockTheme} />
			</>
		);

		fireEvent.click(items()[0]);

		expect(mockJumpToAgent).not.toHaveBeenCalled();
		expect(screen.getByTestId('notification-center')).toBeInTheDocument();
		// Read now, so it left the Unread view.
		expect(items()).toHaveLength(1);
	});

	it('marks all as read', () => {
		seed([record({ id: 'a' }), record({ id: 'b' })], true);
		render(
			<>
				<NotificationCenter theme={mockTheme} />
				<NotificationCenterHost theme={mockTheme} />
			</>
		);

		fireEvent.click(screen.getByTestId('notification-center-mark-all-read'));

		expect(useNotificationStore.getState().history.every((n) => n.read)).toBe(true);
		expect(screen.getByTestId('notification-center-empty')).toHaveTextContent(
			'No unread notifications'
		);
		expect(screen.getByTestId('notification-center-mark-all-read')).toBeDisabled();
	});

	it('makes failed persistence visible even when the history is empty', () => {
		seed([], true);
		useNotificationStore.setState({ historyPersistenceFailed: true });
		render(<NotificationCenterHost theme={mockTheme} />);
		expect(screen.getByRole('alert')).toHaveTextContent('Changes may be lost after restart');
		expect(screen.getByTestId('notification-center-clear-all')).toBeEnabled();
		fireEvent.click(screen.getByTestId('notification-center-clear-all'));
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});

	it('clears the history', () => {
		seed([record({ id: 'a', read: true })], true);
		render(
			<>
				<NotificationCenter theme={mockTheme} />
				<NotificationCenterHost theme={mockTheme} />
			</>
		);

		fireEvent.click(screen.getByTestId('notification-center-clear-all'));

		expect(useNotificationStore.getState().history).toHaveLength(0);
		expect(screen.getByTestId('notification-center-empty')).toHaveTextContent(
			'No notifications yet'
		);
	});
	it('keeps the compact panel, clamped preview, and existing focus by default', () => {
		seed([record()], true);
		render(
			<>
				<button autoFocus>Composer</button>
				<NotificationCenterHost theme={mockTheme} />
			</>
		);
		expect(screen.getByTestId('notification-center')).toHaveClass('w-[22rem]');
		expect(screen.getByText('All done')).toHaveClass('line-clamp-3');
		expect(screen.queryByRole('button', { name: 'Show details' })).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Composer' })).toHaveFocus();
	});

	it('offers a larger panel only when enabled', () => {
		useSettingsStore.setState({ notificationCenterLarge: true });
		seed([], true);
		render(<NotificationCenterHost theme={mockTheme} />);
		expect(screen.getByTestId('notification-center')).toHaveClass('w-[38rem]');
		expect(screen.getByTestId('notification-center')).toHaveStyle({
			maxHeight: 'min(48rem, calc(100vh - 5rem))',
		});
	});

	it('expands full content without activating the entry or marking it read', () => {
		useSettingsStore.setState({ notificationCenterDetails: true });
		seed([record({ project: 'A very long source name', sessionId: 'agent-1' })], true);
		render(<NotificationCenterHost theme={mockTheme} />);
		fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
		expect(screen.getByText('All done')).not.toHaveClass('line-clamp-3');
		expect(screen.getByText('A very long source name')).not.toHaveClass('truncate');
		expect(mockJumpToAgent).not.toHaveBeenCalled();
		expect(useNotificationStore.getState().history[0].read).toBe(false);
		fireEvent.click(screen.getByRole('button', { name: 'Hide details' }));
		expect(screen.getByText('All done')).toHaveClass('line-clamp-3');
	});

	it('focuses the inbox and supports arrows, reading, and dismissal when enabled', () => {
		useSettingsStore.setState({ notificationCenterKeyboardNavigation: true });
		seed([record({ id: 'a' }), record({ id: 'b' }), record({ id: 'c' })], true);
		render(<NotificationCenterHost theme={mockTheme} />);
		expect(items()[0]).toHaveFocus();
		fireEvent.keyDown(items()[0], { key: 'ArrowDown' });
		expect(items()[1]).toHaveFocus();
		fireEvent.keyDown(items()[1], { key: 'r' });
		expect(useNotificationStore.getState().history.find((n) => n.id === 'b')?.read).toBe(true);
		expect(items()[1]).toHaveFocus();
		fireEvent.keyDown(items()[1], { key: 'Delete' });
		expect(useNotificationStore.getState().history.find((n) => n.id === 'c')?.read).toBe(true);
		expect(items()[0]).toHaveFocus();
	});

	it('restores focus after closing and lets Enter activate once', () => {
		useSettingsStore.setState({ notificationCenterKeyboardNavigation: true });
		seed([record({ id: 'a', sessionId: 'agent-1' })]);
		render(
			<>
				<NotificationCenter theme={mockTheme} />
				<NotificationCenterHost theme={mockTheme} />
			</>
		);
		const bell = screen.getByTestId('notification-center-button');
		bell.focus();
		fireEvent.click(bell);
		expect(items()[0]).toHaveFocus();
		fireEvent.click(screen.getByRole('button', { name: 'Close notifications' }));
		expect(bell).toHaveFocus();
		fireEvent.click(bell);
		fireEvent.keyDown(items()[0], { key: 'Enter' });
		expect(mockJumpToAgent).toHaveBeenCalledTimes(1);
	});

	it('does not intercept keyboard activation of independent links', () => {
		useSettingsStore.setState({ notificationCenterKeyboardNavigation: true });
		seed(
			[record({ actionUrl: 'https://example.com', actionLabel: 'Link', sessionId: 'agent-1' })],
			true
		);
		render(<NotificationCenterHost theme={mockTheme} />);
		const link = screen.getByRole('button', { name: 'Link' });
		link.focus();
		fireEvent.keyDown(link, { key: 'Enter' });
		expect(mockJumpToAgent).not.toHaveBeenCalled();
		expect(link).toHaveFocus();
	});
});
