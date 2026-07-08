import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExecutionQueueBrowser } from '../../renderer/components/ExecutionQueueBrowser';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import type { QueuedItem, Session, Theme } from '../../renderer/types';

const theme: Theme = {
	id: 'integration-dark',
	name: 'Integration Dark',
	mode: 'dark',
	colors: {
		accent: '#2563eb',
		accentDim: '#1d4ed8',
		accentForeground: '#ffffff',
		border: '#374151',
		bgActivity: '#0f172a',
		bgMain: '#111827',
		bgSidebar: '#1f2937',
		error: '#dc2626',
		success: '#16a34a',
		textDim: '#9ca3af',
		textMain: '#f9fafb',
		warning: '#f59e0b',
	},
};

describe('ExecutionQueueBrowser integration', () => {
	beforeEach(() => {
		vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-05-26T12:10:00.000Z'));
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('returns null while closed and closes the real layer on Escape when open', async () => {
		const onClose = vi.fn();
		const { container, rerender } = renderBrowser({ isOpen: false, onClose });
		expect(container.firstChild).toBeNull();

		rerender(
			<LayerStackProvider>
				<ExecutionQueueBrowser
					isOpen
					onClose={onClose}
					sessions={[createSession()]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={vi.fn()}
					onSwitchSession={vi.fn()}
				/>
			</LayerStackProvider>
		);

		expect(screen.getByText('Execution Queue')).toBeInTheDocument();
		fireEvent.keyDown(window, { key: 'Escape' });

		await waitFor(() => {
			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});

	it('filters queued items, switches sessions, removes items, and shows empty current state', () => {
		const onClose = vi.fn();
		const onRemoveItem = vi.fn();
		const onSwitchSession = vi.fn();
		const activeSession = createSession({
			executionQueue: [
				createQueuedItem({
					id: 'active-message',
					tabName: 'Plan Tab',
					images: ['data:image/png;base64,one', 'data:image/png;base64,two'],
					text: `Active queued message ${'x'.repeat(120)}`,
					timestamp: Date.now() - 30_000,
				}),
			],
		});
		const otherSession = createSession({
			id: 'other-session',
			name: 'Other Agent',
			executionQueue: [
				createQueuedItem({
					id: 'other-command',
					command: '/commit',
					commandDescription: 'Create a commit',
					tabName: 'Commit Tab',
					type: 'command',
				}),
			],
		});

		const { rerender } = renderBrowser({
			activeSessionId: 'active-session',
			onClose,
			onRemoveItem,
			onSwitchSession,
			sessions: [activeSession, otherSession],
		});

		expect(screen.getByText(/Active queued message/)).toBeInTheDocument();
		expect(screen.getByText('+ 2 images')).toBeInTheDocument();
		expect(screen.queryByText('/commit')).not.toBeInTheDocument();
		fireEvent.click(screen.getByTitle('Jump to this session'));
		expect(onSwitchSession).toHaveBeenCalledWith('active-session', 'tab-1');
		expect(onClose).toHaveBeenCalledTimes(1);
		onClose.mockClear();
		onSwitchSession.mockClear();

		fireEvent.click(screen.getByTitle('Remove from queue'));
		expect(onRemoveItem).toHaveBeenCalledWith('active-session', 'active-message');

		fireEvent.click(screen.getByRole('button', { name: /All Agents/i }));
		expect(screen.getByText('/commit')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /Other Agent/i }));
		expect(onSwitchSession).toHaveBeenCalledWith('other-session');
		expect(onClose).toHaveBeenCalledTimes(1);

		rerender(
			<LayerStackProvider>
				<ExecutionQueueBrowser
					isOpen
					onClose={onClose}
					sessions={[otherSession]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={onRemoveItem}
					onSwitchSession={onSwitchSession}
				/>
			</LayerStackProvider>
		);
		fireEvent.click(screen.getByRole('button', { name: /Current Agent/i }));
		expect(screen.getByText('No items queued for this agent')).toBeInTheDocument();
	});

	it('reorders current-session items using the drag midpoint workflow', async () => {
		vi.useFakeTimers();
		const onReorderItems = vi.fn();
		const { container } = renderBrowser({
			onReorderItems,
			sessions: [
				createSession({
					executionQueue: [
						createQueuedItem({ id: 'first', text: 'First queued message' }),
						createQueuedItem({
							id: 'second',
							command: '/commit',
							commandDescription: 'Create a commit',
							type: 'command',
						}),
					],
				}),
			],
		});

		const itemRows = container.querySelectorAll('.group.select-none');
		const wrappers = container.querySelectorAll('.relative.my-1');
		expect(itemRows).toHaveLength(2);
		expect(wrappers).toHaveLength(2);
		vi.spyOn(wrappers[1]!, 'getBoundingClientRect').mockReturnValue({
			bottom: 140,
			height: 40,
			left: 0,
			right: 300,
			toJSON: () => ({}),
			top: 100,
			width: 300,
			x: 0,
			y: 100,
		} as DOMRect);

		fireEvent.mouseDown(itemRows[0]!, { button: 0, buttons: 1 });
		act(() => {
			vi.advanceTimersByTime(150);
		});
		fireEvent.mouseMove(wrappers[1]!, { clientY: 130 });
		fireEvent.mouseUp(itemRows[0]!);

		expect(onReorderItems).toHaveBeenCalledWith('active-session', 0, 1);
	});

	it('reorders by hovering item and final drop zones while dragging', () => {
		vi.useFakeTimers();
		const onReorderItems = vi.fn();
		const { container } = renderBrowser({
			onReorderItems,
			sessions: [
				createSession({
					executionQueue: [
						createQueuedItem({ id: 'first', text: 'First queued message' }),
						createQueuedItem({ id: 'second', text: 'Second queued message' }),
					],
				}),
			],
		});
		const itemRows = container.querySelectorAll('.group.select-none');
		const dropZones = container.querySelectorAll('div.relative.h-1');
		expect(itemRows).toHaveLength(2);
		expect(dropZones).toHaveLength(3);

		fireEvent.mouseDown(itemRows[1]!, { button: 0, buttons: 1 });
		act(() => {
			vi.advanceTimersByTime(150);
		});
		fireEvent.mouseEnter(dropZones[0]!);
		fireEvent.mouseUp(itemRows[1]!);
		expect(onReorderItems).toHaveBeenCalledWith('active-session', 1, 0);

		onReorderItems.mockClear();
		fireEvent.mouseDown(itemRows[0]!, { button: 0, buttons: 1 });
		act(() => {
			vi.advanceTimersByTime(150);
		});
		fireEvent.mouseEnter(dropZones[2]!);
		fireEvent.mouseUp(itemRows[0]!);
		expect(onReorderItems).toHaveBeenCalledWith('active-session', 0, 1);
	});

	it('cancels active drags with Escape and clears pending drags on mouse leave', async () => {
		vi.useFakeTimers();
		const onReorderItems = vi.fn();
		const keydownHandlers: EventListener[] = [];
		const originalAddEventListener = window.addEventListener.bind(window);
		vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
			if (type === 'keydown' && !options && typeof listener === 'function') {
				keydownHandlers.push(listener as EventListener);
			}
			return originalAddEventListener(type, listener, options);
		});
		const { container } = renderBrowser({
			onReorderItems,
			sessions: [
				createSession({
					executionQueue: [
						createQueuedItem({ id: 'first', text: 'First queued message' }),
						createQueuedItem({ id: 'second', text: 'Second queued message' }),
					],
				}),
			],
		});
		const itemRows = container.querySelectorAll('.group.select-none');
		const dropZones = container.querySelectorAll('div.relative.h-1');

		fireEvent.mouseEnter(itemRows[0]!);
		fireEvent.mouseDown(itemRows[0]!, { button: 0, buttons: 1 });
		await act(async () => {
			vi.advanceTimersByTime(150);
			await Promise.resolve();
		});
		expect(keydownHandlers.length).toBeGreaterThan(0);
		await act(async () => {
			keydownHandlers.at(-1)?.(new KeyboardEvent('keydown', { key: 'Escape' }));
			await Promise.resolve();
		});
		fireEvent.mouseEnter(dropZones[2]!);
		fireEvent.mouseUp(itemRows[0]!);
		expect(onReorderItems).not.toHaveBeenCalled();

		fireEvent.mouseDown(itemRows[0]!, { button: 0, buttons: 1 });
		fireEvent.mouseLeave(itemRows[0]!);
		act(() => {
			vi.advanceTimersByTime(150);
		});
		fireEvent.mouseUp(itemRows[0]!);
		expect(onReorderItems).not.toHaveBeenCalled();
	});

	it('clears a pending drag timer when a row unmounts', () => {
		vi.useFakeTimers();
		const onReorderItems = vi.fn();
		const { container, unmount } = renderBrowser({
			onReorderItems,
			sessions: [
				createSession({
					executionQueue: [
						createQueuedItem({ id: 'first', text: 'First queued message' }),
						createQueuedItem({ id: 'second', text: 'Second queued message' }),
					],
				}),
			],
		});
		const itemRows = container.querySelectorAll('.group.select-none');

		fireEvent.mouseDown(itemRows[0]!, { button: 0, buttons: 1 });
		unmount();
		act(() => {
			vi.advanceTimersByTime(150);
		});

		expect(onReorderItems).not.toHaveBeenCalled();
	});

	it('ignores drag movement and drag starts that are not valid reorder gestures', () => {
		vi.useFakeTimers();
		const onReorderItems = vi.fn();
		const { container } = renderBrowser({
			onReorderItems,
			sessions: [
				createSession({
					executionQueue: [
						createQueuedItem({ id: 'first', text: 'First queued message' }),
						createQueuedItem({ id: 'second', text: 'Second queued message' }),
					],
				}),
			],
		});
		const itemRows = container.querySelectorAll('.group.select-none');
		const wrappers = container.querySelectorAll('.relative.my-1');

		fireEvent.mouseMove(wrappers[1]!, { clientY: 120 });
		fireEvent.mouseDown(itemRows[0]!, { button: 2, buttons: 2 });
		act(() => {
			vi.advanceTimersByTime(150);
		});
		fireEvent.mouseDown(screen.getAllByTitle('Remove from queue')[0]!, {
			button: 0,
			buttons: 1,
		});
		act(() => {
			vi.advanceTimersByTime(150);
		});

		expect(onReorderItems).not.toHaveBeenCalled();
	});
});

function renderBrowser(props: Partial<React.ComponentProps<typeof ExecutionQueueBrowser>> = {}) {
	return render(
		<LayerStackProvider>
			<ExecutionQueueBrowser
				isOpen
				onClose={vi.fn()}
				sessions={[createSession()]}
				activeSessionId="active-session"
				theme={theme}
				onRemoveItem={vi.fn()}
				onSwitchSession={vi.fn()}
				{...props}
			/>
		</LayerStackProvider>
	);
}

function createQueuedItem(overrides: Partial<QueuedItem> = {}): QueuedItem {
	return {
		id: 'queued-item',
		tabId: 'tab-1',
		tabName: 'Main',
		text: 'Queued message',
		timestamp: Date.now() - 90_000,
		type: 'message',
		...overrides,
	};
}

function createSession(overrides: Partial<Session> = {}): Session {
	return {
		activeFileTabId: null,
		activeTabId: 'tab-1',
		activeTimeMs: 0,
		aiLogs: [],
		aiPid: 0,
		aiTabs: [
			{
				agentSessionId: null,
				createdAt: 1700000000000,
				id: 'tab-1',
				inputValue: '',
				isStarred: false,
				logs: [],
				name: 'Main',
				saveToHistory: true,
				stagedImages: [],
				state: 'idle',
			},
		],
		changedFiles: [],
		closedTabHistory: [],
		contextUsage: 0,
		createdAt: 1700000000000,
		cwd: '/workspace/active',
		executionQueue: [createQueuedItem()],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		filePreviewTabs: [],
		fileTree: [],
		fullPath: '/workspace/active',
		id: 'active-session',
		inputMode: 'ai',
		isGitRepo: false,
		isLive: false,
		name: 'Active Agent',
		port: 0,
		projectRoot: '/workspace/active',
		shellLogs: [],
		state: 'idle',
		terminalPid: 0,
		toolType: 'claude-code',
		unifiedClosedTabHistory: [],
		unifiedTabOrder: [{ id: 'tab-1', type: 'ai' }],
		workLog: [],
		...overrides,
	};
}
