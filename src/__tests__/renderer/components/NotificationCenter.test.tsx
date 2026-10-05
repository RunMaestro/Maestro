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
});
