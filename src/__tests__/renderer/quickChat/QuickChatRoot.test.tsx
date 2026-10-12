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
	type QuickChatMessage,
	type QuickChatRoute,
	type QuickChatSnapshot,
} from '../../../shared/quickChat';
import { openZoomViewer, useZoomViewerStore } from '../../../renderer/components/ZoomViewer';
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

describe('keyboard chords', () => {
	it('Cmd+B toggles keep, the same command the bookmark sends', async () => {
		vi.mocked(window.maestro.quickChat.command).mockResolvedValue({
			ok: true,
			snapshot: snapshot({ persistent: true }),
		});
		await renderWith(snapshot({ persistent: false }));
		await act(async () => fireEvent.keyDown(window, { key: 'b', metaKey: true }));
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
		await act(async () => fireEvent.keyDown(window, { key: 'k', metaKey: true }));
		const filter = screen.getByTestId('quick-chat-agent-filter');
		await act(async () => fireEvent.keyDown(filter, { key: 'p', metaKey: true }));
		expect(window.maestro.quickChat.setPinned).toHaveBeenCalledWith(false);

		// Cmd+K from the filter closes the picker again.
		await act(async () => fireEvent.keyDown(filter, { key: 'k', metaKey: true }));
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
		expect(screen.getByRole('tooltip')).toHaveTextContent(/B$/);
	});
});

describe('Open in Maestro', () => {
	it('Cmd+T opens the chat as a tab once there is one, and the overlay names the chord', async () => {
		const open = snapshot({ tabId: 't1', messages: [{ id: 'm', role: 'user', text: 'hi' }] });
		vi.mocked(window.maestro.quickChat.command).mockResolvedValue({ ok: true, snapshot: open });
		await renderWith(open);
		await act(async () => fireEvent.keyDown(window, { key: 't', metaKey: true }));
		expect(window.maestro.quickChat.command).toHaveBeenCalledWith({ type: 'reveal' });

		fireEvent.mouseEnter(screen.getByRole('button', { name: /^Open in Maestro\./ }).parentElement!);
		expect(screen.getByRole('tooltip')).toHaveTextContent(/T$/);
	});

	it('Cmd+T does nothing before the first message', async () => {
		await renderWith(snapshot({ tabId: null }));
		await act(async () => fireEvent.keyDown(window, { key: 't', metaKey: true }));
		expect(window.maestro.quickChat.command).not.toHaveBeenCalledWith({ type: 'reveal' });
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

	it('offers no way out for a message that is not waiting', async () => {
		await renderWith(snapshot({ messages: [sentMessage('m', 'hi', { status: 'running' })] }));
		expect(screen.queryByRole('button', { name: /Send to a new tab/ })).toBeNull();
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
