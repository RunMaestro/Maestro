import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { createRef } from 'react';

import {
	GroupChatMessages,
	type GroupChatMessagesHandle,
} from '../../../renderer/components/GroupChatMessages';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { mockTheme } from '../../helpers/mockTheme';
import type { GroupChatMessage, GroupChatParticipant } from '../../../shared/group-chat-types';

const { markdownRenderSpy } = vi.hoisted(() => ({ markdownRenderSpy: vi.fn() }));

// MarkdownRenderer pulls in react-markdown; stub it to plain text so these
// tests stay focused on the auto-scroll behaviour rather than markdown output.
vi.mock('../../../renderer/components/MarkdownRenderer', () => ({
	MarkdownRenderer: ({ content }: { content: string }) => {
		markdownRenderSpy(content);
		return <div>{content}</div>;
	},
}));

const participants: GroupChatParticipant[] = [
	{ name: 'Alice', agentId: 'a', sessionId: 's-a', addedAt: 0 },
];

function makeMessages(n: number): GroupChatMessage[] {
	return Array.from({ length: n }, (_, i) => ({
		timestamp: new Date(1700000000000 + i * 1000).toISOString(),
		from: 'Alice',
		content: `message ${i}`,
	}));
}

/**
 * jsdom has no layout, so instrument scrollTop/scrollHeight directly. The
 * returned object's `scrollTop` reflects exactly what the component assigned,
 * independent of jsdom's (non-)clamping behaviour.
 */
function instrumentScroll(el: HTMLElement) {
	const state = { scrollTop: 0 };
	Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 1000 });
	Object.defineProperty(el, 'scrollTop', {
		configurable: true,
		get: () => state.scrollTop,
		set: (v: number) => {
			state.scrollTop = v;
		},
	});
	return state;
}

function renderChat(messages: GroupChatMessage[], chatId?: string) {
	const result = render(
		<GroupChatMessages
			theme={mockTheme}
			messages={messages}
			chatId={chatId}
			participants={participants}
			state="idle"
		/>
	);
	const container = result.container.querySelector('[role="region"]') as HTMLElement;
	return { ...result, container };
}

describe('GroupChatMessages auto-scroll setting', () => {
	beforeEach(() => {
		markdownRenderSpy.mockClear();
		useSettingsStore.setState({ groupChatAutoScroll: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('skips rendering message content when stable props are rerendered', () => {
		const messages = makeMessages(3);
		const onToggleMarkdownEditMode = vi.fn();
		const { rerender } = render(
			<GroupChatMessages
				theme={mockTheme}
				messages={messages}
				participants={participants}
				state="idle"
				onToggleMarkdownEditMode={onToggleMarkdownEditMode}
			/>
		);
		const initialRenderCount = markdownRenderSpy.mock.calls.length;

		rerender(
			<GroupChatMessages
				theme={mockTheme}
				messages={messages}
				participants={participants}
				state="idle"
				onToggleMarkdownEditMode={onToggleMarkdownEditMode}
			/>
		);

		expect(markdownRenderSpy).toHaveBeenCalledTimes(initialRenderCount);
	});

	it('renders only a small virtual window for a large chat history', () => {
		const messages = makeMessages(423);
		const { container } = renderChat(messages, 'large-chat');

		expect(container.querySelectorAll('[data-message-timestamp]').length).toBeLessThan(20);
	});

	it('virtualizes the typing indicator as the final scrollable row', async () => {
		const result = render(
			<GroupChatMessages
				theme={mockTheme}
				messages={makeMessages(3)}
				participants={participants}
				state="moderator-thinking"
			/>
		);
		const indicator = await waitFor(() => {
			const element = result.container.querySelector('[data-typing-indicator]');
			expect(element).toBeInTheDocument();
			return element as HTMLElement;
		});

		expect(indicator.dataset.index).toBe('3');
		expect(indicator.style.position).toBe('absolute');
		expect(indicator.textContent).toContain('Moderator is thinking...');
	});

	it('scrolls to messages whose timestamp is a numeric string', () => {
		const ref = createRef<GroupChatMessagesHandle>();
		const timestamp = 1700000000000;
		const result = render(
			<GroupChatMessages
				ref={ref}
				theme={mockTheme}
				messages={[{ timestamp: String(timestamp), from: 'Alice', content: 'target' }]}
				participants={participants}
				state="idle"
			/>
		);
		const container = result.container.querySelector('[role="region"]') as HTMLElement;
		const scrollTo = vi.fn();
		container.scrollTo = scrollTo;

		act(() => ref.current?.scrollToMessage(timestamp));

		expect(scrollTo).toHaveBeenCalled();
	});

	it('retries highlighting until an offscreen target row mounts', async () => {
		const ref = createRef<GroupChatMessagesHandle>();
		const timestamp = 1700000000000;
		const result = render(
			<GroupChatMessages
				ref={ref}
				theme={mockTheme}
				messages={[{ timestamp: String(timestamp), from: 'Alice', content: 'target' }]}
				participants={participants}
				state="idle"
			/>
		);
		const container = result.container.querySelector('[role="region"]') as HTMLElement;
		const target = document.createElement('div');
		const originalQuerySelector = container.querySelector.bind(container);
		let attempts = 0;
		container.scrollTo = vi.fn();
		const querySpy = vi.spyOn(container, 'querySelector').mockImplementation((selector: string) => {
			if (selector === '[data-message-index="0"]') {
				attempts += 1;
				return attempts < 4 ? null : target;
			}
			return originalQuerySelector(selector);
		});

		act(() => ref.current?.scrollToMessage(timestamp));

		await waitFor(() => expect(attempts).toBe(4));
		expect(target.style.backgroundColor).toBe('rgba(255, 255, 255, 0.1)');
		querySpy.mockRestore();
	});

	it('scrolls to the bottom on new messages when auto-scroll is enabled', () => {
		const { rerender, container } = renderChat(makeMessages(2));
		const scroll = instrumentScroll(container);
		scroll.scrollTop = 0;

		rerender(
			<GroupChatMessages
				theme={mockTheme}
				messages={makeMessages(3)}
				participants={participants}
				state="idle"
			/>
		);

		expect(scroll.scrollTop).toBe(1000);
	});

	it('keeps the virtual typing indicator at the bottom when a message arrives', async () => {
		const result = render(
			<GroupChatMessages
				theme={mockTheme}
				messages={makeMessages(2)}
				participants={participants}
				state="moderator-thinking"
			/>
		);
		const container = result.container.querySelector('[role="region"]') as HTMLElement;
		const scroll = instrumentScroll(container);
		scroll.scrollTop = 0;

		result.rerender(
			<GroupChatMessages
				theme={mockTheme}
				messages={makeMessages(3)}
				participants={participants}
				state="moderator-thinking"
			/>
		);

		expect(scroll.scrollTop).toBe(1000);
		await waitFor(() => {
			expect(container.querySelector('[data-typing-indicator]')).toBeInTheDocument();
		});
	});

	it('does not scroll on new messages when auto-scroll is disabled', () => {
		useSettingsStore.setState({ groupChatAutoScroll: false });
		const { rerender, container } = renderChat(makeMessages(2));
		const scroll = instrumentScroll(container);
		scroll.scrollTop = 0;

		rerender(
			<GroupChatMessages
				theme={mockTheme}
				messages={makeMessages(3)}
				participants={participants}
				state="idle"
			/>
		);

		expect(scroll.scrollTop).toBe(0);
	});

	it('scrolls to the bottom on the first messages load even when auto-scroll is disabled', () => {
		useSettingsStore.setState({ groupChatAutoScroll: false });
		// Mount empty, then let the first batch of history load. This mirrors
		// opening an existing chat: the initial scroll must land at the newest
		// message even though subsequent auto-scroll is disabled.
		const { rerender, container } = renderChat([]);
		const scroll = instrumentScroll(container);
		scroll.scrollTop = 0;

		rerender(
			<GroupChatMessages
				theme={mockTheme}
				messages={makeMessages(3)}
				participants={participants}
				state="idle"
			/>
		);

		expect(scroll.scrollTop).toBe(1000);
	});

	it('does not scroll when the setting is toggled on without new messages', () => {
		useSettingsStore.setState({ groupChatAutoScroll: false });
		const { container } = renderChat(makeMessages(3));
		const scroll = instrumentScroll(container);
		scroll.scrollTop = 0;

		// Turning the setting back on while reading older messages must not yank
		// the reader to the bottom; only a new message may trigger a scroll.
		act(() => {
			useSettingsStore.setState({ groupChatAutoScroll: true });
		});

		expect(scroll.scrollTop).toBe(0);
	});

	it('scrolls to the newest message when switching chats even when auto-scroll is disabled', () => {
		useSettingsStore.setState({ groupChatAutoScroll: false });
		// Open chat A: its history loads and lands at the newest message.
		const { rerender, container } = renderChat(makeMessages(3), 'chat-a');
		const scroll = instrumentScroll(container);
		// Reader scrolls up to read earlier messages in chat A.
		scroll.scrollTop = 0;

		// The component instance is reused (props swap, no remount) when the
		// active chat changes. The newly opened chat must still land at its
		// newest message.
		rerender(
			<GroupChatMessages
				theme={mockTheme}
				messages={makeMessages(4)}
				chatId="chat-b"
				participants={participants}
				state="idle"
			/>
		);

		expect(scroll.scrollTop).toBe(1000);
	});

	it('does not re-scroll on new messages within the same chat when auto-scroll is disabled', () => {
		useSettingsStore.setState({ groupChatAutoScroll: false });
		const { rerender, container } = renderChat(makeMessages(3), 'chat-a');
		const scroll = instrumentScroll(container);
		scroll.scrollTop = 0;

		// Same chat, a new message arrives: must not yank the reader to the
		// bottom (the per-chat initial scroll already ran for this chat).
		rerender(
			<GroupChatMessages
				theme={mockTheme}
				messages={makeMessages(4)}
				chatId="chat-a"
				participants={participants}
				state="idle"
			/>
		);

		expect(scroll.scrollTop).toBe(0);
	});
});
