import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';

import { GroupChatMessages } from '../../../renderer/components/GroupChatMessages';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { mockTheme } from '../../helpers/mockTheme';
import type { GroupChatMessage, GroupChatParticipant } from '../../../shared/group-chat-types';

// MarkdownRenderer pulls in react-markdown; stub it to plain text so these
// tests stay focused on the auto-scroll behaviour rather than markdown output.
vi.mock('../../../renderer/components/MarkdownRenderer', () => ({
	MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
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

function renderChat(messages: GroupChatMessage[]) {
	const result = render(
		<GroupChatMessages
			theme={mockTheme}
			messages={messages}
			participants={participants}
			state="idle"
		/>
	);
	const container = result.container.querySelector('[role="region"]') as HTMLElement;
	return { ...result, container };
}

describe('GroupChatMessages auto-scroll setting', () => {
	beforeEach(() => {
		useSettingsStore.setState({ groupChatAutoScroll: true });
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
});
