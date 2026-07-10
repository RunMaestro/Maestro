import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';

import { GroupChatMessages } from '../../../renderer/components/GroupChatMessages';
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
