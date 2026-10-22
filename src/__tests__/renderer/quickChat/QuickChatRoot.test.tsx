/**
 * QuickChatRoot - the Quick Chat window's view.
 *
 * Its icon buttons explain themselves in a hover overlay rather than a native
 * `title`, which macOS does not show in this panel while another app is active.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QuickChatRoot } from '../../../renderer/quickChat/QuickChatRoot';
import {
	EMPTY_QUICK_CHAT_SNAPSHOT,
	QUICK_CHAT_COMPACT_HEIGHT,
	type QuickChatMessage,
	type QuickChatRoute,
	type QuickChatSnapshot,
} from '../../../shared/quickChat';
import { openZoomViewer, useZoomViewerStore } from '../../../renderer/components/ZoomViewer';
import { tabChoiceFromPickerId } from '../../../renderer/quickChat/QuickChatTabPicker';
import { recentChatItem } from '../../../renderer/quickChat/QuickChatHistoryPicker';
import { installLocalStorageMock } from '../../helpers/mockLocalStorage';
import { FONT_SCALE_RANGE, stepScale } from '../../../shared/scaleRange';

function snapshot(patch: Partial<QuickChatSnapshot> = {}): QuickChatSnapshot {
	return { ...EMPTY_QUICK_CHAT_SNAPSHOT, agentId: 'a', agentName: 'Pedsidian', ...patch };
}

async function renderWith(initial: QuickChatSnapshot) {
	vi.mocked(window.maestro.quickChat.getSnapshot).mockResolvedValue(initial);
	render(<QuickChatRoot />);
	await act(async () => {});
}

beforeEach(() => {
	vi.mocked(window.maestro.quickChat.command).mockReset();
	installLocalStorageMock();
});

describe('Keep button', () => {
	it('explains a temporary chat in a hover overlay, not a native title', async () => {
		await renderWith(snapshot({ persistent: false }));
		const button = screen.getByRole('button', { name: /^Keep as a tab\./ });
		expect(button).not.toHaveAttribute('title');

		fireEvent.mouseEnter(button.parentElement!);
		const tooltip = screen.getByRole('tooltip');
		expect(tooltip).toHaveTextContent('Keep as a tab');
		expect(tooltip).toHaveTextContent(
			'Temporary: this chat is deleted when you start a new one. Click to keep it as a tab on Pedsidian.'
		);
	});

	it('explains a kept chat and toggles it back to temporary', async () => {
		vi.mocked(window.maestro.quickChat.command).mockResolvedValue({
			ok: true,
			snapshot: snapshot({ persistent: false }),
		});
		await renderWith(snapshot({ persistent: true }));
		const button = screen.getByRole('button', { name: /^Kept as a tab\./ });

		fireEvent.mouseEnter(button.parentElement!);
		expect(screen.getByRole('tooltip')).toHaveTextContent('stays as a tab on Pedsidian');

		await act(async () => fireEvent.click(button));
		expect(window.maestro.quickChat.command).toHaveBeenCalledWith({
			type: 'setPersistent',
			persistent: false,
		});
	});
});

describe('Pin button', () => {
	it('explains what pinning does in a hover overlay', async () => {
		await renderWith(snapshot());
		const button = screen.getByRole('button', { name: /^Pinned on top\./ });
		fireEvent.mouseEnter(button.parentElement!);
		expect(screen.getByRole('tooltip')).toHaveTextContent('Floats above other windows.');
	});
});

describe('tab picker', () => {
	const tabs = [
		{ id: 't1', name: 'Blog: Waste No Tokens', busy: false, inChat: true },
		{ id: 't2', name: 'Build', busy: true, inChat: false },
	];

	it('names where the next message goes beside the agent', async () => {
		await renderWith(
			snapshot({ tabs, next: { kind: 'tab', tabId: 't1', name: tabs[0].name, chosen: false } })
		);
		expect(screen.getByTestId('quick-chat-tab-button')).toHaveTextContent('Blog: Waste No Tokens');
	});

	it('says "Choose tab" before the chat has one', async () => {
		await renderWith(snapshot());
		expect(screen.getByTestId('quick-chat-tab-button')).toHaveTextContent('Choose tab');
	});

	it('Cmd+T opens it with New tab first, and clicking it forces a new tab', async () => {
		vi.mocked(window.maestro.quickChat.command).mockResolvedValue({
			ok: true,
			snapshot: snapshot({ tabs, next: { kind: 'new' } }),
		});
		await renderWith(snapshot({ tabs }));
		await act(async () => fireEvent.keyDown(window, { key: 't', metaKey: true }));
		const rows = screen.getAllByTestId('quick-chat-tab-row');
		expect(rows.map((r) => r.textContent)).toEqual([
			expect.stringContaining('New tab'),
			expect.stringContaining('Any tab'),
			expect.stringContaining('Blog: Waste No Tokens'),
			expect.stringContaining('Build'),
		]);
		await act(async () => fireEvent.click(rows[0]));
		expect(window.maestro.quickChat.command).toHaveBeenCalledWith({
			type: 'setTab',
			choice: { kind: 'new' },
		});
		expect(screen.queryByTestId('quick-chat-tab-picker')).toBeNull();
	});

	// The keyboard path: Cmd+T, the row in effect (Any tab) is selected with New
	// tab in view right above it, Up then Enter starts a new tab.
	it('Cmd+T selects the row in effect, and Up then Enter picks New tab', async () => {
		vi.mocked(window.maestro.quickChat.command).mockResolvedValue({
			ok: true,
			snapshot: snapshot({ tabs, next: { kind: 'new' } }),
		});
		await renderWith(snapshot({ tabs }));
		await act(async () => fireEvent.keyDown(window, { key: 't', metaKey: true }));
		const rows = screen.getAllByTestId('quick-chat-tab-row');
		expect(rows[0]).toHaveTextContent('New tab');
		expect(rows[1]).toHaveAttribute('aria-selected', 'true');

		const filter = screen.getByTestId('quick-chat-tab-filter');
		expect(filter).toHaveFocus();
		await act(async () => fireEvent.keyDown(filter, { key: 'ArrowUp' }));
		expect(screen.getAllByTestId('quick-chat-tab-row')[0]).toHaveAttribute('aria-selected', 'true');
		await act(async () => fireEvent.keyDown(filter, { key: 'Enter' }));
		expect(window.maestro.quickChat.command).toHaveBeenCalledWith({
			type: 'setTab',
			choice: { kind: 'new' },
		});
	});

	// Opening the list slides rows under a pointer that is not moving, and
	// Chromium reports that as a mousemove: it must not take the selection.
	it('keeps the selection when a row slides under a still pointer', async () => {
		await renderWith(snapshot({ tabs }));
		await act(async () => fireEvent.keyDown(window, { key: 't', metaKey: true }));
		const rows = screen.getAllByTestId('quick-chat-tab-row');
		fireEvent.mouseMove(rows[0], { screenX: 50, screenY: 50 });
		fireEvent.mouseMove(rows[0], { screenX: 50, screenY: 50 });
		expect(rows[1]).toHaveAttribute('aria-selected', 'true');

		// A real move does select.
		fireEvent.mouseMove(rows[0], { screenX: 52, screenY: 50 });
		expect(screen.getAllByTestId('quick-chat-tab-row')[0]).toHaveAttribute('aria-selected', 'true');
	});

	it('picking a tab sends the next message there', async () => {
		vi.mocked(window.maestro.quickChat.command).mockResolvedValue({
			ok: true,
			snapshot: snapshot({ tabs, next: { kind: 'tab', tabId: 't2', name: 'Build', chosen: true } }),
		});
		await renderWith(snapshot({ tabs }));
		await act(async () => fireEvent.click(screen.getByTestId('quick-chat-tab-button')));
		await act(async () => fireEvent.click(screen.getAllByTestId('quick-chat-tab-row')[3]));
		expect(window.maestro.quickChat.command).toHaveBeenCalledWith({
			type: 'setTab',
			choice: { kind: 'tab', tabId: 't2' },
		});
	});
});

describe('recent chats', () => {
	const recent = (id: string, title: string, patch = {}) => ({
		id,
		agentId: 'a',
		agentName: 'Pedsidian',
		title,
		tabName: null,
		persistent: false,
		createdAt: 0,
		updatedAt: Date.now(),
		messageCount: 2,
		searchText: `${title}\nfollow-up about invoices`,
		...patch,
	});

	beforeEach(() => {
		vi.mocked(window.maestro.quickChat.getRecents).mockResolvedValue([
			recent('c1', 'plan the trip'),
			recent('c2', 'what is on my calendar', { agentName: 'Codex' }),
		]);
	});

	it('the History button sits just left of the thinking button and explains itself', async () => {
		await renderWith(snapshot());
		const history = screen.getByRole('button', { name: /^Recent chats\./ });
		const thinking = screen.getByRole('button', { name: /^Thinking hidden\./ });
		expect(
			history.compareDocumentPosition(thinking) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
		fireEvent.mouseEnter(history.parentElement!);
		expect(screen.getByRole('tooltip')).toHaveTextContent('Bring back an earlier chat');
	});

	it('lists the recent chats, the one in the window checked first', async () => {
		await renderWith(snapshot({ chatId: 'c1' }));
		await act(async () => fireEvent.click(screen.getByRole('button', { name: /^Recent chats\./ })));
		const rows = screen.getAllByTestId('quick-chat-history-row');
		expect(rows.map((r) => r.textContent)).toEqual([
			expect.stringContaining('plan the trip'),
			expect.stringContaining('what is on my calendar'),
		]);
		expect(rows[0]).toHaveAttribute('aria-selected', 'true');
		expect(rows[1]).toHaveTextContent('Codex - 2 messages');
	});

	it('a word from a later message finds the chat', async () => {
		await renderWith(snapshot());
		await act(async () => fireEvent.keyDown(window, { key: 'y', metaKey: true }));
		fireEvent.change(screen.getByTestId('quick-chat-history-filter'), {
			target: { value: 'invoices' },
		});
		expect(screen.getAllByTestId('quick-chat-history-row')).toHaveLength(2);
		fireEvent.change(screen.getByTestId('quick-chat-history-filter'), {
			target: { value: 'calendar' },
		});
		expect(screen.getAllByTestId('quick-chat-history-row')[0]).toHaveTextContent(
			'what is on my calendar'
		);
	});

	it('Cmd+Y opens it, and picking a chat recalls it', async () => {
		vi.mocked(window.maestro.quickChat.command).mockResolvedValue({
			ok: true,
			snapshot: snapshot({ chatId: 'c2' }),
		});
		await renderWith(snapshot({ chatId: 'c1' }));
		await act(async () => fireEvent.keyDown(window, { key: 'y', metaKey: true }));
		await act(async () => fireEvent.click(screen.getAllByTestId('quick-chat-history-row')[1]));
		expect(window.maestro.quickChat.command).toHaveBeenCalledWith({
			type: 'recall',
			chatId: 'c2',
		});
		expect(screen.queryByTestId('quick-chat-history-picker')).toBeNull();
	});

	it('picking the chat already in the window only closes the list', async () => {
		await renderWith(snapshot({ chatId: 'c1' }));
		await act(async () => fireEvent.keyDown(window, { key: 'y', metaKey: true }));
		await act(async () => fireEvent.click(screen.getAllByTestId('quick-chat-history-row')[0]));
		expect(window.maestro.quickChat.command).not.toHaveBeenCalled();
		expect(screen.queryByTestId('quick-chat-history-picker')).toBeNull();
	});

	it('says so when there are none', async () => {
		vi.mocked(window.maestro.quickChat.getRecents).mockResolvedValue([]);
		await renderWith(snapshot());
		await act(async () => fireEvent.keyDown(window, { key: 'y', metaKey: true }));
		expect(screen.getByTestId('quick-chat-history-picker')).toHaveTextContent(
			'No recent chats yet'
		);
	});

	it('a row matches on its agent and tab too', () => {
		expect(recentChatItem(recent('c3', 'x', { tabName: 'Deploy' })).extras).toEqual([
			'Pedsidian',
			'Deploy',
			'x\nfollow-up about invoices',
		]);
	});
});

describe('tabChoiceFromPickerId', () => {
	it('maps the fixed rows and tab rows to choices', () => {
		expect(tabChoiceFromPickerId('new')).toEqual({ kind: 'new' });
		expect(tabChoiceFromPickerId('auto')).toEqual({ kind: 'auto' });
		expect(tabChoiceFromPickerId('tab:abc')).toEqual({ kind: 'tab', tabId: 'abc' });
	});
});

describe('Thinking button', () => {
	it.each([
		['off', /^Thinking hidden\./, "Click to show the agent's reasoning"],
		['on', /^Showing thinking\./, 'goes away once the answer arrives'],
		['sticky', /^Keeping thinking\./, 'stays above each answer'],
	] as const)('explains the %s mode', async (mode, name, hint) => {
		await renderWith(snapshot({ thinking: mode }));
		const button = screen.getByRole('button', { name });
		fireEvent.mouseEnter(button.parentElement!);
		expect(screen.getByRole('tooltip')).toHaveTextContent(hint);
	});

	it('asks the engine to step to the next mode', async () => {
		vi.mocked(window.maestro.quickChat.command).mockResolvedValue({
			ok: true,
			snapshot: snapshot({ thinking: 'on' }),
		});
		await renderWith(snapshot());
		await act(async () =>
			fireEvent.click(screen.getByRole('button', { name: /^Thinking hidden\./ }))
		);
		expect(window.maestro.quickChat.command).toHaveBeenCalledWith({
			type: 'setThinking',
			mode: 'cycle',
		});
		expect(screen.getByRole('button', { name: /^Showing thinking\./ })).toBeInTheDocument();
	});

	it('Cmd+Shift+K cycles it, like the main composer', async () => {
		vi.mocked(window.maestro.quickChat.command).mockResolvedValue({
			ok: true,
			snapshot: snapshot({ thinking: 'on' }),
		});
		await renderWith(snapshot());
		await act(async () => fireEvent.keyDown(window, { key: 'K', metaKey: true, shiftKey: true }));
		expect(window.maestro.quickChat.command).toHaveBeenCalledWith({
			type: 'setThinking',
			mode: 'cycle',
		});
	});

	it('renders reasoning apart from the answer', async () => {
		await renderWith(
			snapshot({
				thinking: 'sticky',
				messages: [
					{ id: 'u', role: 'user', text: 'hi', timestamp: 1 },
					{ id: 't', role: 'thinking', text: 'Looking it up.', timestamp: 2 },
					{ id: 'a', role: 'assistant', text: 'Done.', timestamp: 3 },
				],
			})
		);
		expect(screen.getByTestId('quick-chat-thinking')).toHaveTextContent('Looking it up.');
	});
});

describe('keyboard chords', () => {
	it('Cmd+S toggles keep, the same command the bookmark sends', async () => {
		vi.mocked(window.maestro.quickChat.command).mockResolvedValue({
			ok: true,
			snapshot: snapshot({ persistent: true }),
		});
		await renderWith(snapshot({ persistent: false }));
		await act(async () => fireEvent.keyDown(window, { key: 's', metaKey: true }));
		expect(window.maestro.quickChat.command).toHaveBeenCalledWith({
			type: 'setPersistent',
			persistent: true,
		});
	});

	it('Cmd+P toggles the pin and prevents the print default', async () => {
		vi.mocked(window.maestro.quickChat.setPinned).mockClear();
		await renderWith(snapshot());
		const event = new KeyboardEvent('keydown', { key: 'p', metaKey: true, cancelable: true });
		await act(async () => {
			window.dispatchEvent(event);
		});
		expect(event.defaultPrevented).toBe(true);
		expect(window.maestro.quickChat.setPinned).toHaveBeenCalledWith(false);
	});

	it('acts once on a held chord, ignoring auto-repeat', async () => {
		vi.mocked(window.maestro.quickChat.setPinned).mockClear();
		await renderWith(snapshot());
		await act(async () => {
			fireEvent.keyDown(window, { key: 'p', metaKey: true });
			fireEvent.keyDown(window, { key: 'p', metaKey: true, repeat: true });
			fireEvent.keyDown(window, { key: 'p', metaKey: true, repeat: true });
		});
		expect(window.maestro.quickChat.setPinned).toHaveBeenCalledTimes(1);
	});

	it('answers chords typed in the agent picker filter', async () => {
		vi.mocked(window.maestro.quickChat.setPinned).mockClear();
		await renderWith(snapshot({ agents: [{ id: 'a', name: 'Pedsidian' }] }));
		await act(async () => fireEvent.keyDown(window, { key: 'o', metaKey: true }));
		const filter = screen.getByTestId('quick-chat-agent-filter');
		await act(async () => fireEvent.keyDown(filter, { key: 'p', metaKey: true }));
		expect(window.maestro.quickChat.setPinned).toHaveBeenCalledWith(false);

		// Cmd+O from the filter closes the picker again.
		await act(async () => fireEvent.keyDown(filter, { key: 'o', metaKey: true }));
		expect(screen.queryByTestId('quick-chat-agent-filter')).toBeNull();
	});

	it('leaves Shift chords to the composer', async () => {
		vi.mocked(window.maestro.quickChat.setPinned).mockClear();
		await renderWith(snapshot());
		await act(async () => fireEvent.keyDown(window, { key: 'p', metaKey: true, shiftKey: true }));
		expect(window.maestro.quickChat.setPinned).not.toHaveBeenCalled();
	});

	it('names the chord in the Keep and Pin overlays', async () => {
		await renderWith(snapshot());
		fireEvent.mouseEnter(screen.getByRole('button', { name: /^Keep as a tab\./ }).parentElement!);
		expect(screen.getByRole('tooltip')).toHaveTextContent(/S$/);
	});
});

describe('Open in Maestro', () => {
	it('Cmd+Shift+T opens the chat as a tab once there is one, and the overlay names the chord', async () => {
		const open = snapshot({ tabId: 't1', messages: [{ id: 'm', role: 'user', text: 'hi' }] });
		vi.mocked(window.maestro.quickChat.command).mockResolvedValue({ ok: true, snapshot: open });
		await renderWith(open);
		await act(async () => fireEvent.keyDown(window, { key: 'T', metaKey: true, shiftKey: true }));
		expect(window.maestro.quickChat.command).toHaveBeenCalledWith({ type: 'reveal' });

		fireEvent.mouseEnter(screen.getByRole('button', { name: /^Open in Maestro\./ }).parentElement!);
		expect(screen.getByRole('tooltip')).toHaveTextContent(/T$/);
	});

	it('Cmd+Shift+T does nothing before the first message', async () => {
		await renderWith(snapshot({ tabId: null }));
		await act(async () => fireEvent.keyDown(window, { key: 'T', metaKey: true, shiftKey: true }));
		expect(window.maestro.quickChat.command).not.toHaveBeenCalledWith({ type: 'reveal' });
	});
});

describe('Close', () => {
	it('Cmd+W hides the window, even with the agent picker open, and the overlay names it', async () => {
		// The header (and its Close button) only renders once there is a conversation.
		await renderWith(
			snapshot({
				agents: [{ id: 'a', name: 'Pedsidian' }],
				messages: [{ id: 'm', role: 'user', text: 'hi' }],
			})
		);
		fireEvent.mouseEnter(screen.getByRole('button', { name: /^Close\./ }).parentElement!);
		expect(screen.getByRole('tooltip')).toHaveTextContent(/Esc or .*W$/);

		await act(async () => fireEvent.keyDown(window, { key: 'o', metaKey: true }));
		const filter = screen.getByTestId('quick-chat-agent-filter');
		await act(async () => fireEvent.keyDown(filter, { key: 'w', metaKey: true }));
		expect(window.maestro.quickChat.window).toHaveBeenCalledWith('hide');
	});

	it('Cmd+` goes back to Maestro instead of cycling windows, once per press', async () => {
		vi.mocked(window.maestro.quickChat.window).mockClear();
		await renderWith(snapshot({ agents: [{ id: 'a', name: 'Pedsidian' }] }));
		const press = (init: KeyboardEventInit) =>
			act(async () =>
				fireEvent.keyDown(window, { key: '`', code: 'Backquote', metaKey: true, ...init })
			);

		await press({});
		expect(window.maestro.quickChat.window).toHaveBeenCalledWith('return');
		// Shift reverses the cycle; it is the same trip back.
		await press({ key: '~', shiftKey: true });
		expect(window.maestro.quickChat.window).toHaveBeenCalledTimes(2);
		await press({ repeat: true });
		expect(window.maestro.quickChat.window).toHaveBeenCalledTimes(2);
		expect(window.maestro.quickChat.window).not.toHaveBeenCalledWith('hide');
	});
});

describe('header', () => {
	it('shows only the agent, not a "Quick Chat" label', async () => {
		await renderWith(snapshot({ messages: [{ id: 'm', role: 'user', text: 'hi' }] }));
		expect(screen.queryByText('Quick Chat')).toBeNull();
		expect(screen.queryByText('Quick Chat tab')).toBeNull();
	});

	it('explains the agent switcher in an overlay with its chord', async () => {
		await renderWith(snapshot());
		const button = screen.getByTestId('quick-chat-agent-button');
		expect(button).not.toHaveAttribute('title');
		fireEvent.mouseEnter(button.parentElement!);
		expect(screen.getByRole('tooltip')).toHaveTextContent('Switching starts a new chat.');
	});
});

describe('diagram viewer', () => {
	afterEach(() => act(() => useZoomViewerStore.getState().close()));

	it('gives the keyboard back to the viewer, not the hidden composer, when summoned again', async () => {
		let focusInput: (() => void) | undefined;
		vi.mocked(window.maestro.quickChat.onFocusInput).mockImplementationOnce((cb) => {
			focusInput = cb;
			return () => {};
		});
		await renderWith(snapshot());
		act(() =>
			openZoomViewer(document.createElementNS('http://www.w3.org/2000/svg', 'svg'), 'Flow')
		);
		screen.getByPlaceholderText(/anything/).focus();

		act(() => focusInput?.());
		expect(document.activeElement).toBe(screen.getByTestId('zoom-viewer'));
	});

	it('opens full screen over the window, and Escape closes it without hiding the window', async () => {
		vi.mocked(window.maestro.quickChat.setFullView).mockClear();
		vi.mocked(window.maestro.quickChat.window).mockClear();
		await renderWith(snapshot());
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		act(() => openZoomViewer(svg, 'Flow'));
		expect(window.maestro.quickChat.setFullView).toHaveBeenLastCalledWith(true);

		await act(async () =>
			fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
		);
		expect(useZoomViewerStore.getState().request).toBeNull();
		expect(window.maestro.quickChat.setFullView).toHaveBeenLastCalledWith(false);
		expect(window.maestro.quickChat.window).not.toHaveBeenCalledWith('hide');
	});
});

/** A message the user sent, with where it went. */
function sentMessage(
	id: string,
	text: string,
	route: Partial<QuickChatRoute> = {}
): QuickChatMessage {
	return {
		id,
		role: 'user',
		text,
		timestamp: 0,
		route: {
			status: 'done',
			tabId: 'tab-1',
			tabName: 'Amazon Delivery',
			origin: 'open',
			tabOpen: true,
			since: null,
			...route,
		},
	};
}

describe('working indicator', () => {
	it('counts up from the start of the reply being written', async () => {
		await renderWith(
			snapshot({
				busy: true,
				messages: [sentMessage('m', 'hi', { status: 'running', since: Date.now() - 5000 })],
			})
		);
		expect(screen.getByText(/^Working for 5s$/)).toBeTruthy();
	});

	it('says Working without a frozen 0s when the start is unknown', async () => {
		await renderWith(
			snapshot({ busy: true, messages: [sentMessage('m', 'hi', { status: 'running' })] })
		);
		expect(screen.getByText('Working…')).toBeTruthy();
		expect(screen.queryByText(/Working for/)).toBeNull();
	});

	it('sits under the reply it belongs to, not at the bottom of the thread', async () => {
		await renderWith(
			snapshot({
				busy: true,
				messages: [
					sentMessage('m1', 'about the build', { status: 'running' }),
					{ id: 'r1', role: 'assistant', text: 'Looking', timestamp: 0 },
					sentMessage('m2', 'about lunch'),
					{ id: 'r2', role: 'assistant', text: 'Sandwich', timestamp: 0 },
				],
			})
		);
		const working = screen.getByTestId('quick-chat-working');
		const lunch = screen.getByText('about lunch');
		// Before the second message in document order.
		expect(working.compareDocumentPosition(lunch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(screen.getAllByTestId('quick-chat-working')).toHaveLength(1);
	});
});

describe('where a message went', () => {
	it('says it is searching while a tab is being found', async () => {
		await renderWith(
			snapshot({
				busy: true,
				messages: [sentMessage('m', 'hi', { status: 'searching', tabId: null, origin: null })],
			})
		);
		expect(screen.getByText('Searching tabs…')).toBeTruthy();
		expect(screen.queryByTestId('quick-chat-route-pill')).toBeNull();
		// The spin is on a wrapper: a spinning <svg> repaints the window every frame.
		expect(document.querySelector('svg.animate-spin')).toBeNull();
		expect(document.querySelector('span.animate-spin svg')).not.toBeNull();
	});

	it('names the tab in a pill that opens that tab in Maestro', async () => {
		vi.mocked(window.maestro.quickChat.command).mockResolvedValue({
			ok: true,
			snapshot: snapshot(),
		});
		await renderWith(snapshot({ messages: [sentMessage('m1', 'any update?')] }));
		const pill = screen.getByTestId('quick-chat-route-pill');
		expect(pill).toHaveTextContent('Amazon Delivery');

		fireEvent.mouseEnter(pill.parentElement!);
		expect(screen.getByRole('tooltip')).toHaveTextContent('Sent to an open tab');

		await act(async () => fireEvent.click(pill));
		expect(window.maestro.quickChat.command).toHaveBeenCalledWith({
			type: 'reveal',
			messageId: 'm1',
		});
	});

	it.each([
		['reopened', 'Reopened a closed tab'],
		['new', 'Started a new tab'],
	] as const)('explains a %s tab', async (origin, label) => {
		await renderWith(snapshot({ messages: [sentMessage('m', 'hi', { origin })] }));
		fireEvent.mouseEnter(screen.getByTestId('quick-chat-route-pill').parentElement!);
		expect(screen.getByRole('tooltip')).toHaveTextContent(label);
	});

	it('disables the pill once its tab is closed', async () => {
		await renderWith(snapshot({ messages: [sentMessage('m', 'hi', { tabOpen: false })] }));
		expect(screen.getByTestId('quick-chat-route-pill')).toBeDisabled();
	});

	it('shows a queued message as waiting, with the way out to a new tab', async () => {
		vi.mocked(window.maestro.quickChat.command).mockResolvedValue({
			ok: true,
			snapshot: snapshot(),
		});
		await renderWith(
			snapshot({ busy: true, messages: [sentMessage('m7', 'one more', { status: 'queued' })] })
		);
		expect(screen.getByTestId('quick-chat-route-queued')).toHaveTextContent('Queued');

		await act(async () =>
			fireEvent.click(screen.getByRole('button', { name: /Send to a new tab/ }))
		);
		expect(window.maestro.quickChat.command).toHaveBeenCalledWith({
			type: 'moveToNewTab',
			messageId: 'm7',
		});
	});

	it('offers Steer on a queued message the running reply can take', async () => {
		vi.mocked(window.maestro.quickChat.command).mockResolvedValue({
			ok: true,
			snapshot: snapshot(),
		});
		await renderWith(
			snapshot({
				busy: true,
				messages: [sentMessage('m8', 'change course', { status: 'queued', canSteer: true })],
			})
		);
		await act(async () => fireEvent.click(screen.getByTestId('quick-chat-route-steer')));
		expect(window.maestro.quickChat.command).toHaveBeenCalledWith({
			type: 'steer',
			messageId: 'm8',
		});
	});

	it('offers no Steer when the running reply cannot take input', async () => {
		await renderWith(
			snapshot({
				busy: true,
				messages: [sentMessage('m9', 'later', { status: 'queued', canSteer: false })],
			})
		);
		expect(screen.getByTestId('quick-chat-route-queued')).toBeTruthy();
		expect(screen.queryByTestId('quick-chat-route-steer')).toBeNull();
	});

	it('offers no way out for a message that is not waiting', async () => {
		await renderWith(snapshot({ messages: [sentMessage('m', 'hi', { status: 'running' })] }));
		expect(screen.queryByRole('button', { name: /Send to a new tab/ })).toBeNull();
	});

	it('has a thumbs-down beside a tab Maestro chose, which sends the message to a new tab', async () => {
		vi.mocked(window.maestro.quickChat.command).mockResolvedValue({
			ok: true,
			snapshot: snapshot(),
		});
		await renderWith(snapshot({ messages: [sentMessage('m3', 'any update?')] }));
		const reject = screen.getByTestId('quick-chat-route-reject');

		fireEvent.mouseEnter(reject.parentElement!);
		expect(screen.getByRole('tooltip')).toHaveTextContent('Wrong tab');

		await act(async () => fireEvent.click(reject));
		expect(window.maestro.quickChat.command).toHaveBeenCalledWith({
			type: 'moveToNewTab',
			messageId: 'm3',
		});
	});

	it('says the thumbs-down stops a reply still being written', async () => {
		await renderWith(
			snapshot({ busy: true, messages: [sentMessage('m', 'hi', { status: 'running' })] })
		);
		fireEvent.mouseEnter(screen.getByTestId('quick-chat-route-reject').parentElement!);
		expect(screen.getByRole('tooltip')).toHaveTextContent('Stop the reply in "Amazon Delivery"');
	});

	it('offers the thumbs-down on a reopened tab too', async () => {
		await renderWith(snapshot({ messages: [sentMessage('m', 'hi', { origin: 'reopened' })] }));
		expect(screen.getByTestId('quick-chat-route-reject')).toBeTruthy();
	});

	it.each([
		['a new tab it started', { origin: 'new' as const }],
		['a queued message, which has its own way out', { status: 'queued' as const }],
	])('has no thumbs-down for %s', async (_, route) => {
		await renderWith(snapshot({ messages: [sentMessage('m', 'hi', route)] }));
		expect(screen.queryByTestId('quick-chat-route-reject')).toBeNull();
	});

	it('marks a withdrawn message cancelled', async () => {
		await renderWith(snapshot({ messages: [sentMessage('m', 'hi', { status: 'cancelled' })] }));
		expect(screen.getByText('Cancelled')).toBeTruthy();
	});
});

describe('sending while a reply is in progress', () => {
	const busyThread = () =>
		snapshot({ busy: true, messages: [sentMessage('m', 'first', { status: 'running' })] });

	it('sends the next message without waiting', async () => {
		vi.mocked(window.maestro.quickChat.command).mockResolvedValue({
			ok: true,
			snapshot: busyThread(),
		});
		await renderWith(busyThread());
		const composer = screen.getByPlaceholderText(/Reply to/);
		fireEvent.change(composer, { target: { value: 'second' } });
		await act(async () => fireEvent.keyDown(composer, { key: 'Enter' }));
		expect(window.maestro.quickChat.command).toHaveBeenCalledWith({ type: 'send', text: 'second' });
	});

	it('keeps Stop beside Send rather than in its place', async () => {
		vi.mocked(window.maestro.quickChat.command).mockResolvedValue({
			ok: true,
			snapshot: snapshot(),
		});
		await renderWith(busyThread());
		expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
		await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Stop' })));
		expect(window.maestro.quickChat.command).toHaveBeenCalledWith({ type: 'stop' });
	});

	it('shows no Stop when nothing is in motion', async () => {
		await renderWith(snapshot({ messages: [sentMessage('m', 'hi')] }));
		expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
	});
});

describe('text zoom', () => {
	const conversation = () =>
		snapshot({ messages: [{ id: 'm', role: 'user', text: 'what is the story?' }] });
	/** The conversation's size as a multiple of its 0.875rem base. */
	const messagesFontSize = () =>
		Math.round(
			(parseFloat((document.querySelector('.quick-chat-messages') as HTMLElement).style.fontSize) /
				0.875) *
				100
		) / 100;

	/** The main process owns the zoom; this stands in for it. */
	let mainScale: number;
	let pushFromMain: ((scale: number) => void) | undefined;
	beforeEach(() => {
		mainScale = 1;
		vi.mocked(window.maestro.quickChat.getFontScale).mockImplementation(async () => mainScale);
		vi.mocked(window.maestro.quickChat.setFontScale).mockImplementation(async (request) => {
			mainScale =
				'reset' in request
					? 1
					: 'step' in request
						? stepScale(mainScale, request.step, FONT_SCALE_RANGE)
						: request.scale;
			return mainScale;
		});
		vi.mocked(window.maestro.quickChat.onFontScale).mockImplementation((cb) => {
			pushFromMain = cb;
			return () => {};
		});
	});

	it('Cmd+= and Cmd+- step the conversation size, Cmd+0 resets it', async () => {
		await renderWith(conversation());
		expect(messagesFontSize()).toBe(1);

		await act(async () => fireEvent.keyDown(window, { key: '=', metaKey: true }));
		await act(async () => fireEvent.keyDown(window, { key: '=', metaKey: true, repeat: true }));
		expect(messagesFontSize()).toBe(1.2);

		await act(async () => fireEvent.keyDown(window, { key: '-', metaKey: true }));
		expect(messagesFontSize()).toBe(1.1);

		await act(async () => fireEvent.keyDown(window, { key: '0', metaKey: true }));
		expect(messagesFontSize()).toBe(1);
	});

	it('accepts Cmd+Shift+= (the + key) as a step up', async () => {
		await renderWith(conversation());
		await act(async () => fireEvent.keyDown(window, { key: '+', metaKey: true, shiftKey: true }));
		expect(window.maestro.quickChat.setFontScale).toHaveBeenLastCalledWith({ step: 1 });
		expect(messagesFontSize()).toBe(1.1);
	});

	it('opens at the size the main process remembers', async () => {
		mainScale = 1.3;
		await renderWith(conversation());
		expect(messagesFontSize()).toBe(1.3);
		expect(screen.getByRole('button', { name: 'Reset text font size' })).toHaveTextContent('130%');
	});

	it('follows a change made elsewhere (maestro-cli quick-chat font)', async () => {
		await renderWith(conversation());
		act(() => pushFromMain?.(1.5));
		expect(messagesFontSize()).toBe(1.5);
	});

	it('a change announced while the first read is in flight is not overwritten by it', async () => {
		let answerRead: (value: number) => void = () => {};
		vi.mocked(window.maestro.quickChat.getFontScale).mockImplementation(
			() => new Promise((resolve) => (answerRead = resolve))
		);
		await renderWith(conversation());
		act(() => pushFromMain?.(1.5));
		await act(async () => answerRead(1));
		expect(messagesFontSize()).toBe(1.5);
	});

	it('draws the shared control, with overlays that name each chord', async () => {
		await renderWith(conversation());
		const larger = screen.getByRole('button', { name: 'Increase text font size' });
		expect(larger).not.toHaveAttribute('title');
		await act(async () => fireEvent.click(larger));
		expect(messagesFontSize()).toBe(1.1);

		fireEvent.mouseEnter(larger.parentElement!);
		expect(screen.getByRole('tooltip')).toHaveTextContent(/=$/);
	});

	it('hides the control until there is a conversation to zoom', async () => {
		await renderWith(snapshot());
		expect(screen.queryByTestId('quick-chat-font-scale')).toBeNull();
	});
});

describe('composer-only window height', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('reports the composer height so the window grows with the draft', async () => {
		// jsdom has no layout: stand in for the composer's rendered height.
		vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
			this: HTMLElement
		) {
			return this.dataset.testid === 'quick-chat-composer' ? 260 : 0;
		});
		vi.mocked(window.maestro.quickChat.setCompactHeight).mockClear();
		await renderWith(snapshot());

		expect(window.maestro.quickChat.setCompactHeight).toHaveBeenLastCalledWith(260);
		// Its height is its content's, never stretched to the window it sizes.
		expect(screen.getByTestId('quick-chat-composer').className).not.toContain('h-full');
		// Extracting the shared surface must preserve compact sizing and its DOM ref.
		expect(screen.getByTestId('quick-chat-composer')).toHaveStyle({
			minHeight: `${QUICK_CHAT_COMPACT_HEIGHT}px`,
		});
		expect(screen.getByTestId('quick-chat-composer')).toHaveClass('rounded-3xl');
	});
});

describe('images', () => {
	const PNG_BYTES = 'png-bytes';
	const PNG_DATA_URL = `data:image/png;base64,${btoa(PNG_BYTES)}`;

	function imageFile(name = 'shot.png', type = 'image/png'): File {
		return new File([PNG_BYTES], name, { type });
	}

	/** What a paste or a drop hands the window: its files, listed as items too. */
	function transfer(files: File[]) {
		return {
			items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
			files,
			types: ['Files'],
		};
	}

	async function paste(files: File[]) {
		const composer = screen.getByPlaceholderText(/Ask Pedsidian anything/);
		fireEvent.paste(composer, { clipboardData: transfer(files) });
		await vi.waitFor(() => expect(screen.getByTestId('quick-chat-staged-images')).toBeTruthy());
		return composer;
	}

	afterEach(() => act(() => useZoomViewerStore.getState().close()));

	it('stages a pasted image and sends it with the message', async () => {
		vi.mocked(window.maestro.quickChat.command).mockResolvedValue({
			ok: true,
			snapshot: snapshot(),
		});
		await renderWith(snapshot());
		const composer = await paste([imageFile()]);
		expect(screen.getByRole('button', { name: 'Staged image 1' })).toBeTruthy();

		fireEvent.change(composer, { target: { value: 'what is this?' } });
		await act(async () => fireEvent.keyDown(composer, { key: 'Enter' }));
		expect(window.maestro.quickChat.command).toHaveBeenCalledWith({
			type: 'send',
			text: 'what is this?',
			images: [PNG_DATA_URL],
		});
		expect(screen.queryByTestId('quick-chat-staged-images')).toBeNull();
	});

	it('sends images with no text', async () => {
		vi.mocked(window.maestro.quickChat.command).mockResolvedValue({
			ok: true,
			snapshot: snapshot(),
		});
		await renderWith(snapshot());
		await paste([imageFile()]);
		const send = screen.getByRole('button', { name: 'Send' });
		expect(send).not.toBeDisabled();
		await act(async () => fireEvent.click(send));
		expect(window.maestro.quickChat.command).toHaveBeenCalledWith({
			type: 'send',
			text: '',
			images: [PNG_DATA_URL],
		});
	});

	it('keeps the images when the send fails', async () => {
		vi.mocked(window.maestro.quickChat.command).mockResolvedValue({
			ok: false,
			error: 'No agent to chat with.',
			snapshot: snapshot(),
		});
		await renderWith(snapshot());
		await paste([imageFile()]);
		await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
		expect(screen.getByRole('button', { name: 'Staged image 1' })).toBeTruthy();
	});

	it('stages the same image once, and removes it from the strip', async () => {
		await renderWith(snapshot());
		await paste([imageFile(), imageFile('again.png')]);
		expect(screen.getAllByRole('button', { name: /^Staged image/ })).toHaveLength(1);
		fireEvent.click(screen.getByRole('button', { name: 'Remove image 1' }));
		expect(screen.queryByTestId('quick-chat-staged-images')).toBeNull();
	});

	it('stages a dropped image and refuses a dropped file that is not one', async () => {
		await renderWith(snapshot());
		const composer = screen.getByPlaceholderText(/Ask Pedsidian anything/);
		fireEvent.drop(composer, { dataTransfer: transfer([new File(['x'], 'notes.txt')]) });
		expect(screen.getByText('Only images can be attached to a chat message')).toBeTruthy();
		fireEvent.drop(composer, { dataTransfer: transfer([imageFile()]) });
		await vi.waitFor(() =>
			expect(screen.getByRole('button', { name: 'Staged image 1' })).toBeTruthy()
		);
	});

	it('stages images picked with the attach button', async () => {
		await renderWith(snapshot());
		const input = screen.getByTestId('quick-chat-image-input') as HTMLInputElement;
		const click = vi.spyOn(input, 'click');
		fireEvent.click(screen.getByRole('button', { name: /^Attach images/ }));
		expect(click).toHaveBeenCalled();
		fireEvent.change(input, { target: { files: [imageFile()] } });
		await vi.waitFor(() =>
			expect(screen.getByRole('button', { name: 'Staged image 1' })).toBeTruthy()
		);
	});

	it('shows a sent message with its image previews, and opens one large', async () => {
		const preview = 'data:image/webp;base64,UFJFVklFVw==';
		await renderWith(snapshot({ messages: [{ ...sentMessage('m', 'look'), images: [preview] }] }));
		const images = screen.getByTestId('quick-chat-message-images');
		expect(images.querySelector('img')).toHaveAttribute('src', preview);
		act(() => fireEvent.click(screen.getByRole('button', { name: 'Open image 1' })));
		expect(useZoomViewerStore.getState().request).not.toBeNull();
	});

	it('shows an image-only message without an empty bubble', async () => {
		await renderWith(
			snapshot({ messages: [{ ...sentMessage('m', ''), images: ['data:image/png;base64,AA=='] }] })
		);
		expect(screen.getByRole('button', { name: 'Open image 1' })).toBeTruthy();
		expect(document.querySelector('.whitespace-pre-wrap.rounded-2xl')).toBeNull();
	});
});
